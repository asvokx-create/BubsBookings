// Synthetic loopback-only PostgreSQL test. Never pass a production connection.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import ts from 'typescript';
const url = process.env.LISTING_EMAIL_TEST_DATABASE_URL;
if (!url) throw Error('Set LISTING_EMAIL_TEST_DATABASE_URL to a dedicated loopback cluster');
const parsed = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.port === '5432') throw Error('Dedicated loopback nondefault port required');
const schema = process.env.LISTING_EMAIL_TEST_SCHEMA || `listing_email_synthetic_${process.pid}`;
if (!/^listing_email_synthetic_[0-9]+$/.test(schema)) throw Error('Invalid synthetic schema');
process.env.LISTING_EMAIL_TEST_SCHEMA = schema;
const pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${schema} -c statement_timeout=5000` });
const mode = process.argv[2];
const service = '00000000-0000-0000-0000-000000000001';
function load() {
  const context = { exports: {}, require: name => {
    if (name === 'server-only') return {};
    if (name === './database') return { database: pool };
    if (name === './email') return { isEmailConfigured: () => true, sendTransactionalEmail: async payload => {
      await pool.query('INSERT INTO synthetic_requests(payload) VALUES($1)', [payload]);
      if (mode === 'hold' || mode === 'crash' || mode === 'admin-hold') {
        process.send({ ready: true });
        if (mode === 'crash') await new Promise(() => {});
        await new Promise(resolve => process.once('message', resolve));
      }
      return { sent: true, providerMessageId: 'synthetic' };
    } };
    throw Error(name);
  } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/listing-active-email.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  return context.exports;
}
if (mode) {
  try { const api = load(); const result = mode.startsWith('admin-')
    ? await api.requestListingActiveEmail({ serviceId: service, userId: 'owner', actorUserId: 'synthetic-admin' })
    : await api.processListingActiveEmailQueue(); process.send({ done: true, result }); } finally { await pool.end(); }
  process.exit(0);
}
const children = new Set();
const child = mode => { const c = fork(fileURLToPath(import.meta.url), [mode], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }); children.add(c); c.on('exit', () => children.delete(c)); return c; };
const message = c => new Promise((resolve, reject) => { const t = setTimeout(() => reject(Error('worker timed out')), 15000); c.once('message', m => { clearTimeout(t); resolve(m); }); c.once('error', reject); });
const kill = c => new Promise(resolve => { c.once('exit', resolve); c.kill('SIGKILL'); });
try {
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE "user"(id text PRIMARY KEY,email text,name text);
    CREATE TABLE provider_profiles(id uuid PRIMARY KEY,user_id text,business_name text,is_active boolean,age_verification_status text);
    CREATE TABLE provider_companies(id uuid PRIMARY KEY,provider_id uuid,name text,is_active boolean);
    CREATE TABLE services(id uuid PRIMARY KEY,provider_id uuid,company_id uuid,title text,business_name text,slug text,is_active boolean,provider_deleted_at timestamptz);
    CREATE TABLE synthetic_requests(payload jsonb);
    CREATE TABLE admin_audit_log(actor_user_id text,action text,target_type text,target_id text,details jsonb);
    INSERT INTO "user" VALUES('owner','synthetic@example.invalid','Test Owner');
    INSERT INTO provider_profiles VALUES('${service}','owner','Test',true,'requires_input');
    INSERT INTO provider_companies VALUES('${service}','${service}','Fixture company',true);
    INSERT INTO services VALUES('${service}','${service}','${service}','Test service','Test','test',true,NULL)`);
  const migration = fs.readFileSync('database/migrations/117_listing_active_email_queue.sql', 'utf8');
  await pool.query(migration); await pool.query(migration);
  await pool.query("UPDATE provider_profiles SET age_verification_status='verified'");
  const first = child('hold'); assert.equal((await message(first)).ready, true);
  const other = await message(child('run')); assert.equal(other.result.listingActiveSent, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM synthetic_requests')).rows[0].n, 1);
  const finished = message(first); first.send('continue'); await finished;
  console.log('PASS cross-process overlapping cron sends exactly one request');
  await pool.query('TRUNCATE listing_active_email_deliveries, synthetic_requests');
  const crashing = child('crash'); await message(crashing); await kill(crashing);
  const row = (await pool.query('SELECT * FROM listing_active_email_deliveries')).rows[0];
  assert.equal(row.status, 'sending'); assert.equal(row.attempt_count, 1); assert.ok(row.first_attempt_at); assert.ok(row.payload);
  await pool.query("UPDATE listing_active_email_deliveries SET attempted_at=now()-interval '16 minutes'");
  const resumed = await message(child('run')); assert.equal(resumed.result.listingActiveSent, 1);
  const requests = (await pool.query('SELECT payload FROM synthetic_requests')).rows;
  assert.equal(requests.length, 2); assert.deepEqual(requests[0].payload, requests[1].payload);
  assert.equal((await pool.query('SELECT status FROM listing_active_email_deliveries')).rows[0].status, 'sent');
  console.log('PASS SIGKILL releases lock; durable claim retries with exact same payload/key (Resend mocked)');
  await pool.query("UPDATE listing_active_email_deliveries SET status='sending',first_attempt_at=now()-interval '24 hours',attempted_at=now()-interval '16 minutes'");
  await message(child('run'));
  assert.equal((await pool.query('SELECT status FROM listing_active_email_deliveries')).rows[0].status, 'review_required');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM synthetic_requests')).rows[0].n, 2);
  console.log('PASS expired retry window never calls sender');
  await pool.query("TRUNCATE listing_active_email_deliveries,synthetic_requests,admin_audit_log");
  await pool.query("INSERT INTO listing_active_email_deliveries(service_id,status) VALUES($1,'suppressed')", [service]);
  const adminFirst = child('admin-hold'); await message(adminFirst);
  const adminSecond = await message(child('admin-run')); assert.equal(adminSecond.result.status, 'sending');
  const adminFinished = message(adminFirst); adminFirst.send('continue'); await adminFinished;
  await message(child('admin-run'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM synthetic_requests')).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM admin_audit_log')).rows[0].n, 1);
  console.log('PASS simultaneous admin clicks and repeated request send once with one actor audit');
  console.log('ALL REAL POSTGRESQL CHECKS PASSED', (await pool.query('SHOW server_version')).rows[0].server_version);
} finally {
  for (const c of children) c.kill('SIGKILL');
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end();
}
