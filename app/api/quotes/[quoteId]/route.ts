import { requiresHourlyProject } from "@/lib/hourly-project-policy";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { calculateBookingFinancialSnapshot, type BookingFinancialPlan } from "@/lib/booking-financials";
import { database } from "@/lib/database";
import { recordAnalytics } from "@/lib/analytics";
import { enforceRateLimit, recordActivity } from "@/lib/request-security";
import { sendBookingUpdateEmails } from "@/lib/booking-email";
import { unavailableBookingProfessionals } from "@/lib/booking-staff";
import { reconcileExpiredComplimentaryProGrants } from "@/lib/complimentary-pro";

export async function PATCH(request: Request, context: RouteContext<"/api/quotes/[quoteId]">) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Log in to respond to this quote." }, { status: 401 });
  await reconcileExpiredComplimentaryProGrants();
  if (!await enforceRateLimit({ request, userId: session.user.id, bucket: "job-quote-response", limit: 15 })) return NextResponse.json({ error: "Too many quote changes. Please wait a minute." }, { status: 429 });
  const { quoteId } = await context.params;
  const body = await request.json() as { action?: unknown };
  const action = body.action === "accept" ? "accept" : body.action === "decline" ? "decline" : "";
  if (!action) return NextResponse.json({ error: "Choose accept or decline." }, { status: 400 });

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      id: string; customer_id: string; provider_id: string; provider_user_id: string; service_id: string; job_request_id: string;
      booking_id: string | null; quote_status: string; total_cents: number; request_status: string; preferred_starts_at: Date;
      address_line1: string | null; address_line2: string | null; city: string | null; state: string | null; postal_code: string | null; description: string; delivery_method: "IN_PERSON" | "REMOTE";
      duration_minutes: number; service_title: string; plan: BookingFinancialPlan; provider_eligible: boolean;
      pricing_type: "FIXED" | "HOURLY"; hourly_rate_cents: number | null; quote_duration_minutes: number | null;
      billing_increment_minutes: number | null; minimum_duration_minutes: number | null; maximum_duration_minutes: number | null;
      line_items: Array<{ label?: string; amount?: number }> | null;
    }>(
      `SELECT quote.id::text, quote.customer_id, quote.provider_id::text, provider.user_id AS provider_user_id,
              quote.service_id::text, quote.job_request_id::text, quote.booking_id::text, quote.status AS quote_status,
              quote.total_cents, request.status AS request_status, request.preferred_starts_at, COALESCE(quote.delivery_method, 'IN_PERSON') AS delivery_method,
              request.service_address_line1 AS address_line1, request.service_address_line2 AS address_line2,
              request.city, request.state, request.postal_code, request.description,
              service.duration_minutes, service.title AS service_title, provider.plan,
              service.billing_increment_minutes, service.minimum_duration_minutes, service.maximum_duration_minutes,
              quote.pricing_type,quote.hourly_rate_cents,quote.duration_minutes AS quote_duration_minutes,quote.line_items,
              (provider.is_active = true AND provider.is_verified = true AND provider.screening_status = 'passed'
                AND provider.age_verification_status = 'verified'
                AND provider.screening_checked_at BETWEEN now() - interval '30 days' AND now()
                AND provider.stripe_charges_enabled = true AND provider.stripe_payouts_enabled = true
                AND NOT EXISTS (SELECT 1 FROM account_restrictions restriction WHERE restriction.user_id = provider.user_id
                  AND restriction.status IN ('suspended', 'banned') AND (restriction.expires_at IS NULL OR restriction.expires_at > now()))) AS provider_eligible
       FROM quotes quote JOIN job_requests request ON request.id = quote.job_request_id
       JOIN services service ON service.id = quote.service_id JOIN provider_profiles provider ON provider.id = quote.provider_id
       WHERE quote.id::text = $1 AND quote.customer_id = $2
         AND (quote.expires_at IS NULL OR quote.expires_at > now())
       FOR UPDATE OF quote, request`,
      [quoteId, session.user.id],
    );
    const quote = result.rows[0];
    if (!quote) { await client.query("ROLLBACK"); return NextResponse.json({ error: "Quote not found." }, { status: 404 }); }
    if (quote.booking_id) { await client.query("COMMIT"); return NextResponse.json({ ok: true, bookingId: quote.booking_id }); }
    if (quote.quote_status !== "sent" || !["open", "receiving_responses"].includes(quote.request_status)) { await client.query("ROLLBACK"); return NextResponse.json({ error: "This quote is no longer awaiting a response." }, { status: 409 }); }
    if (action === "decline") {
      await client.query("UPDATE quotes SET status = 'declined', declined_at = now() WHERE id::text = $1", [quoteId]);
      await client.query(`INSERT INTO notifications (user_id, type, title, message, href, dedupe_key)
        VALUES ($1,'job_quote','Quote declined',$2,'/provider/dashboard/opportunities',$3) ON CONFLICT (dedupe_key) DO NOTHING`, [quote.provider_user_id, `${session.user.name || "The customer"} declined your quote for ${quote.service_title}.`, `job-quote-declined-${quoteId}`]);
      await client.query("COMMIT");
      return NextResponse.json({ ok: true });
    }
    if (requiresHourlyProject(quote.pricing_type)) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Hourly work now uses tracked projects instead of prepaid hours. Request a project from this service's listing. Your existing paid bookings have not changed.", code: "HOURLY_PROJECT_REQUIRED", serviceId: quote.service_id }, { status: 409 });
    }
    if (!quote.provider_eligible) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "This provider is no longer eligible to accept bookings. Choose another quote or post a new request." }, { status: 409 });
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [quote.provider_id]);
    const startsAt = quote.preferred_starts_at;
    const billableDurationMinutes = quote.pricing_type === "HOURLY" ? quote.quote_duration_minutes! : quote.duration_minutes;
    const endsAt = new Date(startsAt.getTime() + billableDurationMinutes * 60_000);
    const conflict = await client.query(
      `SELECT 1 FROM bookings WHERE provider_id::text = $1 AND status = 'confirmed' AND starts_at < $3 AND ends_at > $2 LIMIT 1`,
      [quote.provider_id, startsAt, endsAt],
    );
    if (conflict.rows[0]) { await client.query("ROLLBACK"); return NextResponse.json({ error: "That time was just booked. Ask the provider to send a revised quote with another time." }, { status: 409 }); }
    const snapshot = calculateBookingFinancialSnapshot(quote.total_cents, quote.plan);
    const quotedAddOns = quote.pricing_type === "HOURLY" && Array.isArray(quote.line_items)
      ? quote.line_items.filter((item) => typeof item.label === "string" && Number.isSafeInteger(item.amount) && item.amount! >= 0)
        .map((item) => ({ name: item.label!, quantity: 1, lineTotalCents: item.amount! }))
      : [];
    const addOnTotalCents = quotedAddOns.reduce((sum, item) => sum + item.lineTotalCents, 0);
    const laborCents = quote.pricing_type === "HOURLY" ? quote.total_cents - addOnTotalCents : quote.total_cents;
    if (laborCents < 0) { await client.query("ROLLBACK"); return NextResponse.json({ error: "This quote has an invalid price breakdown. Ask the provider to revise it." }, { status: 409 }); }
    const formattedAddress = quote.delivery_method === "REMOTE" ? "Remote service" : [quote.address_line1, quote.address_line2, `${quote.city}, ${quote.state} ${quote.postal_code}`].filter(Boolean).join(", ");
    const created = await client.query<{ id: string }>(
      `INSERT INTO bookings (customer_id, provider_id, service_id, starts_at, ends_at, status, service_address,
         service_address_line1, service_address_line2, service_city, service_state, service_postal_code, notes, price_cents,
         source_job_request_id, source_quote_id, provider_plan_snapshot, provider_fee_basis_points, provider_fee_cap_cents, platform_fee_cents,
         provider_payout_cents, customer_service_fee_cents, customer_total_cents, delivery_method,
         pricing_type_snapshot,hourly_rate_cents_snapshot,billable_duration_minutes,base_price_cents,add_on_total_cents,discount_cents,add_on_snapshot,
         billing_increment_minutes_snapshot,minimum_duration_minutes_snapshot,maximum_duration_minutes_snapshot)
       VALUES ($1,$2,$3,$4,$5,'confirmed',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,0,$28::jsonb,$29,$30,$31,$32) RETURNING id::text`,
      [session.user.id, quote.provider_id, quote.service_id, startsAt, endsAt, formattedAddress, quote.address_line1, quote.address_line2, quote.city, quote.state, quote.postal_code, quote.description, quote.total_cents, quote.job_request_id, quoteId, snapshot.providerPlan, snapshot.providerFeeBasisPoints, snapshot.providerFeeCapCents, snapshot.providerFeeCents, snapshot.providerNetCents, snapshot.customerServiceFeeCents, snapshot.customerTotalCents, quote.delivery_method, quote.pricing_type, quote.hourly_rate_cents, billableDurationMinutes, laborCents, addOnTotalCents, JSON.stringify(quotedAddOns), quote.pricing_type === "HOURLY" ? quote.billing_increment_minutes : null, quote.pricing_type === "HOURLY" ? quote.minimum_duration_minutes : null, quote.pricing_type === "HOURLY" ? quote.maximum_duration_minutes : null],
    );
    const bookingId = created.rows[0].id;
    await client.query("INSERT INTO booking_assignees (booking_id, is_owner) VALUES ($1, true)", [bookingId]);
    const unavailable = await unavailableBookingProfessionals(client, { bookingId, providerId: quote.provider_id, serviceId: quote.service_id, startsAt, endsAt });
    if (unavailable.length) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: `${unavailable.join(", ")} is not available for the full quoted duration. Ask the provider for a revised time or duration.` }, { status: 409 });
    }
    await client.query("INSERT INTO booking_events (booking_id, actor_user_id, event_type, message) VALUES ($1,$2,'quote_accepted','Customer accepted the service-request quote. Booking confirmed pending payment.')", [bookingId, session.user.id]);
    await client.query("UPDATE quotes SET status = 'accepted', accepted_at = now(), booking_id = $2 WHERE id::text = $1", [quoteId, bookingId]);
    await client.query("UPDATE quotes SET status = 'declined', declined_at = now() WHERE job_request_id::text = $1 AND id::text <> $2 AND status = 'sent'", [quote.job_request_id, quoteId]);
    await client.query("UPDATE job_requests SET status = 'booking_created', accepted_quote_id = $2, booking_id = $3 WHERE id::text = $1", [quote.job_request_id, quoteId, bookingId]);
    await client.query(`INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key) VALUES
      ($1,$3,'job_quote','Quote accepted',$4,'/provider/dashboard/bookings/' || $3::uuid::text,$5),
      ($2,$3,'booking_confirmed','Booking created from your quote',$6,'/account/bookings/' || $3::uuid::text,$7)
      ON CONFLICT (dedupe_key) DO NOTHING`, [quote.provider_user_id, session.user.id, bookingId, `${session.user.name || "The customer"} accepted your quote for ${quote.service_title}.`, `job-quote-accepted-${quoteId}-provider`, `Your booking for ${quote.service_title} is ready for payment through Stripe.`, `job-quote-accepted-${quoteId}-customer`]);
    await client.query("COMMIT");
    await recordActivity({ userId: session.user.id, action: "job_quote_accepted", targetType: "quote", targetId: quoteId });
    await recordAnalytics({ eventName: "job_quote_accepted", userId: session.user.id, targetType: "quote", targetId: quoteId, metadata: { bookingId, totalCents: quote.total_cents } });
    await sendBookingUpdateEmails(bookingId, "accepted");
    return NextResponse.json({ ok: true, bookingId });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Quote response failed", error);
    return NextResponse.json({ error: "We could not update this quote." }, { status: 500 });
  } finally { client.release(); }
}
