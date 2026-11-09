import "server-only";
import type { PoolClient } from "pg";
import { database } from "./database";

export const BOOKING_PAYOUT_RECONCILIATION = "Provider payout outcome requires reconciliation. Contact support before retrying.";

/** Only matching transfer evidence can finish a durable payout claim. Preserve
 * newer holds/reversals and flag refunds that may need transfer recovery. */
export async function recordBookingPayoutTransfer(input: {
  bookingId: string; transferId: string; mode: "test" | "live"; amountCents: number;
  connectedAccountId: string; sourceChargeId: string | null; expectedRefundedCents?: number;
}, client: Pick<PoolClient, "query"> = database) {
  return client.query(`UPDATE bookings SET stripe_transfer_id = COALESCE(stripe_transfer_id, $2),
      payment_release_status = CASE
        WHEN (payment_release_status = 'reversed' OR (stripe_transfer_id IS NULL AND stripe_dispute_status = 'lost'))
          AND stripe_transfer_reversed_cents < $4 THEN 'frozen'
        WHEN payment_release_status = 'processing' THEN 'paid_out' ELSE payment_release_status END,
      payout_released_at = COALESCE(payout_released_at, now()),
      payout_frozen_at = CASE WHEN (payment_release_status = 'reversed' OR (stripe_transfer_id IS NULL AND stripe_dispute_status = 'lost'))
        AND stripe_transfer_reversed_cents < $4 THEN COALESCE(payout_frozen_at, now()) ELSE payout_frozen_at END,
      payout_freeze_reason = CASE WHEN (payment_release_status = 'reversed' OR (stripe_transfer_id IS NULL AND stripe_dispute_status = 'lost'))
        AND stripe_transfer_reversed_cents < $4 THEN COALESCE(payout_freeze_reason, 'Provider transfer requires recovery review') ELSE payout_freeze_reason END,
      payout_failure_reason = CASE
        WHEN payment_release_status = 'reversed' AND stripe_transfer_reversed_cents < $4
          AND (payout_failure_reason IS NULL OR payout_failure_reason = $6)
          THEN 'Provider transfer recovery is not confirmed. An administrator must review the payment.'
        WHEN payout_failure_reason = $6 AND stripe_dispute_id IS NOT NULL AND stripe_dispute_status NOT IN ('won', 'warning_closed')
          THEN 'A Stripe chargeback affects this provider payout. An administrator must review transfer recovery.'
        WHEN payout_failure_reason = $6 AND refunded_amount_cents + customer_service_fee_refunded_cents > $8
          THEN 'Stripe refund after provider payout requires transfer recovery review.'
        WHEN payout_failure_reason = $6 THEN NULL ELSE payout_failure_reason END
    FROM provider_profiles provider
    WHERE bookings.id::text = $1 AND bookings.provider_id = provider.id AND bookings.stripe_mode = $3
      AND (bookings.provider_payout_cents = $4 OR stripe_transfer_id = $2)
      AND provider.stripe_account_id = $5 AND provider.stripe_connect_mode = $3
      AND bookings.stripe_charge_id = $7 AND (stripe_transfer_id IS NULL OR stripe_transfer_id = $2)
    RETURNING bookings.id`,
  [input.bookingId, input.transferId, input.mode, input.amountCents, input.connectedAccountId,
    BOOKING_PAYOUT_RECONCILIATION, input.sourceChargeId, input.expectedRefundedCents ?? 0]);
}
