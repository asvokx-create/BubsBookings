import "server-only";
import { database } from "./database";

// Persist this warning with the claim, before calling Stripe. A partial charge
// webhook can change refund_status, but must not unlock an unfinished operation.
export const BOOKING_REFUND_RECONCILIATION = "Refund outcome requires reconciliation. Contact support before retrying.";

export function bookingRefundWarning(error?: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "approval_required"
    ? "Stripe approval is pending. Do not retry the refund while approval is under review."
    : BOOKING_REFUND_RECONCILIATION;
}

export async function recordPendingBookingRefund(bookingId: string, warning: string, refundId: string | null = null) {
  try {
    await database.query(`UPDATE bookings SET refund_failure_reason = $2,
      stripe_refund_id = COALESCE($3::text, stripe_refund_id)
      WHERE id::text = $1 AND payment_status <> 'refunded'
        AND (refund_status = 'processing' OR refund_failure_reason = $4)`,
    [bookingId, warning, refundId, BOOKING_REFUND_RECONCILIATION]);
  } catch (error) {
    // The durable claim remains in place if this supplementary warning fails.
    console.error("Could not record booking refund reconciliation warning", bookingId, error);
  }
}
