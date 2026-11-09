/* eslint-disable @typescript-eslint/no-explicit-any -- Real PostgreSQL SQL with fake external/auth boundaries. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);
for (const postgres of [false, true]) test(`${postgres ? "PostgreSQL" : "PGlite"} booking refund route`, {
  skip: postgres && process.env.BOOKME_MIGRATION_TEST_DATABASE !== "1",
}, async (t) => {
  let db: any;
  let cleanup: () => Promise<void>;
  if (postgres) {
    const connectionString = process.env.DATABASE_URL ?? "postgresql://bookme:bookme@127.0.0.1:5432/bookme";
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(connectionString).hostname)) throw new Error("Refund tests require localhost PostgreSQL.");
    const schema = "booking_refund_test_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString, ssl: false });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString, ssl: false, options: `-c search_path=${schema}` });
    db = { query: (sql: string, values: unknown[] = []) => pool.query(sql, values), exec: (sql: string) => pool.query(sql) };
    cleanup = async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); };
  } else { db = new PGlite(); cleanup = () => db.close(); }
  let failure = "";
  let stripeError: any;
  let reversalError: any;
  const reversalCalls: any[] = [];
  let refundStatus = "succeeded";
  let userId = "provider";
  let beforeQuery: (sql: string, values: unknown[]) => Promise<void> = async () => {};
  let duringRefund: () => Promise<void> = async () => {};
  let duringReversal: () => Promise<void> = async () => {};
  const calls: any[] = [];
  t.mock.method(console, "error", () => {});
  const database = { query: async (sql: string, values: unknown[] = []) => {
    await beforeQuery(sql, values);
    if (failure && sql.includes(failure)) { failure = ""; return db.query("SELECT 1 / 0"); }
    const result = await db.query(sql, values);
    return { ...result, rowCount: result.rowCount ?? (result.affectedRows || result.rows.length) };
  } };
  const replacements: Record<string, any> = {
    "server-only": {}, "next/headers": { headers: async () => new Headers() },
    "@/lib/auth": { auth: { api: { getSession: async () => ({ user: { id: userId, email: "provider@example.invalid" } }) } } },
    "@/lib/database": { database }, "./database": { database },
    "@/lib/content-safety": { checkAndRecordContent: async () => ({ allowed: true }) },
    "@/lib/request-security": { enforceRateLimit: async () => true, recordActivity: async () => {} },
    "@/lib/admin": { hasAdminAccess: async () => false },
    "@/lib/analytics": { recordAnalytics: async () => {} },
    "@/lib/affiliates": { syncAffiliateCommissionForBooking: async () => {} },
    "@/lib/plans": { PLAN_ENTITLEMENTS: { free: { bookingFeePercent: 10 } } },
    "@/lib/stripe": { getStripeMode: () => "test", isStripeReady: () => true, getStripe: () => ({
      refunds: { create: async (params: any, options: any) => {
        assert.ok(params.payment_intent.startsWith("pi_test_"));
        calls.push({ params, options }); await duringRefund();
        if (stripeError) throw stripeError;
        return { id: "re_test_" + params.metadata.bookingId, status: refundStatus };
      } }, transfers: { createReversal: async (id: string, params: any, options: any) => {
        assert.equal(id, "tr_test_existing"); reversalCalls.push({ params, options });
        await duringReversal();
        if (reversalError) throw reversalError;
        return { id: "trr_test_synthetic" };
      } },
    }) },
  };
  const load = (name: string): any => {
    if (name in replacements) return replacements[name];
    if (name === "./booking-payout-reconciliation") return load("@/lib/booking-payout-reconciliation");
    if (name === "./booking-refund-operations") return load("@/lib/booking-refund-operations");
    if (!name.startsWith("@/")) return nativeRequire(name);
    const output = ts.transpileModule(readFileSync(resolve(name.slice(2) + ".ts"), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const mod = { exports: {} }; new Function("require", "module", "exports", output)(load, mod, mod.exports); return mod.exports;
  };
  try {
    await db.exec(`CREATE TABLE provider_profiles (id text PRIMARY KEY, user_id text, plan text);
      CREATE TABLE services (id text PRIMARY KEY, business_name text, title text);
      INSERT INTO provider_profiles VALUES ('provider-profile','provider','free');
      INSERT INTO services VALUES ('service','Company','Repair');
      CREATE TABLE bookings (id uuid PRIMARY KEY, customer_id text DEFAULT 'customer', provider_id text DEFAULT 'provider-profile', service_id text DEFAULT 'service',
        price_cents integer DEFAULT 6000, payment_status text DEFAULT 'paid', refund_status text DEFAULT 'requested', stripe_payment_intent_id text,
        stripe_mode text DEFAULT 'test', payment_flow text DEFAULT 'held_transfer_v1', payment_release_status text DEFAULT 'frozen',
        provider_payout_cents integer DEFAULT 5197, platform_fee_cents integer DEFAULT 600, stripe_transfer_id text, stripe_transfer_reversed_cents integer DEFAULT 0,
        refunded_amount_cents integer DEFAULT 0, customer_service_fee_cents integer DEFAULT 299, customer_service_fee_refunded_cents integer DEFAULT 0,
        status text DEFAULT 'completed', refund_amount_cents integer, refund_failure_reason text, stripe_refund_id text, refunded_at timestamptz,
        payout_frozen_at timestamptz DEFAULT now(), payout_frozen_by text DEFAULT 'customer', payout_freeze_reason text DEFAULT 'Refund requested', payout_failure_reason text,
        customer_total_cents integer DEFAULT 6299, refund_requested_by text, refund_reason text, refund_requested_at timestamptz);
      CREATE TABLE booking_events (booking_id uuid, actor_user_id text, event_type text, message text, metadata jsonb);
      CREATE TABLE notifications (user_id text, booking_id uuid, type text, title text, message text, href text, dedupe_key text UNIQUE);`);
    const { POST } = load("@/app/api/bookings/[bookingId]/refund/route");
    const { recordBookingChargeRefund } = load("@/lib/booking-refund-reconciliation");
    const fixture = async () => {
      failure = ""; stripeError = null; reversalError = null; reversalCalls.length = 0; refundStatus = "succeeded"; userId = "provider"; beforeQuery = async () => {}; duringRefund = async () => {}; duringReversal = async () => {}; calls.length = 0;
      const id = randomUUID(); await db.query("INSERT INTO bookings (id,stripe_payment_intent_id) VALUES ($1,$2)", [id, "pi_test_" + id]); return id;
    };
    const send = (id: string, amount = 60) => POST(new Request("http://localhost/refund", { method: "POST", body: JSON.stringify({ action: "approve", amount }) }), { params: Promise.resolve({ bookingId: id }) });
    const booking = async (id: string) => (await db.query("SELECT * FROM bookings WHERE id=$1", [id])).rows[0];
    const webhook = (id: string, amountRefunded = 6299) => recordBookingChargeRefund({ bookingId: id, paymentIntentId: "pi_test_" + id, mode: "test", fullyRefunded: amountRefunded === 6299, amountRefunded, chargeAmount: 6299 });

    await t.test("original untyped refund audit parameters reproduce PostgreSQL 42P18", async () => {
      const id = await fixture();
      await assert.rejects(db.query(`INSERT INTO booking_events (booking_id,actor_user_id,event_type,message,metadata)
        VALUES ($1::uuid,$2,'refunded',$3,jsonb_build_object('amountCents',$4,'serviceFeeRefundCents',$5,'stripeRefundId',$6))`,
      [id, "provider", "Synthetic refund", 6299, 299, "re_test_original"]), { code: "42P18" });
    });
    await t.test("successful cumulative refund clears stale approval warning without inventing a refund ID", async () => {
      const id = await fixture(); stripeError = Object.assign(new Error("synthetic"), { code: "approval_required" });
      assert.equal((await send(id)).status, 202); assert.ok((await booking(id)).refund_failure_reason);
      await webhook(id); const row = await booking(id);
      assert.equal(row.refund_status, "refunded"); assert.equal(row.refund_failure_reason, null); assert.equal(row.stripe_refund_id, null);
    });
    await t.test("stale cumulative event cannot clear a newer outstanding refund warning", async () => {
      const id = await fixture();
      await db.query("UPDATE bookings SET refunded_amount_cents=1000, refund_amount_cents=2000, refund_status='processing', refund_failure_reason='New approval pending' WHERE id=$1", [id]);
      await webhook(id, 1000);
      assert.equal((await booking(id)).refund_failure_reason, "New approval pending");
    });

    for (const action of ["request", "reject"]) await t.test(`stale ${action} cannot replace an approval claim or emit a false event`, async () => {
      const id = await fixture();
      if (action === "request") { userId = "customer"; await db.query("UPDATE bookings SET refund_status='none' WHERE id=$1", [id]); }
      beforeQuery = async (sql) => {
        if (sql.includes(`UPDATE bookings SET refund_status = '${action === "request" ? "requested" : "rejected"}'`)) {
          beforeQuery = async () => {}; await db.query("UPDATE bookings SET refund_status='processing' WHERE id=$1", [id]);
        }
      };
      const response = await POST(new Request("http://localhost/refund", { method: "POST", body: JSON.stringify({ action, reason: "Synthetic reason" }) }), { params: Promise.resolve({ bookingId: id }) });
      assert.equal(response.status, 409); assert.equal((await booking(id)).refund_status, "processing");
      assert.equal((await db.query("SELECT * FROM booking_events WHERE booking_id=$1", [id])).rows.length, 0);
      assert.equal((await db.query("SELECT * FROM notifications WHERE booking_id=$1", [id])).rows.length, 0);
    });

    await t.test("request and rejection preserve an existing administrator hold", async () => {
      const id = await fixture();
      await db.query("UPDATE bookings SET refund_status='none', payout_freeze_reason='Admin investigation', payout_frozen_by='admin' WHERE id=$1", [id]);
      const frozenAt = (await booking(id)).payout_frozen_at;
      for (const action of ["request", "reject"]) {
        userId = action === "request" ? "customer" : "provider";
        const response = await POST(new Request("http://localhost/refund", { method: "POST", body: JSON.stringify({ action, reason: "Synthetic reason" }) }), { params: Promise.resolve({ bookingId: id }) });
        assert.equal(response.status, 200);
        const row = await booking(id); assert.equal(row.payment_release_status, "frozen");
        assert.equal(row.payout_freeze_reason, "Admin investigation"); assert.equal(row.payout_frozen_by, "admin"); assert.deepEqual(row.payout_frozen_at, frozenAt);
      }
    });
    await t.test("partial refund preserves an unrelated hold added during the Stripe call", async () => {
      const id = await fixture();
      duringRefund = async () => { await db.query("UPDATE bookings SET payout_freeze_reason='Stripe chargeback under review', payout_frozen_by='admin' WHERE id=$1", [id]); };
      assert.equal((await send(id, 30)).status, 200);
      const row = await booking(id); assert.equal(row.refunded_amount_cents, 3000); assert.equal(row.payment_release_status, "frozen");
      assert.equal(row.payout_freeze_reason, "Stripe chargeback under review"); assert.equal(row.payout_frozen_by, "admin"); assert.ok(row.payout_frozen_at);
    });
    await t.test("partial charge webhook before route settlement preserves administrator hold ownership", async () => {
      const id = await fixture();
      await db.query("UPDATE bookings SET payout_freeze_reason='Admin investigation', payout_frozen_by='admin' WHERE id=$1", [id]);
      const frozenAt = (await booking(id)).payout_frozen_at;
      duringRefund = async () => { await webhook(id, 3000); };
      assert.equal((await send(id, 30)).status, 200);
      const row = await booking(id); assert.equal(row.refunded_amount_cents, 3000); assert.equal(row.payment_release_status, "frozen");
      assert.equal(row.payout_freeze_reason, "Admin investigation"); assert.equal(row.payout_frozen_by, "admin"); assert.deepEqual(row.payout_frozen_at, frozenAt);
    });

    await t.test("full refund executes typed audit SQL and stable idempotency exactly once", async () => {
      const id = await fixture(); assert.equal((await send(id)).status, 200);
      const row = await booking(id); assert.equal(row.refund_status, "refunded"); assert.equal(row.refunded_amount_cents, 6000);
      assert.equal(row.customer_service_fee_refunded_cents, 299); assert.equal(row.provider_payout_cents, 0);
      assert.equal(calls[0].options.idempotencyKey, `booking-refund-${id}-total-6299`);
      assert.deepEqual((await db.query("SELECT metadata FROM booking_events WHERE booking_id=$1", [id])).rows[0].metadata,
        { amountCents: 6299, serviceFeeRefundCents: 299, stripeRefundId: "re_test_" + id });
      assert.equal((await send(id)).status, 409); assert.equal(calls.length, 1);
    });
    await t.test("webhook before route settlement cannot double-add the fee", async () => {
      const id = await fixture(); duringRefund = async () => { await webhook(id); };
      assert.equal((await send(id)).status, 200); await webhook(id);
      const row = await booking(id); assert.equal(row.refunded_amount_cents, 6000); assert.equal(row.customer_service_fee_refunded_cents, 299);
      assert.equal(row.payment_release_status, "reversed");
    });
    await t.test("newer webhook refund cannot be overwritten by a stale partial settlement", async () => {
      const id = await fixture(); duringRefund = async () => { await webhook(id); };
      assert.equal((await send(id, 30)).status, 202);
      const row = await booking(id); assert.equal(row.refunded_amount_cents, 6000); assert.equal(row.customer_service_fee_refunded_cents, 299);
      assert.equal(row.provider_payout_cents, 0); assert.equal(row.payment_release_status, "reversed");
    });
    for (const sql of ["UPDATE bookings SET refund_status = 'refunded'", "INSERT INTO booking_events", "INSERT INTO notifications"]) {
      await t.test(`post-Stripe failure at ${sql} does not claim no refund or permit a retry`, async () => {
        const id = await fixture(); failure = sql; const response = await send(id);
        assert.equal(response.status, 502); assert.equal(failure, ""); assert.match((await response.json()).error, /Stripe accepted/);
        assert.notEqual((await booking(id)).refund_status, "failed"); assert.equal((await send(id)).status, 409); assert.equal(calls.length, 1);
      });
    }
    for (const code of ["approval_required", "ECONNRESET"]) await t.test(`${code} remains processing and frozen, then webhook reconciles`, async () => {
      const id = await fixture(); stripeError = Object.assign(new Error("synthetic"), { code });
      const response = await send(id); assert.equal(response.status, code === "approval_required" ? 202 : 502);
      const body = await response.json(); assert.equal(body.reconciliationRequired, true); assert.doesNotMatch(body.error, /No refund was issued/);
      const row = await booking(id); assert.equal(row.refund_status, "processing"); assert.equal(row.payment_release_status, "frozen"); assert.ok(row.payout_frozen_at);
      assert.equal((await send(id)).status, 409); assert.equal(calls.length, 1);
      await webhook(id); assert.equal((await booking(id)).refund_status, "refunded");
    });
    await t.test("pending Stripe object is not reported as settled", async () => {
      const id = await fixture(); refundStatus = "pending"; assert.equal((await send(id)).status, 202);
      const row = await booking(id); assert.equal(row.refund_status, "processing"); assert.equal(row.refunded_amount_cents, 0); assert.equal(row.payment_release_status, "frozen");
      assert.equal((await send(id)).status, 409); assert.equal(calls.length, 1);
    });
    await t.test("webhook success followed by transport failure cannot downgrade settlement", async () => {
      const id = await fixture(); duringRefund = async () => { await webhook(id); }; stripeError = new Error("connection lost");
      assert.equal((await send(id)).status, 502); assert.equal((await booking(id)).refund_status, "refunded");
    });
    await t.test("asynchronous approval after payout requires manual transfer recovery", async () => {
      const id = await fixture(); await db.query("UPDATE bookings SET stripe_transfer_id='tr_test_existing', payment_release_status='paid_out' WHERE id=$1", [id]);
      stripeError = Object.assign(new Error("synthetic"), { code: "approval_required" });
      assert.equal((await send(id)).status, 202); await webhook(id);
      const row = await booking(id); assert.equal(row.refund_status, "refunded"); assert.equal(row.stripe_transfer_reversed_cents, 0);
      assert.match(row.payout_failure_reason, /transfer recovery review/);
    });
    for (const code of ["", "ECONNRESET", "approval_required"]) for (const amount of [30, 60]) {
      await t.test(`${amount} dollar refund with transfer reversal ${code || "success"} reports recovery truthfully`, async () => {
        const id = await fixture(); await db.query("UPDATE bookings SET stripe_transfer_id='tr_test_existing', payment_release_status='paid_out' WHERE id=$1", [id]);
        if (code) reversalError = Object.assign(new Error("synthetic reversal result"), { code });
        const response = await send(id, amount); assert.equal(response.status, 200);
        assert.equal((await response.json()).reversalNeedsReview, Boolean(code));
        const row = await booking(id); assert.equal(row.refund_status, "refunded"); assert.equal(row.refunded_amount_cents, amount * 100);
        assert.equal(row.payment_release_status, code ? "paid_out" : amount === 60 ? "reversed" : "partially_released");
        assert.equal(row.stripe_transfer_reversed_cents, code ? 0 : amount === 60 ? 5197 : 2598);
        if (code) assert.match(row.payout_failure_reason, /recovery is not confirmed/);
        else assert.equal(row.payout_failure_reason, null);
        assert.equal(reversalCalls.length, 1);
        assert.equal(reversalCalls[0].options.idempotencyKey, `booking-reversal-${id}-total-${amount === 60 ? 5197 : 2598}`);
        assert.equal((await send(id, amount)).status, 409); assert.equal(reversalCalls.length, 1);
      });
    }
    await t.test("asynchronous partial approval keeps held payout frozen for reconciliation", async () => {
      const id = await fixture(); stripeError = Object.assign(new Error("synthetic"), { code: "approval_required" });
      assert.equal((await send(id, 30)).status, 202); await webhook(id, 3000);
      const row = await booking(id); assert.equal(row.refunded_amount_cents, 3000); assert.equal(row.payment_release_status, "frozen");
      assert.match(row.payout_freeze_reason, /reconciliation/);
    });
    await t.test("later charge refund cannot recreate a warning after confirmed full transfer recovery", async () => {
      const id = await fixture();
      await db.query("UPDATE bookings SET stripe_transfer_id='tr_test_existing', stripe_transfer_reversed_cents=5197, payment_release_status='reversed', payout_failure_reason=NULL WHERE id=$1", [id]);
      await webhook(id);
      const row = await booking(id); assert.equal(row.payout_failure_reason, null); assert.equal(row.payment_release_status, "reversed");
    });
    await t.test("confirmed full reversal during lost Stripe response survives local refund settlement", async () => {
      const id = await fixture();
      await db.query("UPDATE bookings SET stripe_transfer_id='tr_test_existing', payment_release_status='paid_out' WHERE id=$1", [id]);
      duringReversal = async () => { await db.query("UPDATE bookings SET stripe_transfer_reversed_cents=5197, payment_release_status='reversed', payout_failure_reason=NULL WHERE id=$1", [id]); };
      reversalError = new Error("Lost response after confirmed recovery");
      const response = await send(id); assert.equal(response.status, 200); assert.equal((await response.json()).reversalNeedsReview, false);
      const row = await booking(id); assert.equal(row.payment_release_status, "reversed"); assert.equal(row.stripe_transfer_reversed_cents, 5197); assert.equal(row.payout_failure_reason, null);
    });
    await t.test("a second held partial refund reduces only the remaining provider share", async () => {
      const id = await fixture();
      await db.query("UPDATE bookings SET price_cents=1000,customer_total_cents=1299,refunded_amount_cents=200,provider_payout_cents=720 WHERE id=$1", [id]);
      assert.equal((await send(id, 1)).status, 200); const row = await booking(id);
      assert.equal(row.refunded_amount_cents, 300); assert.equal(row.provider_payout_cents, 630); assert.equal(calls[0].params.amount, 100);
    });
    for (const reversed of [0, 180]) await t.test(`transferred partial with prior refund/reversal ${reversed} fails before Stripe, but full remaining refund is safe`, async () => {
      const id = await fixture();
      await db.query("UPDATE bookings SET price_cents=1000,customer_total_cents=1299,refunded_amount_cents=200,provider_payout_cents=720,stripe_transfer_id='tr_test_existing',stripe_transfer_reversed_cents=$2,payment_release_status='paid_out' WHERE id=$1", [id, reversed]);
      assert.equal((await send(id, 1)).status, 409); assert.equal(calls.length, 0); assert.equal(reversalCalls.length, 0);
      assert.equal((await send(id, 8)).status, 200); const row = await booking(id);
      assert.equal(calls[0].params.amount, 1099); assert.equal(reversalCalls[0].params.amount, 720 - reversed);
      assert.equal(row.provider_payout_cents, 720); assert.equal(row.stripe_transfer_reversed_cents, 720); assert.equal(row.payment_release_status, "reversed");
    });
    await t.test("new transfer recovery after the manual refund read invalidates its claim", async () => {
      const id = await fixture(); await db.query("UPDATE bookings SET stripe_transfer_id='tr_test_existing' WHERE id=$1", [id]);
      beforeQuery = async (sql) => {
        if (sql.includes("UPDATE bookings SET refund_status = 'processing'")) {
          beforeQuery = async () => {}; await db.query("UPDATE bookings SET stripe_transfer_reversed_cents=100 WHERE id=$1", [id]);
        }
      };
      assert.equal((await send(id, 30)).status, 409); assert.equal(calls.length, 0); assert.equal(reversalCalls.length, 0);
    });
  } finally { await cleanup(); }
});

test("booking detail refund UI handles accepted-pending and uncertain outcomes without claiming success", async () => {
  const source = readFileSync("components/booking-details.tsx", "utf8");
  const start = source.indexOf('  async function refundAction(');
  const end = source.indexOf('  async function confirmCompletion()', start);
  assert.ok(start >= 0 && end > start);
  const output = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const status of [200, 202, 502, 0]) {
    const notices: string[] = []; const errors: string[] = []; let refreshes = 0;
    const refundAction = new Function("booking", "bookingId", "window", "setWorking", "setError", "setNotice", "fetch", "loadBooking", output + "; return refundAction;")(
      { price: 60, refund: { requestedAmount: 60, refundedAmount: 0 }, customerServiceFee: 0, customerServiceFeeRefunded: 0 }, "fixture",
      { prompt: () => "60", confirm: () => true }, () => {}, (s: string) => errors.push(s), (s: string) => notices.push(s),
      async () => { if (!status) throw new Error("lost response"); return Response.json(status === 200 ? { ok: true, amount: 60, reversalNeedsReview: true } : { error: "Refund needs review", reconciliationRequired: true }, { status }); },
      async () => { refreshes++; });
    await refundAction("approve"); assert.equal(refreshes, 1);
    if (status === 200) { assert.match(notices.at(-1)!, /\$60.00 refund was sent/); assert.match(notices.at(-1)!, /recovery is not confirmed/); }
    else { assert.equal(notices.at(-1), ""); assert.ok(errors.at(-1)); assert.doesNotMatch(notices.join(""), /undefined|refund was sent/); }
  }
});

test("persisted transfer recovery warnings remain visible for full and partial refunds", () => {
  const source = readFileSync("components/booking-details.tsx", "utf8");
  const start = source.indexOf("function paymentReleaseCopy("); assert.ok(start > 0);
  const output = ts.transpileModule(source.slice(start), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const copy = new Function(output + "; return paymentReleaseCopy;")();
  for (const paymentStatus of ["paid", "refunded"]) {
    const result = copy({ paymentStatus, paymentRelease: { status: "paid_out", failureReason: "Provider transfer recovery needs review." } });
    assert.match(result.detail, /recovery needs review/);
    assert.doesNotMatch(result.detail, /payout was reversed/);
  }
});

test("actual payment progress JSX renders the recovery warning after a full refund", () => {
  const source = readFileSync("components/booking-details.tsx", "utf8");
  const parsed = ts.createSourceFile("booking-details.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sections: string[] = [];
  let earningsDeclaration = "";
  const visit = (node: ts.Node) => {
    if (ts.isJsxExpression(node) && node.getText(parsed).includes("Payment progress")) sections.push(node.getText(parsed));
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => declaration.name.getText(parsed) === "providerServiceEarnings")) earningsDeclaration = node.getText(parsed);
    ts.forEachChild(node, visit);
  };
  visit(parsed); sections.sort((a, b) => a.length - b.length); assert.ok(sections.length); assert.ok(earningsDeclaration);
  // Compile the production JSX, including its enclosing status condition, rather
  // than duplicating a guard or testing only the release-copy helper.
  const output = ts.transpileModule(`export function PaymentProgress({ booking, releaseCopy }) {
    const postedTip = 0, customerPaymentTotal = 62.99;
    const processingFeeIsFinal = false, displayedProviderProcessingFee = 0;
    ${earningsDeclaration}
    return <>${sections[0]}</>;
  }`, { fileName: "payment-progress.tsx", compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} as any }; new Function("require", "module", "exports", output)(nativeRequire, mod, mod.exports);
  const { createElement } = nativeRequire("react");
  const { renderToStaticMarkup } = nativeRequire("react-dom/server");
  for (const paymentStatus of ["paid", "refunded", "pending"]) {
    const html = renderToStaticMarkup(createElement(mod.exports.PaymentProgress, {
      booking: { paymentStatus, viewerRole: "customer", price: 60, customerServiceFee: 2.99, paymentRelease: { freezeReason: null } },
      releaseCopy: { label: "Payment refunded", detail: "Provider transfer recovery needs review." },
    }));
    if (paymentStatus === "pending") assert.equal(html, "");
    else { assert.match(html, /Payment progress/); assert.match(html, /Provider transfer recovery needs review/); }
  }
  for (const [providerPayout, transferReversed, expectedEarnings] of [[0, 0, "0.00"], [0.79, 0, "0.79"], [0.79, 0.79, "0.00"]] as const) {
    const html = renderToStaticMarkup(createElement(mod.exports.PaymentProgress, {
      booking: { paymentStatus: "refunded", viewerRole: "provider", price: 1, customerServiceFee: 2.99,
        paymentRelease: { providerPayout, transferReversed, estimatedProviderPayout: 9.99, freezeReason: null, platformFeeBasisPoints: 1000, platformFeeCap: null, platformFee: 0.1 } },
      releaseCopy: { label: "Payment refunded", detail: "Refund recorded." },
    }));
    assert.match(html, new RegExp(`service earnings</span><span>\\$${expectedEarnings.replace(".", "\\.")}</span>`));
    assert.doesNotMatch(html, /\$9\.99/);
  }
});
