import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { database } from "@/lib/database";
import { checkAndRecordContent } from "@/lib/content-safety";
import { sendBookingUpdateEmails } from "@/lib/booking-email";
import { enforceRateLimit, recordActivity } from "@/lib/request-security";
import { recordAnalytics } from "@/lib/analytics";
import { refundUnreleasedBooking } from "@/lib/payment-release";
import { unavailableBookingProfessionals } from "@/lib/booking-staff";
import { calculateHourlyBasePriceCents, validateHourlyDuration, type HourlyPricingConfig } from "@/lib/service-pricing";

type BookingAction = "accepted" | "declined" | "completed" | "cancel" | "assign" | "send_quote";

export async function DELETE(_request: Request, context: RouteContext<"/api/providers/bookings/[bookingId]">) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { bookingId } = await context.params;
  const result = await database.query(
    `UPDATE bookings b SET provider_deleted_at = now()
     FROM provider_profiles p
     WHERE b.id::text = $1 AND b.provider_id = p.id AND p.user_id = $2
       AND b.status = 'cancelled' AND b.provider_deleted_at IS NULL`,
    [bookingId, session.user.id],
  );
  if (!result.rowCount) {
    return NextResponse.json({ error: "Only cancelled booking requests can be removed." }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}

export async function PATCH(request: Request, context: RouteContext<"/api/providers/bookings/[bookingId]">) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!await enforceRateLimit({ request, userId: session.user.id, bucket: "provider-booking-update", limit: 20 })) {
    return NextResponse.json({ error: "Too many booking changes. Please wait a minute and try again." }, { status: 429 });
  }
  const { bookingId } = await context.params;
  const body = (await request.json()) as { action?: unknown; reason?: unknown; memberId?: unknown; memberIds?: unknown; price?: unknown; hourlyRate?: unknown; durationMinutes?: unknown };
  const action = body.action as BookingAction;
  if (!(["accepted", "declined", "completed", "cancel", "assign", "send_quote"] as BookingAction[]).includes(action)) {
    return NextResponse.json({ error: "Choose a valid booking action." }, { status: 400 });
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if ((action === "declined" || action === "cancel" || action === "send_quote") && (reason.length < 3 || reason.length > 500)) {
    return NextResponse.json({ error: "Add a brief reason so the customer knows what happened." }, { status: 400 });
  }
  if (reason) {
    const safety = await checkAndRecordContent({ userId: session.user.id, surface: "booking_cancellation", fields: [reason] });
    if (!safety.allowed) return NextResponse.json({ error: safety.message }, { status: 422 });
  }

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const bookingResult = await client.query<{
      id: string; provider_id: string; service_id: string; starts_at: Date; ends_at: Date; status: string;
      customer_id: string; customer_name: string; service_title: string; service_business_name: string;
      reschedule_starts_at: Date | null; reschedule_ends_at: Date | null; reschedule_reason: string | null;
      assigned_team_member_id: string | null; quote_status: string; payment_status: string; payment_flow: string | null; service_location_id: string; recurring_series_id: string | null;
      pricing_type_snapshot: "FIXED" | "HOURLY" | "QUOTE_ONLY"; hourly_rate_cents_snapshot: number | null; billable_duration_minutes: number;
      billing_increment_minutes_snapshot: 15 | 30 | 60 | null; minimum_duration_minutes_snapshot: number | null; maximum_duration_minutes_snapshot: number | null;
      add_on_total_cents: number; discount_cents: number;
      age_verification_status: "not_started" | "pending" | "requires_input" | "verified" | "failed";
    }>(
      `SELECT b.id::text, b.provider_id::text, b.service_id::text, b.starts_at, b.ends_at, b.status,
              b.customer_id, u.name AS customer_name, s.title AS service_title, s.business_name AS service_business_name,
              b.reschedule_starts_at, b.reschedule_ends_at, b.reschedule_reason, b.assigned_team_member_id::text,
              b.quote_status, b.payment_status, b.payment_flow, s.location_id::text AS service_location_id, b.recurring_series_id::text,
              b.pricing_type_snapshot,b.hourly_rate_cents_snapshot,b.billable_duration_minutes,b.billing_increment_minutes_snapshot,
              b.minimum_duration_minutes_snapshot,b.maximum_duration_minutes_snapshot,b.add_on_total_cents,b.discount_cents,
              p.age_verification_status
       FROM bookings b
       JOIN provider_profiles p ON p.id = b.provider_id
       JOIN services s ON s.id = b.service_id
       JOIN "user" u ON u.id = b.customer_id
       WHERE b.id::text = $1 AND p.user_id = $2
       FOR UPDATE OF b`,
      [bookingId, session.user.id],
    );
    const booking = bookingResult.rows[0];
    if (!booking) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Booking not found." }, { status: 404 });
    }
    const projectPayment = await client.query("SELECT 1 FROM hourly_projects WHERE payment_booking_id::text = $1", [bookingId]);
    if (projectPayment.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "This is an approved hourly-project payment. Manage the project timesheet or use the existing refund and dispute tools.", code: "PROJECT_PAYMENT_LOCKED" }, { status: 409 });
    }
    if (booking.age_verification_status !== "verified" && !["declined", "cancel"].includes(action)) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Complete provider age verification before accepting, assigning, quoting, or completing bookings." }, { status: 403 });
    }

    if (action === "send_quote") {
      if (booking.status !== "requested") { await client.query("ROLLBACK"); return NextResponse.json({ error: "Quotes can only be sent before a booking is confirmed." }, { status: 409 }); }
      let cents: number;
      let quotedRateCents: number | null = null;
      let quotedDuration: number | null = null;
      if (booking.pricing_type_snapshot === "HOURLY") {
        quotedRateCents = Math.round(Number(body.hourlyRate) * 100);
        quotedDuration = Number(body.durationMinutes);
        try {
          validateHourlyDuration({ pricingType: "HOURLY", hourlyRateCents: quotedRateCents,
            minimumDurationMinutes: booking.minimum_duration_minutes_snapshot!, maximumDurationMinutes: booking.maximum_duration_minutes_snapshot,
            billingIncrementMinutes: booking.billing_increment_minutes_snapshot!, defaultDurationMinutes: booking.billable_duration_minutes } satisfies HourlyPricingConfig, quotedDuration);
        } catch (error) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: error instanceof Error ? error.message : "Enter a valid hourly rate and duration." }, { status: 400 });
        }
        const laborCents = calculateHourlyBasePriceCents(quotedRateCents, quotedDuration);
        cents = Math.max(50, laborCents + booking.add_on_total_cents - booking.discount_cents);
      } else {
        const price = Number(body.price);
        if (!Number.isFinite(price) || price < 1 || price > 1000000) { await client.query("ROLLBACK"); return NextResponse.json({ error: "Enter a quote between $1 and $1,000,000." }, { status: 400 }); }
        cents = Math.round(price * 100);
      }
      if (cents > 100_000_000) { await client.query("ROLLBACK"); return NextResponse.json({ error: "The quoted total is too large." }, { status: 400 }); }
      await client.query(`UPDATE bookings SET quote_status = 'pending', quoted_price_cents = $2,
        quote_message = $3, quote_sent_at = now(), quote_responded_at = NULL,
        quoted_pricing_type=$4,quoted_hourly_rate_cents=$5,quoted_duration_minutes=$6 WHERE id::text = $1`,
        [bookingId, cents, reason, booking.pricing_type_snapshot === "HOURLY" ? "HOURLY" : "FIXED", quotedRateCents, quotedDuration]);
      await client.query(`INSERT INTO booking_events (booking_id, actor_user_id, event_type, message, metadata)
        VALUES ($1::uuid, $2, 'quote_sent', $3, jsonb_build_object('priceCents', $4::integer,'hourlyRateCents',$5::integer,'durationMinutes',$6::integer))`,
        [bookingId, session.user.id, `Provider sent a $${(cents / 100).toFixed(2)} quote: ${reason}`, cents, quotedRateCents, quotedDuration]);
      await client.query(`INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
        VALUES ($1, $2::uuid, 'booking_quote', 'New quote from your provider', $3,
        '/account/bookings/' || $2::uuid::text, 'booking-quote-' || $2::uuid::text || '-' || extract(epoch from now())::bigint)`,
        [booking.customer_id, bookingId, `${booking.service_title}: $${(cents / 100).toFixed(2)}${quotedRateCents && quotedDuration ? ` (${quotedDuration} minutes at $${(quotedRateCents / 100).toFixed(2)}/hour)` : ""}. Review and approve it before the booking is confirmed.`]);
    } else if (action === "assign") {
      if (!["requested", "confirmed"].includes(booking.status)) { await client.query("ROLLBACK"); return NextResponse.json({ error: "This booking can no longer be assigned." }, { status: 409 }); }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [booking.provider_id]);
      const rawIds = Array.isArray(body.memberIds) ? body.memberIds : [body.memberId];
      const selectedIds = Array.from(new Set(rawIds.filter((value): value is string => typeof value === "string" && value.length > 0)));
      if (!selectedIds.length) { await client.query("ROLLBACK"); return NextResponse.json({ error: "Assign at least one professional." }, { status: 400 }); }
      const selected: Array<{ memberId: string | null; name: string }> = [];
      for (const selectedId of selectedIds) {
        const memberId = selectedId === "owner" ? null : selectedId;
        let assigneeName = session.user.name || "Company owner";
        if (memberId) {
          const member = await client.query<{ name: string }>(`SELECT member.name FROM provider_team_members member
            JOIN provider_team_member_locations assigned_location ON assigned_location.team_member_id = member.id
            WHERE member.id::text = $1 AND member.provider_id::text = $2 AND assigned_location.location_id::text = $3 AND member.status = 'active'`, [memberId, booking.provider_id, booking.service_location_id]);
          if (!member.rows[0]) { await client.query("ROLLBACK"); return NextResponse.json({ error: "Worker not found." }, { status: 404 }); }
          assigneeName = member.rows[0].name;
        }
        const working = await client.query(`WITH hours AS (
          SELECT a.weekday, a.start_time, a.end_time, a.timezone FROM availability a WHERE a.provider_id::text = $1 AND $4::uuid IS NULL
            AND (a.service_id::text = $5 OR (a.service_id IS NULL AND NOT EXISTS (SELECT 1 FROM availability configured WHERE configured.provider_id = a.provider_id AND configured.service_id::text = $5)))
          UNION ALL SELECT worker.weekday, worker.start_time, worker.end_time, worker.timezone FROM team_member_availability worker
            JOIN provider_team_members member ON member.id = worker.team_member_id
            JOIN provider_team_member_locations assigned_location ON assigned_location.team_member_id = member.id
            WHERE member.provider_id::text = $1 AND member.id = $4::uuid AND member.status = 'active'
              AND assigned_location.location_id = (SELECT location_id FROM services WHERE id::text = $5)
        ) SELECT 1 FROM hours WHERE weekday = EXTRACT(DOW FROM $2::timestamptz AT TIME ZONE timezone)
          AND ($2::timestamptz AT TIME ZONE timezone)::time >= start_time AND ($3::timestamptz AT TIME ZONE timezone)::time <= end_time LIMIT 1`,
          [booking.provider_id, booking.starts_at, booking.ends_at, memberId, booking.service_id]);
        const conflict = await client.query(`SELECT 1 FROM bookings existing
          JOIN booking_assignees assigned ON assigned.booking_id = existing.id
          WHERE existing.provider_id::text = $1 AND existing.id::text <> $2 AND existing.status = 'confirmed'
          AND (($3::uuid IS NULL AND assigned.is_owner = true) OR assigned.team_member_id = $3::uuid)
          AND existing.starts_at < $5 AND existing.ends_at > $4 LIMIT 1`,
          [booking.provider_id, bookingId, memberId, booking.starts_at, booking.ends_at]);
        const blocked = await client.query(`SELECT 1 WHERE EXISTS (SELECT 1 FROM provider_time_off WHERE provider_id::text = $1
          AND team_member_id IS NOT DISTINCT FROM $2::uuid AND starts_at < $4 AND ends_at > $3)
          OR ($2::uuid IS NULL AND EXISTS (SELECT 1 FROM provider_calendly_connections connection
            JOIN provider_calendly_events external_event ON external_event.connection_id=connection.id
            WHERE connection.provider_id::text=$1 AND connection.disconnected_at IS NULL
              AND connection.block_conflicting_bookings=true AND external_event.status='active'
              AND external_event.starts_at<$4 AND external_event.ends_at>$3))
          OR ($2::uuid IS NULL AND EXISTS (SELECT 1 FROM provider_calendly_connections connection
            WHERE connection.provider_id::text=$1 AND connection.disconnected_at IS NULL
              AND connection.block_conflicting_bookings=true
              AND (connection.last_sync_succeeded_at IS NULL
                OR connection.last_sync_succeeded_at<now()-interval '20 minutes'
                OR connection.last_sync_error IS NOT NULL))) LIMIT 1`,
          [booking.provider_id, memberId, booking.starts_at, booking.ends_at]);
        if (!working.rowCount || conflict.rowCount || blocked.rowCount) { await client.query("ROLLBACK"); return NextResponse.json({ error: `${assigneeName} is unavailable at this time.` }, { status: 409 }); }
        selected.push({ memberId, name: assigneeName });
      }
      await client.query("DELETE FROM booking_assignees WHERE booking_id::text = $1", [bookingId]);
      for (const professional of selected) await client.query(
        `INSERT INTO booking_assignees (booking_id, team_member_id, is_owner) VALUES ($1::uuid, $2::uuid, $2::uuid IS NULL)`,
        [bookingId, professional.memberId],
      );
      const primaryMemberId = selected.find((professional) => professional.memberId !== null)?.memberId ?? null;
      await client.query("UPDATE bookings SET assigned_team_member_id = $2::uuid WHERE id::text = $1", [bookingId, primaryMemberId]);
      await client.query(`INSERT INTO booking_events (booking_id, actor_user_id, event_type, message)
        VALUES ($1::uuid, $2, 'assigned', $3)`, [bookingId, session.user.id, `Booking assigned to ${selected.map((professional) => professional.name).join(", ")}.`]);
    } else if (action === "completed") {
      if (booking.status === "completed") {
        await client.query("COMMIT");
        return NextResponse.json({ ok: true, duplicate: true });
      }
      if (booking.status !== "confirmed") {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Only accepted bookings can be completed." }, { status: 409 });
      }
      if (booking.starts_at > new Date()) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "This job can be completed after its scheduled start time." }, { status: 409 });
      }
      if (booking.payment_status !== "paid" || booking.payment_flow !== "held_transfer_v1") {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "The customer must complete payment through Stripe before this job can be marked complete." }, { status: 409 });
      }
      await client.query(`UPDATE bookings SET status = 'completed', completed_at = now(),
        payment_release_status = CASE WHEN payout_frozen_at IS NULL THEN 'awaiting_customer' ELSE 'frozen' END,
        completion_confirmation_due_at = now() + interval '48 hours'
        WHERE id::text = $1`, [bookingId]);
      await client.query(`UPDATE booking_reschedule_requests SET status='expired',response_reason='Original appointment completed',
        responded_by=$2,responded_at=now() WHERE booking_id::text=$1 AND status='pending'`, [bookingId, session.user.id]);
      await client.query(`INSERT INTO booking_events (booking_id, actor_user_id, event_type, message)
        VALUES ($1::uuid, $2, 'completed', 'Provider marked the service complete.')`, [bookingId, session.user.id]);
      await client.query(
        `INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
         VALUES ($1, $2::uuid, 'booking_completed', 'Service completed', $3, '/account/bookings/' || $2::uuid::text, 'booking-completed-' || $2::uuid::text || '-customer')
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [booking.customer_id, bookingId, `${booking.service_title} was marked complete. Confirm the work or report a problem within 48 hours; otherwise the provider payout releases automatically.`],
      );
    } else if (action === "declined" || action === "cancel") {
      const allowedStatus = action === "declined" ? "requested" : "confirmed";
      if (booking.status !== allowedStatus) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: action === "declined" ? "Only new requests can be declined." : "Only confirmed bookings can be cancelled." }, { status: 409 });
      }
      await client.query(
        `UPDATE bookings SET status = 'cancelled', cancelled_by = 'provider', cancellation_reason = $2,
          reschedule_requested_by = NULL, reschedule_starts_at = NULL, reschedule_ends_at = NULL,
          reschedule_reason = NULL, reschedule_requested_at = NULL WHERE id::text = $1`,
        [bookingId, reason],
      );
      await client.query(`UPDATE booking_reschedule_requests SET status='withdrawn',response_reason='Booking cancelled',
        responded_by=$2,responded_at=now() WHERE booking_id::text=$1 AND status='pending'`, [bookingId, session.user.id]);
      await client.query(`INSERT INTO booking_events (booking_id, actor_user_id, event_type, message)
        VALUES ($1::uuid, $2, 'cancelled', $3)`, [bookingId, session.user.id, `Provider ${action === "declined" ? "declined" : "cancelled"} the booking: ${reason}`]);
      await client.query(
        `INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
         VALUES ($1, $2::uuid, 'booking_declined', $3, $4, '/account/bookings/' || $2::uuid::text, $5)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          booking.customer_id,
          bookingId,
          action === "declined" ? "Booking request declined" : "Booking cancelled by provider",
          `${booking.service_title}: ${reason}`,
          `${action === "declined" ? "booking-declined" : "booking-cancelled"}-${bookingId}-customer`,
        ],
      );
    } else {
      if (booking.status !== "requested") {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Only new requests can be accepted." }, { status: 409 });
      }
      if (booking.quote_status === "pending") { await client.query("ROLLBACK"); return NextResponse.json({ error: "The customer must approve or decline the new quote before you confirm this booking." }, { status: 409 }); }
      if (booking.quote_status === "declined") { await client.query("ROLLBACK"); return NextResponse.json({ error: "The customer declined the quote. Send a revised quote or decline the booking request." }, { status: 409 }); }
      if (booking.pricing_type_snapshot === "QUOTE_ONLY" && booking.quote_status !== "accepted") { await client.query("ROLLBACK"); return NextResponse.json({ error: "Send a custom quote and wait for the customer to accept it before confirming this request." }, { status: 409 }); }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [booking.provider_id]);
      const unavailable = await unavailableBookingProfessionals(client, { bookingId, providerId: booking.provider_id,
        serviceId: booking.service_id, startsAt: booking.starts_at, endsAt: booking.ends_at });
      if (unavailable.length) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: `${unavailable.join(", ")} ${unavailable.length === 1 ? "is" : "are"} no longer available at this time.` }, { status: 409 });
      }
      await client.query("UPDATE bookings SET status = 'confirmed' WHERE id::text = $1", [bookingId]);
      if (booking.recurring_series_id) await client.query("UPDATE recurring_booking_series SET status='active' WHERE id::text=$1 AND status='pending'", [booking.recurring_series_id]);
      await client.query(`INSERT INTO booking_events (booking_id, actor_user_id, event_type, message)
        VALUES ($1::uuid, $2, 'confirmed', 'Provider accepted the booking request.')`, [bookingId, session.user.id]);
      await client.query(
        `INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
         VALUES ($1, $2::uuid, 'booking_accepted', 'Booking confirmed', $3, '/account/bookings/' || $2::uuid::text, 'booking-accepted-' || $2::uuid::text || '-customer')
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [booking.customer_id, bookingId, `Your ${booking.service_title} booking was accepted. Open the booking to pay through Stripe before your appointment.`],
      );
      await client.query(
        `WITH cancelled AS (
           UPDATE bookings SET status = 'cancelled', cancelled_by = 'system',
             cancellation_reason = 'The provider accepted another booking for this time.'
           WHERE provider_id::text = $1 AND id::text <> $2 AND status = 'requested'
             AND starts_at < $4 AND ends_at > $3
             AND EXISTS (
               SELECT 1 FROM booking_assignees requested_assignment
               JOIN booking_assignees accepted_assignment ON accepted_assignment.booking_id::text = $2
                 AND ((requested_assignment.is_owner = true AND accepted_assignment.is_owner = true)
                   OR (requested_assignment.team_member_id IS NOT NULL AND requested_assignment.team_member_id = accepted_assignment.team_member_id))
               WHERE requested_assignment.booking_id = bookings.id
             )
           RETURNING id, customer_id, service_id
         ), events AS (
           INSERT INTO booking_events (booking_id, event_type, message)
           SELECT id, 'cancelled', 'Requested time became unavailable after another booking was confirmed.' FROM cancelled
           RETURNING booking_id
         )
         INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
         SELECT cancelled.customer_id, cancelled.id, 'booking_declined', 'Requested time unavailable',
                'Another booking was accepted for the time you requested for ' || s.title || '. Please choose another time.',
                '/account', 'booking-conflict-' || cancelled.id::text || '-customer'
         FROM cancelled JOIN services s ON s.id = cancelled.service_id JOIN events ON events.booking_id = cancelled.id
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [booking.provider_id, bookingId, booking.starts_at, booking.ends_at],
      );
    }
    await client.query("COMMIT");
    const automaticRefund = action === "cancel" ? await refundUnreleasedBooking(bookingId, "Provider cancelled before payout release.") : null;
    await recordActivity({ userId: session.user.id, action, targetType: "booking", targetId: bookingId });
    if (action === "cancel" || action === "declined") await recordAnalytics({ eventName: "booking_cancelled", userId: session.user.id, targetType: "booking", targetId: bookingId, metadata: { cancelledBy: "provider" } });
    if (action === "accepted") await recordAnalytics({ eventName: "booking_confirmed", userId: session.user.id, targetType: "booking", targetId: bookingId });
    if (action === "completed") {
      await recordAnalytics({ eventName: "booking_completed", userId: session.user.id, targetType: "booking", targetId: bookingId });
      const completedCount = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM bookings WHERE provider_id::text = $1 AND status = 'completed'", [booking.provider_id]);
      if (completedCount.rows[0]?.count === 1) await recordAnalytics({ eventName: "first_booking_completed", userId: session.user.id, targetType: "booking", targetId: bookingId });
    }
    if (action !== "assign" && action !== "send_quote") await sendBookingUpdateEmails(bookingId, action === "accepted" ? "accepted" : action === "completed" ? "completed" : action === "declined" ? "declined" : "cancelled");
    return NextResponse.json({ ok: true, refundWarning: automaticRefund && !automaticRefund.ok ? automaticRefund.error : undefined });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Provider booking update failed", error);
    return NextResponse.json({ error: "We could not update this booking. Please try again." }, { status: 500 });
  } finally {
    client.release();
  }
}
