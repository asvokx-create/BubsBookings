import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

test("real PostgreSQL restoration query respects independent listing and account holds", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE provider_profiles (id text PRIMARY KEY, user_id text, is_active boolean);
      CREATE TABLE provider_companies (id text PRIMARY KEY, is_active boolean);
      CREATE TABLE services (id text PRIMARY KEY, provider_id text, company_id text, is_active boolean DEFAULT false,
        age_verification_blocked boolean DEFAULT true, provider_deleted_at timestamptz, updated_at timestamptz);
      CREATE TABLE admin_audit_log (target_type text, target_id text, action text, created_at timestamptz);
      CREATE TABLE account_restrictions (user_id text, status text, expires_at timestamptz);
      INSERT INTO provider_profiles VALUES ('p','u',true),('paused','paused-user',false);
      INSERT INTO provider_companies VALUES ('c',true),('paused-company',false);
      INSERT INTO services(id,provider_id,company_id) VALUES
        ('eligible','p','c'),('removed','p','c'),('restored','p','c'),
        ('deleted','p','c'),('manually-paused','p','c'),('company-paused','p','paused-company'),
        ('provider-paused','paused','c'),('audit-deleted','p','c');
      UPDATE services SET provider_deleted_at=now() WHERE id='deleted';
      UPDATE services SET age_verification_blocked=false WHERE id='manually-paused';
      INSERT INTO admin_audit_log VALUES
        ('listing','removed','listing_removed',now()),
        ('listing','restored','listing_removed',now()-interval '1 hour'),
        ('listing','restored','listing_restored',now()),
        ('listing','audit-deleted','listing_deleted',now());
    `);
    const source = fs.readFileSync("app/api/admin/route.ts","utf8");
    const query = source.match(/await client.query\(`(UPDATE services service SET is_active=true,[\s\S]*?)`, \[provider.id\]\)/)?.[1];
    assert.ok(query, "extract exact production restoration SQL");
    for (const status of ["under_review","suspended","banned"]) {
      await db.query("INSERT INTO account_restrictions VALUES ('u',$1,NULL)",[status]);
      await db.query(query,["p"]);
      assert.equal((await db.query<{count:number}>("SELECT count(*)::int AS count FROM services WHERE is_active")).rows[0].count,0);
      await db.exec("DELETE FROM account_restrictions");
    }
    await db.exec("INSERT INTO account_restrictions VALUES ('u','suspended',now()-interval '1 hour')");
    await db.query(query,["p"]);
    await db.query(query,["paused"]);
    assert.deepEqual((await db.query<{id:string}>("SELECT id FROM services WHERE is_active ORDER BY id")).rows.map(row=>row.id),["eligible","restored"]);
  } finally { await db.close(); }
});

test("retry and mode-reset SQL preserve known-underage evidence; other failures can reset", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE provider_profiles (
      id text, stripe_identity_verification_session_id text, stripe_identity_verification_mode text,
      age_verification_status text, age_identity_verified_at timestamptz, age_verification_failure_code text,
      age_verification_source text, updated_at timestamptz);
      INSERT INTO provider_profiles VALUES ('minor','vs_old','live','failed',NULL,'underage','stripe_identity',NULL),
        ('other','vs_old','live','failed',NULL,'expired','stripe_identity',NULL);`);
    const source = fs.readFileSync("lib/provider-age-verification.ts","utf8");
    const start = source.match(/await client.query\(`(UPDATE provider_profiles\s+SET stripe_identity_verification_session_id=\$2[\s\S]*?)`, \[provider.id, session.id, mode\]\)/)?.[1];
    const reset = source.match(/const reset = await client.query\(`(UPDATE provider_profiles[\s\S]*?)`, \[providerId, mode\]\)/)?.[1];
    assert.ok(start); assert.ok(reset);
    await db.query(reset,["minor","test"]);
    assert.equal((await db.query<{age_verification_failure_code:string}>("SELECT age_verification_failure_code FROM provider_profiles WHERE id='minor'")).rows[0].age_verification_failure_code,"underage");
    for(const id of ["minor","other"]) await db.query(start,[id,"vs_retry","test"]);
    const result = await db.query<{id:string;age_verification_failure_code:string|null}>("SELECT id,age_verification_failure_code FROM provider_profiles ORDER BY id");
    assert.deepEqual(result.rows,[{id:"minor",age_verification_failure_code:"underage"},{id:"other",age_verification_failure_code:null}]);
  } finally { await db.close(); }
});
