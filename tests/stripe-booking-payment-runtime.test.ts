/* eslint-disable @typescript-eslint/no-explicit-any -- Fake external Stripe boundaries around the real signed handler and PostgreSQL queries. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import Stripe from "stripe";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);
const webhookSecret = "whsec_local_signed_webhook_test_only";
const signatureTools = new Stripe("sk_test_local_signature_tools_only").webhooks;

for (const postgres of [false, true]) test(`${postgres ? "PostgreSQL" : "PGlite"} signed booking payment webhook`, {
  skip: postgres && process.env.BOOKME_MIGRATION_TEST_DATABASE !== "1",
}, async (t) => {
  let db: any;
  let cleanup: () => Promise<void>;
  if (postgres) {
    const connectionString = process.env.DATABASE_URL ?? "postgresql://bookme:bookme@127.0.0.1:5432/bookme";
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(connectionString).hostname)) {
      throw new Error("Webhook tests require an explicitly opted-in localhost PostgreSQL database.");
    }
    const schema = "booking_webhook_test_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString, ssl: false });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString, ssl: false, options: `-c search_path=${schema}`, max: 8 });
    // Some local PostgreSQL-compatible servers ignore startup options.
    // Set and verify the schema before issuing any fixture SQL on a connection.
    const connect = async () => {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${schema}"`);
        const selected = await client.query("SELECT current_schema() AS schema");
        assert.equal(selected.rows[0].schema, schema, "all test SQL must use the disposable schema");
        return client;
      } catch (error) { client.release(); throw error; }
    };
    const isolatedQuery = async (sql: string, values: unknown[] = []) => {
      const client = await connect();
      try { return await client.query(sql, values); } finally { client.release(); }
    };
    db = { query: isolatedQuery, exec: isolatedQuery, connect };
    cleanup = async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); };
  } else {
    db = new PGlite();
    cleanup = () => db.close();
  }
  const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
  t.mock.method(console, "error", () => {});
  const failures: string[] = [];
  t.beforeEach(() => { failures.length = 0; });
  const intents = new Map<string, any>();
  let chargeCalls = 0;
  const disputeLists = new Map<string, any>();
  const chargeOverrides = new Map<string, any>();
  const disputedCharges = new Set<string>();
  let transferCalls = 0;
  let duringTransfer: () => Promise<void> = async () => {};
  let afterQuery: (sql: string) => Promise<void> = async () => {};
  let pendingFee = false;
  const stripe = {
    webhooks: signatureTools,
    disputes: { list: async ({ charge }: { charge: string }) => {
      const result = disputeLists.get(charge);
      if (result instanceof Error) throw result;
      assert.ok(result, "only configured synthetic dispute lists may be read");
      return result;
    } },
    transfers: { create: async () => { transferCalls++; await duringTransfer(); return { id: "tr_test_new" }; } },
    paymentIntents: { retrieve: async (id: string) => {
      assert.ok(intents.has(id), "only a known synthetic payment intent may be retrieved");
      return intents.get(id);
    } },
    charges: { retrieve: async (id: string) => {
      assert.ok(id.startsWith("ch_test_"));
      chargeCalls++;
      return { id, payment_intent: id.replace("ch_test_", "pi_test_"), livemode: false, disputed: disputedCharges.has(id), currency: "usd", amount: 6299, amount_refunded: 0, refunded: false, balance_transaction: pendingFee ? null : { fee: 213 }, ...chargeOverrides.get(id) };
    } },
  };
  const query = async (sql: string, values: unknown[] = [], executor: any = db) => {
    if (failures.length && sql.includes(failures[0])) {
      failures.shift();
      // A real database statement error aborts a transaction, unlike a mocked rejection.
      return executor.query("SELECT 1 / 0 AS simulated_database_failure");
    }
    const result = await executor.query(sql, values);
    await afterQuery(sql);
    return { ...result, rowCount: result.rowCount ?? (result.affectedRows || result.rows.length) };
  };
  const database = {
    query,
    connect: async () => {
      if (!postgres) return { query, release() {} };
      const client = await db.connect();
      return { query: (sql: string, values: unknown[] = []) => query(sql, values, client), release: (discard = false) => client.release(discard) };
    },
  };
  const replacements: Record<string, unknown> = {
    "server-only": {},
    "@/lib/database": { database },
    "@/lib/stripe": { getStripe: () => stripe, getStripeMode: () => "test", isStripeReady: () => true },
    // These other webhook paths are not part of booking-payment settlement.
    "@/lib/provider-verification": {},
    "@/lib/email": {}, "@/lib/affiliates": { syncAffiliateCommissionForBooking: async () => {} }, "@/lib/affiliate-payouts": {},
    "@/lib/tip-payments": {}, "@/lib/provider-age-verification": {},
  };
  const cache = new Map<string, unknown>();
  const load = (name: string, importer = resolve("entry.ts")): any => {
    const local = name.startsWith("@/") || name.startsWith(".");
    const file = name.startsWith("@/") ? resolve(name.slice(2) + ".ts") : resolve(dirname(importer), name + ".ts");
    const replacement = Object.entries(replacements).find(([key]) => key === name || (local && key.startsWith("@/") && resolve(key.slice(2) + ".ts") === file));
    if (replacement) return replacement[1];
    if (!local) return nativeRequire(name);
    if (cache.has(file)) return cache.get(file);
    const output = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const mod = { exports: {} };
    cache.set(file, mod.exports);
    new Function("require", "module", "exports", output)((dependency: string) => load(dependency, file), mod, mod.exports);
    return mod.exports;
  };
  try {
    // Use the existing marketplace + hourly schema and a focused payment schema.
    await db.exec(`CREATE TABLE "user" (id text PRIMARY KEY, name text);
      INSERT INTO "user" VALUES ('customer', 'Customer'), ('provider', 'Provider');`);
    await db.exec(readFileSync("database/migrations/001_bookme_marketplace.sql", "utf8").replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""));
    await db.exec(`ALTER TABLE bookings
      ADD payment_status text DEFAULT 'pending', ADD stripe_checkout_session_id text,
      ADD stripe_payment_intent_id text, ADD stripe_charge_id text, ADD stripe_mode text DEFAULT 'test',
      ADD paid_at timestamptz, ADD payment_flow text DEFAULT 'held_transfer_v1', ADD payment_release_status text DEFAULT 'awaiting_payment',
      ADD payout_frozen_at timestamptz, ADD payout_freeze_reason text, ADD completion_confirmation_due_at timestamptz,
      ADD payout_released_at timestamptz, ADD stripe_transfer_id text, ADD stripe_transfer_reversed_cents integer DEFAULT 0, ADD payout_failure_reason text, ADD customer_total_cents integer DEFAULT 6299,
      ADD platform_fee_cents integer DEFAULT 600, ADD stripe_processing_fee_cents integer,
      ADD provider_processing_fee_cents integer DEFAULT 0, ADD provider_payout_cents integer DEFAULT 5400,
      ADD processing_fee_status text DEFAULT 'pending', ADD refunded_amount_cents integer DEFAULT 0,
      ADD customer_service_fee_refunded_cents integer DEFAULT 0, ADD customer_service_fee_cents integer DEFAULT 299,
      ADD stripe_dispute_id text, ADD stripe_dispute_status text, ADD stripe_dispute_reason text, ADD stripe_dispute_opened_at timestamptz, ADD stripe_dispute_closed_at timestamptz,
      ADD refund_status text DEFAULT 'none', ADD refund_failure_reason text, ADD refunded_at timestamptz;
      ALTER TABLE services ADD business_name text DEFAULT 'Company';
      ALTER TABLE provider_profiles ADD stripe_account_id text DEFAULT 'acct_test', ADD stripe_connect_mode text DEFAULT 'test', ADD stripe_payouts_enabled boolean DEFAULT true, ADD age_verification_status text DEFAULT 'verified';
      CREATE TABLE booking_disputes (booking_id uuid, status text);
      CREATE TABLE booking_tips (id uuid, booking_id uuid, provider_id uuid, amount_cents integer, customer_id text, stripe_transfer_id text, payment_status text, stripe_dispute_id text, stripe_dispute_status text, transfer_failure_reason text, stripe_charge_id text, stripe_mode text);
      CREATE TABLE booking_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid REFERENCES bookings(id), event_type text, message text, metadata jsonb);
      CREATE TABLE notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text REFERENCES "user"(id), booking_id uuid REFERENCES bookings(id), type text, title text, message text, href text, dedupe_key text UNIQUE);
      CREATE TABLE analytics_events (event_name text, user_id text, anonymous_id text, path text, target_type text, target_id text, metadata jsonb);
      CREATE TABLE stripe_webhook_events (id text PRIMARY KEY, event_type text NOT NULL, status text DEFAULT 'processing', created_at timestamptz DEFAULT now(), processed_at timestamptz);
      INSERT INTO provider_profiles (id,user_id,business_name,city,state) VALUES ('00000000-0000-4000-8000-000000000001','provider','Company','City','ST');
      INSERT INTO services (id,provider_id,slug,category,title,description,price_cents,duration_minutes) VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','repair','repair','Repair','Repair service',6000,60);`);
    await db.exec(readFileSync("database/migrations/111_hourly_projects.sql", "utf8"));
    const { POST } = load("@/app/api/stripe/webhook/route") as { POST: (request: Request) => Promise<Response> };
    const { recordBookingChargeRefund } = load("@/lib/booking-refund-reconciliation");
    const fixture = async (hourly = true) => {
      const bookingId = randomUUID();
      const projectId = randomUUID();
      const checkoutId = "cs_test_" + bookingId;
      const intentId = "pi_test_" + bookingId;
      await db.query(`INSERT INTO bookings (id,customer_id,provider_id,service_id,starts_at,ends_at,status,service_address,price_cents,stripe_checkout_session_id)
        VALUES ($1,'customer','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',now(),now()+interval '1 hour','completed','',6000,$2)`, [bookingId, checkoutId]);
      if (hourly) await db.query(`INSERT INTO hourly_projects (id,customer_id,provider_id,service_id,title,description,hourly_rate_cents,cap_minutes,delivery_method,service_address,status,version,payment_booking_id)
        VALUES ($1,'customer','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Project','Work',6000,120,'REMOTE','','approved',5,$2)`, [projectId, bookingId]);
      intents.set(intentId, { id: intentId, livemode: false, status: "succeeded", currency: "usd", amount_received: 6299, latest_charge: "ch_test_" + bookingId, metadata: { kind: "booking_payment", bookingId } });
      const checkout = { id: checkoutId, payment_status: "paid", payment_intent: intentId, amount_total: 6299, metadata: { kind: "booking_payment", bookingId, paymentFlow: "held_transfer_v1", ...(hourly ? { hourlyProjectId: projectId, timesheetVersion: "5" } : {}) } };
      return { bookingId, projectId, checkout, eventId: "evt_test_" + bookingId };
    };
    const send = async (f: Awaited<ReturnType<typeof fixture>>, options: { eventId?: string; type?: string; livemode?: boolean; badSignature?: boolean } = {}) => {
      const payload = JSON.stringify({ id: options.eventId ?? f.eventId, object: "event", type: options.type ?? "checkout.session.completed", livemode: options.livemode ?? false, created: Math.floor(Date.now() / 1000), data: { object: f.checkout } });
      const signature = signatureTools.generateTestHeaderString({ payload, secret: options.badSignature ? "whsec_wrong_local_secret" : webhookSecret });
      return POST(new Request("http://localhost/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": signature }, body: payload }));
    };
    const booking = async (id: string) => (await db.query("SELECT * FROM bookings WHERE id=$1", [id])).rows[0];
    const count = async (table: string, column: string, id: string) => (await db.query(`SELECT count(*)::integer AS count FROM ${table} WHERE ${column}=$1`, [id])).rows[0].count;
    const assertSettled = async (f: Awaited<ReturnType<typeof fixture>>) => {
      const paid = await booking(f.bookingId);
      assert.equal(paid.payment_status, "paid");
      assert.equal(paid.payment_release_status, "awaiting_customer");
      assert.equal(paid.processing_fee_status, "final");
      assert.equal(paid.stripe_processing_fee_cents, 213);
      assert.equal(paid.provider_processing_fee_cents, 203);
      assert.equal(paid.provider_payout_cents, 5197);
      assert.equal(paid.stripe_payment_intent_id, f.checkout.payment_intent);
      assert.ok(paid.paid_at);
      assert.ok(paid.completion_confirmation_due_at);
      assert.equal(paid.payout_released_at, null);
      const events = (await db.query("SELECT * FROM booking_events WHERE booking_id=$1", [f.bookingId])).rows;
      assert.equal(events.length, 1);
      assert.equal(events[0].event_type, "payment_received");
      assert.deepEqual(events[0].metadata, { checkoutSessionId: f.checkout.id });
      const recipients = (await db.query("SELECT user_id FROM notifications WHERE booking_id=$1 ORDER BY user_id", [f.bookingId])).rows;
      assert.deepEqual(recipients.map((row: any) => row.user_id), ["customer", "provider"]);
      assert.equal(await count("analytics_events", "target_id", f.bookingId), 1);
    };

    await t.test("first signed hourly payment and same/different-event duplicates settle once", async () => {
      const f = await fixture();
      const response = await send(f);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { received: true });
      await assertSettled(f);
      const original = await booking(f.bookingId);
      assert.deepEqual(await (await send(f)).json(), { received: true, duplicate: true });
      assert.equal((await send(f, { eventId: f.eventId + "_async", type: "checkout.session.async_payment_succeeded" })).status, 200);
      await assertSettled(f);
      assert.deepEqual((await booking(f.bookingId)).paid_at, original.paid_at);
      assert.deepEqual((await booking(f.bookingId)).completion_confirmation_due_at, original.completion_confirmation_due_at);
      assert.equal(chargeCalls, 1);
    });

    for (const failure of ["UPDATE bookings SET stripe_processing_fee_cents", "INSERT INTO booking_events", "'Payment received',"]) {
      await t.test(`database failure at ${failure} rolls back, then the signed retry completes once`, async () => {
        const f = await fixture();
        failures.push(failure);
        assert.equal((await send(f)).status, 500);
        assert.equal(failures.length, 0, "the intended production SQL was reached");
        const unpaid = await booking(f.bookingId);
        assert.equal(unpaid.payment_status, "pending");
        assert.equal(unpaid.paid_at, null);
        assert.equal(unpaid.processing_fee_status, "pending");
        assert.equal(unpaid.stripe_processing_fee_cents, null);
        assert.equal(await count("booking_events", "booking_id", f.bookingId), 0);
        assert.equal(await count("notifications", "booking_id", f.bookingId), 0);
        assert.equal(await count("stripe_webhook_events", "id", f.eventId), 0);
        assert.equal((await send(f)).status, 200);
        await assertSettled(f);
        assert.deepEqual(await (await send(f)).json(), { received: true, duplicate: true });
      });
    }

    await t.test("a webhook-acknowledgment failure retries without duplicating committed settlement", async () => {
      const f = await fixture();
      failures.push("UPDATE stripe_webhook_events SET status");
      assert.equal((await send(f)).status, 500);
      await assertSettled(f);
      assert.equal((await send(f)).status, 200);
      await assertSettled(f);
      assert.equal((await db.query("SELECT status FROM stripe_webhook_events WHERE id=$1", [f.eventId])).rows[0].status, "processed");
    });

    await t.test("an event arriving before session persistence remains retryable", async () => {
      const f = await fixture();
      await db.query("UPDATE bookings SET stripe_checkout_session_id=NULL WHERE id=$1", [f.bookingId]);
      assert.equal((await send(f)).status, 500);
      assert.equal((await booking(f.bookingId)).payment_status, "pending");
      assert.equal(await count("stripe_webhook_events", "id", f.eventId), 0);
      await db.query("UPDATE bookings SET stripe_checkout_session_id=$2 WHERE id=$1", [f.bookingId, f.checkout.id]);
      assert.equal((await send(f)).status, 200);
      await assertSettled(f);
    });

    await t.test("invalid signature and wrong Stripe mode cannot claim or settle an event", async () => {
      const f = await fixture();
      assert.equal((await send(f, { badSignature: true })).status, 400);
      assert.equal((await send(f, { livemode: true })).status, 400);
      assert.equal(await count("stripe_webhook_events", "id", f.eventId), 0);
      assert.equal((await booking(f.bookingId)).payment_status, "pending");
    });

    await t.test("legacy fixed-price payments still settle through the same handler", async () => {
      const f = await fixture(false);
      assert.equal((await send(f)).status, 200);
      await assertSettled(f);
    });

    await t.test("a later success event never revives a refunded payment", async () => {
      const f = await fixture();
      assert.equal((await send(f)).status, 200);
      await db.query("UPDATE bookings SET payment_status='refunded', payment_release_status='reversed' WHERE id=$1", [f.bookingId]);
      const refunded = await booking(f.bookingId);
      const beforeChargeCalls = chargeCalls;
      assert.equal((await send(f, { eventId: f.eventId + "_late", type: "checkout.session.async_payment_succeeded" })).status, 200);
      const unchanged = await booking(f.bookingId);
      assert.equal(unchanged.payment_status, "refunded");
      assert.equal(unchanged.payment_release_status, "reversed");
      assert.deepEqual(unchanged.paid_at, refunded.paid_at);
      assert.deepEqual(unchanged.completion_confirmation_due_at, refunded.completion_confirmation_due_at);
      assert.equal(chargeCalls, beforeChargeCalls);
      assert.equal(await count("booking_events", "booking_id", f.bookingId), 1);
      assert.equal(await count("notifications", "booking_id", f.bookingId), 2);
    });

    await t.test("a mismatched paid amount does not mutate the booking", async () => {
      const f = await fixture();
      intents.get(f.checkout.payment_intent).amount_received = 6300;
      assert.equal((await send(f)).status, 500);
      assert.equal((await booking(f.bookingId)).payment_status, "pending");
      assert.equal(await count("booking_events", "booking_id", f.bookingId), 0);
      assert.equal(await count("notifications", "booking_id", f.bookingId), 0);
      intents.get(f.checkout.payment_intent).amount_received = 6299;
      assert.equal((await send(f)).status, 200);
      await assertSettled(f);
    });

    await t.test("unavailable Stripe fee data keeps payout pending without losing payment notifications", async () => {
      const f = await fixture();
      pendingFee = true;
      try { assert.equal((await send(f)).status, 200); } finally { pendingFee = false; }
      assert.equal((await booking(f.bookingId)).payment_status, "paid");
      assert.equal((await booking(f.bookingId)).processing_fee_status, "pending");
      assert.equal(await count("booking_events", "booking_id", f.bookingId), 1);
      assert.equal(await count("notifications", "booking_id", f.bookingId), 2);
    });

    const transferFixture = async () => {
      const f = await fixture(false); assert.equal((await send(f)).status, 200);
      await db.query("UPDATE bookings SET stripe_transfer_id=$2, payment_release_status='paid_out', payout_failure_reason='Transfer recovery needs review' WHERE id=$1", [f.bookingId, "tr_test_" + f.bookingId]);
      return f;
    };
    const reverse = async (f: Awaited<ReturnType<typeof fixture>>, amountReversed: number, suffix: string, options: { transferId?: string; livemode?: boolean } = {}) => {
      const payload = JSON.stringify({ id: f.eventId + suffix, object: "event", type: "transfer.reversed", livemode: options.livemode ?? false,
        created: Math.floor(Date.now() / 1000), data: { object: { id: options.transferId ?? "tr_test_" + f.bookingId,
          object: "transfer", amount: 5197, amount_reversed: amountReversed, destination: "acct_test", source_transaction: "ch_test_" + f.bookingId,
          metadata: { bookingId: f.bookingId, kind: "provider_payout" } } } });
      return POST(new Request("http://localhost/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": signatureTools.generateTestHeaderString({ payload, secret: webhookSecret }) }, body: payload }));
    };
    const reversalEvents = async (id: string) => (await db.query("SELECT * FROM booking_events WHERE booking_id=$1 AND event_type='transfer_reversed'", [id])).rows;

    await t.test("original untyped transfer reversal subtraction reproduces PostgreSQL ambiguous operator", async () => {
      const f = await transferFixture();
      await assert.rejects(db.query(`UPDATE bookings SET
        payment_release_status = CASE WHEN $3 THEN 'reversed' ELSE 'partially_released' END,
        provider_payout_cents = GREATEST(0, $4 - $5),
        payout_failure_reason = CASE WHEN $3 THEN 'The provider transfer was reversed through Stripe.' ELSE 'Part of the provider transfer was reversed through Stripe.' END
        WHERE id::text = $1 AND stripe_transfer_id = $2 AND stripe_mode = $6`,
      [f.bookingId, "tr_test_" + f.bookingId, true, 5197, 5197, "test"]), { code: "42725" });
    });

    await t.test("signed transfer reversals retain original principal and monotonic recovery across duplicate/out-of-order events", async () => {
      const f = await transferFixture();
      // Repair the old handler's net-payout representation using the signed original amount.
      await db.query("UPDATE bookings SET provider_payout_cents=3197 WHERE id=$1", [f.bookingId]);
      assert.equal((await reverse(f, 2000, "_partial")).status, 200);
      let row = await booking(f.bookingId); assert.equal(row.provider_payout_cents, 5197); assert.equal(row.stripe_transfer_reversed_cents, 2000);
      assert.equal(row.provider_payout_cents - row.stripe_transfer_reversed_cents, 3197); assert.equal(row.payment_release_status, "partially_released");
      assert.equal(row.payout_failure_reason, "Transfer recovery needs review");
      assert.equal((await reverse(f, 2000, "_partial")).status, 200);
      assert.equal((await reverse(f, 2000, "_duplicate")).status, 200); assert.equal((await reversalEvents(f.bookingId)).length, 1);
      assert.equal((await reverse(f, 5197, "_full")).status, 200);
      assert.equal((await reverse(f, 2000, "_stale")).status, 200);
      assert.equal((await reverse(f, 5197, "_full_duplicate")).status, 200);
      row = await booking(f.bookingId); assert.equal(row.provider_payout_cents, 5197); assert.equal(row.stripe_transfer_reversed_cents, 5197);
      assert.equal(row.payment_release_status, "reversed"); assert.equal(row.payout_failure_reason, null);
      assert.equal((await reversalEvents(f.bookingId)).length, 2);
    });
    await t.test("transfer reversal audit failure rolls back financial fields and retries once", async () => {
      const f = await transferFixture(); failures.push("'transfer_reversed'");
      assert.equal((await reverse(f, 5197, "_retry")).status, 500); assert.equal(failures.length, 0);
      const row = await booking(f.bookingId); assert.equal(row.provider_payout_cents, 5197); assert.equal(row.stripe_transfer_reversed_cents, 0);
      assert.equal(row.payment_release_status, "paid_out"); assert.equal(row.payout_failure_reason, "Transfer recovery needs review");
      assert.equal((await reversalEvents(f.bookingId)).length, 0);
      assert.equal((await reverse(f, 5197, "_retry")).status, 200); assert.equal((await reverse(f, 5197, "_another")).status, 200);
      assert.equal((await booking(f.bookingId)).stripe_transfer_reversed_cents, 5197); assert.equal((await reversalEvents(f.bookingId)).length, 1);
    });
    await t.test("signed full transfer reversal before charge-refund reconciliation does not recreate recovery warning", async () => {
      const f = await transferFixture(); assert.equal((await reverse(f, 5197, "_first")).status, 200);
      await recordBookingChargeRefund({ bookingId: f.bookingId, paymentIntentId: f.checkout.payment_intent, mode: "test", fullyRefunded: true, amountRefunded: 6299, chargeAmount: 6299 });
      const row = await booking(f.bookingId); assert.equal(row.payout_failure_reason, null); assert.equal(row.payment_release_status, "reversed");
      assert.equal(row.provider_payout_cents, 5197); assert.equal(row.stripe_transfer_reversed_cents, 5197);
    });
    await t.test("unmatched transfer and wrong-mode reversal cannot change state or record audit", async () => {
      const f = await transferFixture();
      assert.equal((await reverse(f, 5197, "_wrong_transfer", { transferId: "tr_test_unrelated" })).status, 200);
      assert.equal((await reverse(f, 5197, "_wrong_mode", { livemode: true })).status, 400);
      assert.equal((await booking(f.bookingId)).stripe_transfer_reversed_cents, 0);
      assert.equal((await booking(f.bookingId)).payment_release_status, "paid_out"); assert.equal((await reversalEvents(f.bookingId)).length, 0);
    });
    await t.test("concurrent distinct signed reversal events record one audit under PostgreSQL row lock", { skip: !postgres }, async () => {
      const f = await transferFixture();
      const results = await Promise.all([reverse(f, 5197, "_concurrent_a"), reverse(f, 5197, "_concurrent_b")]);
      assert.deepEqual(results.map((response) => response.status), [200, 200]);
      assert.equal((await reversalEvents(f.bookingId)).length, 1); assert.equal((await booking(f.bookingId)).stripe_transfer_reversed_cents, 5197);
    });

    const disputeEvent = async (f: Awaited<ReturnType<typeof fixture>>, status = "needs_response", suffix = status, disputeId = "du_test_" + f.bookingId) => {
      const payload = JSON.stringify({ id: f.eventId + "_dispute_" + suffix, object: "event", type: status === "needs_response" ? "charge.dispute.created" : "charge.dispute.closed", livemode: false,
        data: { object: { id: disputeId, charge: "ch_test_" + f.bookingId, payment_intent: f.checkout.payment_intent, status, reason: "fraudulent", metadata: {} } } });
      return POST(new Request("http://localhost/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": signatureTools.generateTestHeaderString({ payload, secret: webhookSecret }) }, body: payload }));
    };
    const disputeAudits = async (id: string) => (await db.query("SELECT event_type FROM booking_events WHERE booking_id=$1 AND event_type LIKE 'stripe_dispute_%'", [id])).rows;
    const { releaseBookingPayout } = load("@/lib/payment-release");
    await t.test("dispute before payment linkage stays retryable, then freezes once after signed payment", async () => {
      const f = await fixture();
      assert.equal((await disputeEvent(f)).status, 500);
      assert.equal(await count("stripe_webhook_events", "id", f.eventId + "_dispute_needs_response"), 0);
      assert.equal((await booking(f.bookingId)).stripe_dispute_id, null);
      assert.equal((await send(f)).status, 200);
      assert.equal((await disputeEvent(f)).status, 200);
      assert.equal((await disputeEvent(f, "needs_response", "duplicate")).status, 200);
      assert.equal((await booking(f.bookingId)).payment_release_status, "frozen");
      assert.equal((await disputeAudits(f.bookingId)).length, 1);
      assert.equal((await releaseBookingPayout(f.bookingId, "customer")).ok, false);
      assert.equal(transferCalls, 0);
    });
    await t.test("unrecognized payment metadata is ignored and inconsistent linkage never attributes a booking", async () => {
      const unrelated = await fixture();
      intents.get(unrelated.checkout.payment_intent).metadata = { kind: "unrelated" };
      assert.equal((await disputeEvent(unrelated)).status, 200);
      assert.equal((await booking(unrelated.bookingId)).stripe_dispute_id, null);
      for (const field of ["latest_charge", "livemode"]) {
        const f = await fixture();
        intents.get(f.checkout.payment_intent)[field] = field === "livemode" ? true : "ch_test_other";
        assert.equal((await disputeEvent(f)).status, 500);
        assert.equal((await booking(f.bookingId)).stripe_dispute_id, null);
        assert.equal((await disputeAudits(f.bookingId)).length, 0);
      }
    });
    await t.test("close before linkage retries; terminal close before created never reopens", async () => {
      for (const status of ["won", "lost", "warning_closed"]) {
        const f = await fixture(false);
        assert.equal((await disputeEvent(f, status)).status, 500);
        assert.equal((await send(f)).status, 200);
        assert.equal((await disputeEvent(f, status)).status, 200);
        const terminal = await booking(f.bookingId);
        assert.equal((await disputeEvent(f, "needs_response", "late_open")).status, 200);
        assert.equal((await disputeEvent(f, status, "late_close")).status, 200);
        assert.equal((await booking(f.bookingId)).stripe_dispute_status, status);
        assert.equal((await booking(f.bookingId)).payment_release_status, status === "lost" ? "reversed" : "awaiting_customer");
        assert.deepEqual((await booking(f.bookingId)).stripe_dispute_closed_at, terminal.stripe_dispute_closed_at);
        assert.equal((await disputeAudits(f.bookingId)).length, 1);
      }
    });
    await t.test("payment settlement preserves an already-linked dispute hold and loss", async () => {
      for (const status of ["needs_response", "lost"]) {
        const f = await fixture();
        await db.query("UPDATE bookings SET stripe_charge_id=$2 WHERE id=$1", [f.bookingId, "ch_test_" + f.bookingId]);
        assert.equal((await disputeEvent(f, status)).status, 200);
        assert.equal((await send(f)).status, 200);
        assert.equal((await booking(f.bookingId)).payment_status, "paid");
        assert.equal((await booking(f.bookingId)).payment_release_status, status === "lost" ? "reversed" : "frozen");
      }
    });
    await t.test("winning closure preserves admin, refund, and booking dispute holds", async () => {
      for (const hold of ["admin", "refund", "booking"]) {
        const f = await fixture(); await send(f);
        if (hold === "admin") await db.query("UPDATE bookings SET payout_frozen_at=now(),payout_freeze_reason='Administrator review',payment_release_status='frozen' WHERE id=$1", [f.bookingId]);
        assert.equal((await disputeEvent(f)).status, 200);
        if (hold === "refund") await db.query("UPDATE bookings SET refund_status='requested' WHERE id=$1", [f.bookingId]);
        if (hold === "booking") await db.query("INSERT INTO booking_disputes VALUES ($1,'open')", [f.bookingId]);
        assert.equal((await disputeEvent(f, "won")).status, 200);
        const row = await booking(f.bookingId);
        assert.equal(row.payment_release_status, "frozen"); assert.ok(row.payout_frozen_at);
        assert.equal(row.payout_freeze_reason, hold === "admin" ? "Administrator review" : hold === "refund" ? "Refund requested" : "Open booking dispute");
      }
      const f = await fixture(); await send(f); await disputeEvent(f); await disputeEvent(f, "won");
      assert.equal((await booking(f.bookingId)).payment_release_status, "awaiting_customer");
      assert.equal((await booking(f.bookingId)).payout_frozen_at, null);
    });
    await t.test("authoritative disputed charge blocks payout without any dispute webhook", async () => {
      const f = await fixture(); await send(f);
      disputedCharges.add("ch_test_" + f.bookingId);
      const result = await releaseBookingPayout(f.bookingId, "automatic");
      assert.equal(result.ok, false); assert.match(result.error, /dispute/);
      assert.equal(transferCalls, 0);
      assert.equal((await booking(f.bookingId)).payment_release_status, "frozen");
      assert.equal((await booking(f.bookingId)).stripe_dispute_id, null);
    });
    await t.test("historical disputed flag permits signed favorable closures but not open or lost cases", async () => {
      for (const status of ["needs_response", "lost", "won", "warning_closed"]) {
        const f = await fixture(); await send(f); await disputeEvent(f, status);
        disputedCharges.add("ch_test_" + f.bookingId);
        disputeLists.set("ch_test_" + f.bookingId, { has_more: false, data: [{ id: "du_test_" + f.bookingId, charge: "ch_test_" + f.bookingId, payment_intent: f.checkout.payment_intent, livemode: false, status }] });
        const before = transferCalls;
        const result = await releaseBookingPayout(f.bookingId, "customer");
        const favorable = status === "won" || status === "warning_closed";
        assert.equal(result.ok, favorable);
        assert.equal(transferCalls, before + (favorable ? 1 : 0));
      }
    });
    await t.test("favorable payout preflight fails closed for stale, incomplete, denied, or mismatched dispute reads", async () => {
      for (const problem of ["empty", "missing_id", "has_more", "new_case", "escalated", "wrong_charge", "wrong_mode", "wrong_pi", "denied"]) {
        const f = await fixture(); await send(f); await disputeEvent(f, "won");
        const charge = "ch_test_" + f.bookingId;
        disputedCharges.add(charge);
        const item = { id: "du_test_" + f.bookingId, charge, payment_intent: f.checkout.payment_intent, livemode: false, status: "won" };
        const list = { has_more: false, data: [item] };
        if (problem === "empty") list.data = [];
        if (problem === "missing_id") item.id = "du_test_unrelated";
        if (problem === "has_more") list.has_more = true;
        if (problem === "new_case") list.data.push({ ...item, id: "du_test_new", status: "needs_response" });
        if (problem === "escalated") item.status = "needs_response";
        if (problem === "wrong_charge") item.charge = "ch_test_other";
        if (problem === "wrong_mode") item.livemode = true;
        if (problem === "wrong_pi") item.payment_intent = "pi_test_other";
        disputeLists.set(charge, problem === "denied" ? new Error("synthetic permission denial") : list);
        const before = transferCalls;
        const result = await releaseBookingPayout(f.bookingId, "customer");
        assert.equal(result.ok, false, problem); assert.match(result.error, /reconciliation/);
        assert.equal(transferCalls, before); assert.equal((await booking(f.bookingId)).payment_release_status, "frozen");
      }
    });
    await t.test("payout charge preflight rejects wrong charge identity, mode, and intent", async () => {
      for (const patch of [{ id: "ch_test_other" }, { livemode: true }, { payment_intent: "pi_test_other" }]) {
        const f = await fixture(); await send(f);
        chargeOverrides.set("ch_test_" + f.bookingId, patch);
        const before = transferCalls;
        assert.equal((await releaseBookingPayout(f.bookingId, "customer")).ok, false);
        assert.equal(transferCalls, before);
        assert.equal((await booking(f.bookingId)).payment_release_status, "frozen");
      }
    });
    await t.test("old terminal dispute cannot overwrite a later case on the same charge", async () => {
      const f = await fixture(); await send(f); await disputeEvent(f, "won");
      const nextId = "du_test_second_" + f.bookingId;
      await disputeEvent(f, "needs_response", "new_case", nextId);
      await disputeEvent(f, "won", "stale_close");
      await disputeEvent(f, "needs_response", "stale_open");
      const row = await booking(f.bookingId);
      assert.equal(row.stripe_dispute_id, nextId);
      assert.equal(row.stripe_dispute_status, "needs_response");
      assert.equal(row.payment_release_status, "frozen");
      assert.equal((await disputeAudits(f.bookingId)).length, 2);
    });
    await t.test("existing freeze ownership survives a legacy inconsistent release status", async () => {
      const f = await fixture(); await send(f);
      await db.query("UPDATE bookings SET payout_frozen_at=now(),payout_freeze_reason='Administrator review' WHERE id=$1", [f.bookingId]);
      const before = await booking(f.bookingId);
      await disputeEvent(f); await disputeEvent(f, "won");
      const after = await booking(f.bookingId);
      assert.equal(after.payment_release_status, "frozen");
      assert.equal(after.payout_freeze_reason, "Administrator review");
      assert.deepEqual(after.payout_frozen_at, before.payout_frozen_at);
    });
    await t.test("concurrent linked payment and dispute preserve the dispute outcome in both start orders", { skip: !postgres }, async () => {
      for (const status of ["needs_response", "lost"]) for (const paymentFirst of [true, false]) {
        const f = await fixture();
        await db.query("UPDATE bookings SET stripe_charge_id=$2 WHERE id=$1", [f.bookingId, "ch_test_" + f.bookingId]);
        const results = await Promise.all(paymentFirst ? [send(f), disputeEvent(f, status)] : [disputeEvent(f, status), send(f)]);
        assert.deepEqual(results.map(r => r.status), [200, 200]);
        const row = await booking(f.bookingId);
        assert.equal(row.payment_status, "paid");
        assert.equal(row.payment_release_status, status === "lost" ? "reversed" : "frozen");
        assert.equal((await disputeAudits(f.bookingId)).length, 1);
      }
    });
    await t.test("concurrent duplicate dispute events serialize their audit", { skip: !postgres }, async () => {
      const f = await fixture(); await send(f);
      const results = await Promise.all([disputeEvent(f, "needs_response", "parallel_a"), disputeEvent(f, "needs_response", "parallel_b")]);
      assert.deepEqual(results.map(r => r.status), [200, 200]);
      assert.equal((await disputeAudits(f.bookingId)).length, 1);
    });

    const payoutWarning = "Provider payout outcome requires reconciliation. Contact support before retrying.";
    const unknownPayoutFixture = async () => {
      const f = await fixture(false); await send(f);
      await db.query("UPDATE bookings SET payment_release_status='processing',payout_failure_reason=$2 WHERE id=$1", [f.bookingId, payoutWarning]); return f;
    };
    const transferCreated = async (f: Awaited<ReturnType<typeof fixture>>, patch: Record<string, unknown> = {}, livemode = false) => {
      const payload = JSON.stringify({ id: "evt_test_transfer_" + randomUUID(), object: "event", type: "transfer.created", livemode,
        data: { object: { id: "tr_test_" + f.bookingId, object: "transfer", amount: 5197, destination: "acct_test",
          source_transaction: "ch_test_" + f.bookingId, metadata: { bookingId: f.bookingId, kind: "provider_payout" }, ...patch } } });
      return POST(new Request("http://localhost/api/stripe/webhook", { method: "POST", headers: {
        "stripe-signature": signatureTools.generateTestHeaderString({ payload, secret: webhookSecret }),
      }, body: payload }));
    };
    await t.test("signed delayed transfer confirms only matching kind, mode, amount, destination and source", async () => {
      for (const patch of [{ amount: 5196 }, { destination: "acct_unrelated" }, { source_transaction: "ch_test_unrelated" },
        { metadata: { kind: "unrelated" } }, { source_transaction: null }]) {
        const f = await unknownPayoutFixture(); assert.equal((await transferCreated(f, patch)).status, 200);
        assert.equal((await booking(f.bookingId)).stripe_transfer_id, null); assert.equal((await booking(f.bookingId)).payout_failure_reason, payoutWarning);
      }
      const f = await unknownPayoutFixture(); assert.equal((await transferCreated(f, {}, true)).status, 400);
      assert.equal((await transferCreated(f)).status, 200); let row = await booking(f.bookingId);
      assert.equal(row.stripe_transfer_id, "tr_test_" + f.bookingId); assert.equal(row.payment_release_status, "paid_out"); assert.equal(row.payout_failure_reason, null);
      assert.equal((await transferCreated(f, { id: "tr_test_unrelated" })).status, 200); row = await booking(f.bookingId);
      assert.equal(row.stripe_transfer_id, "tr_test_" + f.bookingId);
    });
    for (const status of ["needs_response", "lost"]) await t.test(`late signed transfer after ${status} chargeback retains recovery state`, async () => {
      const f = await unknownPayoutFixture(); assert.equal((await disputeEvent(f, status)).status, 200);
      assert.equal((await transferCreated(f)).status, 200); const row = await booking(f.bookingId);
      assert.equal(row.stripe_transfer_id, "tr_test_" + f.bookingId); assert.equal(row.provider_payout_cents, 5197); assert.equal(row.stripe_transfer_reversed_cents, 0);
      assert.equal(row.payment_release_status, "frozen"); assert.ok(row.payout_frozen_at); assert.match(row.payout_failure_reason, /recovery/);
    });
    await t.test("late signed transfer after full refund preserves principal and requires recovery", async () => {
      const f = await unknownPayoutFixture();
      await recordBookingChargeRefund({ bookingId: f.bookingId, paymentIntentId: f.checkout.payment_intent, mode: "test", fullyRefunded: true, amountRefunded: 6299, chargeAmount: 6299 });
      assert.equal((await booking(f.bookingId)).provider_payout_cents, 5197);
      assert.equal((await transferCreated(f)).status, 200); const row = await booking(f.bookingId);
      assert.equal(row.stripe_transfer_id, "tr_test_" + f.bookingId); assert.equal(row.payment_release_status, "frozen"); assert.match(row.payout_failure_reason, /recovery/);
    });
    await t.test("signed reversal before transfer-created commits identity and recovery together", async () => {
      const f = await unknownPayoutFixture(); failures.push("'transfer_reversed'");
      assert.equal((await reverse(f, 5197, "_unknown_retry")).status, 500);
      let row = await booking(f.bookingId); assert.equal(row.stripe_transfer_id, null); assert.equal(row.stripe_transfer_reversed_cents, 0); assert.equal(row.payout_failure_reason, payoutWarning);
      assert.equal((await reverse(f, 5197, "_unknown_retry")).status, 200); assert.equal((await transferCreated(f)).status, 200);
      row = await booking(f.bookingId); assert.equal(row.stripe_transfer_id, "tr_test_" + f.bookingId);
      assert.equal(row.stripe_transfer_reversed_cents, 5197); assert.equal(row.payment_release_status, "reversed"); assert.equal(row.payout_failure_reason, null);
    });
    await t.test("PostgreSQL never exposes matched transfer identity without its signed reversal", { skip: !postgres }, async () => {
      const f = await unknownPayoutFixture();
      let entered!: () => void, finish!: () => void;
      const identified = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { finish = resolve; });
      afterQuery = async (sql) => { if (sql.startsWith("UPDATE bookings SET stripe_transfer_id = COALESCE")) { afterQuery = async () => {}; entered(); await gate; } };
      const reversing = reverse(f, 5197, "_atomic"); await identified;
      try {
        const row = await booking(f.bookingId); assert.equal(row.stripe_transfer_id, null); assert.equal(row.stripe_transfer_reversed_cents, 0); assert.equal(row.payout_failure_reason, payoutWarning);
        const claim = await db.query(`UPDATE bookings SET refund_status='processing' WHERE id=$1
          AND payment_release_status <> 'processing' AND payout_failure_reason IS DISTINCT FROM $2 RETURNING id`, [f.bookingId, payoutWarning]);
        assert.equal(claim.rowCount, 0);
      } finally { finish(); afterQuery = async () => {}; }
      assert.equal((await reversing).status, 200); assert.equal((await booking(f.bookingId)).stripe_transfer_reversed_cents, 5197);
    });
    await t.test("PostgreSQL dispute creation waits across the payout claim commit and Stripe send", { skip: !postgres }, async () => {
      const f = await fixture(false); await send(f);
      let entered!: () => void, finish!: () => void;
      const sending = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { finish = resolve; });
      duringTransfer = async () => { entered(); await gate; };
      const releasing = releaseBookingPayout(f.bookingId, "customer"); await sending;
      let disputeFinished = false;
      const disputing = disputeEvent(f).then((response: Response) => { disputeFinished = true; return response; });
      try {
        await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(disputeFinished, false);
        const row = await booking(f.bookingId); assert.equal(row.payment_release_status, "processing"); assert.equal(row.payout_failure_reason, payoutWarning);
      } finally { finish(); duringTransfer = async () => {}; }
      assert.equal((await releasing).ok, true); assert.equal((await disputing).status, 200);
      const row = await booking(f.bookingId); assert.equal(row.stripe_transfer_id, "tr_test_new"); assert.match(row.payout_failure_reason, /recovery/);
    });

    await t.test("all webhook booking-event JSON queries execute with typed parameters", async () => {
      const f = await fixture();
      const parameters: Record<string, unknown[]> = {
        payment_received: [f.bookingId, "cs_test_json"],
        tip_paid: [f.bookingId, randomUUID(), 500, "cs_test_tip"],
        tip_review_required: [f.bookingId, randomUUID(), 50000],
        transfer_reversed: [f.bookingId, "Transfer reversed", "tr_test_json", 500],
        stripe_dispute_opened: [f.bookingId, "Dispute opened", "dp_test_json", "fraudulent", false],
        stripe_dispute_closed: [f.bookingId, "Dispute closed", "dp_test_json", "won"],
      };
      const source = ts.createSourceFile("route.ts", readFileSync("app/api/stripe/webhook/route.ts", "utf8"), ts.ScriptTarget.Latest, true);
      const queries: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isNoSubstitutionTemplateLiteral(node) && node.text.includes("INSERT INTO booking_events") && node.text.includes("jsonb_build_object")) queries.push(node.text);
        ts.forEachChild(node, visit);
      };
      visit(source);
      assert.equal(queries.length, Object.keys(parameters).length);
      for (const sql of queries) {
        const eventType = Object.keys(parameters).find((key) => sql.includes(`'${key}'`));
        assert.ok(eventType, "every production event query has a runtime fixture");
        await db.query(sql, parameters[eventType]);
      }
      const rows = (await db.query("SELECT event_type,metadata FROM booking_events WHERE booking_id=$1", [f.bookingId])).rows;
      assert.equal(rows.length, 6);
      assert.equal(rows.find((row: any) => row.event_type === "tip_paid").metadata.amountCents, 500);
      assert.equal(rows.find((row: any) => row.event_type === "stripe_dispute_opened").metadata.payoutAlreadySent, false);
    });
  } finally {
    if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
    await cleanup();
  }
});
