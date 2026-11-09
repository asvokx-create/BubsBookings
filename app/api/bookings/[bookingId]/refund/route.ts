import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { database } from "@/lib/database";
import { checkAndRecordContent } from "@/lib/content-safety";
import { enforceRateLimit, recordActivity } from "@/lib/request-security";
import { getStripe, getStripeMode, isStripeReady } from "@/lib/stripe";
import { PLAN_ENTITLEMENTS, type ProviderPlan } from "@/lib/plans";
import { hasAdminAccess } from "@/lib/admin";
import { recordAnalytics } from "@/lib/analytics";
import { syncAffiliateCommissionForBooking } from "@/lib/affiliates";

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
        AND refund_status NOT IN ('requested', 'processing', 'refunded')
      RETURNING id`, [bookingId, session.user.id, reason, getStripeMode()]);
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
  const claimed = await database.query(`UPDATE bookings SET refund_status = 'processing', refund_amount_cents = $2, refund_failure_reason = NULL
    WHERE id::text = $1 AND refund_status = 'requested'
      AND refunded_amount_cents = $3 AND customer_service_fee_refunded_cents = $4
      AND provider_payout_cents = $5 AND stripe_transfer_id IS NOT DISTINCT FROM $6::text
    RETURNING id`, [bookingId, amountCents, booking.refunded_amount_cents, booking.customer_service_fee_refunded_cents, booking.provider_payout_cents, booking.stripe_transfer_id]);
  if (!claimed.rowCount) return NextResponse.json({ error: "This refund is already being processed." }, { status: 409 });

  let stripeRefundCreated = false;
  try {
    const legacyDestinationCharge = booking.payment_flow !== "held_transfer_v1";
    const hasApplicationFee = legacyDestinationCharge && PLAN_ENTITLEMENTS[booking.plan].bookingFeePercent > 0;
    const totalRefunded = booking.refunded_amount_cents + amountCents;
    const fullyRefunded = totalRefunded >= booking.price_cents;
    const serviceFeeRefund = fullyRefunded
      ? Math.max(0, booking.customer_service_fee_cents - booking.customer_service_fee_refunded_cents)
      : 0;
    const stripeRefundAmount = amountCents + serviceFeeRefund;
    const refund = await getStripe().refunds.create({
      payment_intent: booking.stripe_payment_intent_id,
      amount: stripeRefundAmount,
      ...(legacyDestinationCharge ? { reverse_transfer: true } : {}),
      ...(hasApplicationFee ? { refund_application_fee: true } : {}),
      metadata: { bookingId, approvedBy: session.user.id },
    }, { idempotencyKey: `booking-refund-${bookingId}-total-${booking.refunded_amount_cents + booking.customer_service_fee_refunded_cents + stripeRefundAmount}` });
    stripeRefundCreated = true;
    // Accepted/pending refunds are not proof of settlement. Keep the claim so
    // another request cannot issue a second refund while Stripe reconciles it.
    if (refund.status !== "succeeded") {
      await database.query(`UPDATE bookings SET stripe_refund_id = $2,
        refund_failure_reason = 'Stripe refund requires reconciliation. Contact support before retrying.'
        WHERE id::text = $1 AND refund_status = 'processing'`, [bookingId, refund.id]);
      return NextResponse.json({ error: "Stripe has not confirmed this refund as completed. Contact support before retrying.", reconciliationRequired: true }, { status: 202 });
    }
    let reversalFailure = "";
    let reversedCents = booking.stripe_transfer_reversed_cents;
    // This is the recorded provider payout after the final platform-fee cap
    // and Stripe processing-cost allocation, not a recomputed plan fee.
    const originalProviderShare = booking.provider_payout_cents;
    if (!legacyDestinationCharge && booking.stripe_transfer_id) {
      const targetReversal = fullyRefunded
        ? booking.provider_payout_cents
        : Math.max(0, booking.provider_payout_cents - Math.round(originalProviderShare * (booking.price_cents - totalRefunded) / booking.price_cents));
      const reversalAmount = Math.max(0, targetReversal - booking.stripe_transfer_reversed_cents);
      if (reversalAmount > 0) {
        try {
          await getStripe().transfers.createReversal(booking.stripe_transfer_id, {
            amount: reversalAmount,
            metadata: { bookingId, kind: "refund_reversal", stripeRefundId: refund.id },
          }, { idempotencyKey: `booking-reversal-${bookingId}-total-${targetReversal}` });
          reversedCents += reversalAmount;
        } catch (reversalError) {
          console.error("Stripe transfer reversal failed after refund", reversalError);
          reversalFailure = "The customer was refunded, but provider transfer recovery is not confirmed. Admin review is required before retrying recovery.";
        }
      }
    }
    const adjustedHeldPayout = !legacyDestinationCharge && !booking.stripe_transfer_id
      ? Math.max(0, Math.round(originalProviderShare * (booking.price_cents - totalRefunded) / booking.price_cents))
      : booking.provider_payout_cents;
    const settled = await database.query(`UPDATE bookings SET refund_status = 'refunded', stripe_refund_id = $2,
      refunded_amount_cents = GREATEST(refunded_amount_cents, $3),
      customer_service_fee_refunded_cents = GREATEST(customer_service_fee_refunded_cents, $8),
      refunded_at = now(), payment_status = CASE WHEN $4 THEN 'refunded' ELSE payment_status END,
      provider_payout_cents = LEAST(provider_payout_cents, $5), stripe_transfer_reversed_cents = GREATEST(stripe_transfer_reversed_cents, $6),
      payment_release_status = CASE
        WHEN stripe_transfer_id IS NOT NULL AND $7 <> '' THEN payment_release_status
        WHEN $4 THEN 'reversed'
        WHEN (payout_frozen_at IS NOT NULL OR payout_freeze_reason IS NOT NULL)
          AND COALESCE(payout_freeze_reason, '') NOT IN ('Refund requested', 'Stripe refund requires payout reconciliation') THEN 'frozen'
        WHEN stripe_transfer_id IS NOT NULL THEN 'partially_released'
        WHEN status = 'completed' THEN 'awaiting_customer'
        ELSE 'secured' END,
      payout_frozen_at = CASE WHEN payout_freeze_reason IN ('Refund requested', 'Stripe refund requires payout reconciliation') THEN NULL ELSE payout_frozen_at END,
      payout_frozen_by = CASE WHEN payout_freeze_reason IN ('Refund requested', 'Stripe refund requires payout reconciliation') THEN NULL ELSE payout_frozen_by END,
      payout_freeze_reason = CASE WHEN payout_freeze_reason IN ('Refund requested', 'Stripe refund requires payout reconciliation') THEN NULL ELSE payout_freeze_reason END,
      payout_failure_reason = NULLIF($7, '')
      WHERE id::text = $1 AND refunded_amount_cents <= $3
        AND customer_service_fee_refunded_cents <= $8
      RETURNING id`, [bookingId, refund.id, totalRefunded, fullyRefunded, adjustedHeldPayout, reversedCents, reversalFailure, booking.customer_service_fee_refunded_cents + serviceFeeRefund]);
    if (!settled.rowCount) {
      return NextResponse.json({ error: "Stripe completed the refund, but newer refund activity needs reconciliation. Contact support before retrying.", reconciliationRequired: true }, { status: 202 });
    }
    await syncAffiliateCommissionForBooking(bookingId);
    await database.query(`INSERT INTO booking_events (booking_id, actor_user_id, event_type, message, metadata)
      VALUES ($1::uuid, $2, 'refunded', $3, jsonb_build_object('amountCents', $4::integer, 'serviceFeeRefundCents', $5::integer, 'stripeRefundId', $6::text))`, [bookingId, session.user.id, `$${(stripeRefundAmount / 100).toFixed(2)} refund approved through Stripe.`, stripeRefundAmount, serviceFeeRefund, refund.id]);
    await database.query(`INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
      VALUES ($1, $2::uuid, 'refund_approved', 'Refund approved', $3, '/account/bookings/' || $2::uuid::text,
      'refund-approved-' || $2::uuid::text || '-' || extract(epoch from now())::bigint)`, [booking.customer_id, bookingId, `${booking.provider_name} approved a $${(stripeRefundAmount / 100).toFixed(2)} refund. Stripe will return it to the original payment method.`]);
    await recordActivity({ userId: session.user.id, action: "refund_approved", targetType: "booking", targetId: bookingId, metadata: { amountCents: stripeRefundAmount, serviceFeeRefundCents: serviceFeeRefund } });
    await recordAnalytics({ eventName: "refund_completed", userId: session.user.id, targetType: "booking", targetId: bookingId, metadata: { amountCents: stripeRefundAmount, serviceFeeRefundCents: serviceFeeRefund } });
    return NextResponse.json({ ok: true, amount: stripeRefundAmount / 100, reversalNeedsReview: Boolean(reversalFailure) });
  } catch (error) {
    console.error("Stripe refund requires reconciliation", error);
    const approvalRequired = typeof error === "object" && error !== null && "code" in error && error.code === "approval_required";
    // A transport error may hide a successful Stripe operation. A later local
    // failure must never downgrade webhook-confirmed settlement or allow a retry.
    try {
      await database.query(`UPDATE bookings SET refund_failure_reason = $2
        WHERE id::text = $1 AND refund_status = 'processing'`, [bookingId,
        approvalRequired ? "Stripe approval is pending. Do not retry the refund while approval is under review."
          : "Refund outcome requires reconciliation. Contact support before retrying."]);
    } catch (recordError) {
      console.error("Could not record refund reconciliation warning", recordError);
    }
    return NextResponse.json({ error: approvalRequired
      ? "Stripe approval is pending. Do not retry the refund while approval is under review."
      : stripeRefundCreated
      ? "Stripe accepted the refund, but local reconciliation is incomplete. Contact support before retrying."
      : "The refund outcome could not be confirmed. Contact support before retrying.", reconciliationRequired: true }, { status: approvalRequired ? 202 : 502 });
  }
}
