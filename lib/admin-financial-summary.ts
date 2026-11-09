import "server-only";

import { database } from "@/lib/database";

export async function getAdminFinancialSummary() {
  const result = await database.query<{ platform_revenue_cents: string | number }>(`
    SELECT COALESCE(SUM(
      GREATEST(0, b.platform_fee_cents - COALESCE(
        ROUND(b.platform_fee_cents::numeric * LEAST(b.refunded_amount_cents, b.price_cents) / NULLIF(b.price_cents, 0)),
        0
      )::bigint)
      + GREATEST(0, b.customer_service_fee_cents - b.customer_service_fee_refunded_cents)
      - CASE WHEN b.processing_fee_status = 'final'
        THEN GREATEST(0, COALESCE(b.stripe_processing_fee_cents, 0)
          -- A full service refund returns the entire net provider payout (or
          -- cancels it before release). Its original processing allocation is
          -- no longer income: the platform bears the unrecovered Stripe fee.
          - CASE WHEN b.refunded_amount_cents >= b.price_cents
            THEN 0 ELSE b.provider_processing_fee_cents END)
        ELSE 0 END
    ), 0)::bigint AS platform_revenue_cents
    FROM bookings b
    WHERE b.payment_status IN ('paid', 'refunded')
      AND b.payment_release_status <> 'not_applicable'
  `);

  return { platformRevenueCents: Number(result.rows[0]?.platform_revenue_cents ?? 0) };
}
