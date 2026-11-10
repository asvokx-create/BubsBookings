import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { database } from "@/lib/database";
import { checkAndRecordContent } from "@/lib/content-safety";
import { enforceRateLimit, recordActivity } from "@/lib/request-security";
import { getStripeMode, isStripeReady } from "@/lib/stripe";
import { PLAN_ENTITLEMENTS, type ProviderPlan } from "@/lib/plans";
import { hasAdminAccess } from "@/lib/admin";
import { recordAnalytics } from "@/lib/analytics";
import { BOOKING_REFUND_RECONCILIATION } from "@/lib/booking-refund-operations";
import { BOOKING_PAYOUT_RECONCILIATION } from "@/lib/booking-payout-reconciliation";

import { claimBookingRefundOperation, submitBookingRefundOperation } from "@/lib/booking-refund-finalization";

type RefundAction = "request" | "approve" | "reject";

export async function POST(request: Request, context: { params: Promise<{ bookingId: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Sign in to manage this refund." }, { status: 401 });
  if (!await enforceRateLimit({ request, userId: session.user.id, bucket: "booking-refund", limit: 8 }))
    return NextResponse.json({ error: "Too many refund changes. Please wait and try again." }, { status: 429 });
  const { bookingId } = await context.params;
  const body = await request.json().catch(() => null) as { action?: unknown; reason?: unknown; amount?: unknown } | null;
  const action = body?.action as RefundAction;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!(["request", "approve", "reject"] as RefundAction[]).includes(action)) return NextResponse.json({ error: "Choose a valid refund action." }, { status: 400 });
  if ((action === "request" || action === "reject") && (reason.length < 3 || reason.length > 500)) return NextResponse.json({ error: "Add a brief reason." }, { status: 400 });
  if (reason) {
    const safety = await checkAndRecordContent({ userId: session.user.id, surface: "booking_refund", fields: [reason] });
    if (!safety.allowed) return NextResponse.json({ error: safety.message }, { status: 422 });
  }

  const result = await database.query<{
    id: string; customer_id: string; provider_user_id: string; provider_name: string; service_title: string;
    price_cents: number; payment_status: string; refund_status: string; stripe_payment_intent_id: string | null;
    stripe_mode: "test" | "live" | null; plan: ProviderPlan;
    payment_flow: string | null; payment_release_status: string; provider_payout_cents: number;
    platform_fee_cents: number; stripe_transfer_id: string | null; stripe_transfer_reversed_cents: number; refunded_amount_cents: number;
    customer_service_fee_cents: number; customer_service_fee_refunded_cents: number;
    booking_status: string;
  }>(`SELECT b.id::text, b.customer_id, p.user_id AS provider_user_id, s.business_name AS provider_name,
      s.title AS service_title, b.price_cents, b.payment_status, b.refund_status,
      b.stripe_payment_intent_id, b.stripe_mode, p.plan, b.payment_flow, b.payment_release_status,
      b.provider_payout_cents, b.platform_fee_cents, b.stripe_transfer_id, b.stripe_transfer_reversed_cents, b.refunded_amount_cents,
      b.customer_service_fee_cents, b.customer_service_fee_refunded_cents,
      b.status AS booking_status
    FROM bookings b JOIN provider_profiles p ON p.id = b.provider_id JOIN services s ON s.id = b.service_id
    WHERE b.id::text = $1`, [bookingId]);
  const booking = result.rows[0];
  if (!booking) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const isCustomer = booking.customer_id === session.user.id;
  const isProvider = booking.provider_user_id === session.user.id;
  const isAdmin = await hasAdminAccess(session.user.id, session.user.email);

  if (action === "request") {
    if (!isCustomer) return NextResponse.json({ error: "Only the customer can request a refund." }, { status: 403 });
    if (booking.payment_status !== "paid" || booking.stripe_mode !== getStripeMode()) return NextResponse.json({ error: "Only a completed Stripe payment can be refunded." }, { status: 409 });
    if (["requested", "processing", "refunded"].includes(booking.refund_status)) return NextResponse.json({ error: "A refund is already underway for this booking." }, { status: 409 });
    const requested = await database.query(`UPDATE bookings SET refund_status = 'requested', refund_requested_by = $2,
      refund_reason = $3, refund_requested_at = now(), refund_amount_cents = price_cents,
      refund_failure_reason = NULL,
      payout_frozen_at = CASE WHEN payment_flow = 'held_transfer_v1' AND stripe_transfer_id IS NULL AND payout_frozen_at IS NULL AND payout_freeze_reason IS NULL THEN now() ELSE payout_frozen_at END,
      payout_frozen_by = CASE WHEN payment_flow = 'held_transfer_v1' AND stripe_transfer_id IS NULL AND payout_frozen_at IS NULL AND payout_freeze_reason IS NULL THEN $2 ELSE payout_frozen_by END,
      payout_freeze_reason = CASE WHEN payment_flow = 'held_transfer_v1' AND stripe_transfer_id IS NULL AND payout_frozen_at IS NULL AND payout_freeze_reason IS NULL THEN 'Refund requested' ELSE payout_freeze_reason END,
      payment_release_status = CASE WHEN payment_flow = 'held_transfer_v1' AND stripe_transfer_id IS NULL THEN 'frozen' ELSE payment_release_status END
      WHERE id::text = $1 AND payment_status = 'paid' AND stripe_mode = $4
        AND payment_release_status <> 'processing' AND payout_failure_reason IS DISTINCT FROM $5
        AND refund_status NOT IN ('requested', 'processing', 'refunded')
      RETURNING id`, [bookingId, session.user.id, reason, getStripeMode(), BOOKING_PAYOUT_RECONCILIATION]);
    if (!requested.rowCount) return NextResponse.json({ error: "A refund is already underway or this payment is no longer refundable." }, { status: 409 });
    await database.query(`INSERT INTO booking_events (booking_id, actor_user_id, event_type, message)
      VALUES ($1::uuid, $2, 'refund_requested', $3)`, [bookingId, session.user.id, `Customer requested a refund: ${reason}`]);
    await database.query(`INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
      VALUES ($1, $2::uuid, 'refund_requested', 'Refund requested', $3, '/provider/dashboard/bookings/' || $2::uuid::text,
      'refund-request-' || $2::uuid::text || '-' || extract(epoch from now())::bigint)`, [booking.provider_user_id, bookingId, `${session.user.name || "The customer"} requested a refund for ${booking.service_title}.`]);
    await recordActivity({ userId: session.user.id, action: "refund_requested", targetType: "booking", targetId: bookingId });
    await recordAnalytics({ eventName: "refund_requested", userId: session.user.id, targetType: "booking", targetId: bookingId });
    return NextResponse.json({ ok: true });
  }

  if (!isProvider && !isAdmin) return NextResponse.json({ error: "Only the provider or an administrator can decide this refund." }, { status: 403 });
  if (booking.refund_status !== "requested") return NextResponse.json({ error: "This refund is no longer awaiting a decision." }, { status: 409 });
  if (action === "reject") {
    const rejected = await database.query(`UPDATE bookings SET refund_status = 'rejected', refund_failure_reason = $2,
      payout_frozen_at = CASE WHEN payout_freeze_reason = 'Refund requested' THEN NULL ELSE payout_frozen_at END,
      payout_frozen_by = CASE WHEN payout_freeze_reason = 'Refund requested' THEN NULL ELSE payout_frozen_by END,
      payout_freeze_reason = CASE WHEN payout_freeze_reason = 'Refund requested' THEN NULL ELSE payout_freeze_reason END,
      payment_release_status = CASE WHEN payout_freeze_reason = 'Refund requested'
        THEN CASE WHEN status = 'completed' THEN 'awaiting_customer' ELSE 'secured' END
        ELSE payment_release_status END
      WHERE id::text = $1 AND refund_status = 'requested' RETURNING id`, [bookingId, reason]);
    if (!rejected.rowCount) return NextResponse.json({ error: "This refund is no longer awaiting a decision." }, { status: 409 });
    await database.query(`INSERT INTO booking_events (booking_id, actor_user_id, event_type, message) VALUES ($1::uuid, $2, 'refund_rejected', $3)`, [bookingId, session.user.id, `Refund request declined: ${reason}`]);
    await database.query(`INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
      VALUES ($1, $2::uuid, 'refund_rejected', 'Refund update', $3, '/account/bookings/' || $2::uuid::text,
      'refund-rejected-' || $2::uuid::text || '-' || extract(epoch from now())::bigint)`, [booking.customer_id, bookingId, `${booking.provider_name} declined the refund request: ${reason}`]);
    await recordActivity({ userId: session.user.id, action: "refund_rejected", targetType: "booking", targetId: bookingId });
    return NextResponse.json({ ok: true });
  }

  if (!isStripeReady() || !booking.stripe_payment_intent_id || booking.stripe_mode !== getStripeMode()) return NextResponse.json({ error: "This Stripe payment cannot be refunded from the current environment." }, { status: 409 });
  const requestedDollars = Number(body?.amount);
  const amountCents = Number.isFinite(requestedDollars) ? Math.round(requestedDollars * 100) : booking.price_cents;
  const remainingRefundable = booking.price_cents - booking.refunded_amount_cents;
  if (amountCents < 1 || amountCents > remainingRefundable) return NextResponse.json({ error: `Choose an amount from $0.01 to $${(remainingRefundable / 100).toFixed(2)}.` }, { status: 400 });
  if (booking.stripe_transfer_id && amountCents < remainingRefundable
    && (booking.refunded_amount_cents > 0 || booking.stripe_transfer_reversed_cents > 0)) {
    return NextResponse.json({ error: "This transferred payment has earlier refund or recovery activity. Reconcile its remaining provider share before issuing another partial refund.", reconciliationRequired: true }, { status: 409 });
  }
  const claimed = await claimBookingRefundOperation({ bookingId, mode: getStripeMode(), origin: 'provider', actorUserId: session.user.id,
    refundApplicationFee: booking.payment_flow !== 'held_transfer_v1' && PLAN_ENTITLEMENTS[booking.plan].bookingFeePercent > 0 },
    client => client.query(`UPDATE bookings SET refund_status = 'processing', refund_amount_cents = $2, refund_failure_reason = $7
    WHERE id::text = $1 AND refund_status = 'requested'
      AND payment_release_status <> 'processing' AND payout_failure_reason IS DISTINCT FROM $8
      AND refunded_amount_cents = $3 AND customer_service_fee_refunded_cents = $4
      AND provider_payout_cents = $5 AND stripe_transfer_id IS NOT DISTINCT FROM $6::text
      AND stripe_transfer_reversed_cents = $9
    RETURNING id`, [bookingId, amountCents, booking.refunded_amount_cents, booking.customer_service_fee_refunded_cents, booking.provider_payout_cents, booking.stripe_transfer_id, BOOKING_REFUND_RECONCILIATION, BOOKING_PAYOUT_RECONCILIATION, booking.stripe_transfer_reversed_cents]));
  if (!claimed) return NextResponse.json({ error: "This refund is already being processed." }, { status: 409 });

  const refund = await submitBookingRefundOperation(claimed.operation.id);
  if (!refund.ok) return NextResponse.json({ error: refund.error, reconciliationRequired: true }, { status: 202 });
  return NextResponse.json({ ok: true, amount: refund.amount / 100, reversalNeedsReview: refund.recoveryNeedsReview });
}
