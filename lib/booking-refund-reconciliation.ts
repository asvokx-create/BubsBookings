import "server-only";
import { database } from "./database";
import { BOOKING_PAYOUT_RECONCILIATION } from "./booking-payout-reconciliation";
import { BOOKING_REFUND_RECONCILIATION } from "./booking-refund-operations";

/** Signed charge events report cumulative refunds. Never regress totals when
 * events arrive out of order, or release an unreconciled external refund.
 * Only full-charge settlement proves an outstanding refund warning is obsolete;
 * partial totals do not identify which pending operation completed. */
export async function recordBookingChargeRefund(input: { paymentIntentId: string | null; bookingId: string; mode: "test" | "live"; fullyRefunded: boolean; amountRefunded: number; chargeAmount: number }) {
  return database.query<{id:string}>(`UPDATE bookings SET
    payment_status = CASE WHEN $3 THEN 'refunded' ELSE payment_status END,
    refund_status = 'refunded',
    refund_failure_reason = CASE WHEN $3 AND $4 >= customer_total_cents THEN NULL
      WHEN NOT $3 AND $4 > refunded_amount_cents + customer_service_fee_refunded_cents
        THEN COALESCE(refund_failure_reason, $8::text)
      ELSE refund_failure_reason END,
    payout_frozen_at = CASE WHEN payment_flow='held_transfer_v1' AND stripe_transfer_id IS NULL
      AND $4 > refunded_amount_cents + customer_service_fee_refunded_cents THEN COALESCE(payout_frozen_at,now()) ELSE payout_frozen_at END,
    payout_freeze_reason = CASE WHEN payment_flow='held_transfer_v1' AND stripe_transfer_id IS NULL
      AND $4 > refunded_amount_cents + customer_service_fee_refunded_cents
      AND ((payout_frozen_at IS NULL AND payout_freeze_reason IS NULL)
        OR payout_freeze_reason IN ('Refund requested', 'Stripe refund requires payout reconciliation'))
      THEN 'Stripe refund requires payout reconciliation' ELSE payout_freeze_reason END,
    payment_release_status = CASE WHEN payment_flow='held_transfer_v1' AND stripe_transfer_id IS NULL AND $3
        AND payout_failure_reason IS DISTINCT FROM $7 THEN 'reversed'
      WHEN payment_flow='held_transfer_v1' AND stripe_transfer_id IS NULL AND $4 > refunded_amount_cents + customer_service_fee_refunded_cents THEN 'frozen'
      ELSE payment_release_status END,
    provider_payout_cents = CASE WHEN payment_flow='held_transfer_v1' AND stripe_transfer_id IS NULL AND $3
      AND payout_failure_reason IS DISTINCT FROM $7 THEN 0 ELSE provider_payout_cents END,
    payout_failure_reason = CASE WHEN payment_flow='held_transfer_v1' AND stripe_transfer_id IS NOT NULL
      AND stripe_transfer_reversed_cents < provider_payout_cents
      AND $4 > refunded_amount_cents + customer_service_fee_refunded_cents THEN 'Stripe refund after provider payout requires transfer recovery review.' ELSE payout_failure_reason END,
    refunded_amount_cents = GREATEST(refunded_amount_cents,LEAST(price_cents,$4)),
    customer_service_fee_refunded_cents = GREATEST(customer_service_fee_refunded_cents,LEAST(customer_service_fee_cents,GREATEST($4-price_cents,0))),
    refunded_at = now()
    WHERE stripe_mode=$2 AND customer_total_cents=$6
      AND (stripe_payment_intent_id=$1 OR ($5<>'' AND id::text=$5)) RETURNING id::text`,
    [input.paymentIntentId,input.mode,input.fullyRefunded,input.amountRefunded,input.bookingId,input.chargeAmount,BOOKING_PAYOUT_RECONCILIATION,BOOKING_REFUND_RECONCILIATION]);
}
