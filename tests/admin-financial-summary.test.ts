import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

// Execute the production SQL, not a JavaScript reimplementation of its math.
const source = readFileSync(new URL("../lib/admin-financial-summary.ts", import.meta.url), "utf8");
const sql = source.match(/database\.query<[^>]+>\(`([\s\S]*?)`\)/)?.[1];
assert.ok(sql, "Admin summary query must be available for regression coverage");

test("admin summary charges the full Stripe cost after a full refund", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE bookings (
      price_cents integer, platform_fee_cents integer,
      refunded_amount_cents integer, customer_service_fee_cents integer,
      customer_service_fee_refunded_cents integer, processing_fee_status text,
      stripe_processing_fee_cents integer, provider_processing_fee_cents integer,
      payment_status text, payment_release_status text
    )`);
    async function summary(overrides: Record<string, number | string | null> = {}) {
      const booking = {
        price_cents: 100, platform_fee_cents: 10, refunded_amount_cents: 100,
        customer_service_fee_cents: 299, customer_service_fee_refunded_cents: 299,
        processing_fee_status: "final", stripe_processing_fee_cents: 42,
        provider_processing_fee_cents: 11, payment_status: "refunded",
        payment_release_status: "reversed", ...overrides,
      };
      await db.exec("DELETE FROM bookings");
      await db.query(`INSERT INTO bookings (${Object.keys(booking).join(", ")})
        VALUES (${Object.keys(booking).map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(booking));
      const result = await db.query<{ platform_revenue_cents: number | string }>(sql!);
      return Number(result.rows[0].platform_revenue_cents);
    }
    // Regression: the old SQL incorrectly returned -31 by retaining 11c income.
    assert.equal(await summary(), -42);
    // The result does not depend on whether the net payout was released first.
    assert.equal(await summary({ payment_release_status: "secured" }), -42);
    assert.equal(await summary({ refunded_amount_cents: 110 }), -42);
    assert.equal(await summary({ provider_processing_fee_cents: 0 }), -42);
    assert.equal(await summary({ stripe_processing_fee_cents: 0 }), 0);
    assert.equal(await summary({ processing_fee_status: "pending", stripe_processing_fee_cents: null }), 0);
    // Only the full-service-refund case changes; other existing policy is preserved.
    assert.equal(await summary({ refunded_amount_cents: 0, customer_service_fee_refunded_cents: 0, payment_status: "paid" }), 278);
    assert.equal(await summary({ refunded_amount_cents: 50, customer_service_fee_refunded_cents: 0, payment_status: "paid" }), 273);
    assert.equal(await summary({ customer_service_fee_refunded_cents: 0 }), 257);
    assert.equal(await summary({ payment_status: "unpaid" }), 0);
    assert.equal(await summary({ payment_release_status: "not_applicable" }), 0);
    await db.exec("DELETE FROM bookings");
    assert.equal(Number((await db.query<{ platform_revenue_cents: string }>(sql!)).rows[0].platform_revenue_cents), 0);
  } finally {
    await db.close();
  }
});
