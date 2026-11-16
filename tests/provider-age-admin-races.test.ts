import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function harness(kind: "sync" | "start", change: "admin" | "session" | "mode", stripeStatus = "verified") {
  const snapshot = { id: "provider", user_id: "user", email: "synthetic@example.invalid",
    stripe_identity_verification_session_id: kind === "sync" ? "vs_old" : null,
    stripe_identity_verification_mode: kind === "sync" ? "test" : null,
    age_verification_status: "requires_input", age_verification_source: null };
  const latest = { ...snapshot, ...(change === "admin"
    ? { age_verification_source: "admin_exception", age_verification_status: "verified" }
    : change === "session"
      ? { stripe_identity_verification_session_id: "vs_replacement", age_verification_status: "pending" }
      : { stripe_identity_verification_mode: "live", age_verification_status: "not_started" }) };
  const sqls: string[] = [];
  let changed = false;
  let releases = 0;
  let effects = 0;
  const client = { query: async (sql: string) => {
    sqls.push(sql);
    if (sql.includes("FOR UPDATE")) {
      assert.ok(changed, "simulate grant/session replacement during Stripe network request");
      return { rows: [latest] };
    }
    return { rows: [] };
  }, release: () => { releases++; } };
  const stripeSession = { id: "vs_old", status: stripeStatus, client_reference_id: "provider",
    metadata: { providerId: "provider", purpose: "provider_age_eligibility" }, livemode: false,
    verified_outputs: { dob: { year: 1990, month: 1, day: 1 } }, url: "https://example.invalid/identity" };
  const modules: Record<string, unknown> = {
    "server-only": {},
    "./database": { database: { query: async () => ({ rows: [snapshot] }), connect: async () => client } },
    "./age-eligibility": { isAtLeastEighteen: () => true },
    "./stripe-identity-config": { identityResultsError: () => Error("unavailable") },
    "./stripe": { getStripeMode: () => "test",
      getStripe: () => ({ identity: { verificationSessions: {
        retrieve: async () => { changed = true; return stripeSession; },
        create: async () => { changed = true; return { ...stripeSession, id: "vs_created" }; },
      } } }),
      getStripeIdentityResults: () => ({ identity: { verificationSessions: { retrieve: async () => stripeSession } } }),
    },
    "./affiliates": { markAffiliateListingPublished: async () => { effects++; } },
    "./analytics": { recordAnalytics: async () => { effects++; } },
    "./email": { sendTransactionalEmail: async () => { effects++; } },
  };
  const output = ts.transpileModule(fs.readFileSync("lib/provider-age-verification.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { exports: {} as Record<string, (...args: unknown[]) => Promise<unknown>>,
    require: (name: string) => { if (!(name in modules)) throw Error(name); return modules[name]; }, console };
  vm.runInNewContext(output, context);
  return { api: context.exports, latest, assertUntouched: () => {
    assert.ok(sqls.some(sql => sql.includes("FOR UPDATE")));
    assert.equal(sqls.filter(sql => /UPDATE provider_profiles|UPDATE services|INSERT INTO/.test(sql)).length, 0);
    assert.equal(effects, 0);
    assert.equal(releases, 1);
    assert.equal(sqls.at(-1), "COMMIT");
  } };
}

for (const change of ["admin", "session", "mode"] as const) {
  for (const status of ["verified", "requires_input", "processing", "canceled"]) {
    test("in-flight Stripe " + status + " cannot overwrite a concurrent " + change + " decision", async () => {
      const h = harness("sync", change, status);
      assert.equal(await h.api.syncProviderAgeVerificationFromStripe("vs_old"), h.latest.age_verification_status);
      h.assertUntouched();
    });
  }
  test("in-flight Stripe session creation preserves concurrent " + change + " decision", async () => {
    const h = harness("start", change);
    const result = await h.api.startProviderAgeVerification({ providerId: "provider", origin: "https://example.invalid" });
    assert.equal(JSON.stringify(result), JSON.stringify({ status: h.latest.age_verification_status, url: null }));
    h.assertUntouched();
  });
}
