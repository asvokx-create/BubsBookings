import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Kysely, PostgresDialect, type PostgresPool } from "kysely";

const migration = await readFile(new URL("../database/migrations/110_better_auth_legacy_issuer.sql", import.meta.url), "utf8");

// Real PostgreSQL in memory. No production URL, credentials, network, or user data.
async function fixture() {
  const postgres = new PGlite();
  const pool = {
    options: {},
    async connect() {
      return {
        async query(sql: string, parameters: unknown[] = []) {
          const result = await postgres.query(sql, parameters);
          return { rows: result.rows, rowCount: result.affectedRows ?? 0, command: sql.trim().split(/\s+/)[0].toUpperCase() };
        },
        release() {},
      };
    },
    async end() {},
  };
  // Kysely's Postgres driver uses query/release here, never its optional cursor API.
  const db = new Kysely({ dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }) });
  const options: BetterAuthOptions = {
    database: { db, type: "postgres" },
    baseURL: "https://auth.example.test",
    secret: "only-for-isolated-google-auth-regression-tests-123456789",
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    socialProviders: { google: { clientId: "test-client", clientSecret: "test-secret", disableImplicitSignUp: true } },
    logger: { disabled: true },
  };
  await (await getMigrations(options)).runMigrations();
  return { postgres, options, close: async () => { await db.destroy(); await postgres.close(); } };
}

function googleRequest(requestSignUp: boolean) {
  return new Request("https://auth.example.test/api/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://auth.example.test" },
    body: JSON.stringify({ provider: "google", requestSignUp, callbackURL: "/account", errorCallbackURL: "/login?oauthError=1", newUserCallbackURL: "/account/settings?welcome=1" }),
  });
}

test("legacy issuer migration restores both Google starts and preserves existing accounts", async () => {
  const f = await fixture();
  try {
    const before = betterAuth(f.options);
    const existing = await before.api.signUpEmail({ body: { name: "Existing test user", email: "existing@example.test", password: "test-password-12345" } });
    await f.postgres.exec(`ALTER TABLE account ADD COLUMN issuer text;
      UPDATE account SET issuer = 'local:credential';
      ALTER TABLE account ALTER COLUMN issuer SET NOT NULL;
      CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON account (issuer, "accountId");`);
    const preserved = (await f.postgres.query("SELECT * FROM account ORDER BY id")).rows;
    const broken = betterAuth(f.options);
    for (const requestSignUp of [false, true]) {
      await assert.rejects(broken.handler(googleRequest(requestSignUp)), (error: unknown) => error instanceof Error && "code" in error && error.code === "SCHEMA_MISMATCH");
    }

    await f.postgres.exec(migration);
    await f.postgres.exec(migration); // The startup runner reapplies migrations.
    assert.deepEqual((await f.postgres.query("SELECT * FROM account ORDER BY id")).rows, preserved);
    assert.deepEqual((await f.postgres.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'account' AND column_name = 'issuer'")).rows, [{ is_nullable: "YES" }]);
    assert.equal((await f.postgres.query("SELECT 1 FROM pg_indexes WHERE indexname = 'account_issuer_accountId_uidx'")).rows.length, 0);

    // Schema failures are cached. A fresh process/instance must accompany the migration.
    const fixed = betterAuth(f.options);
    for (const requestSignUp of [false, true]) {
      const response = await fixed.handler(googleRequest(requestSignUp));
      assert.equal(response.status, 200);
      const payload = await response.json();
      const url = new URL(payload.url);
      assert.equal(url.origin, "https://accounts.google.com");
      assert.equal(url.searchParams.get("redirect_uri"), "https://auth.example.test/api/auth/callback/google");
      assert.ok(url.searchParams.get("state"));
      assert.ok(response.headers.get("set-cookie"));
    }
    const login = await fixed.api.signInEmail({ body: { email: "existing@example.test", password: "test-password-12345" } });
    assert.equal(login.user.id, existing.user.id);
    const context = await fixed.$context;
    const linked = await context.internalAdapter.createAccount({ userId: existing.user.id, providerId: "google", accountId: "test-google-subject" });
    assert.equal(linked.userId, existing.user.id);
    assert.deepEqual((await f.postgres.query("SELECT issuer FROM account WHERE id = $1", [linked.id])).rows, [{ issuer: null }]);
    const signup = await fixed.api.signUpEmail({ body: { name: "New test user", email: "new@example.test", password: "new-test-password-12345" } });
    assert.ok(signup.user.id);
  } finally {
    await f.close();
  }
});

test("migration also supports a fresh schema without issuer", async () => {
  const f = await fixture();
  try {
    await f.postgres.exec(migration);
    await f.postgres.exec(migration);
    assert.equal((await f.postgres.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'account' AND column_name = 'issuer'")).rows.length, 0);
  } finally { await f.close(); }
});

test("migration refuses ambiguous provider keys without changing data", async () => {
  const f = await fixture();
  try {
    const auth = betterAuth(f.options);
    const user = await auth.api.signUpEmail({ body: { name: "Duplicate test user", email: "duplicate@example.test", password: "test-password-12345" } });
    await f.postgres.exec("ALTER TABLE account ADD COLUMN issuer text DEFAULT 'local:credential' NOT NULL");
    await f.postgres.query(`INSERT INTO account (id, issuer, "accountId", "providerId", "userId", "createdAt", "updatedAt")
      SELECT 'duplicate-account', 'legacy:other', "accountId", "providerId", "userId", "createdAt", "updatedAt" FROM account WHERE "userId" = $1`, [user.user.id]);
    await assert.rejects(f.postgres.exec(migration), /Resolve duplicate account/);
    assert.deepEqual((await f.postgres.query("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'account' AND column_name = 'issuer'")).rows, [{ is_nullable: "NO" }]);
    assert.equal((await f.postgres.query("SELECT * FROM account")).rows.length, 2);
  } finally { await f.close(); }
});
