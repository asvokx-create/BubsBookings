import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks, createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { chromium } from '/tmp/pw/node_modules/playwright-core/index.mjs';

const app = 'http://127.0.0.1:3000';
const database = 'postgresql://qa:qa-disposable-service-only@127.0.0.1:5432/qa';
const domain = '@protected-audit.example.test';
const password = randomBytes(24).toString('hex');
const actor = (role) => role.toLowerCase() + domain;
const fixtureStage = { value: 'runner isolation' };
let browser, server, pool;
function stage(name) {
  fixtureStage.value = name;
  console.log('START ' + name);
}
function unreachable(host) {
  return new Promise((done) => {
    const socket = connect({ host, port: 443, timeout: 4000 });
    socket.once('connect', () => { socket.destroy(); done(false); });
    socket.once('timeout', () => { socket.destroy(); done(false); });
    socket.once('error', (e) => done(['ENETUNREACH', 'EHOSTUNREACH', 'EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(e.code)));
  });
}
async function retry(label, run) {
  for (let i = 0; i < 75; i++) {
    try { if (await run()) return; } catch {}
    await sleep(1500);
  }
  throw new Error(label);
}
function totp(base32, time = Date.now()) {
  let accum = 0, bits = 0;
  const key = [];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  for (const letter of base32.replace(/[\s=]/g, '').toUpperCase()) {
    const n = alphabet.indexOf(letter);
    assert(n >= 0);
    accum = (accum << 5) | n; bits += 5;
    if (bits >= 8) { bits -= 8; key.push((accum >>> bits) & 255); }
  }
  assert(key.length >= 10);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const mac = createHmac('sha1', Buffer.from(key)).update(counter).digest();
  return String((mac.readUInt32BE(mac[mac.length-1] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}
async function freshTotp(secret) {
  const phase = Date.now() % 30000;
  if (phase > 25000) await sleep(31000 - phase);
  return totp(secret);
}
function birthdate() {
  const now = new Date();
  return String(now.getUTCFullYear() - 34) + '-01-15';
}
async function endpoint(page, path, body) {
  assert(/^\/api\/[a-z0-9/-]+$/.test(path));
  return await page.evaluate(async ({ path, body }) => {
    const init = body === undefined ? { cache: 'no-store' } : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
    const response = await fetch(path, init);
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { path, body });
}
async function pageIn(viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', acceptDownloads: false });
  await context.route('**/*', route => {
    try { if (new URL(route.request().url()).origin === app) return route.continue(); } catch {}
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await openPath(page, '/login');
  return [context, page];
}
async function openPath(page, path, expected = path.split('?')[0]) {
  const response = await page.goto(app + path, { waitUntil: 'domcontentloaded', timeout: 40000 });
  assert(response && response.ok(), 'Navigation status');
  const landed = new URL(page.url());
  assert.equal(landed.origin, app);
  assert((Array.isArray(expected) ? expected : [expected]).includes(landed.pathname), 'Expected local route');
}
async function hasHeading(page, text) {
  await page.getByRole('heading', { name: text, exact: true }).first().waitFor();
}
async function session(page, role) {
  const current = await endpoint(page, '/api/auth/get-session');
  assert.equal(current.status, 200);
  assert.equal(current.body?.user?.email, actor(role));
}
async function signIn(page, role, needsMfa = false) {
  const result = await endpoint(page, '/api/auth/sign-in/email', {
    email: actor(role), password, callbackURL: '/account', rememberMe: false,
  });
  assert.equal(result.status, 200);
  assert.equal(Boolean(result.body?.twoFactorRedirect), needsMfa);
  if (!needsMfa) await session(page, role);
}
async function signup(role, policy) {
  const [context, page] = await pageIn();
  try {
    assert.equal((await endpoint(page, '/api/age-eligibility', { dateOfBirth: birthdate() })).status, 200);
    assert.equal((await endpoint(page, '/api/policy-consent', { termsAccepted: true, privacyAcknowledged: true })).status, 200);
    assert.equal((await endpoint(page, '/api/auth/sign-up/email', {
      name: 'QA ' + role, email: actor(role), password, phone: '2025550101',
      ...policy, callbackURL: '/account', city: '', state: '', postalCode: '', country: 'United States',
    })).status, 200);
    await session(page, role);
  } finally { await context.close(); }
}

try {
  assert(process.getuid() > 0);
  assert.equal(process.versions.node, '24.22.1');
  const envNames = ['HOME', 'PATH', 'PLAYWRIGHT_BROWSERS_PATH', 'PWD', 'SHLVL', '_'];
  assert(Object.keys(process.env).every(name => envNames.includes(name)));
  assert(Object.entries(networkInterfaces()).every(([name, addresses]) =>
    name === 'lo' && addresses.every(a => a.internal)));
  assert(await unreachable('192.0.2.1'));
  assert(await unreachable('2001:db8::1'));
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, timeout: 15000 });
  const probeContext = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await probeContext.newPage();
    await assert.rejects(page.goto('http://192.0.2.1/', { timeout: 5000 }), /ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_FAILED|ERR_CONNECTION_REFUSED/);
  } finally { await probeContext.close(); }
  console.log('PASS isolated OS socket and sandboxed Chromium network probes');

  stage('PostgreSQL bootstrap');
  Object.assign(process.env, {
    NODE_ENV: 'development', DATABASE_URL: database, BETTER_AUTH_URL: app, NEXT_PUBLIC_APP_URL: app,
    BETTER_AUTH_SECRET: randomBytes(38).toString('hex'),
    BOOKME_REQUIRE_ADMIN_2FA: 'true',
    NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-protected-audit',
  });
  pool = new pg.Pool({ connectionString: database, connectionTimeoutMillis: 2000 });
  await retry('Local database unavailable', async () => {
    const r = await pool.query("SELECT inet_server_addr()::text AS ip, current_database() AS db, current_setting('server_version_num')::int AS version");
    return r.rows[0]?.ip === '127.0.0.1/32' && r.rows[0]?.db === 'qa' && r.rows[0]?.version === 170008
      || r.rows[0]?.ip === '127.0.0.1' && r.rows[0]?.db === 'qa' && r.rows[0]?.version === 170008;
  });
  const root = new URL('../../', import.meta.url);
  const require = createRequire(import.meta.url);
  const resolver = registerHooks({
    resolve(specifier, context, nextResolve) {
      const localParent = context.parentURL?.startsWith(root.href) && !context.parentURL.includes('/node_modules/');
      if (localParent && specifier === 'server-only') {
        return nextResolve(pathToFileURL(require.resolve('next/dist/compiled/server-only/empty')).href, context);
      }
      if (localParent && (specifier.startsWith('@/') || specifier.startsWith('.'))) {
        const base = specifier.startsWith('@/') ? new URL(specifier.slice(2), root) : new URL(specifier, context.parentURL);
        for (const append of ['', '.ts', '/index.ts']) {
          const candidate = new URL(base.href + append);
          if (existsSync(fileURLToPath(candidate)) && /\.(m?[tj]s|json)$/.test(candidate.pathname)) return nextResolve(candidate.href, context);
        }
      }
      return nextResolve(specifier, context);
    },
  });
  const { getMigrations } = await import('better-auth/db/migration');
  const { auth } = await import('../../lib/auth.ts');
  assert.equal(auth.options.baseURL, app);
  const { createPolicyConsentFields, PARTNER_AGREEMENT_VERSION, TERMS_OF_SERVICE_VERSION, PRIVACY_POLICY_VERSION } = await import('../../lib/policy-consent.ts');
  const authDatabase = auth.options.database;
  assert(typeof authDatabase?.query === 'function');
  await (await getMigrations(auth.options)).runMigrations();
  await authDatabase.end();
  resolver.deregister();
  const migrated = spawnSync(process.execPath, ['scripts/setup-marketplace-db.mjs'], { stdio: 'ignore', timeout: 90000 });
  assert.equal(migrated.status, 0);

  stage('local Next startup');
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', '3000'], { stdio: 'ignore' });
  await retry('Local app unavailable', async () => {
    const r = await fetch(app + '/login', { redirect: 'manual', signal: AbortSignal.timeout(9000) });
    return r.ok;
  });

  stage('anonymous route guards');
  {
    const [context, page] = await pageIn();
    try {
      for (const path of ['/account', '/affiliate', '/admin', '/provider/dashboard']) await openPath(page, path, '/login');
    } finally { await context.close(); }
  }
  console.log('PASS anonymous account, affiliate, admin and provider guards');

  stage('synthetic real signup, role fixtures and denied admin');
  for (const role of ['Customer', 'Provider', 'Admin', 'Affiliate']) await signup(role, createPolicyConsentFields());
  await pool.query("UPDATE \"user\" SET role = 'provider' WHERE email = $1", [actor('Provider')]);
  assert.equal((await pool.query("INSERT INTO provider_profiles (user_id,business_name,city,state,is_verified) SELECT id,'QA Provider Studio','Testville','WA',true FROM \"user\" WHERE email=$1", [actor('Provider')])).rowCount, 1);
  assert.equal((await pool.query("INSERT INTO bookme_admins (user_id) SELECT id FROM \"user\" WHERE email=$1", [actor('Admin')])).rowCount, 1);
  assert.equal((await pool.query("INSERT INTO affiliate_profiles (user_id,program_id,display_name,email,affiliate_code,status,account_link_status,partner_agreement_version,terms_version,privacy_version) SELECT u.id,p.id,'QA Affiliate',u.email,'qa-audit-code','active','linked',$2,$3,$4 FROM \"user\" u CROSS JOIN affiliate_programs p WHERE u.email=$1 AND p.name='Standard Creator Program'", [actor('Affiliate'), PARTNER_AGREEMENT_VERSION, TERMS_OF_SERVICE_VERSION, PRIVACY_POLICY_VERSION])).rowCount, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM \"user\" WHERE age_verified_at IS NOT NULL AND email LIKE $1", ['%' + domain])).rows[0].n, 4);

  stage('customer and provider authenticated browser landings');
  {
    const [context, page] = await pageIn();
    try {
      await signIn(page, 'Customer');
      await openPath(page, '/account');
      await hasHeading(page, 'Hi, QA.');
      await openPath(page, '/account/security');
      await hasHeading(page, 'Authenticator protection');
      await openPath(page, '/admin', ['/login', '/']);
      await openPath(page, '/affiliate');
      await hasHeading(page, 'No partner account yet');
    } finally { await context.close(); }
  }
  console.log('PASS customer account, security, admin denial and affiliate-empty state');
  {
    const [context, page] = await pageIn();
    try {
      await signIn(page, 'Provider');
      await openPath(page, '/provider/dashboard');
      await session(page, 'Provider');
      const profile = await endpoint(page, '/api/providers/me');
      assert.equal(profile.status, 200);
      assert.equal(profile.body?.accessRole, 'owner');
      assert.equal(profile.body?.businessName, 'QA Provider Studio');
      await openPath(page, '/admin', ['/login', '/']);
    } finally { await context.close(); }
  }
  console.log('PASS provider dashboard and admin denial');

  stage('affiliate authenticated browser landing');
  {
    const [context, page] = await pageIn({ width: 390, height: 844 });
    try {
      await signIn(page, 'Affiliate');
      await openPath(page, '/affiliate');
      await hasHeading(page, 'Welcome, QA Affiliate');
      await openPath(page, '/affiliate?range=7d');
      await hasHeading(page, 'Welcome, QA Affiliate');
    } finally { await context.close(); }
  }
  console.log('PASS narrow affiliate active dashboard and seven-day range');

  stage('synthetic authenticator enrollment and fresh challenge');
  let secret;
  {
    const [context, page] = await pageIn();
    try {
      await signIn(page, 'Admin');
      await openPath(page, '/admin', '/login');
      await openPath(page, '/account/security');
      await page.getByLabel('Confirm your current password').fill(password);
      await page.getByRole('button', { name: 'Set up authenticator' }).click();
      secret = (await page.getByText('Manual setup key', { exact: true }).locator('..').locator('code').textContent()).trim();
      await page.getByLabel('Six-digit authenticator code').fill(await freshTotp(secret));
      await page.getByRole('button', { name: 'Verify and turn on' }).click();
      await page.getByText('✓ Authenticator is on', { exact: true }).waitFor();
    } finally { await context.close(); }
  }
  {
    const [context, page] = await pageIn();
    try {
      await signIn(page, 'Admin', true);
      assert.equal((await endpoint(page, '/api/auth/get-session')).body?.user, undefined);
      await openPath(page, '/admin', '/login');
      await openPath(page, '/two-factor');
      await page.getByLabel('Trust this device for 30 days').uncheck();
      await page.getByLabel('Six-digit authenticator code').fill(await freshTotp(secret));
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
      await page.waitForURL(app + '/account');
      await session(page, 'Admin');
      await openPath(page, '/admin');
      await openPath(page, '/admin/support');
    } finally { await context.close(); }
  }
  console.log('PASS admin denied without MFA, first-device MFA challenge and admin/support after MFA');
  console.log('PASS exact-app protected smoke; no claims for payments, payouts, OAuth, email, messages, bookings, or screen reader');
} catch {
  console.error('FAIL or BLOCKED at stage: ' + fixtureStage.value);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
  await pool?.end().catch(() => {});
}
