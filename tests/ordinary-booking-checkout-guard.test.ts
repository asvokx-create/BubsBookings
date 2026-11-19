import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";

const route = ts.transpileModule(
  readFileSync(new URL("../app/api/stripe/bookings/[bookingId]/checkout/route.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

test("ordinary checkout preserves the authoritative settlement link", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE bookings (
    id text PRIMARY KEY, stripe_checkout_session_id text, stripe_payment_intent_id text,
    stripe_charge_id text, stripe_transfer_id text, stripe_mode text, payment_status text,
    status text, quote_status text, price_cents integer, payment_flow text, payment_release_status text,
    platform_fee_cents integer, provider_payout_cents integer, customer_service_fee_cents integer,
    provider_plan_snapshot text, provider_fee_basis_points integer, provider_fee_cap_cents integer,
    customer_total_cents integer, stripe_processing_fee_cents integer, provider_processing_fee_cents integer,
    processing_fee_status text, customer_service_fee_refunded_cents integer, paid_at timestamptz,
    completion_confirmation_due_at timestamptz, customer_confirmed_at timestamptz, payout_released_at timestamptz,
    payout_failure_reason text, payout_frozen_at timestamptz, payout_frozen_by text, payout_freeze_reason text
  ); INSERT INTO bookings (id,stripe_checkout_session_id,stripe_mode,payment_status,status,quote_status,price_cents)
    VALUES ('booking-fixture','session-fixture','test','pending','confirmed','none',3000)`);
  const state = async () => (await db.query<{ stripe_checkout_session_id: string | null; payment_status: string; stripe_charge_id: string | null }>("SELECT stripe_checkout_session_id, payment_status, stripe_charge_id FROM bookings")).rows[0];
  let responseStatus: "open" | "complete" | "expired" = "complete";
  let retrievalFailure = false;
  let retrievalCalls = 0;
  let sessionMode = false;
  const concurrentGate: { wait?: Promise<void>; release?: () => void } = {};
  const idempotencyKeys: string[] = [];
  let intentStatus = "requires_payment_method";
  let intentBookingId = "booking-fixture";
  let simulateSettlement = false;
  let creationCalls = 0;
  const stripe = {
    accounts: { retrieve: async () => ({ charges_enabled: true, payouts_enabled: true }) },
    checkout: { sessions: {
      retrieve: async () => {
        retrievalCalls++;
        if (retrievalFailure) throw new Error("Fixture provider unavailable");
        return { id: "session-fixture", livemode: sessionMode, status: responseStatus, payment_status: "unpaid", url: "https://example.invalid/existing",
          metadata: { kind: "booking_payment", bookingId: "booking-fixture", paymentFlow: "held_transfer_v1", checkoutVersion: "fixture", customerServiceFeeCents: "299" },
          payment_intent: { id: "intent-fixture", status: intentStatus, amount_received: 0, livemode: false, metadata: { kind: "booking_payment", bookingId: intentBookingId } },
        };
      },
      create: async (_: unknown, options: { idempotencyKey: string }) => {
        creationCalls++;
        idempotencyKeys.push(options.idempotencyKey);
        if (concurrentGate.wait) {
          if (creationCalls % 2 === 0) concurrentGate.release?.();
          await concurrentGate.wait;
        }
        return { id: "replacement-fixture", url: "https://example.invalid/test" };
      },
    } },
  };
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes("FROM hourly_projects")) return { rows: [] };
    if (sql.includes("FROM bookings b JOIN")) return { rows: [{
      id: "booking-fixture", title: "Fixture", provider_name: "Fixture provider",
      pricing_type_snapshot: "FIXED", age_verification_status: "verified",
      stripe_account_id: "account-fixture", stripe_connect_mode: "test",
      base_price_cents: 3000, ...(await db.query<Record<string, unknown>>("SELECT * FROM bookings")).rows[0],
    }] };
    if (sql.startsWith("UPDATE provider_profiles")) return { rows: [] };
    if (simulateSettlement) await db.exec("UPDATE bookings SET payment_status='paid',stripe_charge_id='settled-fixture'");
    const result = await db.query(sql, values);
    return { ...result, rowCount: result.rows.length };
  };
  const exports: { POST?: (request: Request, context: { params: Promise<{ bookingId: string }> }) => Promise<Response> } = {};
  const deps: Record<string, unknown> = {
    "next/headers": { headers: async () => new Headers() },
    "next/server": { NextResponse: Response },
    "@/lib/auth": { auth: { api: { getSession: async () => ({ user: { id: "consumer-fixture" } }) } } },
    "@/lib/account-age": { hasConfirmedAge: async () => true },
    "@/lib/customer-stripe": { getOrCreateConsumerStripeCustomer: async () => "customer-fixture" },
    "@/lib/database": { database: { query } },
    "@/lib/stripe": { getStripe: () => stripe, getStripeMode: () => "test", isStripeReady: () => true },
    "@/lib/request-security": { enforceRateLimit: async () => true },
    "@/lib/analytics": { recordAnalytics: async () => {} },
    "@/lib/booking-fees": { BOOKING_CHECKOUT_VERSION: "fixture" },
    "@/lib/booking-financials": { calculateBookingFinancialSnapshot: () => ({
      providerPlan: "starter", providerFeeBasisPoints: 1000, providerFeeCapCents: 20000,
      providerFeeCents: 300, providerNetCents: 2700, customerServiceFeeCents: 299, customerTotalCents: 3299,
    }) },
  };
  new Function("require", "exports", route)((name: string) => {
    assert.ok(Object.hasOwn(deps, name), `Missing test fake: ${name}`);
    return deps[name];
  }, exports);
  assert.ok(exports.POST);
  const post = () => exports.POST!(new Request("https://example.invalid/", { method: "POST" }), {
    params: Promise.resolve({ bookingId: "booking-fixture" }),
  });

  const before = await state();
  retrievalFailure = true;
  assert.equal((await post()).status, 503);
  retrievalFailure = false;
  sessionMode = true;
  assert.equal((await post()).status, 503);
  sessionMode = false;
  responseStatus = "open";
  const existing = await post();
  assert.equal(existing.status, 200);
  assert.equal((await existing.json()).url, "https://example.invalid/existing");
  assert.equal(creationCalls, 0);
  assert.deepEqual(await state(), before);
  responseStatus = "complete";
  const completed = await post();
  assert.equal(completed.status, 409);
  assert.match((await completed.json()).error, /confirming your previous payment/i);
  assert.equal(creationCalls, 0);
  assert.deepEqual(await state(), before);

  await db.exec("UPDATE bookings SET payment_status='failed'");
  const failedUnresolved = await post();
  assert.equal(failedUnresolved.status, 409);
  assert.match((await failedUnresolved.json()).error, /Contact support/i);
  assert.equal(creationCalls, 0);

  intentStatus = "canceled";
  intentBookingId = "different-fixture";
  assert.equal((await post()).status, 409);
  assert.equal(creationCalls, 0);

  intentBookingId = "booking-fixture";
  await db.exec("UPDATE bookings SET stripe_payment_intent_id='wrong-intent-fixture'");
  assert.equal((await post()).status, 409);
  assert.equal(creationCalls, 0);
  await db.exec("UPDATE bookings SET stripe_payment_intent_id='intent-fixture'");
  assert.equal((await post()).status, 200);
  assert.equal(creationCalls, 1);
  assert.equal((await state())?.stripe_checkout_session_id, "replacement-fixture");

  await db.exec("UPDATE bookings SET stripe_checkout_session_id='session-fixture',payment_status='pending'");

  responseStatus = "expired";
  simulateSettlement = true;
  const raced = await post();
  assert.equal(raced.status, 409);
  assert.equal((await raced.json()).url, undefined);
  assert.deepEqual(await state(), {
    stripe_checkout_session_id: "session-fixture", payment_status: "paid", stripe_charge_id: "settled-fixture",
  });

  simulateSettlement = false;
  await db.exec("UPDATE bookings SET payment_status='unpaid',stripe_charge_id=NULL");
  const replacement = await post();
  assert.equal(replacement.status, 200);
  assert.match((await replacement.json()).url, /example.invalid/);
  assert.equal((await state())?.stripe_checkout_session_id, "replacement-fixture");

  await db.exec("UPDATE bookings SET payment_status='paid'");
  const retrievalsBeforePaid = retrievalCalls;
  assert.equal((await post()).status, 409);
  assert.equal(retrievalCalls, retrievalsBeforePaid);
  await db.exec("UPDATE bookings SET stripe_checkout_session_id='session-fixture',payment_status='unpaid'");
  creationCalls = 0;
  idempotencyKeys.length = 0;
  concurrentGate.wait = new Promise<void>((resolve) => { concurrentGate.release = resolve; });
  const concurrent = await Promise.all([post(), post()]);
  assert.deepEqual(concurrent.map(({status}) => status).sort(), [200, 409]);
  assert.equal(creationCalls, 2);
  assert.equal(new Set(idempotencyKeys).size, 1);
  assert.equal((await state())?.stripe_checkout_session_id, "replacement-fixture");
});
