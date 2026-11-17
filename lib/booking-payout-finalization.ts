import "server-only";
import type { PoolClient } from "pg";
import { database } from "./database";
import { syncAffiliateCommissionForBooking } from "./affiliates";

/** Caller owns a transaction. Lock the booking before reading the outbox so
 * release retries, webhooks, refunds and cron cannot finalize stale state. This
 * function never calls Stripe or changes transfer/recovery evidence. */
export async function finalizeBookingPayoutInTransaction(bookingId: string, mode: "test" | "live", client: Pick<PoolClient, "query">) {
  const current = await client.query<{
    stripe_transfer_id: string | null; customer_id: string; provider_user_id: string; service_title: string;
    eligible: boolean; terminal: boolean; reversed_cents: number; refunded_cents: number;
  }>(`SELECT b.stripe_transfer_id, b.customer_id, p.user_id AS provider_user_id, s.title AS service_title,
      (b.status = 'completed' AND b.payment_status = 'paid'
        AND b.payment_release_status IN ('paid_out', 'partially_released')
        AND b.payout_frozen_at IS NULL AND b.payout_failure_reason IS NULL
        AND b.refund_status NOT IN ('requested', 'processing', 'failed')
        AND (b.refund_failure_reason IS NULL OR b.refund_status = 'rejected')
        AND (b.stripe_dispute_status IS NULL OR b.stripe_dispute_status IN ('won', 'warning_closed'))
        AND NOT EXISTS (SELECT 1 FROM booking_disputes d WHERE d.booking_id = b.id AND d.status IN ('open', 'reviewing'))) AS eligible,
      (b.payment_status = 'refunded' OR b.payment_release_status = 'reversed' OR b.stripe_dispute_status = 'lost') IS TRUE AS terminal,
      b.stripe_transfer_reversed_cents AS reversed_cents,
      b.refunded_amount_cents + b.customer_service_fee_refunded_cents AS refunded_cents
    FROM bookings b JOIN provider_profiles p ON p.id = b.provider_id JOIN services s ON s.id = b.service_id
    WHERE b.id::text = $1 AND b.stripe_mode = $2 FOR UPDATE OF b`, [bookingId, mode]);
  const booking = current.rows[0];
  if (!booking?.stripe_transfer_id) return false;
  const pending = await client.query<{ release_trigger: string; amount_cents: number; refunded_cents: number }>(
    "SELECT release_trigger, amount_cents, refunded_cents FROM booking_payout_finalizations WHERE booking_id = $1::uuid AND completed_at IS NULL", [bookingId]);
  const work = pending.rows[0];
  if (!work) return false;

  await client.query(`INSERT INTO booking_events (booking_id, event_type, message, metadata)
    SELECT $1::uuid, 'payout_released', $2, jsonb_build_object('transferId', $3::text, 'trigger', $4::text)
    WHERE NOT EXISTS (SELECT 1 FROM booking_events WHERE booking_id = $1::uuid AND event_type = 'payout_released'
      AND metadata->>'transferId' = $3)`,
  [bookingId, `Provider payout of $${(work.amount_cents / 100).toFixed(2)} was released through Stripe.`, booking.stripe_transfer_id, work.release_trigger]);

  // Keep temporary refund/dispute holds pending. Terminal refunds/reversals get
  // their historical transfer audit, but must never recreate earnings or send
  // a stale success notification. A later hold resolution can drain the queue.
  if (!booking.eligible && !booking.terminal) return false;
  await syncAffiliateCommissionForBooking(bookingId, client);
  if (booking.eligible && booking.reversed_cents === 0 && booking.refunded_cents === work.refunded_cents) {
    if (work.release_trigger === "automatic") {
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
    [booking.provider_user_id, bookingId, `$${(work.amount_cents / 100).toFixed(2)} for ${booking.service_title} was sent to your Stripe balance.`]);
  }
  await client.query("UPDATE booking_payout_finalizations SET completed_at = now() WHERE booking_id = $1::uuid", [bookingId]);
  return true;
}

export async function finalizeBookingPayout(bookingId: string, mode: "test" | "live") {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const finalized = await finalizeBookingPayoutInTransaction(bookingId, mode, client);
    await client.query("COMMIT");
    return finalized;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function finalizePendingBookingPayouts(mode: "test" | "live", limit = 50) {
  const pending = await database.query<{ id: string }>(`SELECT b.id::text FROM booking_payout_finalizations f
    JOIN bookings b ON b.id = f.booking_id
    WHERE f.completed_at IS NULL AND b.stripe_mode = $1 AND b.stripe_transfer_id IS NOT NULL
      AND ((b.payout_frozen_at IS NULL AND b.payout_failure_reason IS NULL
        AND b.payment_release_status IN ('paid_out', 'partially_released')
        AND b.status = 'completed' AND b.payment_status = 'paid'
        AND (b.stripe_dispute_status IS NULL OR b.stripe_dispute_status IN ('won', 'warning_closed'))
        AND b.refund_status NOT IN ('requested', 'processing', 'failed')
        AND (b.refund_failure_reason IS NULL OR b.refund_status = 'rejected')
        AND NOT EXISTS (SELECT 1 FROM booking_disputes d WHERE d.booking_id = b.id AND d.status IN ('open', 'reviewing')))
        OR b.payment_status = 'refunded' OR b.payment_release_status = 'reversed' OR b.stripe_dispute_status = 'lost')
    ORDER BY f.created_at LIMIT $2`, [mode, limit]);
  let finalized = 0;
  const failed: string[] = [];
  for (const booking of pending.rows) {
    try { if (await finalizeBookingPayout(booking.id, mode)) finalized++; }
    catch (error) { failed.push(booking.id); console.error("Provider payout finalization failed", booking.id, error); }
  }
  return { eligible: pending.rowCount, finalized, failed };
}
