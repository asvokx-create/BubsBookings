import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { database } from "@/lib/database";
import { checkAndRecordContent } from "@/lib/content-safety";
import { sendBookingUpdateEmails } from "@/lib/booking-email";
import { enforceRateLimit, recordActivity } from "@/lib/request-security";
import { getStripeMode } from "@/lib/stripe";
import { recordAnalytics } from "@/lib/analytics";
import { refundUnreleasedBooking } from "@/lib/payment-release";
import { unavailableBookingProfessionals } from "@/lib/booking-staff";
import { CUSTOMER_SERVICE_FEE_CENTS } from "@/lib/booking-fees";
import { calculateBookingFinancialSnapshot, estimateProviderProcessingFeeCents, type BookingFinancialPlan } from "@/lib/booking-financials";
import { reconcileExpiredComplimentaryProGrants } from "@/lib/complimentary-pro";
import { expireRescheduleRequests } from "@/lib/booking-rescheduling";

export async function GET(_request: Request, context: RouteContext<"/api/bookings/[bookingId]">) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { bookingId } = await context.params;
  const result = await database.query<{
    hourly_project_id: string | null; id: string; customer_id: string; customer_name: string; provider_id: string; provider_user_id: string; provider_name: string; owner_name: string;
    service_id: string; service_slug: string; service_title: string; service_location_id: string | null; category: string; starts_at: Date; ends_at: Date;
    service_address: string; service_city: string | null; service_state: string | null; service_postal_code: string | null;
    access_instructions: string; notes: string; booking_answers: Record<string, string>; price_cents: number; status: string; was_confirmed: boolean; cancelled_by: string | null;
    cancellation_reason: string | null; late_cancellation: boolean; cancellation_window_hours: number;
    cancellation_policy: string; completed_at: Date | null; conversation_id: string | null;
    review_id: string | null; rating: number | null; review_body: string | null; reschedule_requested_by: string | null;
    reschedule_starts_at: Date | null; reschedule_ends_at: Date | null; reschedule_reason: string | null; reschedule_requested_at: Date | null;
    assigned_team_member_id: string | null; assignee_name: string; quote_status: string;
    quoted_price_cents: number | null; quote_message: string; quote_sent_at: Date | null; quote_responded_at: Date | null;
    quoted_pricing_type: "FIXED" | "HOURLY" | null; quoted_hourly_rate_cents: number | null; quoted_duration_minutes: number | null;
    payment_status: "unpaid" | "pending" | "paid" | "refunded" | "failed"; paid_at: Date | null;
    stripe_mode: "test" | "live" | null; payment_flow: string | null;
    refund_status: "none" | "requested" | "processing" | "refunded" | "rejected" | "failed";
    refund_reason: string | null; refund_amount_cents: number | null; refunded_amount_cents: number;
    refund_failure_reason: string | null; payment_release_status: string; platform_fee_cents: number; provider_fee_basis_points: number | null; provider_fee_cap_cents: number | null;
    customer_service_fee_cents: number; customer_service_fee_refunded_cents: number;
    provider_payout_cents: number; provider_processing_fee_cents: number; stripe_processing_fee_cents: number | null; stripe_transfer_reversed_cents: number; processing_fee_status: "not_applicable" | "pending" | "final" | "unavailable"; completion_confirmation_due_at: Date | null; customer_confirmed_at: Date | null;
    payout_released_at: Date | null; payout_failure_reason: string | null; payout_freeze_reason: string | null; delivery_method: "IN_PERSON" | "REMOTE";
    base_price_cents: number; add_on_total_cents: number; discount_cents: number; package_snapshot: Record<string, unknown> | null; add_on_snapshot: unknown[]; coupon_code_snapshot: string | null; recurring_series_id: string | null; recurrence_index: number | null; recurrence_frequency: string | null; recurrence_status: string | null; booking_kind: string;
    pricing_type_snapshot: "FIXED" | "HOURLY" | "QUOTE_ONLY"; hourly_rate_cents_snapshot: number | null; billable_duration_minutes: number; billing_increment_minutes_snapshot: number | null; minimum_duration_minutes_snapshot: number | null; maximum_duration_minutes_snapshot: number | null; actual_duration_minutes: number | null;
  }>(
    `SELECT (SELECT project.id::text FROM hourly_projects project WHERE project.payment_booking_id=b.id) AS hourly_project_id, b.id::text, b.customer_id, customer.name AS customer_name, b.provider_id::text, p.user_id AS provider_user_id,
            s.business_name AS provider_name, b.service_id::text, s.slug AS service_slug, s.title AS service_title, s.location_id::text AS service_location_id,
            s.category, b.starts_at, b.ends_at, b.service_address, b.service_city, b.service_state, b.service_postal_code, b.delivery_method,
            b.access_instructions, b.notes, b.booking_answers, b.price_cents, b.status,
            EXISTS (SELECT 1 FROM booking_events confirmed_event WHERE confirmed_event.booking_id = b.id AND confirmed_event.event_type IN ('confirmed', 'reschedule_approved')) AS was_confirmed,
            b.cancelled_by, b.cancellation_reason, b.late_cancellation, p.cancellation_window_hours,
            p.cancellation_policy, b.completed_at, b.reschedule_requested_by,
            b.reschedule_starts_at, b.reschedule_ends_at, b.reschedule_reason, b.reschedule_requested_at,
            b.quote_status, b.quoted_price_cents, b.quote_message, b.quote_sent_at, b.quote_responded_at,
            b.quoted_pricing_type,b.quoted_hourly_rate_cents,b.quoted_duration_minutes,
            b.payment_status, b.paid_at, b.stripe_mode, b.payment_flow, b.refund_status, b.refund_reason,
            b.refund_amount_cents, b.refunded_amount_cents, b.refund_failure_reason,
            b.payment_release_status, b.platform_fee_cents, b.provider_fee_basis_points, b.provider_fee_cap_cents, b.provider_payout_cents,
            b.provider_processing_fee_cents, b.stripe_processing_fee_cents, b.stripe_transfer_reversed_cents, b.processing_fee_status,
            b.customer_service_fee_cents, b.customer_service_fee_refunded_cents,
            b.completion_confirmation_due_at, b.customer_confirmed_at, b.payout_released_at,
            b.payout_failure_reason, b.payout_freeze_reason,
            b.base_price_cents,b.add_on_total_cents,b.discount_cents,b.package_snapshot,b.add_on_snapshot,b.coupon_code_snapshot,b.recurring_series_id::text,b.recurrence_index,b.booking_kind,
            b.pricing_type_snapshot,b.hourly_rate_cents_snapshot,b.billable_duration_minutes,b.billing_increment_minutes_snapshot,b.minimum_duration_minutes_snapshot,b.maximum_duration_minutes_snapshot,b.actual_duration_minutes,
            series.frequency AS recurrence_frequency,series.status AS recurrence_status,
            b.assigned_team_member_id::text, owner.name AS owner_name, COALESCE(member.name, owner.name) AS assignee_name,
            c.id::text AS conversation_id, r.id::text AS review_id, r.rating, r.body AS review_body
     FROM bookings b JOIN "user" customer ON customer.id = b.customer_id
     JOIN provider_profiles p ON p.id = b.provider_id JOIN "user" owner ON owner.id = p.user_id
     JOIN services s ON s.id = b.service_id
     LEFT JOIN provider_team_members member ON member.id = b.assigned_team_member_id
     LEFT JOIN conversations c ON c.customer_id = b.customer_id AND c.provider_id = b.provider_id AND c.service_id = b.service_id
     LEFT JOIN reviews r ON r.booking_id = b.id AND r.is_hidden = false
     LEFT JOIN recurring_booking_series series ON series.id=b.recurring_series_id
     WHERE b.id::text = $1 AND (b.customer_id = $2 OR (p.user_id = $2 AND b.provider_deleted_at IS NULL)
       OR EXISTS (
         SELECT 1 FROM booking_assignees worker_assignment JOIN provider_team_members worker ON worker.id = worker_assignment.team_member_id
         WHERE worker_assignment.booking_id = b.id AND worker.status = 'active'
           AND (worker.user_id = $2 OR (worker.user_id IS NULL AND lower(worker.email) = lower($3)))
       )) LIMIT 1`,
    [bookingId, session.user.id, session.user.email],
  );
  const row = result.rows[0];
  if (!row) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  await expireRescheduleRequests(bookingId);
  const assignments = await database.query<{ member_id: string | null; name: string }>(
    `SELECT assigned.team_member_id::text AS member_id,
            CASE WHEN assigned.is_owner THEN $2 ELSE member.name END AS name
     FROM booking_assignees assigned
     LEFT JOIN provider_team_members member ON member.id = assigned.team_member_id
     WHERE assigned.booking_id::text = $1
     ORDER BY assigned.is_owner DESC, member.name`,
    [bookingId, row.owner_name],
  );
  const assignedProfessionals = assignments.rows.length
    ? assignments.rows.map((assignment) => ({ memberId: assignment.member_id, name: assignment.name }))
    : [{ memberId: row.assigned_team_member_id, name: row.assignee_name }];
  const history = await database.query<{ id: string; event_type: string; message: string; created_at: Date }>(
    `SELECT id::text, event_type, message, created_at FROM booking_events WHERE booking_id::text = $1 ORDER BY created_at DESC`, [bookingId],
  );
  const pendingChange = await database.query<{ id: string; requested_by: string; original_duration_minutes: number; requested_duration_minutes: number; original_service_subtotal_cents: number; requested_service_subtotal_cents: number; reason: string; created_at: Date }>(
    `SELECT id::text,requested_by,original_duration_minutes,requested_duration_minutes,original_service_subtotal_cents,
            requested_service_subtotal_cents,reason,created_at FROM booking_change_requests
     WHERE booking_id::text=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1`, [bookingId],
  );
  const reschedules = await database.query<{
    id: string; requested_by: string; requester_role: "customer" | "provider"; original_starts_at: Date; original_ends_at: Date;
    proposed_starts_at: Date; proposed_ends_at: Date; reason: string; status: "pending" | "approved" | "declined" | "withdrawn" | "expired" | "time_unavailable";
    response_reason: string; responded_by: string | null; responded_at: Date | null; expires_at: Date; created_at: Date;
  }>(`SELECT id::text,requested_by,requester_role,original_starts_at,original_ends_at,proposed_starts_at,proposed_ends_at,
      reason,status,response_reason,responded_by,responded_at,expires_at,created_at
      FROM booking_reschedule_requests WHERE booking_id::text=$1 ORDER BY created_at DESC`, [bookingId]);
  const pendingReschedule = reschedules.rows.find((request) => request.status === "pending") ?? null;
  const viewerRole = row.customer_id === session.user.id ? "customer" : row.provider_user_id === session.user.id ? "provider" : "worker";
  const financialSnapshotVisible = viewerRole === "provider" && (row.stripe_mode === null || row.stripe_mode === getStripeMode());
  const estimatedProcessing = estimateProviderProcessingFeeCents({
    serviceSubtotalCents: row.price_cents,
    customerTotalCents: row.price_cents + CUSTOMER_SERVICE_FEE_CENTS,
  });
  const tipResult = await database.query<{
    id: string; amount_cents: number; tip_type: "percentage" | "custom"; percentage: number | null;
    payment_status: "pending" | "paid" | "failed" | "cancelled" | "refunded" | "partially_refunded" | "disputed";
    transfer_status: "not_ready" | "pending" | "paid_out" | "partially_reversed" | "reversed" | "failed";
    refunded_amount_cents: number; risk_status: "clear" | "review"; failure_reason: string | null;
  }>("SELECT id::text,amount_cents,tip_type,percentage,payment_status,transfer_status,refunded_amount_cents,risk_status,failure_reason FROM booking_tips WHERE booking_id::text=$1", [bookingId]);
  const tip = tipResult.rows[0] ?? null;
  // Tips are a customer-to-provider financial record. Assigned workers retain
  // their normal booking access but do not receive tip amount or status data.
  const visibleTip = viewerRole === "worker" ? null : tip;
  const approximateLocation = [row.service_city, row.service_state].filter(Boolean).join(", ") + (row.service_postal_code ? ` ${row.service_postal_code}` : "");
  const canSeeExactAddress = viewerRole === "customer" || ["confirmed", "completed"].includes(row.status) || row.was_confirmed;
  const team = viewerRole !== "provider" ? [] : (await database.query<{ id: string; name: string }>(
    `SELECT member.id::text, member.name FROM provider_team_members member
     WHERE member.provider_id::text = $1 AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM provider_team_member_locations assigned_location WHERE assigned_location.team_member_id = member.id AND assigned_location.location_id::text = $2)) AND member.status = 'active' ORDER BY member.name`, [row.provider_id, row.service_location_id])).rows;
  return NextResponse.json({ booking: {
    id: row.id, hourlyProjectId: row.hourly_project_id, viewerRole, customerName: row.customer_name,
    providerId: row.provider_id, providerName: row.provider_name, serviceId: row.service_id, serviceSlug: row.service_slug,
    serviceTitle: row.service_title, category: row.category, startsAt: row.starts_at, endsAt: row.ends_at,
    deliveryMethod: row.delivery_method,
    location: row.delivery_method === "REMOTE" ? "Remote service" : canSeeExactAddress ? row.service_address : approximateLocation.trim() || "Address available after acceptance",
    addressIsApproximate: row.delivery_method !== "REMOTE" && !canSeeExactAddress,
    accessInstructions: row.delivery_method !== "REMOTE" && canSeeExactAddress ? row.access_instructions : "",
    notes: row.notes, bookingAnswers: row.booking_answers ?? {}, price: row.price_cents / 100,
    pricing: { type: row.pricing_type_snapshot, hourlyRate: row.hourly_rate_cents_snapshot === null ? null : row.hourly_rate_cents_snapshot / 100, billableDurationMinutes: row.billable_duration_minutes, billingIncrementMinutes: row.billing_increment_minutes_snapshot, minimumDurationMinutes: row.minimum_duration_minutes_snapshot, maximumDurationMinutes: row.maximum_duration_minutes_snapshot, actualDurationMinutes: row.actual_duration_minutes },
    commerce: { basePrice: row.base_price_cents/100, addOnTotal: row.add_on_total_cents/100, discount: row.discount_cents/100, package: row.package_snapshot, addOns: row.add_on_snapshot ?? [], couponCode: row.coupon_code_snapshot, bookingKind: row.booking_kind },
    recurrence: row.recurring_series_id ? { seriesId: row.recurring_series_id, index: row.recurrence_index, frequency: row.recurrence_frequency, status: row.recurrence_status } : null,
    customerServiceFee: (["paid", "refunded"] as string[]).includes(row.payment_status)
      ? row.customer_service_fee_cents / 100
      : CUSTOMER_SERVICE_FEE_CENTS / 100,
    customerServiceFeeRefunded: row.customer_service_fee_refunded_cents / 100,
    tip: visibleTip ? { id: visibleTip.id, amount: visibleTip.amount_cents / 100, type: visibleTip.tip_type, percentage: visibleTip.percentage,
      status: visibleTip.payment_status, transferStatus: visibleTip.transfer_status, refundedAmount: visibleTip.refunded_amount_cents / 100,
      riskStatus: visibleTip.risk_status, failureReason: visibleTip.failure_reason }
      : { id: null, amount: 0, type: null, percentage: null, status: "none", transferStatus: "not_ready", refundedAmount: 0, riskStatus: "clear", failureReason: null },
    tipEligible: viewerRole === "customer" && row.status === "completed" && row.payment_status === "paid"
      && row.payment_flow === "held_transfer_v1" && row.stripe_mode === getStripeMode()
      && (!visibleTip || ["failed", "cancelled"].includes(visibleTip.payment_status)),
    status: row.status,
    cancelledBy: row.cancelled_by, cancellationReason: row.cancellation_reason, completedAt: row.completed_at,
    lateCancellation: row.late_cancellation, cancellationWindowHours: row.cancellation_window_hours,
    cancellationPolicy: row.cancellation_policy,
    paymentStatus: viewerRole !== "worker" && row.stripe_mode === getStripeMode() ? row.payment_status : "unpaid",
    paidAt: viewerRole !== "worker" && row.stripe_mode === getStripeMode() ? row.paid_at : null,
    paymentRelease: viewerRole !== "worker" && (row.stripe_mode === getStripeMode() || financialSnapshotVisible) ? {
      status: row.payment_release_status,
      platformFee: row.platform_fee_cents / 100,
      platformFeeBasisPoints: row.provider_fee_basis_points ?? 0,
      platformFeeCap: row.provider_fee_cap_cents === null ? null : row.provider_fee_cap_cents / 100,
      providerProcessingFee: row.provider_processing_fee_cents / 100,
      transferReversed: row.stripe_transfer_reversed_cents / 100,
      processingFeeStatus: row.processing_fee_status,
      providerPayout: row.provider_payout_cents / 100,
      estimatedProviderProcessingFee: estimatedProcessing.estimatedProviderProcessingFeeCents / 100,
      estimatedProviderPayout: Math.max(0, row.price_cents - row.platform_fee_cents - estimatedProcessing.estimatedProviderProcessingFeeCents) / 100,
      processingEstimateBasisPoints: estimatedProcessing.estimateBasisPoints,
      processingEstimateFixedFee: estimatedProcessing.estimateFixedCents / 100,
      confirmationDueAt: row.completion_confirmation_due_at,
      customerConfirmedAt: row.customer_confirmed_at,
      releasedAt: row.payout_released_at,
      failureReason: row.payout_failure_reason,
      freezeReason: row.payout_freeze_reason,
    } : { status: "not_applicable", platformFee: 0, platformFeeBasisPoints: 0, platformFeeCap: null, providerProcessingFee: 0, transferReversed: 0, processingFeeStatus: "not_applicable", providerPayout: 0, estimatedProviderProcessingFee: 0, estimatedProviderPayout: 0, processingEstimateBasisPoints: 0, processingEstimateFixedFee: 0, confirmationDueAt: null,
      customerConfirmedAt: null, releasedAt: null, failureReason: null, freezeReason: null },
    refund: { status: viewerRole !== "worker" && row.stripe_mode === getStripeMode() ? row.refund_status : "none",
      reason: row.refund_reason, requestedAmount: row.refund_amount_cents === null ? null : row.refund_amount_cents / 100,
      refundedAmount: row.refunded_amount_cents / 100, failureReason: row.refund_failure_reason },
    conversationId: row.conversation_id,
    assignedTeamMemberId: row.assigned_team_member_id,
    ownerName: row.owner_name,
    assigneeName: assignedProfessionals.map((professional) => professional.name).join(", "),
    assignedProfessionals,
    quote: { status: row.quote_status, price: row.quoted_price_cents === null ? null : row.quoted_price_cents / 100,
      message: row.quote_message, sentAt: row.quote_sent_at, respondedAt: row.quote_responded_at,
      pricingType: row.quoted_pricing_type, hourlyRate: row.quoted_hourly_rate_cents === null ? null : row.quoted_hourly_rate_cents / 100,
      durationMinutes: row.quoted_duration_minutes },
    teamMembers: team,
    reschedule: pendingReschedule ? { id: pendingReschedule.id, requestedByViewer: pendingReschedule.requested_by === session.user.id,
      requesterRole: pendingReschedule.requester_role, originalStartsAt: pendingReschedule.original_starts_at,
      originalEndsAt: pendingReschedule.original_ends_at, startsAt: pendingReschedule.proposed_starts_at,
      endsAt: pendingReschedule.proposed_ends_at, reason: pendingReschedule.reason,
      requestedAt: pendingReschedule.created_at, expiresAt: pendingReschedule.expires_at } : null,
    rescheduleHistory: reschedules.rows.map((request) => ({ id: request.id, requesterRole: request.requester_role,
      requestedByViewer: request.requested_by === session.user.id, originalStartsAt: request.original_starts_at,
      originalEndsAt: request.original_ends_at, proposedStartsAt: request.proposed_starts_at,
      proposedEndsAt: request.proposed_ends_at, reason: request.reason, status: request.status,
      responseReason: request.response_reason, respondedAt: request.responded_at, expiresAt: request.expires_at, createdAt: request.created_at })),
    history: history.rows.map((event) => ({ id: event.id, type: event.event_type, message: event.message, createdAt: event.created_at })),
    pendingDurationChange: pendingChange.rows[0] ? { id: pendingChange.rows[0].id,
      requestedByViewer: pendingChange.rows[0].requested_by === session.user.id,
      originalDurationMinutes: pendingChange.rows[0].original_duration_minutes,
      requestedDurationMinutes: pendingChange.rows[0].requested_duration_minutes,
      originalSubtotal: pendingChange.rows[0].original_service_subtotal_cents / 100,
      requestedSubtotal: pendingChange.rows[0].requested_service_subtotal_cents / 100,
      reason: pendingChange.rows[0].reason, createdAt: pendingChange.rows[0].created_at } : null,
    review: row.review_id ? { id: row.review_id, rating: row.rating, body: row.review_body ?? "" } : null,
  } });
}

export async function PATCH(request: Request, context: RouteContext<"/api/bookings/[bookingId]">) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  await reconcileExpiredComplimentaryProGrants();
  if (!await enforceRateLimit({ request, userId: session.user.id, bucket: "customer-booking-update", limit: 12 }))
    return NextResponse.json({ error: "Too many booking changes. Please wait a minute and try again." }, { status: 429 });
  const { bookingId } = await context.params;
  const body = (await request.json()) as { action?: unknown; reason?: unknown };
  const action = body.action;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!["cancel", "accept_quote", "decline_quote"].includes(String(action))) return NextResponse.json({ error: "Choose a valid booking action." }, { status: 400 });
  if (action === "cancel" && (reason.length < 3 || reason.length > 500)) return NextResponse.json({ error: "Add a brief reason." }, { status: 400 });
  if (reason) { const safety = await checkAndRecordContent({ userId: session.user.id, surface: "booking_cancellation", fields: [reason] }); if (!safety.allowed) return NextResponse.json({ error: safety.message }, { status: 422 }); }

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ provider_id: string; provider_user_id: string; service_id: string; service_title: string; status: string; duration_minutes: number; billable_duration_minutes: number; assigned_team_member_id: string | null; starts_at: Date; cancellation_window_hours: number; quote_status: string; quoted_price_cents: number | null; quoted_pricing_type: "FIXED" | "HOURLY" | null; quoted_hourly_rate_cents: number | null; quoted_duration_minutes: number | null; provider_plan: BookingFinancialPlan; add_on_total_cents: number; discount_cents: number }>(
      `SELECT b.provider_id::text, p.user_id AS provider_user_id, b.service_id::text, s.title AS service_title, b.status,
              round(EXTRACT(EPOCH FROM (b.ends_at-b.starts_at))/60)::integer AS duration_minutes,b.billable_duration_minutes,
              b.starts_at, p.cancellation_window_hours, p.plan AS provider_plan, b.quote_status, b.quoted_price_cents,
              b.quoted_pricing_type,b.quoted_hourly_rate_cents,b.quoted_duration_minutes,b.add_on_total_cents,b.discount_cents,
              b.assigned_team_member_id::text
       FROM bookings b JOIN provider_profiles p ON p.id = b.provider_id JOIN services s ON s.id = b.service_id
       WHERE b.id::text = $1 AND b.customer_id = $2 FOR UPDATE OF b`, [bookingId, session.user.id],
    );
    const booking = result.rows[0];
    if (!booking || !["requested", "confirmed"].includes(booking.status)) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "This booking can no longer be changed." }, { status: 409 });
    }
    let shouldAutoRefund = false;
    if (action === "accept_quote" || action === "decline_quote") {
      if (booking.status !== "requested" || booking.quote_status !== "pending" || booking.quoted_price_cents === null) { await client.query("ROLLBACK"); return NextResponse.json({ error: "This quote is no longer awaiting your response." }, { status: 409 }); }
      const accepted = action === "accept_quote";
      const snapshot = accepted ? calculateBookingFinancialSnapshot(booking.quoted_price_cents, booking.provider_plan) : null;
      const quotedDuration = accepted && booking.quoted_pricing_type === "HOURLY" ? booking.quoted_duration_minutes : null;
      const addOnMinutes = Math.max(0, booking.duration_minutes - booking.billable_duration_minutes);
      const quotedEnd = quotedDuration ? new Date(booking.starts_at.getTime() + (quotedDuration + addOnMinutes) * 60_000) : null;
      if (accepted && quotedEnd) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [booking.provider_id]);
        const unavailable = await unavailableBookingProfessionals(client, { bookingId, providerId: booking.provider_id,
          serviceId: booking.service_id, startsAt: booking.starts_at, endsAt: quotedEnd });
        if (unavailable.length) { await client.query("ROLLBACK"); return NextResponse.json({ error: "The quoted duration no longer fits the provider's availability. Ask for a revised quote." }, { status: 409 }); }
      }
      await client.query(`UPDATE bookings SET quote_status = $2, quote_responded_at = now(),
        price_cents = CASE WHEN $2 = 'accepted' THEN quoted_price_cents ELSE price_cents END,
        base_price_cents = CASE WHEN $2 = 'accepted' THEN quoted_price_cents-add_on_total_cents+discount_cents ELSE base_price_cents END,
        pricing_type_snapshot = CASE WHEN $2 = 'accepted' THEN COALESCE(quoted_pricing_type,pricing_type_snapshot) ELSE pricing_type_snapshot END,
        hourly_rate_cents_snapshot = CASE WHEN $2 = 'accepted' AND quoted_pricing_type='HOURLY' THEN quoted_hourly_rate_cents ELSE hourly_rate_cents_snapshot END,
        billable_duration_minutes = CASE WHEN $2 = 'accepted' AND quoted_duration_minutes IS NOT NULL THEN quoted_duration_minutes ELSE billable_duration_minutes END,
        ends_at = CASE WHEN $2 = 'accepted' AND $3::timestamptz IS NOT NULL THEN $3::timestamptz ELSE ends_at END,
        provider_plan_snapshot=CASE WHEN $2='accepted' THEN $4 ELSE provider_plan_snapshot END,
        provider_fee_basis_points=CASE WHEN $2='accepted' THEN $5 ELSE provider_fee_basis_points END,
        provider_fee_cap_cents=CASE WHEN $2='accepted' THEN $6 ELSE provider_fee_cap_cents END,
        platform_fee_cents=CASE WHEN $2='accepted' THEN $7 ELSE platform_fee_cents END,
        provider_payout_cents=CASE WHEN $2='accepted' THEN $8 ELSE provider_payout_cents END,
        customer_service_fee_cents=CASE WHEN $2='accepted' THEN $9 ELSE customer_service_fee_cents END,
        customer_total_cents=CASE WHEN $2='accepted' THEN $10 ELSE customer_total_cents END
        WHERE id::text = $1`, [bookingId, accepted ? "accepted" : "declined", quotedEnd,
          snapshot?.providerPlan ?? booking.provider_plan, snapshot?.providerFeeBasisPoints ?? 0,
          snapshot?.providerFeeCapCents ?? null, snapshot?.providerFeeCents ?? 0, snapshot?.providerNetCents ?? 0,
          snapshot?.customerServiceFeeCents ?? 0, snapshot?.customerTotalCents ?? 0]);
      await client.query(`INSERT INTO booking_events (booking_id, actor_user_id, event_type, message)
        VALUES ($1::uuid, $2, $3, $4)`, [bookingId, session.user.id, accepted ? "quote_accepted" : "quote_declined", accepted ? "Customer approved the provider's quote." : "Customer declined the provider's quote."]);
      await client.query(`INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
        VALUES ($1, $2::uuid, 'booking_quote', $3, $4, '/provider/dashboard/bookings/' || $2::uuid::text,
        $5 || '-' || extract(epoch from now())::bigint)`, [booking.provider_user_id, bookingId, accepted ? "Quote approved" : "Quote declined", `${session.user.name || "The customer"} ${accepted ? "approved" : "declined"} your quote for ${booking.service_title}.`, action]);
    } else if (action === "cancel") {
      const noticeDeadline = booking.starts_at.getTime() - booking.cancellation_window_hours * 60 * 60 * 1000;
      const lateCancellation = booking.status === "confirmed" && booking.cancellation_window_hours > 0 && Date.now() > noticeDeadline;
      shouldAutoRefund = !lateCancellation;
      await client.query(`UPDATE bookings SET status = 'cancelled', cancelled_by = 'customer', cancellation_reason = $2,
        late_cancellation = $3,
        reschedule_requested_by = NULL, reschedule_starts_at = NULL, reschedule_ends_at = NULL, reschedule_reason = NULL,
        reschedule_requested_at = NULL WHERE id::text = $1`, [bookingId, reason, lateCancellation]);
      await client.query(`UPDATE booking_reschedule_requests SET status='withdrawn',response_reason='Booking cancelled',
        responded_by=$2,responded_at=now() WHERE booking_id::text=$1 AND status='pending'`, [bookingId, session.user.id]);
      await client.query(`INSERT INTO booking_events (booking_id, actor_user_id, event_type, message)
        VALUES ($1::uuid, $2, 'cancelled', $3)`, [bookingId, session.user.id, `${lateCancellation ? "Late cancellation" : "Customer cancelled the booking"}: ${reason}`]);
      await client.query(`INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
        VALUES ($1, $2::uuid, 'booking_cancelled', 'Booking cancelled', $3, '/provider/dashboard/bookings/' || $2::uuid::text,
        'booking-cancelled-' || $2::uuid::text || '-provider') ON CONFLICT (dedupe_key) DO NOTHING`,
        [booking.provider_user_id, bookingId, `${session.user.name || "The customer"} cancelled ${booking.service_title}: ${reason}`]);
    }
    await client.query("COMMIT");
    const automaticRefund = shouldAutoRefund ? await refundUnreleasedBooking(bookingId, "Customer cancelled within the provider notice window before payout release.") : null;
    await recordActivity({ userId: session.user.id, action: String(action), targetType: "booking", targetId: bookingId });
    if (action === "cancel") await sendBookingUpdateEmails(bookingId, "cancelled");
    if (action === "cancel") await recordAnalytics({ eventName: "booking_cancelled", userId: session.user.id, targetType: "booking", targetId: bookingId, metadata: { cancelledBy: "customer" } });
    return NextResponse.json({ ok: true, refundWarning: automaticRefund && !automaticRefund.ok ? automaticRefund.error : undefined });
  } catch (error) {
    await client.query("ROLLBACK"); console.error("Customer booking update failed", error);
    return NextResponse.json({ error: "We could not update this booking. Please try again." }, { status: 500 });
  } finally { client.release(); }
}
