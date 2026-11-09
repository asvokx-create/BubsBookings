import "server-only";

import { database } from "./database";
import { getStripe, getStripeMode, isStripeReady } from "./stripe";
import { stripeOperationKey } from "./booking-financials";
import { syncAffiliateCommissionForBooking } from "./affiliates";
import { reconcileBookingProcessingFee } from "./booking-processing-fees";

export const CUSTOMER_CONFIRMATION_HOURS = 48;

type ReleaseResult =
  | { ok: true; released: boolean; transferId?: string }
  | { ok: false; error: string };

export async function releaseBookingPayout(bookingId: string, trigger: "customer" | "automatic" | "admin"): Promise<ReleaseResult> {
  if (!isStripeReady()) return { ok: false, error: "Stripe is not configured." };

  // Reconcile before taking the payout row lock. The reconciliation writes the
  // same booking row, so doing it inside the transfer transaction would wait on
  // our own lock. A later conditional claim still protects the transfer race.
  const feeTarget = await database.query<{ stripe_charge_id: string | null }>(
    "SELECT stripe_charge_id FROM bookings WHERE id::text = $1 AND stripe_mode = $2",
    [bookingId, getStripeMode()],
  );
  const processingFee = await reconcileBookingProcessingFee(bookingId, feeTarget.rows[0]?.stripe_charge_id);
  if (processingFee.status !== "final") {
    return { ok: false, error: "Stripe is still finalizing this payment. Please try the payout again shortly." };
  }

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    // Dispute creation takes the same lock. Whichever action starts first finishes
    // atomically, so a newly opened dispute cannot slip between the eligibility
    // check and the Stripe transfer.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`booking-payout:${bookingId}`]);
    const claimed = await client.query<{
      id: string; customer_id: string; provider_user_id: string; provider_name: string; service_title: string;
      provider_payout_cents: number; stripe_account_id: string | null; stripe_charge_id: string | null; stripe_payment_intent_id: string | null;
      stripe_dispute_id: string | null; stripe_dispute_status: string | null; stripe_dispute_closed_at: Date | null;
      stripe_mode: "test" | "live" | null; refunded_amount_cents: number; customer_service_fee_refunded_cents: number; customer_total_cents: number;
    }>(`UPDATE bookings b SET payment_release_status = 'processing', payout_failure_reason = NULL
        FROM provider_profiles p, services s
        WHERE b.id::text = $1 AND p.id = b.provider_id AND s.id = b.service_id
          AND b.payment_status = 'paid' AND b.stripe_mode = $2
          AND b.payment_release_status IN ('secured', 'awaiting_customer', 'failed')
          AND p.age_verification_status = 'verified'
          AND p.stripe_connect_mode = $2 AND p.stripe_payouts_enabled = true
          AND b.status = 'completed' AND b.payout_frozen_at IS NULL
          AND b.refund_status NOT IN ('requested', 'processing')
          AND NOT EXISTS (
            SELECT 1 FROM booking_disputes d
            WHERE d.booking_id = b.id AND d.status IN ('open', 'reviewing')
          )
        RETURNING b.id::text, b.customer_id, p.user_id AS provider_user_id,
          s.business_name AS provider_name, s.title AS service_title,
          b.provider_payout_cents, p.stripe_account_id, b.stripe_charge_id, b.stripe_mode, b.stripe_payment_intent_id,
          b.stripe_dispute_id, b.stripe_dispute_status, b.stripe_dispute_closed_at,
          b.refunded_amount_cents,b.customer_service_fee_refunded_cents,b.customer_total_cents`,
      [bookingId, getStripeMode()]);
    const booking = claimed.rows[0];
    if (!booking) {
      const current = await client.query<{ payment_release_status: string; stripe_transfer_id: string | null }>(
        "SELECT payment_release_status, stripe_transfer_id FROM bookings WHERE id::text = $1", [bookingId]);
      await client.query("ROLLBACK");
      if (current.rows[0]?.payment_release_status === "paid_out" || current.rows[0]?.stripe_transfer_id) {
        return { ok: true, released: false, transferId: current.rows[0].stripe_transfer_id ?? undefined };
      }
      return { ok: false, error: "This payout is not ready, is frozen, or has an open refund or dispute." };
    }
    if (!booking.stripe_account_id || !booking.stripe_charge_id || booking.provider_payout_cents < 1) {
      await client.query("UPDATE bookings SET payment_release_status = 'failed', payout_failure_reason = $2 WHERE id::text = $1", [bookingId, "Missing provider payout details."]);
      await client.query("COMMIT");
      return { ok: false, error: "The provider payout details are incomplete." };
    }

    // Stripe dashboard refunds can precede their webhook. Check while holding
    // the payout row lock, and never transfer unreconciled customer funds.
    const charge = await getStripe().charges.retrieve(booking.stripe_charge_id);
    const stripeId = (value: string | { id: string } | null) => typeof value === "string" ? value : value?.id ?? null;
    const chargeMatches = charge.id === booking.stripe_charge_id
      && charge.livemode === (booking.stripe_mode === "live")
      && Boolean(booking.stripe_payment_intent_id) && stripeId(charge.payment_intent) === booking.stripe_payment_intent_id;
    if (!chargeMatches) {
      await client.query(`UPDATE bookings SET payment_release_status='frozen',payout_frozen_at=COALESCE(payout_frozen_at,now()),
        payout_freeze_reason='Stripe charge identity requires reconciliation',payout_failure_reason='Review the linked Stripe charge before releasing this payout.' WHERE id::text=$1`, [bookingId]);
      await client.query("COMMIT");
      return { ok: false, error: "This payment needs Stripe charge reconciliation before payout." };
    }
    // Stripe retains disputed=true after a win. A stored favorable closure alone
    // cannot rule out an escalated inquiry or newer case before its webhook.
    // Disputes Read is required only on this historically disputed payout path.
    let disputeClosedFavorably = Boolean(booking.stripe_dispute_id && booking.stripe_dispute_closed_at
      && (booking.stripe_dispute_status === "won" || booking.stripe_dispute_status === "warning_closed"));
    if (charge.disputed && disputeClosedFavorably) {
      try {
        const disputes = await getStripe().disputes.list({ charge: charge.id, limit: 100 });
        disputeClosedFavorably = !disputes.has_more
          && disputes.data.some(dispute => dispute.id === booking.stripe_dispute_id)
          && disputes.data.every(dispute => stripeId(dispute.charge) === charge.id
            && dispute.livemode === charge.livemode
            && stripeId(dispute.payment_intent) === booking.stripe_payment_intent_id
            && (dispute.status === "won" || dispute.status === "warning_closed"));
      } catch {
        // Includes missing read permission: never silently broaden key access.
        disputeClosedFavorably = false;
      }
    }
    if (charge.disputed && !disputeClosedFavorably) {
      await client.query(`UPDATE bookings SET payment_release_status='frozen',payout_frozen_at=COALESCE(payout_frozen_at,now()),
        payout_freeze_reason='Stripe chargeback under review',payout_failure_reason='Verify all current Stripe disputes are closed favorably. Disputes Read access is required for this check.' WHERE id::text=$1`, [bookingId]);
      await client.query("COMMIT");
      return { ok: false, error: "This payment needs Stripe dispute reconciliation before payout. Current disputes could not be verified as closed favorably." };
    }
    if (charge.currency !== "usd" || charge.amount !== booking.customer_total_cents || charge.amount_refunded > booking.refunded_amount_cents + booking.customer_service_fee_refunded_cents || charge.refunded) {
      await client.query(`UPDATE bookings SET payment_release_status='frozen',payout_frozen_at=COALESCE(payout_frozen_at,now()),
        payout_freeze_reason='Stripe refund requires payout reconciliation',payout_failure_reason='Review the Stripe charge and reconcile the refund before releasing this payout.' WHERE id::text=$1`,[bookingId]);
      await client.query("COMMIT");
      return {ok:false,error:"This payment needs refund reconciliation before payout."};
    }
    let transfer;
    try {
      transfer = await getStripe().transfers.create({
        amount: booking.provider_payout_cents,
        currency: "usd",
        destination: booking.stripe_account_id,
        source_transaction: booking.stripe_charge_id,
        transfer_group: `booking_${booking.id}`,
        metadata: { bookingId: booking.id, kind: "provider_payout", releaseTrigger: trigger },
      }, { idempotencyKey: stripeOperationKey("payout", getStripeMode(), booking.id) });
    } catch (error) {
      console.error("Provider payout release failed", bookingId, error);
      await client.query("UPDATE bookings SET payment_release_status = 'failed', payout_failure_reason = $2 WHERE id::text = $1", [bookingId, "Stripe could not release this payout. An administrator can retry it."]);
      await client.query("COMMIT");
      return { ok: false, error: "Stripe could not release this payout. An administrator can retry it." };
    }

    await client.query(`UPDATE bookings SET payment_release_status = 'paid_out', stripe_transfer_id = $2,
      payout_released_at = now(), payout_failure_reason = NULL WHERE id::text = $1`, [bookingId, transfer.id]);
    await syncAffiliateCommissionForBooking(bookingId, client);
    await client.query(`INSERT INTO booking_events (booking_id, event_type, message, metadata)
      VALUES ($1::uuid, 'payout_released', $2, jsonb_build_object('transferId', $3::text, 'trigger', $4::text))`,
      [bookingId, `Provider payout of $${(booking.provider_payout_cents / 100).toFixed(2)} was released through Stripe.`, transfer.id, trigger]);
    if (trigger === "automatic") {
      await client.query(`INSERT INTO booking_events (booking_id, event_type, message)
        SELECT $1::uuid, 'customer_review_expired', 'The 48-hour customer review window ended without a reported problem.'
        WHERE NOT EXISTS (SELECT 1 FROM booking_events WHERE booking_id = $1::uuid AND event_type = 'customer_review_expired')`, [bookingId]);
      await client.query(`INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
        VALUES ($1, $2::uuid, 'review_window_closed', 'Review window closed', $3,
          '/account/bookings/' || $2::uuid::text, 'review-window-closed-' || $2::uuid::text)
        ON CONFLICT (dedupe_key) DO NOTHING`, [booking.customer_id, bookingId,
        `The 48-hour review window for ${booking.service_title} ended and the provider payout was released.`]);
    }
    await client.query(`INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
      VALUES ($1, $2::uuid, 'payout_released', 'Payout released', $3,
      '/provider/dashboard/bookings/' || $2::uuid::text, 'payout-released-' || $2::uuid::text)
      ON CONFLICT (dedupe_key) DO NOTHING`,
      [booking.provider_user_id, bookingId, `$${(booking.provider_payout_cents / 100).toFixed(2)} for ${booking.service_title} was sent to your Stripe balance.`]);
    await client.query("COMMIT");
    return { ok: true, released: true, transferId: transfer.id };
  } catch (error) {
    console.error("Provider payout release failed", bookingId, error);
    await client.query("ROLLBACK").catch(() => undefined);
    return { ok: false, error: "This payout could not be completed. An administrator can retry it." };
  } finally {
    client.release();
  }
}

export async function releaseDuePayouts(limit = 50) {
  const due = await database.query<{ id: string }>(`SELECT id::text FROM bookings
    WHERE payment_release_status IN ('awaiting_customer', 'failed')
      AND completion_confirmation_due_at IS NOT NULL
      AND completion_confirmation_due_at <= now()
      AND payout_frozen_at IS NULL
    ORDER BY completion_confirmation_due_at ASC LIMIT $1`, [limit]);
  let released = 0;
  const failed: string[] = [];
  for (const booking of due.rows) {
    const result = await releaseBookingPayout(booking.id, "automatic");
    if (result.ok && result.released) released += 1;
    else if (!result.ok) failed.push(booking.id);
  }
  await database.query("INSERT INTO operations_checks (check_type, status, details) VALUES ('payment_releases', $1, $2::jsonb)",
    [failed.length ? "warning" : "ok", JSON.stringify({ eligible: due.rowCount, released, failed })]);
  return { eligible: due.rowCount, released, failed };
}

export async function refundUnreleasedBooking(bookingId: string, reason: string) {
  if (!isStripeReady()) return { ok: false, error: "Stripe is not configured." } as const;
  const claimed = await database.query<{
    customer_id: string; provider_user_id: string; provider_name: string; service_title: string; stripe_payment_intent_id: string;
    price_cents: number; refunded_amount_cents: number;
    customer_service_fee_cents: number; customer_service_fee_refunded_cents: number;
  }>(`UPDATE bookings b SET refund_status = 'processing', refund_reason = $2,
      refund_requested_at = COALESCE(b.refund_requested_at, now()),
      refund_amount_cents = b.price_cents - b.refunded_amount_cents,
      refund_failure_reason = NULL
    FROM provider_profiles p, services s
    WHERE b.id::text = $1 AND p.id = b.provider_id AND s.id = b.service_id
      AND b.payment_flow = 'held_transfer_v1' AND b.payment_status = 'paid'
      AND b.stripe_mode = $3 AND b.stripe_payment_intent_id IS NOT NULL AND b.stripe_transfer_id IS NULL
      AND (b.refunded_amount_cents < b.price_cents
        OR b.customer_service_fee_refunded_cents < b.customer_service_fee_cents)
      AND b.refund_status <> 'processing'
    RETURNING b.customer_id, p.user_id AS provider_user_id, s.business_name AS provider_name, s.title AS service_title,
      b.stripe_payment_intent_id, b.price_cents, b.refunded_amount_cents,
      b.customer_service_fee_cents, b.customer_service_fee_refunded_cents`, [bookingId, reason, getStripeMode()]);
  const booking = claimed.rows[0];
  if (!booking) return { ok: true, refunded: false } as const;
  const amount = booking.price_cents - booking.refunded_amount_cents
    + booking.customer_service_fee_cents - booking.customer_service_fee_refunded_cents;
  try {
    const refund = await getStripe().refunds.create({
      payment_intent: booking.stripe_payment_intent_id,
      amount,
      metadata: { bookingId, kind: "held_payment_refund" },
    }, { idempotencyKey: `booking-auto-refund-${getStripeMode()}-${bookingId}` });
    await database.query(`UPDATE bookings SET refund_status = 'refunded', stripe_refund_id = $2,
      refunded_amount_cents = price_cents,
      customer_service_fee_refunded_cents = customer_service_fee_cents,
      refunded_at = now(), payment_status = 'refunded',
      payment_release_status = 'reversed', provider_payout_cents = 0 WHERE id::text = $1`, [bookingId, refund.id]);
    await syncAffiliateCommissionForBooking(bookingId);
    await database.query(`INSERT INTO booking_events (booking_id, event_type, message, metadata)
      VALUES ($1::uuid, 'refunded', 'Payment refunded before provider payout.',
      jsonb_build_object('amountCents', $2::integer, 'stripeRefundId', $3))`, [bookingId, amount, refund.id]);
    await database.query(`INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
      VALUES ($1, $2::uuid, 'refund_approved', 'Payment refunded', $3,
      '/account/bookings/' || $2::uuid::text, 'automatic-refund-' || $2::uuid::text)
      ON CONFLICT (dedupe_key) DO NOTHING`, [booking.customer_id, bookingId, `$${(amount / 100).toFixed(2)} for ${booking.service_title} was returned to your original payment method.`]);
    await database.query(`INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
      VALUES ($1, $2::uuid, 'refund_approved', 'Booking payment refunded', $3,
      '/provider/dashboard/bookings/' || $2::uuid::text, 'held-payment-refund-provider-' || $2::uuid::text)
      ON CONFLICT (dedupe_key) DO NOTHING`, [booking.provider_user_id, bookingId, `The held payment for ${booking.service_title} was refunded to the customer. No provider payout was released.`]);
    return { ok: true, refunded: true, amount } as const;
  } catch (error) {
    console.error("Automatic held payment refund failed", bookingId, error);
    await database.query(`UPDATE bookings SET refund_status = 'failed',
      refund_failure_reason = 'The automatic refund needs administrator attention.' WHERE id::text = $1`, [bookingId]);
    return { ok: false, error: "The booking was cancelled, but its automatic refund needs administrator attention." } as const;
  }
}
