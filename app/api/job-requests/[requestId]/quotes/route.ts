import { requiresHourlyProject } from "@/lib/hourly-project-policy";
import { NextResponse } from "next/server";
import { database } from "@/lib/database";
import { checkAndRecordContent } from "@/lib/content-safety";
import { getProviderAccess } from "@/lib/provider-access";
import { enforceRateLimit, recordActivity } from "@/lib/request-security";
import { recordAnalytics } from "@/lib/analytics";
import { sendTransactionalEmail } from "@/lib/email";
import { isBookingDeliveryMethod, serviceSupportsMethod, type BookingDeliveryMethod, type RequestDeliveryType, type ServiceDeliveryType } from "@/lib/service-delivery";
import { calculateHourlyBasePriceCents, validateHourlyDuration, type HourlyPricingConfig } from "@/lib/service-pricing";

type LineItem = { label: string; amount: number };

export async function POST(request: Request, context: RouteContext<"/api/job-requests/[requestId]/quotes">) {
  const access = await getProviderAccess();
  if (!access) return NextResponse.json({ error: "Provider access not found." }, { status: 403 });
  if (!await enforceRateLimit({ request, userId: access.session.user.id, bucket: "job-quote-send", limit: 20 })) return NextResponse.json({ error: "Too many quote changes. Please wait a minute." }, { status: 429 });
  const { requestId } = await context.params;
  const body = await request.json() as Record<string, unknown>;
  const serviceId = typeof body.serviceId === "string" ? body.serviceId : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  const total = Number(body.total);
  const requestedPricingType = body.pricingType === "HOURLY" ? "HOURLY" : "FIXED";
  if (requiresHourlyProject(requestedPricingType)) {
    return NextResponse.json({ error: "Prepaid hourly quotes have been replaced by tracked projects. Ask the customer to request a project from your hourly listing, with a work limit and a final timesheet to approve.", code: "HOURLY_PROJECT_REQUIRED" }, { status: 409 });
  }
  const requestedHourlyRateCents = Math.round(Number(body.hourlyRate) * 100);
  const requestedDurationMinutes = Number(body.durationMinutes);
  const expiresInDays = body.expiresInDays == null ? 7 : Number(body.expiresInDays);
  const requestedDeliveryMethod = isBookingDeliveryMethod(body.deliveryMethod) ? body.deliveryMethod : null;
  const rawItems = Array.isArray(body.lineItems) ? body.lineItems : [];
  const lineItems: LineItem[] = rawItems.slice(0, 12).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const label = typeof (item as { label?: unknown }).label === "string" ? (item as { label: string }).label.trim() : "";
    const amount = Number((item as { amount?: unknown }).amount);
    return label && Number.isFinite(amount) && amount >= 0 ? [{ label, amount: Math.round(amount * 100) }] : [];
  });
  if (!serviceId || title.length < 3 || title.length > 120 || description.length > 1000 || notes.length > 1000 || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) return NextResponse.json({ error: "Enter a valid title and expiration." }, { status: 400 });
  const safety = await checkAndRecordContent({ userId: access.session.user.id, surface: "job_quote", fields: [title, description, notes, ...lineItems.map((item) => item.label)] });
  if (!safety.allowed) return NextResponse.json({ error: safety.message }, { status: 422 });

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const match = await client.query<{ customer_id: string; customer_email: string; customer_notifications: boolean; status: string; service_id: string; conversation_id: string | null; request_delivery_type: RequestDeliveryType; service_delivery_type: ServiceDeliveryType; pricing_type: "FIXED" | "HOURLY" | "QUOTE_ONLY"; hourly_rate_cents: number | null; minimum_duration_minutes: number | null; maximum_duration_minutes: number | null; billing_increment_minutes: 15 | 30 | 60 | null; default_duration_minutes: number | null }>(
      `SELECT request.customer_id, customer.email AS customer_email,
              COALESCE(settings.request_notifications, true) AS customer_notifications,
              request.status, match.service_id::text, request.delivery_type AS request_delivery_type, service.delivery_type AS service_delivery_type,
              service.pricing_type,service.hourly_rate_cents,service.minimum_duration_minutes,service.maximum_duration_minutes,
              service.billing_increment_minutes,service.default_duration_minutes,
              COALESCE(match.conversation_id::text, (SELECT conversation.id::text FROM conversations conversation
               WHERE conversation.customer_id = request.customer_id AND conversation.provider_id = match.provider_id
                 AND conversation.service_id = match.service_id LIMIT 1)) AS conversation_id
       FROM job_request_matches match JOIN job_requests request ON request.id = match.request_id
       JOIN services service ON service.id = match.service_id
       JOIN provider_profiles eligible ON eligible.id = match.provider_id
       JOIN "user" customer ON customer.id = request.customer_id
       LEFT JOIN user_settings settings ON settings.user_id = customer.id
       WHERE request.id::text = $1 AND match.provider_id::text = $2 AND match.service_id::text = $3
         AND request.status IN ('open','receiving_responses') AND request.expires_at > now()
         AND eligible.is_active = true AND eligible.is_verified = true AND eligible.screening_status = 'passed'
         AND eligible.age_verification_status = 'verified'
         AND eligible.screening_checked_at BETWEEN now() - interval '30 days' AND now()
         AND eligible.stripe_charges_enabled = true AND eligible.stripe_payouts_enabled = true
         AND NOT EXISTS (SELECT 1 FROM account_restrictions restriction WHERE restriction.user_id = eligible.user_id
           AND restriction.status IN ('suspended', 'banned') AND (restriction.expires_at IS NULL OR restriction.expires_at > now()))
       FOR UPDATE OF request, match`,
      [requestId, access.providerId, serviceId],
    );
    const matched = match.rows[0];
    if (!matched) { await client.query("ROLLBACK"); return NextResponse.json({ error: "This request is no longer available to quote." }, { status: 409 }); }
    const deliveryMethod: BookingDeliveryMethod = requestedDeliveryMethod
      ?? (matched.request_delivery_type === "REMOTE" || (matched.request_delivery_type === "EITHER" && matched.service_delivery_type === "REMOTE") ? "REMOTE" : "IN_PERSON");
    if (!serviceSupportsMethod(matched.service_delivery_type, deliveryMethod) || (matched.request_delivery_type !== "EITHER" && matched.request_delivery_type !== deliveryMethod)) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Choose a delivery method supported by both the request and service." }, { status: 400 });
    }
    let totalCents: number;
    let hourlyRateCents: number | null = null;
    let durationMinutes: number | null = null;
    if (requestedPricingType === "HOURLY") {
      if (matched.pricing_type !== "HOURLY") { await client.query("ROLLBACK"); return NextResponse.json({ error: "This matched service is not configured for hourly quotes." }, { status: 400 }); }
      hourlyRateCents = requestedHourlyRateCents;
      durationMinutes = requestedDurationMinutes;
      try {
        validateHourlyDuration({ pricingType: "HOURLY", hourlyRateCents,
          minimumDurationMinutes: matched.minimum_duration_minutes!, maximumDurationMinutes: matched.maximum_duration_minutes,
          billingIncrementMinutes: matched.billing_increment_minutes!, defaultDurationMinutes: matched.default_duration_minutes! } satisfies HourlyPricingConfig, durationMinutes);
      } catch (error) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: error instanceof Error ? error.message : "Enter a valid hourly rate and duration." }, { status: 400 });
      }
      totalCents = calculateHourlyBasePriceCents(hourlyRateCents, durationMinutes) + lineItems.reduce((sum, item) => sum + item.amount, 0);
    } else {
      if (!Number.isFinite(total) || total < 1 || total > 1_000_000) { await client.query("ROLLBACK"); return NextResponse.json({ error: "Enter a quote between $1 and $1,000,000." }, { status: 400 }); }
      totalCents = Math.round(total * 100);
      if (lineItems.length && lineItems.reduce((sum, item) => sum + item.amount, 0) !== totalCents) { await client.query("ROLLBACK"); return NextResponse.json({ error: "Line items must add up to the quote total." }, { status: 400 }); }
    }
    const latest = await client.query<{ id: string; version: number }>(
      `SELECT id::text, version FROM quotes WHERE job_request_id::text = $1 AND provider_id::text = $2 ORDER BY version DESC LIMIT 1 FOR UPDATE`,
      [requestId, access.providerId],
    );
    const previous = latest.rows[0];
    if (previous) await client.query("UPDATE quotes SET status = 'superseded' WHERE id::text = $1 AND status = 'sent'", [previous.id]);
    const created = await client.query<{ id: string }>(
      `INSERT INTO quotes (customer_id, provider_id, service_id, job_request_id, conversation_id, version, title,
         description, line_items, total_cents, notes, expires_at, supersedes_quote_id, delivery_method,
         pricing_type,hourly_rate_cents,duration_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,now() + make_interval(days => $12),$13::uuid,$14,$15,$16,$17)
       RETURNING id::text`,
      [matched.customer_id, access.providerId, serviceId, requestId, matched.conversation_id, (previous?.version ?? 0) + 1, title, description, JSON.stringify(lineItems), totalCents, notes, expiresInDays, previous?.id ?? null, deliveryMethod, requestedPricingType, hourlyRateCents, durationMinutes],
    );
    await client.query("UPDATE job_request_matches SET status = 'responded', viewed_at = COALESCE(viewed_at, now()), responded_at = COALESCE(responded_at, now()), updated_at = now() WHERE request_id::text = $1 AND provider_id::text = $2", [requestId, access.providerId]);
    await client.query("UPDATE job_requests SET status = 'receiving_responses' WHERE id::text = $1 AND status = 'open'", [requestId]);
    if (matched.customer_notifications) await client.query(
      `INSERT INTO notifications (user_id, type, title, message, href, dedupe_key)
       VALUES ($1,'job_quote','New quote for your service request',$2,'/account/requests',$3)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [matched.customer_id, `${access.session.user.name || "A provider"} sent a $${(totalCents / 100).toFixed(2)} quote.`, `job-quote-${created.rows[0].id}`],
    );
    await client.query("COMMIT");
    await recordActivity({ userId: access.session.user.id, action: "job_quote_sent", targetType: "quote", targetId: created.rows[0].id });
    await recordAnalytics({ eventName: "job_quote_sent", userId: access.session.user.id, targetType: "quote", targetId: created.rows[0].id, metadata: { requestId, totalCents, deliveryMethod, pricingType: requestedPricingType, durationMinutes } });
    const providerQuoteCount = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM quotes WHERE provider_id::text = $1", [access.providerId]);
    if (providerQuoteCount.rows[0]?.count === 1) await recordAnalytics({ eventName: "first_quote_sent", userId: access.session.user.id, targetType: "quote", targetId: created.rows[0].id });
    if (matched.customer_notifications) await sendTransactionalEmail({ to: matched.customer_email, userId: matched.customer_id, emailType: `job_quote_${created.rows[0].id}`, idempotencyKey: `job-quote-${created.rows[0].id}`, subject: "You received a new BubsBookings quote", heading: "A provider responded to your service request", message: `${access.session.user.name || "A provider"} sent a $${(totalCents / 100).toFixed(2)}${hourlyRateCents && durationMinutes ? ` hourly quote for ${durationMinutes} minutes at $${(hourlyRateCents / 100).toFixed(2)}/hour` : " quote"}. Compare the details before accepting.`, actionLabel: "Review quote", actionUrl: "/account/requests" });
    return NextResponse.json({ id: created.rows[0].id }, { status: 201 });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Job quote creation failed", error);
    return NextResponse.json({ error: "We could not send this quote." }, { status: 500 });
  } finally { client.release(); }
}
