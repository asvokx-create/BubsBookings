import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

const migration = fs.readFileSync(new URL("../database/migrations/117_listing_active_email_queue.sql", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../lib/listing-active-email.ts", import.meta.url), "utf8");
const service = '00000000-0000-0000-0000-000000000001';
const provider = '00000000-0000-0000-0000-000000000002';
const company = '00000000-0000-0000-0000-000000000003';
async function fixture(publicAtStart = false) {
  const db = new PGlite();
  await db.exec(`CREATE TABLE "user"(id text PRIMARY KEY,email text,name text);
    CREATE TABLE provider_profiles(id uuid PRIMARY KEY,user_id text,business_name text,is_active boolean,age_verification_status text);
    CREATE TABLE provider_companies(id uuid PRIMARY KEY,is_active boolean);
    CREATE TABLE admin_audit_log(actor_user_id text,action text,target_type text,target_id text,details jsonb);
    CREATE TABLE services(id uuid PRIMARY KEY,provider_id uuid,company_id uuid,title text,business_name text,slug text,is_active boolean,provider_deleted_at timestamptz);
    INSERT INTO "user" VALUES('owner','synthetic@example.invalid','Jo Provider');
    INSERT INTO provider_profiles VALUES('${provider}','owner','Test business',true,'${publicAtStart ? 'verified' : 'requires_input'}');
    INSERT INTO provider_companies VALUES('${company}',true);
    INSERT INTO services VALUES('${service}','${provider}','${company}','Test service','Listing business','test-service',true,NULL);`);
  await db.exec(migration);
  const sent: Record<string, unknown>[] = [];
  let fail = false;
  let crash = false;
  let configured = true;
  let locked = true;
  const query = async (sql: string, params?: unknown[]) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [] };
    return db.query(sql, params);
  };
  const exports: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  const sandbox = { exports, require: (name: string) => {
    if (name === 'server-only') return {};
    if (name === './database') return { database: { query, connect: async () => ({ query, release() {} }) } };
    if (name === './email') return { isEmailConfigured: () => configured, sendTransactionalEmail: async (payload: Record<string, unknown>) => {
      sent.push(payload);
      if (crash) throw Error('Simulated process crash after provider acceptance');
      return { sent: !fail, providerMessageId: 'synthetic-email' };
    } };
    throw Error(name);
  } };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  return { db, sent, request: (userId = "owner") => exports.requestListingActiveEmail({ serviceId: service, userId, actorUserId: "admin" }), run: () => exports.processListingActiveEmailQueue(),
    fail: (value: boolean) => { fail = value; }, crash: (value: boolean) => { crash = value; },
    lockAvailable: (value: boolean) => { locked = value; },
    configured: (value: boolean) => { configured = value; },
    activate: () => db.exec("UPDATE provider_profiles SET age_verification_status='verified'"),
    row: async () => (await db.query<{ status: string; attempt_count: number; payload: unknown; first_attempt_at: unknown }>("SELECT * FROM listing_active_email_deliveries")).rows[0],
    due: () => db.exec("UPDATE listing_active_email_deliveries SET next_attempt_at=now()-interval '1 minute', attempted_at=now()-interval '16 minutes'") };
}

test('existing public listings are baselined once; migration reruns do not suppress new activations', async () => {
  const f = await fixture(true);
  try {
    await f.run(); assert.equal(f.sent.length, 0); assert.equal((await f.row()).status, 'suppressed');
    await f.db.exec(`INSERT INTO services VALUES('00000000-0000-0000-0000-000000000004','${provider}','${company}','New service','New business','new-service',true,NULL)`);
    await f.db.exec(migration);
    await f.run(); assert.equal(f.sent.length, 1);
  } finally { await f.db.close(); }
});

test('age-held listing sends once after verification or admin pass and not after reactivation', async () => {
  const f = await fixture();
  try {
    await f.run(); assert.equal(f.sent.length, 0);
    await f.activate(); await f.run(); await f.run(); assert.equal(f.sent.length, 1);
    await f.db.exec("UPDATE services SET is_active=false"); await f.run();
    await f.db.exec("UPDATE services SET is_active=true"); await f.run(); assert.equal(f.sent.length, 1);
    assert.equal((await f.row()).status, 'sent');
    assert.match(String(f.sent[0].message), /Listing business/); assert.match(String(f.sent[0].message), /earnings/); assert.match(String(f.sent[0].message), /QR code/);
    assert.match(JSON.stringify(f.sent[0].actions), /\/provider\/dashboard\/revenue/);
    assert.match(JSON.stringify(f.sent[0].actions), /\/services\/test-service/);
  } finally { await f.db.close(); }
});

test('inactive provider, company, paused and deleted services never qualify', async () => {
  const f = await fixture();
  try {
    await f.activate();
    for (const [off, on] of [
      ["UPDATE provider_profiles SET is_active=false", "UPDATE provider_profiles SET is_active=true"],
      ["UPDATE provider_companies SET is_active=false", "UPDATE provider_companies SET is_active=true"],
      ["UPDATE services SET is_active=false", "UPDATE services SET is_active=true"],
      ["UPDATE services SET provider_deleted_at=now()", "UPDATE services SET provider_deleted_at=NULL"],
    ]) { await f.db.exec(off); await f.run(); assert.equal(f.sent.length, 0); await f.db.exec(on); }
    await f.run(); assert.equal(f.sent.length, 1);
  } finally { await f.db.close(); }
});

test('retries freeze payload and pause while listing is private', async () => {
  const f = await fixture();
  try {
    await f.activate(); f.fail(true); await f.run(); assert.equal((await f.row()).attempt_count, 1);
    await f.due(); await f.db.exec("UPDATE services SET is_active=false,title='Edited title'");
    await f.run(); assert.equal(f.sent.length, 1);
    await f.db.exec("UPDATE services SET is_active=true"); f.fail(false); await f.run();
    assert.deepEqual(JSON.parse(JSON.stringify(f.sent[0])), JSON.parse(JSON.stringify(f.sent[1]))); assert.equal((await f.row()).status, 'sent');
  } finally { await f.db.close(); }
});

test('crash retains committed payload/deadline, and retries stop before dedupe expires', async () => {
  const f = await fixture();
  try {
    await f.activate(); f.crash(true); await assert.rejects(f.run(), /Simulated process crash/);
    let row = await f.row(); assert.equal(row.status, 'sending'); assert.equal(row.attempt_count, 1); assert.ok(row.payload); assert.ok(row.first_attempt_at);
    f.crash(false); await f.run(); assert.equal(f.sent.length, 1, 'no immediate duplicate on abandoned lease');
    await f.db.exec("UPDATE listing_active_email_deliveries SET first_attempt_at=now()-interval '24 hours'");
    await f.due(); await f.run(); row = await f.row(); assert.equal(row.status, 'review_required'); assert.equal(f.sent.length, 1);
  } finally { await f.db.close(); }
});

test('recipient changes stop retries and missing configuration consumes no attempts', async () => {
  const f = await fixture();
  try {
    await f.activate(); f.configured(false); await f.run(); assert.equal(f.sent.length, 0);
    f.configured(true); f.fail(true); await f.run(); await f.due();
    await f.db.exec("UPDATE \"user\" SET email='new@example.invalid'"); await f.run();
    assert.equal(f.sent.length, 1); assert.equal((await f.row()).status, 'review_required');
  } finally { await f.db.close(); }
});


test('a competing sender lock is skipped without consuming an attempt', async () => {
  const f = await fixture();
  try {
    await f.activate(); f.lockAvailable(false); await f.run();
    assert.equal(f.sent.length, 0); assert.equal((await f.row()).attempt_count, 0);
    f.lockAvailable(true); await f.run(); assert.equal(f.sent.length, 1);
  } finally { await f.db.close(); }
});

test('slug changes stop retry rather than email a stale public link', async () => {
  const f = await fixture();
  try {
    await f.activate(); f.fail(true); await f.run(); await f.due();
    await f.db.exec("UPDATE services SET slug='new-slug'"); await f.run();
    assert.equal(f.sent.length, 1); assert.equal((await f.row()).status, 'review_required');
  } finally { await f.db.close(); }
});

test('migration discovery accepts numeric gaps and applies the queue after current schema', () => {
  const files = fs.readdirSync(new URL('../database/migrations/', import.meta.url))
    .filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.indexOf('117_listing_active_email_queue.sql') > files.indexOf('110_better_auth_legacy_issuer.sql'));
  const runner = fs.readFileSync(new URL('../scripts/setup-marketplace-db.mjs', import.meta.url), 'utf8');
  assert.match(runner, /readdir\(migrationsUrl\)/);
  assert.match(runner, /\.sort\(\)/);
  assert.match(runner, /for \(const fileName of migrationFiles\)/);
  // The runner enumerates filenames, not consecutive version numbers. The
  // migration replay test above proves its one-time baseline survives reruns.
});


test('admin can explicitly send a baselined public listing once, with actor audit', async () => {
  const f = await fixture(true);
  try {
    await f.request(); await f.request(); await f.run();
    assert.equal(f.sent.length, 1); assert.equal((await f.row()).status, 'sent');
    const audit = await f.db.query<{ actor_user_id: string; action: string }>('SELECT * FROM admin_audit_log');
    assert.equal(audit.rows.length, 1); assert.equal(audit.rows[0].actor_user_id, 'admin');
    assert.equal(audit.rows[0].action, 'listing_active_email_requested');
  } finally { await f.db.close(); }
});

test('manual request refuses private listings and another account without audit/send', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request() as {status:string}).status, 'not_public');
    await f.activate();
    assert.equal((await f.request('other-owner') as {status:string}).status, 'not_public');
    assert.equal(f.sent.length, 0);
    assert.equal((await f.db.query('SELECT * FROM admin_audit_log')).rows.length, 0);
  } finally { await f.db.close(); }
});

test('manual send targets only selected listing; uncertain deliveries cannot be reset', async () => {
  const f = await fixture(true);
  try {
    await f.db.exec(`INSERT INTO services VALUES('00000000-0000-0000-0000-000000000004','${provider}','${company}','Other service','Other business','other-service',true,NULL)`);
    await f.request(); assert.equal(f.sent.length, 1);
    assert.equal((await f.db.query('SELECT * FROM listing_active_email_deliveries')).rows.length, 1);
    await f.db.exec("UPDATE listing_active_email_deliveries SET status='review_required'");
    await f.request(); assert.equal(f.sent.length, 1); assert.equal((await f.row()).status, 'review_required');
  } finally { await f.db.close(); }
});

test('admin UI and API require explicit selected-listing confirmation and authentication', () => {
  const route = fs.readFileSync(new URL('../app/api/admin/accounts/[userId]/route.ts', import.meta.url), 'utf8');
  const ui = fs.readFileSync(new URL('../components/admin-dashboard.tsx', import.meta.url), 'utf8');
  assert.match(route, /getAdminSession/); assert.match(route, /body.confirmed !== true/);
  assert.match(route, /actorUserId: session.user.id/);
  assert.match(ui, /window.confirm\(`Send the listing-active email/);
  assert.match(ui, /service.publicly_visible && \(!status \|\| status === "suppressed"\)/);
  assert.match(ui, /serviceId: service.id, confirmed: true/);
});

test('closing or switching accounts prevents stale fetch and send refresh from reopening old account', async () => {
  const ui = fs.readFileSync(new URL('../components/admin-dashboard.tsx', import.meta.url), 'utf8');
  const methods = ui.slice(ui.indexOf('  async function openAccount(account: Account)'), ui.indexOf('  useEffect(() => {\n    if (!selectedAccount)'));
  const pending: Array<(value: unknown) => void> = [];
  let selected: unknown; let details: unknown;
  const context: Record<string, unknown> = {
    activeAccountId: { current: null }, accountRequestVersion: { current: 0 },
    setSelectedAccount: (v: unknown) => { selected = v; }, setAccountDetails: (v: unknown) => { details = v; },
    setAccountDetailsError() {}, setAccountDetailsLoading() {},
    fetch: () => new Promise(resolve => pending.push(resolve)), encodeURIComponent,
  };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(methods, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const open = context.openAccount as (a: { id: string }) => Promise<void>;
  const close = context.closeAccount as () => void;
  const refresh = context.refreshAccount as (a: { id: string }) => Promise<void>;
  const a = open({ id: 'a' }); close();
  pending.shift()!({ ok: true, json: async () => ({ id: 'a' }) }); await a;
  assert.equal(selected, null); assert.equal(details, null);
  await refresh({ id: 'a' }); assert.equal(pending.length, 0);
  const old = open({ id: 'a' }); const newer = open({ id: 'b' });
  pending.shift()!({ ok: true, json: async () => ({ id: 'a' }) }); await old;
  assert.equal(details, null);
  pending.shift()!({ ok: true, json: async () => ({ id: 'b' }) }); await newer;
  assert.deepEqual(details, { id: 'b' });
  await refresh({ id: 'a' }); assert.equal(pending.length, 0);
  assert.match(ui, /key=\{selectedAccount.id\}/);
  assert.match(ui, /if \(!dialogActive.current\) return;\s*setActivationEmailResult/);
});
