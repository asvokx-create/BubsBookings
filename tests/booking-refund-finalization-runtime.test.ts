/* eslint-disable @typescript-eslint/no-explicit-any -- Production SQL, isolated databases, stateful fake Stripe. */
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
for (const postgres of [false, true]) test(`${postgres ? "PostgreSQL" : "PGlite"} durable refund finalization`, {
  skip: postgres && process.env.BOOKME_MIGRATION_TEST_DATABASE !== "1",
}, async (t) => {
  let db: any;
  let connect: () => Promise<any>;
  let cleanup: () => Promise<void>;
  if (postgres) {
    const connectionString = process.env.DATABASE_URL ?? "postgresql://bookme:bookme@127.0.0.1:5432/bookme";
    const url = new URL(connectionString);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.port === "55432") throw new Error("Finalization tests require a dedicated local test database, never the application database.");
    const schema = "refund_finalization_test_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString, ssl: false });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString, ssl: false, options: `-c search_path=${schema}` });
    db = { query: (sql: string, values: unknown[] = []) => pool.query(sql, values), exec: (sql: string) => pool.query(sql) };
    connect = () => pool.connect();
    cleanup = async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); };
  } else {
    db = new PGlite();
    connect = async () => ({ query: db.query.bind(db), release() {} });
    cleanup = () => db.close();
  }
  let failQuery = "";
  let failAffiliates = false;
  let queryStarted: (sql: string, target: any) => void = () => {};
  let afterQuery: (sql: string) => Promise<void> = async () => {};
  const queryFor = (target: any) => async (sql: string, values: unknown[] = []) => {
    if (!postgres && /SELECT pg_advisory_(lock|unlock)\(/.test(sql)) return { rows: [{ unlocked: true }], rowCount: 1 };
    if (failQuery && sql.includes(failQuery)) { failQuery = ""; return target.query("SELECT 1/0"); }
    const pending = target.query(sql, values);
    queryStarted(sql, target);
    const result = await pending;
    await afterQuery(sql);
    return { ...result, rowCount: result.rowCount ?? (result.affectedRows || result.rows.length) };
  };
  const database = { query: queryFor(db), connect: async () => {
    const client = await connect(); return { query: queryFor(client), release: () => client.release() };
  } };
  let refundError: any;
  let reversalError: any;
  let refundStatus = "succeeded";
  let beforeRefundReturn: () => Promise<void> = async () => {};
  let beforeReversalReturn: () => Promise<void> = async () => {};
  const refundCalls: any[] = [], reversalCalls: any[] = [];
  const payoutCalls: any[] = [];
  const refunds = new Map<string, any>(), charges = new Map<string, any>(), transfers = new Map<string, any>();
  const refundListErrors = new Set<string>();
  const copy = (value: any) => structuredClone(value);
  const list = (items: any[]) => Object.assign(Promise.resolve({ data: copy(items), has_more: false }), {
    autoPagingToArray: async () => copy(items),
    async *[Symbol.asyncIterator]() { for (const item of items) yield copy(item); },
  });
  const stripe = {
    refunds: {
      create: async (params: any, options: any) => {
        refundCalls.push(copy({ params, options }));
        await beforeRefundReturn();
        if (refundError) throw refundError;
        const charge = [...charges.values()].find(value => value.payment_intent === params.payment_intent);
        assert.ok(charge, "refund must belong to synthetic fixture");
        const refund = { id: "re_test_" + refundCalls.length, object: "refund", payment_intent: params.payment_intent,
          charge: charge.id, amount: params.amount, currency: "usd", status: refundStatus,
          metadata: copy(params.metadata), created: Math.floor(Date.now() / 1000) };
        refunds.set(refund.id, refund);
        if (refund.status === "succeeded") { charge.amount_refunded += refund.amount; charge.refunded = charge.amount_refunded === charge.amount; }
        return copy(refund);
      },
      retrieve: async (id: string) => { assert.ok(refunds.has(id)); return copy(refunds.get(id)); },
      list: (params: any) => {
        if (refundListErrors.has(params.payment_intent)) throw new Error("Synthetic refund read failure");
        return list([...refunds.values()].filter(r => !params.payment_intent || r.payment_intent === params.payment_intent).filter(r => !params.charge || r.charge === params.charge));
      },
    },
    charges: { retrieve: async (id: string) => { assert.ok(charges.has(id)); return copy(charges.get(id)); } },
    paymentIntents: { retrieve: async (id: string) => {
      const charge = [...charges.values()].find(value => value.payment_intent === id); assert.ok(charge);
      return { id, livemode: false, currency: "usd", amount: charge.amount, latest_charge: charge.id, metadata: copy(charge.metadata) };
    } },
    transfers: {
      create: async (params: any) => { payoutCalls.push(copy(params)); throw new Error("Unexpected synthetic payout dispatch"); },
      retrieve: async (id: string) => { assert.ok(transfers.has(id)); return copy(transfers.get(id)); },
      createReversal: async (id: string, params: any, options: any) => {
        reversalCalls.push(copy({ id, params, options }));
        await beforeReversalReturn();
        if (reversalError) throw reversalError;
        const transfer = transfers.get(id); assert.ok(transfer);
        assert.ok(params.amount > 0 && params.amount <= transfer.amount - transfer.amount_reversed);
        const reversal = { id: "trr_test_" + reversalCalls.length, object: "transfer_reversal", amount: params.amount,
          currency: "usd", transfer: id, metadata: copy(params.metadata), created: Math.floor(Date.now() / 1000) };
        transfer.amount_reversed += params.amount; transfer.reversed = transfer.amount_reversed === transfer.amount;
        transfer.reversals.data.push(reversal);
        return copy(reversal);
      },
      listReversals: (id: string) => list(transfers.get(id)?.reversals.data ?? []),
      retrieveReversal: async (id: string, reversalId: string) => copy(transfers.get(id)?.reversals.data.find((r: any) => r.id === reversalId)),
    },
  };
  const replacements: Record<string, any> = {
    "@/lib/booking-processing-fees": { reconcileBookingProcessingFee: async () => ({ status: "final" }) },
    "server-only": {}, "@/lib/database": { database },
    "@/lib/stripe": { getStripeMode: () => "test", isStripeReady: () => true, getStripe: () => stripe },
    "@/lib/affiliates": { syncAffiliateCommissionForBooking: async (id: string, client = database) => {
      if (failAffiliates) { failAffiliates = false; throw new Error("Synthetic affiliate transaction failure"); }
      await client.query("INSERT INTO synthetic_commissions(booking_id) VALUES($1) ON CONFLICT DO NOTHING", [id]);
    } },
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
  t.mock.method(console, "error", () => {});
  try {
    await db.exec(`CREATE TABLE provider_profiles(id text PRIMARY KEY,user_id text,stripe_account_id text DEFAULT 'acct_synthetic',stripe_connect_mode text DEFAULT 'test');
      CREATE TABLE services(id text PRIMARY KEY,title text,business_name text);
      INSERT INTO provider_profiles VALUES('provider-profile','provider','acct_synthetic','test');
      INSERT INTO services VALUES('service','Synthetic repair','Synthetic provider');
      CREATE TABLE bookings(id uuid PRIMARY KEY,customer_id text DEFAULT 'customer',provider_id text DEFAULT 'provider-profile',service_id text DEFAULT 'service',
        price_cents integer DEFAULT 100,customer_service_fee_cents integer DEFAULT 299,customer_total_cents integer DEFAULT 399,
        payment_status text DEFAULT 'paid',refund_status text DEFAULT 'requested',stripe_payment_intent_id text,stripe_charge_id text,
        stripe_mode text DEFAULT 'test',payment_flow text DEFAULT 'held_transfer_v1',payment_release_status text DEFAULT 'paid_out',
        provider_payout_cents integer DEFAULT 79,platform_fee_cents integer DEFAULT 10,stripe_transfer_id text,stripe_transfer_reversed_cents integer DEFAULT 0,
        refunded_amount_cents integer DEFAULT 0,customer_service_fee_refunded_cents integer DEFAULT 0,
        status text DEFAULT 'completed',refund_amount_cents integer DEFAULT 100,refund_failure_reason text,stripe_refund_id text,refunded_at timestamptz,
        payout_frozen_at timestamptz,payout_frozen_by text,payout_freeze_reason text,payout_failure_reason text,
        refund_requested_by text DEFAULT 'customer',refund_reason text,refund_requested_at timestamptz,stripe_dispute_id text,stripe_dispute_status text,stripe_dispute_closed_at timestamptz);
      CREATE TABLE booking_disputes(id uuid PRIMARY KEY,booking_id uuid,status text DEFAULT 'open',resolution_outcome text,resolved_at timestamptz,resolved_by text,
        admin_note text,opened_by text DEFAULT 'customer',against_user_id text DEFAULT 'provider',updated_at timestamptz DEFAULT now());
      CREATE TABLE booking_events(booking_id uuid,actor_user_id text,event_type text,message text,metadata jsonb);
      CREATE TABLE notifications(user_id text,booking_id uuid,type text,title text,message text,href text,dedupe_key text UNIQUE);
      CREATE TABLE synthetic_commissions(booking_id uuid PRIMARY KEY);
      CREATE TABLE admin_audit_log(actor_user_id text,action text,target_type text,target_id text,details jsonb);
      CREATE TABLE operations_checks(check_type text,status text,details jsonb);`);
    await db.exec(readFileSync("database/migrations/113_booking_refund_operations.sql", "utf8"));
    await db.exec(readFileSync("database/migrations/112_booking_payout_finalizations.sql", "utf8"));
    await db.exec("ALTER TABLE provider_profiles ADD COLUMN age_verification_status text DEFAULT 'verified', ADD COLUMN stripe_payouts_enabled boolean DEFAULT true");
    const api = load("@/lib/booking-refund-finalization");
    const readBooking = async (id: string) => (await db.query("SELECT * FROM bookings WHERE id=$1", [id])).rows[0];
    const readOperation = async (id: string) => (await db.query("SELECT * FROM booking_refund_operations WHERE id=$1", [id])).rows[0];
    const fixture = async (overrides: Record<string, unknown> = {}, reset = true) => {
      if (reset) {
        await db.exec("TRUNCATE booking_payout_finalizations,booking_refund_operations,bookings,booking_disputes,booking_events,notifications,synthetic_commissions");
        payoutCalls.length = 0; afterQuery = async () => {};
        refunds.clear(); charges.clear(); transfers.clear(); refundListErrors.clear(); refundCalls.length = 0; reversalCalls.length = 0;
        refundError = null; reversalError = null; refundStatus = "succeeded"; failQuery = ""; failAffiliates = false;
        queryStarted = () => {};
        beforeRefundReturn = async () => {}; beforeReversalReturn = async () => {};
      }
      const id = randomUUID();
      const values = { id, stripe_payment_intent_id: "pi_test_" + id, stripe_charge_id: "ch_test_" + id,
        stripe_transfer_id: "tr_test_" + id, ...overrides };
      await db.query(`INSERT INTO bookings(${Object.keys(values).join(",")}) VALUES(${Object.keys(values).map((_, i) => "$" + (i + 1)).join(",")})`, Object.values(values));
      const b = await readBooking(id);
      charges.set(b.stripe_charge_id, { id: b.stripe_charge_id, object: "charge", payment_intent: b.stripe_payment_intent_id,
        amount: b.customer_total_cents, amount_refunded: b.refunded_amount_cents + b.customer_service_fee_refunded_cents,
        refunded: false, disputed: false, currency: "usd", livemode: b.stripe_mode === "live", metadata: { bookingId: id, kind: "booking_payment" } });
      if (b.stripe_transfer_id) transfers.set(b.stripe_transfer_id, { id: b.stripe_transfer_id, object: "transfer", amount: b.provider_payout_cents,
        amount_reversed: b.stripe_transfer_reversed_cents, reversed: false, currency: "usd", livemode: b.stripe_mode === "live",
        destination: "acct_synthetic", source_transaction: b.stripe_charge_id, metadata: { bookingId: id, kind: "provider_payout" },
        reversals: { data: [], has_more: false } });
      return id;
    };
    const claim = (id: string, amount = 100, origin = "provider", mode = "test") => api.claimBookingRefundOperation({ bookingId: id, mode, origin, actorUserId: "provider" },
      (client: any) => client.query("UPDATE bookings SET refund_status='processing',refund_amount_cents=$2,refund_failure_reason='Refund outcome requires reconciliation. Contact support before retrying.' WHERE id=$1 AND refund_status='requested' RETURNING *", [id, amount]));
    const settle = async (opId: string, status = "succeeded", overrides: Record<string, unknown> = {}) => {
      const op = await readOperation(opId);
      const refund = { id: "re_test_async", object: "refund", payment_intent: op.payment_intent_id, charge: op.charge_id,
        amount: op.service_amount_cents + op.fee_amount_cents, currency: "usd", status,
        metadata: { bookingId: op.booking_id, refundOperationId: op.id }, ...overrides };
      refunds.set(refund.id, refund);
      if (status === "succeeded") { const charge = charges.get(op.charge_id); charge.amount_refunded = refund.amount + op.baseline_service_cents + op.baseline_fee_cents; charge.refunded = charge.amount_refunded === charge.amount; }
      return refund;
    };
    const assertEffects = async (id: string, expected = 1) => {
      assert.equal((await db.query("SELECT count(*)::int n FROM booking_events WHERE booking_id=$1 AND event_type='refunded'", [id])).rows[0].n, expected);
      assert.equal((await db.query("SELECT count(*)::int n FROM notifications WHERE booking_id=$1 AND type='refund_approved'", [id])).rows[0].n, expected * 2);
      assert.equal((await db.query("SELECT count(*)::int n FROM synthetic_commissions WHERE booking_id=$1", [id])).rows[0].n, expected);
    };

    await t.test("sticky ledger issue blocks payout even after mutable refund warnings and freeze are cleared", async () => {
      const payout = load("@/lib/payment-release");
      for (const status of ["none", "rejected"]) {
        const id = await fixture({ stripe_transfer_id: null, payment_release_status: "secured" });
        const { operation } = await claim(id);
        await db.query("UPDATE booking_refund_operations SET settlement_issue_at=now() WHERE id=$1", [operation.id]);
        await db.query("UPDATE bookings SET refund_status=$2,refund_failure_reason=NULL,payout_frozen_at=NULL,payout_freeze_reason=NULL WHERE id=$1", [id, status]);
        const result = await payout.releaseBookingPayout(id, "admin");
        assert.equal(result.ok, false);
        assert.match(result.error, /not ready, is frozen, or has an open refund or dispute/);
        assert.equal(payoutCalls.length, 0);
        assert.equal((await readBooking(id)).payment_release_status, "secured");
        assert.equal((await db.query("SELECT count(*)::int n FROM booking_payout_finalizations")).rows[0].n, 0);
      }
    });
    await t.test("sticky issue arriving after durable payout claim prevents dispatch at send recheck", async () => {
      const payout = load("@/lib/payment-release");
      const id = await fixture({ stripe_transfer_id: null, payment_release_status: "secured" });
      const { operation } = await claim(id);
      await db.query("UPDATE bookings SET refund_status='rejected',refund_failure_reason=NULL,payout_frozen_at=NULL,payout_freeze_reason=NULL WHERE id=$1", [id]);
      let injected = false;
      afterQuery = async (sql) => {
        if (sql === "COMMIT" && !injected) {
          injected = true;
          await db.query("UPDATE booking_refund_operations SET settlement_issue_at=now() WHERE id=$1", [operation.id]);
        }
      };
      const result = await payout.releaseBookingPayout(id, "admin");
      afterQuery = async () => {};
      assert.equal(injected, true, "must reach committed payout claim before introducing issue");
      assert.equal(result.ok, false);
      assert.equal(result.error, load("@/lib/booking-payout-reconciliation").BOOKING_PAYOUT_RECONCILIATION);
      assert.equal(payoutCalls.length, 0);
      assert.equal((await db.query("SELECT count(*)::int n FROM booking_payout_finalizations WHERE booking_id=$1", [id])).rows[0].n, 1);
      assert.ok((await readOperation(operation.id)).settlement_issue_at);
    });
    await t.test("claim and authorization snapshot commit together; active operation blocks a second claim", async () => {
      const id = await fixture();
      failQuery = "INSERT INTO booking_refund_operations";
      await assert.rejects(claim(id));
      assert.equal((await readBooking(id)).refund_status, "requested");
      assert.equal((await db.query("SELECT count(*)::int n FROM booking_refund_operations")).rows[0].n, 0);
      const { operation } = await claim(id);
      assert.equal(operation.service_amount_cents, 100); assert.equal(operation.fee_amount_cents, 299);
      assert.equal(operation.reversal_target_cents, 79); assert.equal(operation.baseline_reversed_cents, 0);
      assert.equal(await claim(id), null); assert.equal(refundCalls.length, 0);
    });
    await t.test("ordinary settlement, receipt and recovery complete once", async () => {
      const id = await fixture(); const { operation } = await claim(id);
      const result = await api.submitBookingRefundOperation(operation.id);
      assert.equal(result.ok, true); assert.equal(result.recoveryNeedsReview, false);
      assert.equal(refundCalls.length, 1); assert.equal(reversalCalls.length, 1);
      assert.equal(refundCalls[0].params.amount, 399); assert.equal(reversalCalls[0].params.amount, 79);
      assert.equal(refundCalls[0].options.maxNetworkRetries, 0); assert.equal(reversalCalls[0].options.maxNetworkRetries, 0);
      await api.submitBookingRefundOperation(operation.id); await api.reconcilePendingBookingRefunds("test");
      await api.observeBookingRefund([...refunds.values()][0], "test");
      assert.equal(refundCalls.length, 1); assert.equal(reversalCalls.length, 1); await assertEffects(id);
      const b = await readBooking(id); assert.equal(b.refunded_amount_cents, 100); assert.equal(b.customer_service_fee_refunded_cents, 299);
      assert.equal(b.stripe_transfer_reversed_cents, 79); assert.equal(b.payment_release_status, "reversed");
    });
    await t.test("approval-required refund later settles and recovers without another refund", async () => {
      const id = await fixture(); const { operation } = await claim(id);
      refundError = Object.assign(new Error("Synthetic approval"), { code: "approval_required" });
      assert.equal((await api.submitBookingRefundOperation(operation.id)).pending, true);
      await api.submitBookingRefundOperation(operation.id); assert.equal(refundCalls.length, 1);
      const refund = await settle(operation.id); await api.observeBookingRefund(refund, "test");
      await api.observeBookingRefund(refund, "test"); await api.reconcilePendingBookingRefunds("test");
      assert.equal(refundCalls.length, 1); assert.equal(reversalCalls.length, 1); await assertEffects(id);
      assert.equal((await readBooking(id)).stripe_refund_id, refund.id);
    });
    await t.test("pending or failed refund cannot trigger provider recovery", async () => {
      for (const status of ["pending", "failed", "canceled", "requires_action"]) {
        const id = await fixture(); const { operation } = await claim(id); refundStatus = status;
        assert.equal((await api.submitBookingRefundOperation(operation.id)).refunded, false);
        await api.reconcilePendingBookingRefunds("test");
        assert.equal(refundCalls.length, 1); assert.equal(reversalCalls.length, 0); await assertEffects(id, 0);
        assert.equal((await readBooking(id)).refunded_amount_cents, 0);
      }
    });
    await t.test("refund identity mismatches cannot record success or move money", async () => {
      const changes = [{ currency: "eur" }, { amount: 400 }, { payment_intent: "pi_other" }, { charge: "ch_other" },
        { metadata: { bookingId: randomUUID(), refundOperationId: randomUUID() } }];
      for (const change of changes) {
        const id = await fixture(); const { operation } = await claim(id); const refund = await settle(operation.id, "succeeded", change);
        assert.equal(await api.observeBookingRefund(refund, "test"), false);
        assert.equal((await readOperation(operation.id)).refund_confirmed_at, null);
        assert.equal(reversalCalls.length, 0); await assertEffects(id, 0);
      }
      const id = await fixture(); const { operation } = await claim(id); const refund = await settle(operation.id);
      delete refund.metadata.refundOperationId;
      assert.equal(await api.observeBookingRefund(refund, "test"), false, "Dashboard refund is not application recovery authority");
      assert.equal(reversalCalls.length, 0);
    });
    await t.test("wrong current environment cannot observe and recover a live operation", async () => {
      const id = await fixture({ stripe_mode: "live" }); const { operation } = await claim(id, 100, "provider", "live");
      assert.equal(await api.observeBookingRefund(await settle(operation.id), "live"), false);
      await assert.rejects(api.submitBookingRefundOperation(operation.id)); assert.equal(reversalCalls.length, 0);
    });
    await t.test("existing confirmed evidence prevents a later first submit", async () => {
      const id = await fixture(); const { operation } = await claim(id);
      await api.observeBookingRefund(await settle(operation.id), "test");
      assert.equal((await api.submitBookingRefundOperation(operation.id)).refunded, true);
      assert.equal(refundCalls.length, 0, "observed refund must never be followed by a new refund");
    });
    await t.test("transaction failure rolls back receipt; replay completes without refund resend", async () => {
      const id = await fixture({ stripe_transfer_id: null, payment_release_status: "frozen" }); const { operation } = await claim(id);
      failAffiliates = true; await api.submitBookingRefundOperation(operation.id);
      assert.ok((await readOperation(operation.id)).refund_confirmed_at);
      assert.equal((await readOperation(operation.id)).effects_completed_at, null);
      assert.equal((await readBooking(id)).refunded_amount_cents, 0); await assertEffects(id, 0);
      await api.reconcilePendingBookingRefunds("test"); await assertEffects(id);
      assert.equal(refundCalls.length, 1); assert.equal((await readBooking(id)).provider_payout_cents, 0);
    });
    await t.test("successful refund with lost response is discovered read-only by operation metadata", async () => {
      const id = await fixture(); const { operation } = await claim(id);
      beforeRefundReturn = async () => { await settle(operation.id); };
      refundError = new Error("Synthetic lost refund response");
      await api.submitBookingRefundOperation(operation.id);
      assert.equal((await readOperation(operation.id)).stripe_refund_id, null);
      await api.reconcilePendingBookingRefunds("test");
      assert.equal(refundCalls.length, 1); assert.equal(reversalCalls.length, 1); await assertEffects(id);
      assert.equal((await readBooking(id)).stripe_refund_id, "re_test_async");
    });
    await t.test("late failed HTTP response cannot downgrade already finalized webhook success", async () => {
      const id = await fixture(); const { operation } = await claim(id);
      refundError = new Error("Synthetic response lost after webhook success");
      beforeRefundReturn = async () => { await api.observeBookingRefund(await settle(operation.id), "test"); };
      const result = await api.submitBookingRefundOperation(operation.id);
      assert.equal(result.ok, true); assert.equal(result.pending, false);
      assert.equal((await readOperation(operation.id)).last_error, null);
      assert.equal((await readBooking(id)).refund_failure_reason, null);
      assert.equal(refundCalls.length, 1); assert.equal(reversalCalls.length, 1); await assertEffects(id);
    });
    await t.test("refund recovery survives notification failure after audit insertion", async () => {
      const id = await fixture({ stripe_transfer_id: null }); const { operation } = await claim(id);
      failQuery = "INSERT INTO notifications";
      await api.submitBookingRefundOperation(operation.id); await assertEffects(id, 0);
      assert.equal((await readOperation(operation.id)).effects_completed_at, null);
      await api.reconcilePendingBookingRefunds("test"); await assertEffects(id);
      assert.equal(refundCalls.length, 1);
    });
    await t.test("two sequential held refunds preserve both receipts and never refund the fee twice", async () => {
      const id = await fixture({ stripe_transfer_id: null, payment_release_status: "frozen" });
      const first = (await claim(id, 50)).operation;
      await api.submitBookingRefundOperation(first.id);
      const firstRefund = copy([...refunds.values()][0]);
      assert.equal((await readBooking(id)).provider_payout_cents, 40);
      await db.query("UPDATE bookings SET refund_status='requested' WHERE id=$1", [id]);
      const second = (await claim(id, 50)).operation;
      await api.submitBookingRefundOperation(second.id);
      assert.equal(refundCalls[0].params.amount, 50); assert.equal(refundCalls[1].params.amount, 349);
      await api.observeBookingRefund(firstRefund, "test");
      const b = await readBooking(id);
      assert.equal(b.stripe_refund_id, "re_test_2"); assert.equal(b.refunded_amount_cents, 100);
      assert.equal(b.customer_service_fee_refunded_cents, 299); assert.equal(b.provider_payout_cents, 0);
      assert.equal((await db.query("SELECT count(*)::int n FROM booking_events WHERE booking_id=$1 AND event_type='refunded'", [id])).rows[0].n, 2);
      assert.equal((await db.query("SELECT count(*)::int n FROM notifications WHERE booking_id=$1", [id])).rows[0].n, 4);
      assert.equal((await db.query("SELECT count(*)::int n FROM booking_refund_operations WHERE booking_id=$1 AND effects_completed_at IS NOT NULL AND recovery_completed_at IS NOT NULL", [id])).rows[0].n, 2);
      assert.equal(reversalCalls.length, 0);
    });
    await t.test("reversal approval-required remains one-shot until signed matching evidence", async () => {
      const id = await fixture(); const { operation } = await claim(id);
      reversalError = Object.assign(new Error("Synthetic approval"), { code: "approval_required" });
      assert.equal((await api.submitBookingRefundOperation(operation.id)).recoveryNeedsReview, true);
      for (let i = 0; i < 3; i++) await api.reconcilePendingBookingRefunds("test");
      assert.equal(reversalCalls.length, 1); await assertEffects(id);
      const transfer = transfers.get(operation.transfer_id); transfer.amount_reversed = 79; transfer.reversed = true;
      await api.observeBookingRefundTransfer(copy(transfer), "test");
      await api.observeBookingRefundTransfer({ ...copy(transfer), amount_reversed: 0, reversed: false }, "test");
      assert.ok((await readOperation(operation.id)).recovery_completed_at);
      assert.equal((await readBooking(id)).stripe_transfer_reversed_cents, 79);
      assert.equal(reversalCalls.length, 1);
    });
    await t.test("lost reversal response reconciles existing transfer without resend", async () => {
      const id = await fixture(); const { operation } = await claim(id);
      beforeReversalReturn = async () => { const transfer = transfers.get(operation.transfer_id); transfer.amount_reversed = 79; transfer.reversed = true; };
      reversalError = new Error("Synthetic lost response"); await api.submitBookingRefundOperation(operation.id);
      await api.reconcilePendingBookingRefunds("test");
      assert.equal(reversalCalls.length, 1); assert.ok((await readOperation(operation.id)).recovery_completed_at);
      const audit = () => db.query("SELECT * FROM booking_events WHERE booking_id=$1 AND event_type='transfer_reversed'", [id]);
      assert.equal((await audit()).rows.length, 1, "read-only evidence recovery must leave a reversal audit even with no webhook");
      await api.observeBookingRefundTransfer(copy(transfers.get(operation.transfer_id)), "test");
      await api.reconcilePendingBookingRefunds("test");
      assert.equal((await audit()).rows.length, 1);
    });
    await t.test("database failure after successful reversal is repaired from evidence without another reversal", async () => {
      const id = await fixture(); const { operation } = await claim(id);
      failQuery = "UPDATE booking_refund_operations SET stripe_reversal_id";
      await api.submitBookingRefundOperation(operation.id);
      assert.equal(reversalCalls.length, 1); assert.equal(transfers.get(operation.transfer_id).amount_reversed, 79);
      assert.equal((await readOperation(operation.id)).recovery_completed_at, null);
      await api.reconcilePendingBookingRefunds("test");
      assert.ok((await readOperation(operation.id)).recovery_completed_at); assert.equal(reversalCalls.length, 1);
      assert.equal((await db.query("SELECT count(*)::int n FROM booking_events WHERE booking_id=$1 AND event_type='transfer_reversed'", [id])).rows[0].n, 1);
    });
    await t.test("legacy destination refund delegates its reversal to Stripe, never a second transfer command", async () => {
      const id = await fixture({ payment_flow: "destination_charge" });
      const claimed = await api.claimBookingRefundOperation({ bookingId: id, mode: "test", origin: "provider", actorUserId: "provider", refundApplicationFee: true },
        (client: any) => client.query("UPDATE bookings SET refund_status='processing' WHERE id=$1 RETURNING *", [id]));
      await api.submitBookingRefundOperation(claimed.operation.id);
      assert.equal(refundCalls[0].params.reverse_transfer, true); assert.equal(refundCalls[0].params.refund_application_fee, true);
      assert.equal(reversalCalls.length, 0); assert.ok((await readOperation(claimed.operation.id)).recovery_completed_at);
      await assertEffects(id);
    });
    await t.test("claimed but unsent reversal is never blindly retried", async () => {
      const id = await fixture(); const { operation } = await claim(id);
      await db.query("UPDATE booking_refund_operations SET reversal_attempted_at=now(),reversal_amount_cents=79 WHERE id=$1", [operation.id]);
      await api.observeBookingRefund(await settle(operation.id), "test"); await api.reconcilePendingBookingRefunds("test");
      assert.equal(reversalCalls.length, 0); assert.equal((await readOperation(operation.id)).recovery_completed_at, null);
    });
    await t.test("partial manual recovery or changed transfer identity prevents a new reversal", async () => {
      for (const change of [{ amount_reversed: 20 }, { amount_reversed: -1 }, { amount_reversed: 80 }, { destination: "acct_other" },
        { source_transaction: "ch_other" }, { amount: 80 }, { livemode: true }, { currency: "eur" }, { metadata: { kind: "other" } }]) {
        const id = await fixture(); const { operation } = await claim(id);
        Object.assign(transfers.get(operation.transfer_id), change);
        await api.submitBookingRefundOperation(operation.id);
        assert.equal(reversalCalls.length, 0); assert.equal((await readOperation(operation.id)).recovery_completed_at, null);
      }
    });
    await t.test("transfer evidence arriving before refund settlement is safely reconciled later", async () => {
      const id = await fixture(); const { operation } = await claim(id);
      const transfer = transfers.get(operation.transfer_id); transfer.amount_reversed = 79; transfer.reversed = true;
      await api.observeBookingRefundTransfer(copy(transfer), "test");
      assert.equal((await readOperation(operation.id)).recovery_completed_at, null, "refund is not yet confirmed");
      await api.observeBookingRefund(await settle(operation.id), "test");
      assert.ok((await readOperation(operation.id)).recovery_completed_at);
      assert.equal(reversalCalls.length, 0); assert.equal((await readBooking(id)).stripe_transfer_reversed_cents, 79);
    });
    await t.test("new dispute and unrelated hold are preserved without recovery", async () => {
      const id = await fixture(); const { operation } = await claim(id);
      await db.query("UPDATE bookings SET stripe_dispute_status='needs_response',payout_frozen_at=now(),payout_freeze_reason='Admin investigation',payout_failure_reason='Separate investigation' WHERE id=$1", [id]);
      await api.submitBookingRefundOperation(operation.id);
      assert.equal(reversalCalls.length, 0); const b = await readBooking(id);
      assert.equal(b.payout_freeze_reason, "Admin investigation"); assert.equal(b.payout_failure_reason, "Separate investigation");
      await assertEffects(id);
    });
    await t.test("known newer refunds do not trigger stale recovery", async () => {
      const id = await fixture(); const { operation } = await claim(id, 50);
      await db.query("UPDATE bookings SET refunded_amount_cents=75,refund_failure_reason='External refund needs review' WHERE id=$1", [id]);
      await api.submitBookingRefundOperation(operation.id);
      assert.equal(reversalCalls.length, 0); assert.equal((await readBooking(id)).refunded_amount_cents, 75);
      assert.equal((await readBooking(id)).refund_failure_reason, "External refund needs review");
      assert.equal((await readOperation(operation.id)).recovery_completed_at, null);
    });
    await t.test("recovery of an older partial operation preserves newer external refund warning", async () => {
      const id = await fixture(); const { operation } = await claim(id, 50);
      refundStatus = "pending"; await api.submitBookingRefundOperation(operation.id);
      const warning = "Stripe refund after provider payout requires transfer recovery review.";
      await db.query("UPDATE bookings SET refunded_amount_cents=75,payout_failure_reason=$2 WHERE id=$1", [id, warning]);
      const refund = [...refunds.values()][0]; refund.status = "succeeded";
      await api.observeBookingRefund(copy(refund), "test", true, true);
      const transfer = transfers.get(operation.transfer_id); transfer.amount_reversed = 39;
      await api.observeBookingRefundTransfer(copy(transfer), "test");
      assert.ok((await readOperation(operation.id)).recovery_completed_at, "this operation's share really was recovered");
      assert.match((await readBooking(id)).payout_failure_reason, /transfer recovery.*(?:review|confirmed)/,
        "another25¢ refund still requires independent recovery review");
      assert.equal(reversalCalls.length, 0);
    });
    await t.test("partial refund recovers only exact proportional authorized amount", async () => {
      const id = await fixture(); const { operation } = await claim(id, 50);
      assert.equal(operation.fee_amount_cents, 0); assert.equal(operation.reversal_target_cents, 39);
      assert.equal((await api.submitBookingRefundOperation(operation.id)).recoveryNeedsReview, false);
      assert.equal(refundCalls[0].params.amount, 50); assert.equal(reversalCalls[0].params.amount, 39);
      const b = await readBooking(id); assert.equal(b.payment_status, "paid"); assert.equal(b.provider_payout_cents, 79);
      assert.equal(b.stripe_transfer_reversed_cents, 39); assert.equal(b.payment_release_status, "partially_released");
    });
    await t.test("stale pending evidence does not regress settled operation", async () => {
      const id = await fixture(); const { operation } = await claim(id); await api.submitBookingRefundOperation(operation.id);
      const refund = [...refunds.values()][0]; await api.observeBookingRefund({ ...refund, status: "pending" }, "test");
      assert.equal((await readOperation(operation.id)).stripe_refund_status, "succeeded");
      assert.equal(reversalCalls.length, 1); await assertEffects(id);
    });
    await t.test("authoritative success-then-failure is sticky review without numerical rollback or repeated money", async () => {
      const id = await fixture(); const { operation } = await claim(id); await api.submitBookingRefundOperation(operation.id);
      const refund = [...refunds.values()][0]; const staleSuccess = copy(refund); refund.status = "failed";
      await api.observeBookingRefund(copy(refund), "test", true, true);
      await api.observeBookingRefund(copy(refund), "test", true, true);
      await api.observeBookingRefund(staleSuccess, "test");
      await api.observeBookingRefund(staleSuccess, "test", true, true);
      await api.reconcilePendingBookingRefunds("test");
      const op = await readOperation(operation.id); const b = await readBooking(id);
      assert.ok(op.settlement_issue_at); assert.equal(op.stripe_refund_status, "failed");
      assert.equal(b.refund_status, "failed"); assert.ok(b.refund_failure_reason); assert.ok(b.payout_frozen_at);
      assert.equal(b.refunded_amount_cents, 100); assert.equal(b.customer_service_fee_refunded_cents, 299);
      assert.equal(b.stripe_transfer_reversed_cents, 79, "historical recovery evidence is never silently reversed");
      assert.equal(refundCalls.length, 1); assert.equal(reversalCalls.length, 1);
      assert.equal((await db.query("SELECT count(*)::int n FROM booking_events WHERE booking_id=$1 AND event_type='refund_settlement_issue'", [id])).rows[0].n, 1);
      assert.equal((await db.query("SELECT count(*)::int n FROM notifications WHERE booking_id=$1 AND type='refund_failed'", [id])).rows[0].n, 2);
      let callbackRan = false;
      const blocked = await api.claimBookingRefundOperation({ bookingId: id, mode: "test", origin: "provider" }, async (client: any) => {
        callbackRan = true; return client.query("UPDATE bookings SET refund_status='processing' WHERE id=$1 RETURNING *", [id]);
      });
      assert.equal(blocked, null); assert.equal(callbackRan, false);
      const reconcileCharge = load("@/lib/booking-refund-reconciliation").recordBookingChargeRefund;
      assert.equal((await reconcileCharge({ bookingId: id, paymentIntentId: b.stripe_payment_intent_id, mode: "test", fullyRefunded: true, amountRefunded: 399, chargeAmount: 399 })).rowCount, 0);
      assert.equal((await readBooking(id)).refund_status, "failed");
    });
    await t.test("authoritative returned refund before first reversal prevents all finalization and recovery", async () => {
      const id = await fixture(); const { operation } = await claim(id);
      const refund = await settle(operation.id);
      await api.observeBookingRefund(refund, "test", false);
      assert.ok((await readOperation(operation.id)).refund_confirmed_at);
      const failed = { ...refund, status: "failed" }; refunds.set(failed.id, failed);
      await api.observeBookingRefund(failed, "test", true, true);
      await api.observeBookingRefund(refund, "test"); await api.reconcilePendingBookingRefunds("test");
      const op = await readOperation(operation.id);
      assert.ok(op.settlement_issue_at); assert.equal(op.effects_completed_at, null); assert.equal(op.reversal_attempted_at, null);
      assert.equal(refundCalls.length, 0); assert.equal(reversalCalls.length, 0); await assertEffects(id, 0);
      assert.equal((await readBooking(id)).refunded_amount_cents, 0);
    });
    await t.test("late failure of completed earlier refund can coexist with a newer active operation safely", async () => {
      const id = await fixture({ stripe_transfer_id: null }); const first = (await claim(id, 50)).operation;
      await api.submitBookingRefundOperation(first.id); const firstRefund = copy([...refunds.values()][0]);
      await db.query("UPDATE bookings SET refund_status='requested' WHERE id=$1", [id]);
      const second = (await claim(id, 50)).operation;
      await api.observeBookingRefund({ ...firstRefund, status: "failed" }, "test", true, true);
      assert.ok((await readOperation(first.id)).settlement_issue_at);
      assert.equal((await readOperation(second.id)).refund_attempted_at, null);
      await api.submitBookingRefundOperation(second.id);
      assert.equal(refundCalls.length, 1, "newer prepared operation cannot dispatch using a failed refund baseline");
      assert.equal(reversalCalls.length, 0);
    });
    await t.test("a newer refund completing cannot erase an earlier returned-refund hold", async () => {
      const id = await fixture({ stripe_transfer_id: null }); const first = (await claim(id, 50)).operation;
      await api.submitBookingRefundOperation(first.id); const firstRefund = copy([...refunds.values()][0]);
      await db.query("UPDATE bookings SET refund_status='requested' WHERE id=$1", [id]);
      const second = (await claim(id, 50)).operation; refundStatus = "pending";
      await api.submitBookingRefundOperation(second.id);
      const secondRefund = [...refunds.values()].find(r => r.metadata.refundOperationId === second.id);
      await api.observeBookingRefund({ ...firstRefund, status: "failed" }, "test", true, true);
      const warning = (await readBooking(id)).refund_failure_reason;
      secondRefund.status = "succeeded";
      await api.observeBookingRefund(copy(secondRefund), "test", true, true);
      await api.submitBookingRefundOperation(second.id);
      assert.ok((await readOperation(second.id)).refund_confirmed_at, "real newer refund evidence must still be retained");
      const b = await readBooking(id);
      assert.equal(b.refund_status, "failed"); assert.equal(b.refund_failure_reason, warning); assert.ok(b.payout_frozen_at);
      assert.equal(refundCalls.length, 2, "both original authorized calls happened before the returned-refund issue; neither is resent");
      assert.equal(reversalCalls.length, 0);
    });
    await t.test("unresolved old operations cannot starve later confirmed refunds", async () => {
      let valid: any;
      for (let i = 0; i < 5; i++) {
        const id = await fixture({}, i === 0); const { operation } = await claim(id);
        refundError = Object.assign(new Error("Synthetic approval"), { code: "approval_required" });
        await api.submitBookingRefundOperation(operation.id);
        if (i === 4) valid = operation;
        else refundListErrors.add(operation.payment_intent_id);
      }
      await settle(valid.id);
      for (let i = 0; i < 3; i++) await api.reconcilePendingBookingRefunds("test", 2);
      assert.ok((await readOperation(valid.id)).effects_completed_at);
      assert.ok((await readOperation(valid.id)).recovery_completed_at);
      assert.equal(refundCalls.length, 5, "reconciliation never resubmits the unresolved refunds");
      assert.equal(reversalCalls.length, 1); await assertEffects(valid.booking_id);
    });
    await t.test("cumulative charge evidence cannot settle a bound pending or failed refund", async () => {
      const reconcileCharge = load("@/lib/booking-refund-reconciliation").recordBookingChargeRefund;
      for (const status of ["pending", "failed"]) {
        const id = await fixture(); const { operation } = await claim(id); refundStatus = status;
        await api.submitBookingRefundOperation(operation.id);
        const b = await readBooking(id);
        const chargeInput = { bookingId: id, paymentIntentId: b.stripe_payment_intent_id, mode: "test", fullyRefunded: true, amountRefunded: 399, chargeAmount: 399 };
        assert.equal((await reconcileCharge(chargeInput)).rowCount, 0);
        assert.equal((await readBooking(id)).payment_status, "paid");
        assert.equal((await readBooking(id)).refunded_amount_cents, 0); assert.equal(reversalCalls.length, 0);
        const refund = [...refunds.values()][0]; refund.status = "succeeded";
        await api.observeBookingRefund(copy(refund), "test");
        assert.equal((await reconcileCharge(chargeInput)).rowCount, 1);
        assert.equal((await readBooking(id)).payment_status, "refunded"); await assertEffects(id);
      }
    });
    await t.test("transferred partial refund without proven basis rolls back its claim", async () => {
      for (const history of [{ refunded_amount_cents: 20 }, { stripe_transfer_reversed_cents: 10 }]) {
        const id = await fixture(history);
        await assert.rejects(claim(id, 30), /proven original refund basis/);
        assert.equal((await readBooking(id)).refund_status, "requested");
        assert.equal((await db.query("SELECT count(*)::int n FROM booking_refund_operations")).rows[0].n, 0);
        assert.equal(refundCalls.length, 0);
      }
    });
    await t.test("older partial transfer evidence never regresses already recorded full recovery", async () => {
      const id = await fixture(); const { operation } = await claim(id, 50);
      reversalError = new Error("Synthetic uncertainty"); await api.submitBookingRefundOperation(operation.id);
      await db.query("UPDATE bookings SET stripe_transfer_reversed_cents=79,payment_release_status='reversed' WHERE id=$1", [id]);
      await api.observeBookingRefundTransfer({ ...copy(transfers.get(operation.transfer_id)), amount_reversed: 39 }, "test");
      const b = await readBooking(id); assert.equal(b.stripe_transfer_reversed_cents, 79); assert.equal(b.payment_release_status, "reversed");
    });
    const claimDecision = async (id: string, full = false) => {
      const disputeId = randomUUID(); const outcome = full ? "customer" : "partial";
      await db.query("INSERT INTO booking_disputes(id,booking_id,status,resolution_outcome,resolved_by,admin_note) VALUES($1,$2,'resolved',$3,'admin','Original approved decision')", [disputeId, id, outcome]);
      await db.query("UPDATE bookings SET payout_frozen_at=now(),payout_freeze_reason='Open booking dispute' WHERE id=$1", [id]);
      const result = await api.claimBookingRefundOperation({ bookingId: id, mode: "test", origin: full ? "automatic" : "dispute_partial", actorUserId: "admin", disputeId },
        (client: any) => client.query("UPDATE bookings SET refund_status='processing',refund_amount_cents=$2 WHERE id=$1 RETURNING *", [id, full ? 100 : 50]));
      return { operation: result.operation, disputeId, outcome };
    };
    await t.test("async partial and full admin decisions finalize audit and notices once", async () => {
      for (const full of [false, true]) {
        const id = await fixture({ stripe_transfer_id: null }); const { operation, disputeId, outcome } = await claimDecision(id, full);
        refundError = Object.assign(new Error("Synthetic approval"), { code: "approval_required" }); await api.submitBookingRefundOperation(operation.id);
        await db.query("UPDATE booking_disputes SET status='reviewing',resolution_outcome=NULL,resolved_by=NULL,resolved_at=NULL WHERE id=$1", [disputeId]);
        const refund = await settle(operation.id); await api.observeBookingRefund(refund, "test");
        await api.observeBookingRefund(refund, "test"); await api.reconcilePendingBookingRefunds("test");
        const dispute = (await db.query("SELECT * FROM booking_disputes WHERE id=$1", [disputeId])).rows[0];
        assert.equal(dispute.status, "resolved"); assert.equal(dispute.resolution_outcome, outcome); assert.equal(dispute.resolved_by, "admin");
        assert.ok((await readOperation(operation.id)).decision_completed_at);
        assert.equal((await db.query("SELECT count(*)::int n FROM admin_audit_log WHERE target_id=$1", [disputeId])).rows[0].n, 1);
        assert.equal((await db.query("SELECT count(*)::int n FROM notifications WHERE booking_id=$1 AND type='dispute_resolved'", [id])).rows[0].n, 2);
        assert.equal((await readBooking(id)).payout_freeze_reason, null); assert.equal(refundCalls.length, 1);
        await assertEffects(id);
      }
    });
    await t.test("admin decision transaction failure remains recoverable after financial settlement", async () => {
      const id = await fixture({ stripe_transfer_id: null }); const { operation, disputeId } = await claimDecision(id);
      failQuery = "INSERT INTO admin_audit_log"; await api.submitBookingRefundOperation(operation.id);
      assert.ok((await readOperation(operation.id)).effects_completed_at);
      assert.equal((await readOperation(operation.id)).decision_completed_at, null);
      assert.equal((await db.query("SELECT count(*)::int n FROM admin_audit_log WHERE target_id=$1", [disputeId])).rows[0].n, 0);
      await api.reconcilePendingBookingRefunds("test");
      assert.ok((await readOperation(operation.id)).decision_completed_at);
      assert.equal((await db.query("SELECT count(*)::int n FROM admin_audit_log WHERE target_id=$1", [disputeId])).rows[0].n, 1);
      assert.equal((await db.query("SELECT count(*)::int n FROM notifications WHERE booking_id=$1 AND type='dispute_resolved'", [id])).rows[0].n, 2);
      assert.equal(refundCalls.length, 1); await assertEffects(id);
    });
    await t.test("changed admin decision or lost ownership stays under review", async () => {
      for (const change of ["admin_note='New administrator decision'", "refund_operation_id=NULL", "resolution_outcome='provider'"]) {
        const id = await fixture({ stripe_transfer_id: null }); const { operation, disputeId } = await claimDecision(id);
        await db.query(`UPDATE booking_disputes SET status='reviewing',${change} WHERE id=$1`, [disputeId]);
        await api.submitBookingRefundOperation(operation.id);
        assert.equal((await readOperation(operation.id)).decision_completed_at, null);
        assert.match((await readOperation(operation.id)).last_error, /decision changed/);
        assert.equal((await db.query("SELECT status FROM booking_disputes WHERE id=$1", [disputeId])).rows[0].status, "reviewing");
        assert.equal((await db.query("SELECT count(*)::int n FROM notifications WHERE booking_id=$1 AND type='dispute_resolved'", [id])).rows[0].n, 0);
        assert.equal(await claim(id, 50), null); assert.equal(refundCalls.length, 1);
      }
    });
    await t.test("concurrent submit and duplicate settlement issue money only once", { skip: !postgres }, async () => {
      const id = await fixture(); const { operation } = await claim(id);
      await Promise.all([api.submitBookingRefundOperation(operation.id), api.submitBookingRefundOperation(operation.id)]);
      const refund = [...refunds.values()][0];
      await Promise.all([api.observeBookingRefund(refund, "test"), api.observeBookingRefund(refund, "test")]);
      assert.equal(refundCalls.length, 1); assert.equal(reversalCalls.length, 1); await assertEffects(id);

      const id2 = await fixture();
      const claims = await Promise.all([claim(id2), claim(id2)]);
      assert.equal(claims.filter(Boolean).length, 1);
      const op2 = claims.find(Boolean).operation;
      const asyncRefund = await settle(op2.id);
      await Promise.all([api.observeBookingRefund(asyncRefund, "test"), api.observeBookingRefund(asyncRefund, "test")]);
      assert.equal(refundCalls.length, 0); assert.equal(reversalCalls.length, 1); await assertEffects(id2);
    });
    await t.test("charge event waiting behind an uncommitted claim sees the newly committed pending operation", { skip: !postgres, timeout: 15000 }, async () => {
      const id = await fixture();
      const bounded = async <T>(promise: Promise<T>): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { return await Promise.race([promise, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Test SQL barrier was not reached")), 4000);
        })]); } finally { clearTimeout(timer); }
      };
      let releaseClaim!: () => void;
      const release = new Promise<void>(resolve => { releaseClaim = resolve; });
      let announceLocked!: () => void;
      const locked = new Promise<void>(resolve => { announceLocked = resolve; });
      let announceChargePid!: (pid: number) => void;
      const chargePid = new Promise<number>(resolve => { announceChargePid = resolve; });
      queryStarted = (sql, target) => {
        if (sql.includes("SELECT id FROM bookings WHERE stripe_mode=$2") && sql.includes("FOR UPDATE")) announceChargePid(target.processID);
      };
      const claiming = api.claimBookingRefundOperation({ bookingId: id, mode: "test", origin: "provider", actorUserId: "provider" }, async (client: any) => {
        const result = await client.query("UPDATE bookings SET refund_status='processing',refund_amount_cents=100 WHERE id=$1 RETURNING *", [id]);
        announceLocked(); await release; return result;
      });
      let observing: Promise<any> | undefined;
      try {
        await bounded(locked);
        const b = await readBooking(id);
        const reconcileCharge = load("@/lib/booking-refund-reconciliation").recordBookingChargeRefund;
        observing = reconcileCharge({ bookingId: id, paymentIntentId: b.stripe_payment_intent_id, mode: "test", fullyRefunded: true, amountRefunded: 399, chargeAmount: 399 });
        const pid = await bounded(chargePid); assert.ok(Number.isInteger(pid), "identified the test charge-event connection");
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          const state = (await db.query("SELECT wait_event_type,cardinality(pg_blocking_pids(pid)) AS blockers FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
          if (state?.wait_event_type === "Lock" && state.blockers > 0) { blocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(blocked, true, "the charge event really waits behind the uncommitted booking claim");
        releaseClaim();
        const claimed = await claiming;
        assert.equal((await observing).rowCount, 0, "post-lock ledger snapshot must see pending operation");
        assert.equal((await readOperation(claimed.operation.id)).refund_confirmed_at, null);
        const after = await readBooking(id);
        assert.equal(after.refund_status, "processing"); assert.equal(after.payment_status, "paid");
        assert.equal(after.refunded_amount_cents, 0); assert.equal(after.customer_service_fee_refunded_cents, 0);
        assert.equal(refundCalls.length, 0); assert.equal(reversalCalls.length, 0);
      } finally {
        releaseClaim(); await Promise.allSettled([claiming, ...(observing ? [observing] : [])]); queryStarted = () => {};
      }
    });
  } finally { await cleanup(); }
});
