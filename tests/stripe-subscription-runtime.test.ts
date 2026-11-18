/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic Stripe boundary around the real signed handler and PostgreSQL queries. */
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
const webhookSecret = "whsec_local_subscription_regression_only";
const signatureTools = new Stripe("sk_test_local_signature_tools_only").webhooks;

for (const postgres of [false, true]) test(`${postgres ? "PostgreSQL" : "PGlite"} signed Pro subscription webhook`, {
  skip: postgres && process.env.BOOKME_MIGRATION_TEST_DATABASE !== "1",
}, async (t) => {
  let db: any;
  let cleanup: () => Promise<void>;
  if (postgres) {
    const connectionString = process.env.DATABASE_URL ?? "postgresql://bookme:bookme@127.0.0.1:5432/bookme";
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(connectionString).hostname)) {
      throw new Error("Subscription tests require an explicitly opted-in localhost PostgreSQL database.");
    }
    const schema = "subscription_webhook_test_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString, ssl: false });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString, ssl: false, options: `-c search_path=${schema}`, max: 4 });
    db = { query: (sql: string, values: unknown[] = []) => pool.query(sql, values), exec: (sql: string) => pool.query(sql), connect: () => pool.connect() };
    cleanup = async () => {
      await pool.end();
      try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
    };
  } else {
    db = new PGlite();
    cleanup = () => db.close();
  }
  const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
  let mode = "test";
  const failures: string[] = [];
  t.beforeEach(() => { failures.length = 0; errors.length = 0; mode = "test"; });
  const subscriptions = new Map<string, any>();
  const stripe = {
    webhooks: signatureTools,
    subscriptions: { retrieve: async (id: string) => {
      assert.ok(subscriptions.has(id), "only a known synthetic subscription may be retrieved");
      return subscriptions.get(id);
    } },
  };
  const query = async (sql: string, values: unknown[] = [], executor: any = db) => {
    if (failures.length && sql.includes(failures[0])) {
      failures.shift();
      return executor.query("SELECT 1 / 0 AS simulated_database_failure");
    }
    const result = await executor.query(sql, values);
    return { ...result, rowCount: result.rowCount ?? (result.affectedRows || result.rows.length) };
  };
  const database = {
    query,
    connect: async () => {
      if (!postgres) return { query, release() {} };
      const client = await db.connect();
      return { query: (sql: string, values: unknown[] = []) => query(sql, values, client), release: () => client.release() };
    },
  };
  const replacements: Record<string, unknown> = {
    "server-only": {},
    "@/lib/database": { database },
    "@/lib/stripe": { getStripe: () => stripe, getStripeMode: () => mode },
    // Unexpected side effects fail closed; no network services are available.
    "@/lib/analytics": {}, "@/lib/provider-verification": {}, "@/lib/email": {},
    "@/lib/affiliates": {}, "@/lib/affiliate-payouts": {}, "@/lib/tip-payments": {},
    "@/lib/provider-age-verification": {}, "@/lib/booking-processing-fees": {},
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
    await db.exec(`CREATE TABLE "user" (id text PRIMARY KEY, email text, "emailVerified" boolean DEFAULT false);`);
    // Execute the real schema migrations for subscriptions, teams, grants, and notifications.
    const migrations = [
      "001_bookme_marketplace.sql", "003_notifications.sql", "012_provider_team.sql",
      "022_stripe_payments.sql", "024_stripe_modes.sql", "036_pro_team_seat_addons.sql",
      "039_worker_portal_and_schedule_approval.sql", "045_pro_plan_trials.sql",
      "050_subscription_checkout_safety.sql", "073_team_invitation_seats.sql",
      "094_subscription_cancellation_state.sql", "097_complimentary_pro_grants.sql",
    ];
    for (const migration of migrations) {
      if (migration === "024_stripe_modes.sql") {
        await db.exec("ALTER TABLE provider_profiles ADD plan text NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter','pro','business','owner'))");
      }
      await db.exec(readFileSync("database/migrations/" + migration, "utf8").replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""));
    }
    const { POST } = load("@/app/api/stripe/webhook/route") as { POST: (request: Request) => Promise<Response> };
    const fixture = async (status = "active", plan = "starter") => {
      const providerId = randomUUID();
      const subscriptionId = "sub_test_" + providerId;
      await db.query('INSERT INTO "user" (id) VALUES ($1)', [providerId]);
      await db.query(`INSERT INTO provider_profiles (id,user_id,business_name,city,state,plan,stripe_subscription_checkout_session_id)
        VALUES ($1::uuid,$1::text,'Synthetic provider','City','ST',$2,$3)`, [providerId, plan, "cs_test_" + providerId]);
      for (const memberStatus of ["pending", "active", "inactive"]) {
        await db.query(`INSERT INTO provider_team_members (provider_id,name,email,status)
          VALUES ($1,'Synthetic member',$2,$3)`, [providerId, memberStatus + "@example.invalid", memberStatus]);
      }
      const subscription = {
        id: subscriptionId, object: "subscription", status, cancel_at_period_end: false, trial_end: 1900000000,
        metadata: { kind: "provider_subscription", providerId, plan: "pro" },
        items: { data: [
          { id: "si_base_" + providerId, current_period_end: 1901000000, metadata: {}, price: { lookup_key: null } },
          { id: "si_seat_" + providerId, quantity: 2, current_period_end: 1901000000, metadata: { kind: "pro_extra_team_seat" }, price: { lookup_key: null } },
        ] },
      };
      subscriptions.set(subscriptionId, subscription);
      return { providerId, subscription, eventId: "evt_test_" + providerId };
    };
    const send = async (f: Awaited<ReturnType<typeof fixture>>, options: { eventId?: string; type?: string; created?: number; livemode?: boolean; badSignature?: boolean; object?: unknown } = {}) => {
      const payload = JSON.stringify({
        id: options.eventId ?? f.eventId, object: "event", type: options.type ?? "customer.subscription.updated",
        created: options.created ?? 1800000000, livemode: options.livemode ?? mode === "live",
        data: { object: options.object ?? f.subscription },
      });
      const signature = signatureTools.generateTestHeaderString({ payload, secret: options.badSignature ? "whsec_wrong_local_secret" : webhookSecret });
      return POST(new Request("http://localhost/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": signature }, body: payload }));
    };
    const success = async (response: Response) => {
      assert.equal(response.status, 200, JSON.stringify(errors));
      assert.deepEqual(await response.json(), { received: true });
    };
    const profile = async (f: Awaited<ReturnType<typeof fixture>>) => (await db.query("SELECT * FROM provider_profiles WHERE id=$1", [f.providerId])).rows[0];
    const team = async (f: Awaited<ReturnType<typeof fixture>>) => (await db.query("SELECT status FROM provider_team_members WHERE provider_id=$1 ORDER BY email", [f.providerId])).rows.map((row: any) => row.status);
    const eventCount = async (id: string) => (await db.query("SELECT count(*)::int AS count FROM stripe_webhook_events WHERE id=$1", [id])).rows[0].count;
    const invoice = (f: Awaited<ReturnType<typeof fixture>>) => ({
      id: "in_test_" + f.providerId, parent: { subscription_details: { subscription: f.subscription.id } },
    });

    await t.test("created and updated events persist all bound values and duplicates are no-ops", async () => {
      const f = await fixture();
      await success(await send(f, { type: "customer.subscription.created" }));
      const saved = await profile(f);
      assert.equal(saved.plan, "pro");
      assert.equal(saved.stripe_subscription_id, f.subscription.id);
      assert.equal(saved.stripe_subscription_checkout_session_id, null);
      assert.equal(saved.stripe_subscription_status, "active");
      assert.equal(saved.stripe_current_period_end.toISOString(), new Date(1901000000 * 1000).toISOString());
      assert.equal(saved.stripe_billing_mode, "test");
      assert.equal(saved.extra_team_seats, 2);
      assert.equal(saved.stripe_team_seat_item_id, f.subscription.items.data[1].id);
      assert.equal(saved.stripe_cancel_at_period_end, false);
      assert.equal(String(saved.stripe_subscription_event_created_at), "1800000000");
      assert.deepEqual(await (await send(f)).json(), { received: true, duplicate: true });
      assert.deepEqual(await profile(f), saved);
      f.subscription.cancel_at_period_end = true;
      await success(await send(f, { eventId: f.eventId + "_cancel", created: 1800000001 }));
      assert.equal((await profile(f)).stripe_cancel_at_period_end, true);
      assert.deepEqual(await team(f), ["active", "inactive", "pending"]);
    });

    for (const billingMode of ["test", "live"]) await t.test(`trial timestamps are preserved and isolated in ${billingMode} mode`, async () => {
      mode = billingMode;
      const f = await fixture("trialing");
      await success(await send(f));
      const saved = await profile(f);
      const field = "pro_trial_used_at_" + billingMode;
      assert.ok(saved[field]);
      assert.equal(saved[billingMode === "test" ? "pro_trial_used_at_live" : "pro_trial_used_at_test"], null);
      assert.equal(saved.stripe_current_period_end.toISOString(), new Date(f.subscription.trial_end * 1000).toISOString());
      await success(await send(f, { eventId: f.eventId + "_repeat" }));
      assert.deepEqual((await profile(f))[field], saved[field]);
    });

    await t.test("past-due retries preserve Pro and team access", async () => {
      const f = await fixture("past_due", "pro");
      await success(await send(f));
      assert.equal((await profile(f)).plan, "pro");
      assert.equal((await profile(f)).extra_team_seats, 2);
      assert.deepEqual(await team(f), ["active", "inactive", "pending"]);
    });

    for (const status of ["unpaid", "paused", "incomplete", "incomplete_expired", "canceled"]) await t.test(`${status} removes paid access and seats atomically`, async () => {
      const f = await fixture(status, "pro");
      f.subscription.items.data = [];
      await success(await send(f));
      const saved = await profile(f);
      assert.equal(saved.plan, "starter");
      assert.equal(saved.stripe_subscription_status, status);
      assert.equal(saved.extra_team_seats, 0);
      assert.equal(saved.stripe_team_seat_item_id, null);
      assert.equal(saved.stripe_current_period_end, null);
      assert.deepEqual(await team(f), ["inactive", "inactive", "inactive"]);
    });

    for (const grant of ["active", "lifetime", "expired", "future", "revoked"]) await t.test(`${grant} complimentary Pro is respected`, async () => {
      const f = await fixture("unpaid", "pro");
      await db.query(`INSERT INTO complimentary_pro_grants (provider_id,granted_by,starts_at,expires_at,revoked_at)
        VALUES ($1::uuid,$1::text,${grant === "future" ? "now()+interval '1 day'" : "now()-interval '2 days'"},
          ${grant === "lifetime" ? "NULL" : grant === "expired" ? "now()-interval '1 day'" : "now()+interval '2 days'"},
          ${grant === "revoked" ? "now()" : "NULL"})`, [f.providerId]);
      await success(await send(f));
      const retained = ["active", "lifetime"].includes(grant);
      assert.equal((await profile(f)).plan, retained ? "pro" : "starter");
      assert.equal((await profile(f)).extra_team_seats, 0);
      assert.deepEqual(await team(f), retained ? ["active", "inactive", "pending"] : ["inactive", "inactive", "inactive"]);
    });

    await t.test("stale and post-cancellation subscription events cannot restore access", async () => {
      const f = await fixture("active");
      await success(await send(f));
      const active = await profile(f);
      f.subscription.status = "unpaid";
      await success(await send(f, { eventId: f.eventId + "_stale", created: 1799999999 }));
      assert.deepEqual(await profile(f), active);
      assert.deepEqual(await team(f), ["active", "inactive", "pending"]);
      f.subscription.status = "canceled";
      await success(await send(f, { eventId: f.eventId + "_deleted", type: "customer.subscription.deleted", created: 1800000001 }));
      const canceled = await profile(f);
      assert.equal(canceled.plan, "starter");
      assert.equal(canceled.stripe_subscription_id, null);
      f.subscription.status = "active";
      await success(await send(f, { eventId: f.eventId + "_late", created: 1800000002 }));
      assert.deepEqual(await profile(f), canceled);
    });

    await t.test("owner and invalid subscription metadata do not alter provider access", async () => {
      const owner = await fixture("unpaid", "owner");
      const original = await profile(owner);
      await success(await send(owner));
      assert.deepEqual(await profile(owner), original);
      assert.deepEqual(await team(owner), ["active", "inactive", "pending"]);
      const ordinary = await fixture();
      const ordinaryOriginal = await profile(ordinary);
      for (const metadata of [{ providerId: "", plan: "pro" }, { providerId: ordinary.providerId, plan: "starter" }]) {
        await success(await send(ordinary, { eventId: "evt_test_" + randomUUID(), object: { ...ordinary.subscription, metadata } }));
        assert.deepEqual(await profile(ordinary), ordinaryOriginal);
        assert.deepEqual(await team(ordinary), ["active", "inactive", "pending"]);
      }
    });

    await t.test("invoice.paid retrieves current subscription and preserves the event watermark", async () => {
      const f = await fixture();
      await success(await send(f));
      f.subscription.cancel_at_period_end = true;
      await success(await send(f, { type: "invoice.paid", eventId: f.eventId + "_invoice", object: invoice(f) }));
      assert.equal((await profile(f)).stripe_cancel_at_period_end, true);
      assert.equal(String((await profile(f)).stripe_subscription_event_created_at), "1800000000");
      const notifications = (await db.query("SELECT * FROM notifications WHERE user_id=$1", [f.providerId])).rows;
      assert.equal(notifications.length, 0);
    });

    await t.test("invoice.payment_failed synchronizes current state and notifies only once per invoice", async () => {
      const f = await fixture("past_due");
      const options = { type: "invoice.payment_failed", object: invoice(f) };
      await success(await send(f, options));
      await success(await send(f, { ...options, eventId: f.eventId + "_repeat" }));
      assert.equal((await profile(f)).stripe_subscription_status, "past_due");
      assert.equal((await profile(f)).plan, "pro");
      assert.equal((await profile(f)).stripe_subscription_event_created_at, null);
      const notifications = (await db.query("SELECT * FROM notifications WHERE user_id=$1", [f.providerId])).rows;
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].dedupe_key, "provider-invoice-failed-" + invoice(f).id);
    });

    await t.test("non-provider and subscriptionless invoices are ignored", async () => {
      const f = await fixture();
      const original = await profile(f);
      f.subscription.metadata.kind = "unrelated";
      await success(await send(f, { type: "invoice.payment_failed", object: invoice(f) }));
      await success(await send(f, { eventId: f.eventId + "_none", type: "invoice.paid", object: { id: "in_test_none", parent: null } }));
      assert.deepEqual(await profile(f), original);
    });

    for (const failure of ["UPDATE provider_profiles SET", "UPDATE provider_team_members SET"]) await t.test(`database failure at ${failure} rolls back and retries`, async () => {
      const f = await fixture("unpaid", "pro");
      const original = await profile(f);
      failures.push(failure);
      assert.equal((await send(f)).status, 500);
      assert.equal(failures.length, 0);
      assert.deepEqual(await profile(f), original);
      assert.deepEqual(await team(f), ["active", "inactive", "pending"]);
      assert.equal(await eventCount(f.eventId), 0);
      await success(await send(f));
      assert.equal((await profile(f)).plan, "starter");
      assert.deepEqual(await team(f), ["inactive", "inactive", "inactive"]);
    });

    for (const failure of ["INSERT INTO notifications", "UPDATE stripe_webhook_events SET status"]) await t.test(`invoice failure at ${failure} remains retryable without duplicate notifications`, async () => {
      const f = await fixture("past_due");
      const options = { type: "invoice.payment_failed", object: invoice(f) };
      failures.push(failure);
      assert.equal((await send(f, options)).status, 500);
      assert.equal(failures.length, 0);
      assert.equal(await eventCount(f.eventId), 0);
      await success(await send(f, options));
      assert.deepEqual(await (await send(f, options)).json(), { received: true, duplicate: true });
      assert.equal((await db.query("SELECT count(*)::int AS count FROM notifications WHERE user_id=$1", [f.providerId])).rows[0].count, 1);
    });

    await t.test("invalid signatures and wrong billing mode cannot claim or change subscription state", async () => {
      const f = await fixture();
      const original = await profile(f);
      assert.equal((await send(f, { badSignature: true })).status, 400);
      assert.equal((await send(f, { livemode: true })).status, 400);
      assert.equal(await eventCount(f.eventId), 0);
      assert.deepEqual(await profile(f), original);
    });
  } finally {
    if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
    await cleanup();
  }
});

