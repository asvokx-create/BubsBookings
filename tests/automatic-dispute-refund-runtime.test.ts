/* eslint-disable @typescript-eslint/no-explicit-any -- Execute production SQL with fake Stripe/auth boundaries. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);
for (const postgres of [false, true]) test(`${postgres ? "PostgreSQL" : "PGlite"} automatic and dispute refunds`, {
  skip: postgres && process.env.BOOKME_MIGRATION_TEST_DATABASE !== "1",
}, async (t) => {
  let db: any;
  let connect: () => Promise<any>;
  let cleanup: () => Promise<void>;
  if (postgres) {
    const connectionString = process.env.DATABASE_URL ?? "postgresql://bookme:bookme@127.0.0.1:5432/bookme";
    const url = new URL(connectionString);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.port === "55432") throw new Error("Refund tests require a dedicated local test database, never the application database.");
    const schema = "automatic_refund_test_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString, ssl: false });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString, ssl: false, options: `-c search_path=${schema}` });
    db = { query: (sql: string, values: unknown[] = []) => pool.query(sql, values), exec: (sql: string) => pool.query(sql) };
    connect = () => pool.connect();
    cleanup = async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); };
  } else {
    db = new PGlite(); connect = async () => ({ query: db.query.bind(db), release: () => {} }); cleanup = () => db.close();
  }
  let failure = "";
  let stripeError: any;
  let reversalError: any;
  let transferError: any;
  let unlockFailure = false;
  let lockResponseFailure = false;
  const releasedClients: boolean[] = [];
  let refundStatus = "succeeded";
  let userId = "provider";
  const calls: any[] = [], reversals: any[] = [], transfers: any[] = [];
  let duringRefund: () => Promise<void> = async () => {};
  let duringReversal: () => Promise<void> = async () => {};
  let duringTransfer: () => Promise<void> = async () => {};
  let beforeQuery: (sql: string) => Promise<void> = async () => {};
  const wrap = (target: any) => async (sql: string, values: unknown[] = []) => {
    await beforeQuery(sql);
    if (unlockFailure && sql.includes("pg_advisory_unlock")) { unlockFailure = false; throw new Error("Synthetic unlock uncertainty"); }
    if (lockResponseFailure && sql.includes("SELECT pg_advisory_lock(")) {
      lockResponseFailure = false; await target.query(sql, values); throw new Error("Synthetic lost acquisition response");
    }
    if (failure && sql.includes(failure)) { failure = ""; return target.query("SELECT 1 / 0"); }
    const result = await target.query(sql, values);
    return { ...result, rowCount: result.rowCount ?? (result.affectedRows || result.rows.length) };
  };
  const database = { query: wrap(db), connect: async () => {
    const client = await connect(); return { query: wrap(client), release: (discard = false) => { releasedClients.push(discard); client.release(discard); } };
  } };
  t.mock.method(console, "error", () => {});
  const replacements: Record<string, any> = {
    "server-only": {}, "next/headers": { headers: async () => new Headers() },
    "@/lib/database": { database },
    "@/lib/auth": { auth: { api: { getSession: async () => ({ user: { id: userId, email: "provider@example.invalid" } }) } } },
    "@/lib/admin": { getAdminSession: async () => ({ user: { id: "admin" } }), hasAdminAccess: async () => false },
    "@/lib/request-security": { enforceRateLimit: async () => true, recordActivity: async () => {} },
    "@/lib/content-safety": { checkAndRecordContent: async () => ({ allowed: true }) },
    "@/lib/analytics": { recordAnalytics: async () => {} },
    "@/lib/affiliates": { syncAffiliateCommissionForBooking: async () => {} },
    "@/lib/booking-financials": { stripeOperationKey: () => "synthetic" },
    "@/lib/booking-processing-fees": { reconcileBookingProcessingFee: async () => ({ status: "final" }) },
    "@/lib/plans": { PLAN_ENTITLEMENTS: { free: { bookingFeePercent: 10 } } },
    "@/lib/stripe": { getStripeMode: () => "test", isStripeReady: () => true, getStripe: () => ({
      refunds: { create: async (params: any, options: any) => {
        assert.ok(params.payment_intent.startsWith("pi_test_")); calls.push({ params, options });
        await duringRefund(); if (stripeError) throw stripeError;
        return { id: "re_test_" + calls.length, status: refundStatus };
      } },
      charges: { retrieve: async (id: string) => {
        const booking = (await db.query("SELECT * FROM bookings WHERE stripe_charge_id=$1", [id])).rows[0];
        return { id, livemode: false, currency: "usd", amount: booking.customer_total_cents,
          amount_refunded: booking.refunded_amount_cents + booking.customer_service_fee_refunded_cents,
          refunded: booking.payment_status === "refunded", disputed: false, payment_intent: booking.stripe_payment_intent_id };
      } },
      transfers: { create: async (params: any, options: any) => {
        transfers.push({ params, options }); await duringTransfer(); if (transferError) throw transferError; return { id: "tr_test_created" };
      }, createReversal: async (id: string, params: any, options: any) => {
        assert.equal(id, "tr_test_existing"); reversals.push({ params, options });
        await duringReversal(); if (reversalError) throw reversalError;
        return { id: "trr_test_" + reversals.length };
      } },
    }) },
  };
  const cache = new Map<string, any>();
  const load = (name: string, from = resolve("entry.ts")): any => {
    const file = name.startsWith("@/") ? resolve(name.slice(2) + ".ts") : name.startsWith(".") ? resolve(dirname(from), name + ".ts") : null;
    const key = file ? "@/" + file.slice(resolve(".").length + 1).replaceAll("\\", "/").slice(0, -3) : name;
    if (key in replacements) return replacements[key];
    if (!file) return nativeRequire(name);
    if (cache.has(file)) return cache.get(file);
    const output = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const mod = { exports: {} }; new Function("require", "module", "exports", output)((child: string) => load(child, file), mod, mod.exports);
    cache.set(file, mod.exports); return mod.exports;
  };
  try {
    await db.exec(`CREATE TABLE provider_profiles (id text PRIMARY KEY, user_id text, plan text DEFAULT 'free',
        age_verification_status text DEFAULT 'verified', stripe_connect_mode text DEFAULT 'test', stripe_payouts_enabled boolean DEFAULT true, stripe_account_id text DEFAULT 'acct_test');
      CREATE TABLE services (id text PRIMARY KEY, business_name text, title text);
      INSERT INTO provider_profiles(id,user_id) VALUES ('provider-profile','provider');
      INSERT INTO services VALUES ('service','Company','Repair');
      CREATE TABLE bookings (id uuid PRIMARY KEY, customer_id text DEFAULT 'customer', provider_id text DEFAULT 'provider-profile', service_id text DEFAULT 'service',
        price_cents integer DEFAULT 6000, payment_status text DEFAULT 'paid', refund_status text DEFAULT 'none', stripe_payment_intent_id text,
        stripe_mode text DEFAULT 'test', payment_flow text DEFAULT 'held_transfer_v1', payment_release_status text DEFAULT 'frozen',
        provider_payout_cents integer DEFAULT 5197, platform_fee_cents integer DEFAULT 600, stripe_transfer_id text, stripe_transfer_reversed_cents integer DEFAULT 0,
        refunded_amount_cents integer DEFAULT 0, customer_service_fee_cents integer DEFAULT 299, customer_service_fee_refunded_cents integer DEFAULT 0,
        status text DEFAULT 'completed', refund_amount_cents integer, refund_failure_reason text, stripe_refund_id text, refunded_at timestamptz,
        payout_frozen_at timestamptz DEFAULT now(), payout_frozen_by text DEFAULT 'customer', payout_freeze_reason text DEFAULT 'Open booking dispute', payout_failure_reason text,
        customer_total_cents integer DEFAULT 6299, refund_requested_by text, refund_reason text, refund_requested_at timestamptz,
        stripe_charge_id text, stripe_dispute_id text, stripe_dispute_status text, stripe_dispute_closed_at timestamptz,
        payout_released_at timestamptz, completion_confirmation_due_at timestamptz);
      CREATE TABLE booking_disputes (id uuid PRIMARY KEY, booking_id uuid, status text DEFAULT 'open', opened_by text DEFAULT 'customer',
        against_user_id text DEFAULT 'provider', admin_note text, resolution_outcome text, resolved_at timestamptz, resolved_by text, updated_at timestamptz);
      CREATE TABLE booking_events (booking_id uuid, actor_user_id text, event_type text, message text, metadata jsonb);
      CREATE TABLE notifications (user_id text, booking_id uuid, type text, title text, message text, href text, dedupe_key text UNIQUE);
      CREATE TABLE admin_audit_log (actor_user_id text, action text, target_type text, target_id text, details jsonb);`);
    const { refundUnreleasedBooking, releaseBookingPayout } = load("@/lib/payment-release");
    const { PATCH } = load("@/app/api/admin/issues/route");
    const { POST } = load("@/app/api/bookings/[bookingId]/refund/route");
    const { recordBookingChargeRefund } = load("@/lib/booking-refund-reconciliation");
    const { BOOKING_PAYOUT_RECONCILIATION, recordBookingPayoutTransfer } = load("@/lib/booking-payout-reconciliation");
    const fixture = async () => {
      failure = ""; stripeError = null; reversalError = null; transferError = null; unlockFailure = false; lockResponseFailure = false; releasedClients.length = 0;
      refundStatus = "succeeded"; userId = "provider"; calls.length = 0; reversals.length = 0; transfers.length = 0;
      duringRefund = async () => {}; duringReversal = async () => {}; duringTransfer = async () => {}; beforeQuery = async () => {};
      const id = randomUUID(), dispute = randomUUID();
      await db.query("INSERT INTO bookings(id,stripe_payment_intent_id,stripe_charge_id) VALUES($1,$2,$3)", [id, "pi_test_" + id, "ch_test_" + id]);
      await db.query("INSERT INTO booking_disputes(id,booking_id) VALUES($1,$2)", [dispute, id]); return { id, dispute };
    };
    const booking = async (id: string) => (await db.query("SELECT * FROM bookings WHERE id=$1", [id])).rows[0];
    const caseStatus = async (id: string) => (await db.query("SELECT status FROM booking_disputes WHERE id=$1", [id])).rows[0].status;
    const count = async (table: string, id: string) => (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE booking_id=$1`, [id])).rows[0].n;
    const full = (id: string) => refundUnreleasedBooking(id, "Synthetic cancellation");
    const partial = (dispute: string, amount = 30, outcome = "partial") => PATCH(new Request("http://localhost/admin/issues", {
      method: "PATCH", body: JSON.stringify({ type: "disputes", id: dispute, status: "resolved", note: "Synthetic decision", outcome, amount }),
    }));
    const manual = (id: string, action = "approve") => POST(new Request("http://localhost/refund", {
      method: "POST", body: JSON.stringify({ action, amount: 30, reason: "Synthetic reason" }),
    }), { params: Promise.resolve({ bookingId: id }) });
    const webhook = (id: string, amountRefunded = 6299) => recordBookingChargeRefund({ bookingId: id, paymentIntentId: "pi_test_" + id,
      mode: "test", fullyRefunded: amountRefunded === 6299, amountRefunded, chargeAmount: 6299 });
    const payoutFixture = async () => {
      const f = await fixture(); await db.query("UPDATE booking_disputes SET status='resolved' WHERE id=$1", [f.dispute]);
      await db.query("UPDATE bookings SET payout_frozen_at=NULL,payout_freeze_reason=NULL,payment_release_status='awaiting_customer' WHERE id=$1", [f.id]); return f;
    };
    const transferEvent = (id: string) => recordBookingPayoutTransfer({ bookingId: id, transferId: "tr_test_created", mode: "test",
      amountCents: 5197, connectedAccountId: "acct_test", sourceChargeId: "ch_test_" + id });

    await t.test("full success executes typed audit SQL atomically and is idempotent", async () => {
      const { id } = await fixture(); assert.equal((await full(id)).refunded, true);
      const row = await booking(id); assert.equal(row.payment_status, "refunded"); assert.equal(row.refund_status, "refunded");
      assert.equal(row.refunded_amount_cents, 6000); assert.equal(row.customer_service_fee_refunded_cents, 299); assert.equal(row.provider_payout_cents, 0);
      assert.equal(row.refund_failure_reason, null); assert.equal(await count("booking_events", id), 1); assert.equal(await count("notifications", id), 2);
      assert.equal((await full(id)).refunded, false); assert.equal(calls.length, 1);
      assert.equal(calls[0].params.amount, 6299); assert.equal(calls[0].options.idempotencyKey, `booking-auto-refund-test-${id}`);
    });
    for (const path of ["automatic", "partial", "customer"]) for (const status of ["pending", "failed", "canceled", "requires_action"]) {
      await t.test(`${path} ${status} is never called refunded or retried`, async () => {
        const { id, dispute } = await fixture(); refundStatus = status;
        if (path === "automatic") assert.equal((await full(id)).reconciliationRequired, true);
        else assert.equal((await partial(dispute, 30, path)).status, 202);
        const row = await booking(id); assert.equal(row.payment_status, "paid"); assert.equal(row.refund_status, "processing");
        assert.equal(row.refunded_amount_cents, 0); assert.equal(row.provider_payout_cents, 5197); assert.ok(row.refund_failure_reason);
        assert.equal(await caseStatus(dispute), "open"); assert.equal(await count("booking_events", id), 0); assert.equal(await count("notifications", id), 0);
        assert.equal(reversals.length, 0);
        if (path === "automatic") await full(id); else await partial(dispute, 30, path);
        assert.equal(calls.length, 1);
      });
    }
    for (const path of ["automatic", "partial"]) for (const code of ["approval_required", "ECONNRESET"]) {
      await t.test(`${path} ${code} and later partial webhook retain the operation claim`, async () => {
        const { id, dispute } = await fixture(); stripeError = Object.assign(new Error("Synthetic Stripe uncertainty"), { code });
        if (path === "automatic") assert.equal((await full(id)).ok, false);
        else assert.equal((await partial(dispute)).status, code === "approval_required" ? 202 : 502);
        assert.equal((await booking(id)).refund_status, "processing");
        await webhook(id, 1000); assert.equal((await booking(id)).refund_status, "refunded"); assert.ok((await booking(id)).refund_failure_reason);
        await full(id); await partial(dispute); assert.equal(calls.length, 1);
        userId = "customer"; assert.equal((await manual(id, "request")).status, 409);
      });
    }
    await t.test("manual, automatic, and partial paths share the same claim", async () => {
      const { id, dispute } = await fixture(); await db.query("UPDATE bookings SET refund_status='requested' WHERE id=$1", [id]);
      refundStatus = "pending"; assert.equal((await manual(id)).status, 202);
      assert.equal((await full(id)).ok, false); assert.equal((await partial(dispute)).status, 409); assert.equal(calls.length, 1);
      assert.equal((await booking(id)).refund_status, "processing");
    });
    for (const code of ["approval_required", "ECONNRESET", "pending"]) await t.test(`manual ${code} after an old partial webhook cannot unlock a cross-path refund or payout`, async () => {
      const { id, dispute } = await fixture();
      await db.query("UPDATE bookings SET refunded_amount_cents=1000,refund_status='requested' WHERE id=$1", [id]);
      duringRefund = async () => { await webhook(id, 1000); };
      if (code === "pending") refundStatus = "pending"; else stripeError = Object.assign(new Error("Synthetic uncertainty"), { code });
      assert.equal((await manual(id)).status, code === "ECONNRESET" ? 502 : 202);
      assert.equal((await booking(id)).refund_status, "refunded"); assert.ok((await booking(id)).refund_failure_reason);
      await full(id); assert.equal((await partial(dispute, 10)).status, 409); assert.equal(calls.length, 1);
      assert.equal((await partial(dispute, 0, "provider")).status, 502);
      assert.equal(await caseStatus(dispute), "open"); assert.equal((await booking(id)).payout_freeze_reason, "Open booking dispute");
      assert.equal((await releaseBookingPayout(id, "admin")).ok, false); assert.equal(transfers.length, 0);
    });
    await t.test("rejected-request explanation does not block an otherwise safe payout", async () => {
      const { id, dispute } = await fixture(); await db.query("UPDATE booking_disputes SET status='resolved' WHERE id=$1", [dispute]);
      await db.query("UPDATE bookings SET refund_status='rejected',refund_failure_reason='Request declined',payout_frozen_at=NULL,payout_freeze_reason=NULL,payment_release_status='awaiting_customer' WHERE id=$1", [id]);
      assert.equal((await releaseBookingPayout(id, "customer")).ok, true); assert.equal(transfers.length, 1);
    });
    await t.test("a second path cannot enter during an automatic Stripe request", async () => {
      const { id, dispute } = await fixture();
      duringRefund = async () => { assert.equal((await partial(dispute)).status, 409); assert.equal((await manual(id)).status, 409); };
      assert.equal((await full(id)).ok, true); assert.equal(calls.length, 1);
    });
    for (const path of ["automatic", "partial"]) await t.test(`${path} full webhook success survives a lost Stripe response`, async () => {
      const { id, dispute } = await fixture(); duringRefund = async () => { await webhook(id); }; stripeError = new Error("Lost response");
      if (path === "automatic") await full(id); else await partial(dispute);
      const row = await booking(id); assert.equal(row.payment_status, "refunded"); assert.equal(row.refund_status, "refunded");
      assert.equal(row.refund_failure_reason, null); assert.equal(row.provider_payout_cents, 0); assert.equal(row.refunded_amount_cents, 6000);
      assert.equal(row.customer_service_fee_refunded_cents, 299); assert.equal(row.payment_release_status, "reversed");
    });
    await t.test("a stale partial response cannot regress a newer full webhook or reverse a stale target", async () => {
      const { id, dispute } = await fixture(); duringRefund = async () => { await webhook(id); };
      assert.equal((await partial(dispute)).status, 502);
      const row = await booking(id); assert.equal(row.refunded_amount_cents, 6000); assert.equal(row.customer_service_fee_refunded_cents, 299);
      assert.equal(row.provider_payout_cents, 0); assert.equal(row.refund_failure_reason, null); assert.equal(row.payment_release_status, "reversed");
      assert.equal(reversals.length, 0); assert.equal(await count("notifications", id), 0);
    });
    for (const reason of ["Admin investigation", "Stripe chargeback under review"]) await t.test(`partial success preserves ${reason} ownership`, async () => {
      const { id, dispute } = await fixture(); await db.query("UPDATE bookings SET payout_freeze_reason=$2,payout_frozen_by='admin' WHERE id=$1", [id, reason]);
      const frozenAt = (await booking(id)).payout_frozen_at; duringRefund = async () => { await webhook(id, 3000); };
      assert.equal((await partial(dispute)).status, 200);
      const row = await booking(id); assert.equal(row.payout_freeze_reason, reason); assert.equal(row.payout_frozen_by, "admin");
      assert.deepEqual(row.payout_frozen_at, frozenAt); assert.equal(row.payment_release_status, "frozen"); assert.equal(row.provider_payout_cents, 2599);
      assert.equal(await caseStatus(dispute), "resolved"); assert.equal(await count("booking_events", id), 1); assert.equal(await count("notifications", id), 2);
    });
    await t.test("another open dispute retains its hold after partial settlement", async () => {
      const { id, dispute } = await fixture(); await db.query("INSERT INTO booking_disputes(id,booking_id) VALUES($1,$2)", [randomUUID(), id]);
      assert.equal((await partial(dispute)).status, 200); const row = await booking(id);
      assert.equal(row.payout_freeze_reason, "Open booking dispute"); assert.equal(row.payment_release_status, "frozen");
    });
    await t.test("partial success clears only its own completed dispute hold", async () => {
      const { id, dispute } = await fixture(); assert.equal((await partial(dispute)).status, 200);
      const row = await booking(id); assert.equal(row.provider_payout_cents, 2599); assert.equal(row.refunded_amount_cents, 3000);
      assert.equal(row.payout_frozen_at, null); assert.equal(row.payout_freeze_reason, null); assert.equal(row.payment_release_status, "awaiting_customer");
      assert.equal(row.refund_failure_reason, null); assert.equal((await partial(dispute)).status, 409); assert.equal(calls.length, 1);
      assert.equal(calls[0].options.idempotencyKey, `dispute-partial-refund-${dispute}-3000`);
      await webhook(id, 3000); await webhook(id, 1000);
      assert.equal((await booking(id)).refund_failure_reason, null, "equal/older webhooks cannot recreate uncertainty after owned settlement");
      assert.equal((await booking(id)).provider_payout_cents, 2599);
    });
    await t.test("external partial refund cannot establish a trusted remaining provider-share basis", async () => {
      const { id, dispute } = await fixture();
      await db.query("UPDATE bookings SET price_cents=1000,customer_total_cents=1299,provider_payout_cents=900 WHERE id=$1", [id]);
      await recordBookingChargeRefund({ bookingId: id, paymentIntentId: "pi_test_" + id, mode: "test", fullyRefunded: false, amountRefunded: 200, chargeAmount: 1299 });
      const row = await booking(id); assert.equal(row.refunded_amount_cents, 200); assert.equal(row.provider_payout_cents, 900); assert.ok(row.refund_failure_reason);
      assert.equal((await partial(dispute, 1)).status, 409); assert.equal((await full(id)).ok, false); assert.equal(calls.length, 0);
      assert.equal((await partial(dispute, 0, "provider")).status, 502); assert.equal(transfers.length, 0);
      assert.equal((await booking(id)).provider_payout_cents, 900); assert.equal(await caseStatus(dispute), "open");
    });
    await t.test("transferred partial refunds retain principal and require a proven basis before another refund", async () => {
      const { id, dispute } = await fixture(); await db.query("UPDATE bookings SET stripe_transfer_id='tr_test_existing',payment_release_status='paid_out' WHERE id=$1", [id]);
      assert.equal((await partial(dispute)).status, 200);
      let row = await booking(id); assert.equal(row.provider_payout_cents, 5197); assert.equal(row.stripe_transfer_reversed_cents, 2598);
      assert.equal(reversals[0].params.amount, 2598); assert.equal(reversals[0].options.idempotencyKey, `dispute-partial-reversal-${dispute}-2598`);
      const nextDispute = randomUUID(); await db.query("INSERT INTO booking_disputes(id,booking_id) VALUES($1,$2)", [nextDispute, id]);
      assert.equal((await partial(nextDispute, 10)).status, 409);
      row = await booking(id); assert.equal(row.provider_payout_cents, 5197); assert.equal(row.stripe_transfer_reversed_cents, 2598);
      assert.equal(calls.length, 1); assert.equal(reversals.length, 1);
    });
    await t.test("a refund before transfer cannot be discounted a second time after transfer", async () => {
      const { id, dispute } = await fixture();
      await db.query("UPDATE bookings SET price_cents=1000,customer_total_cents=1299,provider_payout_cents=900 WHERE id=$1", [id]);
      assert.equal((await partial(dispute, 2)).status, 200); assert.equal((await booking(id)).provider_payout_cents, 720);
      await db.query("UPDATE bookings SET stripe_transfer_id='tr_test_existing',payment_release_status='paid_out' WHERE id=$1", [id]);
      const nextDispute = randomUUID(); await db.query("INSERT INTO booking_disputes(id,booking_id) VALUES($1,$2)", [nextDispute, id]);
      assert.equal((await partial(nextDispute, 1)).status, 409); assert.equal(calls.length, 1); assert.equal(reversals.length, 0);
      assert.equal((await booking(id)).provider_payout_cents, 720);
    });
    for (const code of ["approval_required", "ECONNRESET"]) await t.test(`partial refund with ${code} recovery stays open without retrying money movement`, async () => {
      const { id, dispute } = await fixture(); await db.query("UPDATE bookings SET stripe_transfer_id='tr_test_existing',payment_release_status='paid_out' WHERE id=$1", [id]);
      reversalError = Object.assign(new Error("Synthetic recovery uncertainty"), { code });
      const response = await partial(dispute); assert.equal(response.status, 202); assert.equal((await response.json()).reconciliationRequired, true);
      const row = await booking(id); assert.equal(row.refund_status, "refunded"); assert.equal(row.refunded_amount_cents, 3000);
      assert.equal(row.provider_payout_cents, 5197); assert.equal(row.stripe_transfer_reversed_cents, 0); assert.ok(row.refund_failure_reason); assert.match(row.payout_failure_reason, /not confirmed/);
      assert.equal(await caseStatus(dispute), "open"); assert.equal(await count("notifications", id), 0);
      assert.equal((await partial(dispute, 10)).status, 409); assert.equal(calls.length, 1); assert.equal(reversals.length, 1);
    });
    await t.test("confirmed full reversal survives the reversal response being lost", async () => {
      const { id, dispute } = await fixture(); await db.query("UPDATE bookings SET stripe_transfer_id='tr_test_existing',payment_release_status='paid_out' WHERE id=$1", [id]);
      duringReversal = async () => { await db.query("UPDATE bookings SET stripe_transfer_reversed_cents=5197,payment_release_status='reversed',payout_failure_reason=NULL WHERE id=$1", [id]); };
      reversalError = new Error("Lost reversal response"); assert.equal((await partial(dispute)).status, 200);
      const row = await booking(id); assert.equal(row.provider_payout_cents, 5197); assert.equal(row.stripe_transfer_reversed_cents, 5197);
      assert.equal(row.payment_release_status, "reversed"); assert.equal(row.refund_failure_reason, null); assert.equal(row.payout_failure_reason, null);
    });
    for (const path of ["automatic", "partial"]) for (const sql of ["INSERT INTO booking_events", "INSERT INTO notifications", ...(path === "partial" ? ["INSERT INTO admin_audit_log"] : [])]) {
      await t.test(`${path} audit rollback at ${sql} preserves a durable non-retryable claim`, async () => {
        const { id, dispute } = await fixture(); failure = sql;
        if (path === "automatic") assert.equal((await full(id)).ok, false); else assert.equal((await partial(dispute)).status, 502);
        assert.equal(failure, ""); const row = await booking(id); assert.equal(row.refund_status, "processing"); assert.equal(row.refunded_amount_cents, 0);
        assert.equal(row.provider_payout_cents, 5197); assert.ok(row.refund_failure_reason); assert.equal(await count("booking_events", id), 0); assert.equal(await count("notifications", id), 0);
        await webhook(id, 1000); await full(id); await partial(dispute); assert.equal(calls.length, 1);
      });
    }
    await t.test("partial webhook before local audit rollback remains authoritative but cannot unlock another refund", async () => {
      const { id, dispute } = await fixture(); duringRefund = async () => { await webhook(id, 3000); }; failure = "INSERT INTO admin_audit_log";
      assert.equal((await partial(dispute)).status, 502); const row = await booking(id);
      assert.equal(row.refunded_amount_cents, 3000); assert.equal(row.refund_status, "refunded"); assert.ok(row.refund_failure_reason); assert.equal(row.provider_payout_cents, 5197);
      await partial(dispute, 10); await full(id); assert.equal(calls.length, 1);
    });
    await t.test("a payout winning before the partial claim prevents the stale refund snapshot", async () => {
      const { id, dispute } = await fixture(); beforeQuery = async (sql) => {
        if (sql.includes("UPDATE bookings SET refund_status = 'processing'")) {
          beforeQuery = async () => {}; await db.query("UPDATE bookings SET stripe_transfer_id='tr_test_existing',payment_release_status='paid_out' WHERE id=$1", [id]);
        }
      };
      assert.equal((await partial(dispute)).status, 409); assert.equal(calls.length, 0); assert.equal(await caseStatus(dispute), "open");
      assert.equal((await full(id)).refunded, false); assert.equal(calls.length, 0);
    });
    await t.test("customer decision audit rollback can close the confirmed refund without another Stripe request", async () => {
      const { id, dispute } = await fixture(); failure = "INSERT INTO admin_audit_log";
      assert.equal((await partial(dispute, 30, "customer")).status, 202); assert.equal((await booking(id)).payment_status, "refunded");
      assert.equal(await caseStatus(dispute), "open"); assert.equal((await partial(dispute, 30, "customer")).status, 200);
      assert.equal(calls.length, 1); assert.equal(await caseStatus(dispute), "resolved");
    });
    for (const code of ["approval_required", "ECONNRESET"]) await t.test(`unknown payout ${code} durably blocks all refund paths and repeat transfers`, async () => {
      const { id, dispute } = await payoutFixture(); transferError = Object.assign(new Error("Synthetic payout uncertainty"), { code });
      assert.equal((await releaseBookingPayout(id, "customer")).ok, false);
      const row = await booking(id); assert.equal(row.payment_release_status, "processing"); assert.equal(row.payout_failure_reason, BOOKING_PAYOUT_RECONCILIATION);
      assert.equal(row.stripe_transfer_id, null); assert.equal((await releaseBookingPayout(id, "automatic")).ok, false); assert.equal(transfers.length, 1);
      assert.equal((await full(id)).ok, false); userId = "customer"; assert.equal((await manual(id, "request")).status, 409);
      await db.query("UPDATE booking_disputes SET status='open' WHERE id=$1", [dispute]);
      assert.equal((await partial(dispute)).status, 409); assert.equal(calls.length, 0);
      await db.query("UPDATE bookings SET refund_status='requested' WHERE id=$1", [id]); userId = "provider";
      assert.equal((await manual(id)).status, 409); assert.equal(calls.length, 0);
    });
    for (const sql of ["INSERT INTO booking_events", "INSERT INTO notifications"]) await t.test(`known transfer survives ${sql} rollback without another transfer`, async () => {
      const { id } = await payoutFixture(); failure = sql;
      assert.equal((await releaseBookingPayout(id, "customer")).ok, false); assert.equal(failure, "");
      const row = await booking(id); assert.equal(row.stripe_transfer_id, "tr_test_created"); assert.equal(row.payment_release_status, "paid_out");
      assert.equal(row.payout_failure_reason, null); assert.equal(await count("booking_events", id), 0); assert.equal(await count("notifications", id), 0);
      assert.equal((await releaseBookingPayout(id, "customer")).released, false); assert.equal(transfers.length, 1);
      assert.equal((await full(id)).refunded, false); assert.equal(calls.length, 0);
    });
    await t.test("lost transfer response followed by full refund preserves principal for delayed transfer evidence", async () => {
      const { id } = await payoutFixture(); transferError = new Error("Lost transfer response"); await releaseBookingPayout(id, "customer");
      await webhook(id); let row = await booking(id);
      assert.equal(row.payment_status, "refunded"); assert.equal(row.provider_payout_cents, 5197); assert.equal(row.payout_failure_reason, BOOKING_PAYOUT_RECONCILIATION);
      assert.equal((await transferEvent(id)).rowCount, 1); row = await booking(id);
      assert.equal(row.stripe_transfer_id, "tr_test_created"); assert.equal(row.provider_payout_cents, 5197); assert.equal(row.payment_release_status, "frozen");
      assert.match(row.payout_failure_reason, /transfer recovery review/); assert.ok(row.payout_frozen_at);
      await transferEvent(id); assert.equal((await booking(id)).payout_failure_reason, row.payout_failure_reason);
    });
    await t.test("delayed transfer confirmation preserves a newer dispute hold", async () => {
      const { id } = await payoutFixture(); transferError = new Error("Lost transfer response"); await releaseBookingPayout(id, "customer");
      await db.query("UPDATE bookings SET payment_release_status='frozen',payout_frozen_at=now(),payout_freeze_reason='Stripe chargeback under review' WHERE id=$1", [id]);
      await transferEvent(id); const row = await booking(id); assert.equal(row.stripe_transfer_id, "tr_test_created");
      assert.equal(row.payment_release_status, "frozen"); assert.equal(row.payout_freeze_reason, "Stripe chargeback under review");
    });
    await t.test("unconfirmed unlock destroys the pooled client on an early return", async () => {
      const { id } = await fixture(); unlockFailure = true; assert.equal((await releaseBookingPayout(id, "customer")).ok, false);
      assert.equal(releasedClients.at(-1), true); assert.equal(transfers.length, 0);
    });
    await t.test("a lost session-lock acquisition response also destroys the pooled client", async () => {
      const { id } = await fixture(); lockResponseFailure = true;
      assert.equal((await releaseBookingPayout(id, "customer")).ok, false); assert.equal(releasedClients.at(-1), true); assert.equal(transfers.length, 0);
    });
    await t.test("durable payout claim, session lock, and row lock span the external send under PostgreSQL", { skip: !postgres }, async () => {
      const { id } = await payoutFixture();
      let entered!: () => void, finish!: () => void;
      const sending = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { finish = resolve; });
      duringTransfer = async () => { entered(); await gate; };
      const release = releaseBookingPayout(id, "customer"); await sending;
      const observer = await connect();
      try {
        const row = await booking(id); assert.equal(row.payment_release_status, "processing"); assert.equal(row.payout_failure_reason, BOOKING_PAYOUT_RECONCILIATION);
        assert.equal((await observer.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired", [`booking-payout:${id}`])).rows[0].acquired, false);
        await assert.rejects(observer.query("SELECT id FROM bookings WHERE id=$1 FOR UPDATE NOWAIT", [id]), { code: "55P03" });
      } finally { observer.release(); finish(); }
      assert.equal((await release).ok, true); assert.equal(transfers.length, 1);
      const after = await connect();
      try {
        assert.equal((await after.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired", [`booking-payout:${id}`])).rows[0].acquired, true);
        await after.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`booking-payout:${id}`]);
      } finally { after.release(); }
    });
  } finally { await cleanup(); }
});

test("admin issue UI preserves reconciliation warnings after refreshing the queue", async () => {
  const source = readFileSync("components/admin-issue-queue.tsx", "utf8");
  const start = source.indexOf("  async function update("); const end = source.indexOf("  const unresolvedBugs", start);
  assert.ok(start >= 0 && end > start);
  const output = ts.transpileModule(source.slice(start, end), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const status of [200, 202, 409, 502, 0]) {
    const errors: string[] = []; let refreshes = 0;
    const update = new Function("window", "setError", "setBusy", "fetch", "load", "type", output + "; return update;")(
      { prompt: (message: string) => message.includes("amount") ? "30" : "Synthetic reason", confirm: () => true },
      (message: string) => errors.push(message), () => {},
      async () => { if (!status) throw new Error("Lost response"); return Response.json(status === 200 ? { ok: true } : { error: "Refund needs reconciliation", reconciliationRequired: true }, { status }); },
      async () => { refreshes++; errors.push(""); }, "disputes");
    await update({ id: "case", admin_note: "" }, "resolved", "partial");
    assert.equal(refreshes, 1);
    if (status === 200) assert.equal(errors.at(-1), "");
    else assert.match(errors.at(-1)!, /reconciliation|could not be confirmed/);
  }
});
