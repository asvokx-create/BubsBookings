import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { identityResultsKey, identityResultsError } from "../lib/stripe-identity-config.ts";
import { isAtLeastEighteen } from "../lib/age-eligibility.ts";
import { providerAgeVerificationError } from "../lib/provider-age-verification-errors.ts";

test("dedicated identity key requires matching mode and restricted-key type", () => {
  for (const key of [undefined, "sk_live_example", "rk_test_example", "bad"]) {
    assert.throws(() => identityResultsKey(key, "live"), /temporarily unavailable/);
  }
  assert.equal(identityResultsKey("rk_live_example", "live"), "rk_live_example");
  assert.equal(identityResultsKey("rk_test_example", "test"), "rk_test_example");
  const failure = providerAgeVerificationError(identityResultsError());
  assert.equal(failure.status, 503);
  assert.match(failure.message, /do not need to upload your ID again/);
});

function harness(dob: unknown, unavailable = false) {
  const writes: string[] = [];
  const expansions: unknown[] = [];
  const session = { id: "vs_test", status: "verified", client_reference_id: "provider", metadata: { providerId: "provider", purpose: "provider_age_eligibility" }, livemode: false };
  const provider = { id: "provider", stripe_identity_verification_session_id: session.id, stripe_identity_verification_mode: "test", age_verification_status: "failed", age_verification_source: null };
  const client = { query: async (sql: string) => {
    writes.push(sql);
    if (sql.includes("SELECT provider.user_id")) return { rows: [{ user_id: "user", email: "synthetic@example.invalid", age_verification_status: "verified", stripe_identity_verification_session_id: null }] };
    if (sql.includes("RETURNING user_id")) return { rows: [{user_id:"user"}] };
    return {rows:[]};
  }, release: () => {} };
  const database = { query: async () => ({rows:[provider]}), connect: async () => client };
  const modules: Record<string, unknown> = {
    "server-only": {}, "./age-eligibility": {isAtLeastEighteen}, "./database": {database},
    "./stripe-identity-config": {identityResultsError},
    "./stripe": {getStripeMode: () => "test", getStripe: () => ({identity:{verificationSessions:{retrieve:async()=>session,create:async()=>{throw Error("must not create another session");}}}}), getStripeIdentityResults: () => {
      if (unavailable) throw new Error("private SDK details");
      return {identity:{verificationSessions:{retrieve:async (_id:string, params:unknown)=>{expansions.push(params); return {...session,verified_outputs:{dob}};}}}};
    }},
    "./affiliates": {markAffiliateListingPublished:async()=>{}}, "./analytics": {recordAnalytics:async()=>{}}, "./email": {sendTransactionalEmail:async()=>{}},
  };
  const output = ts.transpileModule(fs.readFileSync("lib/provider-age-verification.ts", "utf8"), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const context = {exports:{} as Record<string, (...args: unknown[])=>Promise<unknown>>,require:(id:string)=>{if (!(id in modules)) throw Error(id);return modules[id];},console};
  vm.runInNewContext(output,context);
  return {api:context.exports,writes,expansions};
}

test("verified adult reconciles only after explicit DOB expansion", async () => {
  const h=harness({year:1990,month:1,day:1});
  assert.equal(await h.api.syncProviderAgeVerificationFromStripe("vs_test"),"verified");
  assert.equal(JSON.stringify(h.expansions),JSON.stringify([{expand:["verified_outputs.dob"]}]));
  assert.ok(h.writes.some(sql=>sql.includes("age_verification_status='verified'")));
});
test("verified underage result remains ineligible", async () => {
  const h=harness({year:2020,month:1,day:1});
  assert.equal(await h.api.syncProviderAgeVerificationFromStripe("vs_test"),"failed");
  assert.ok(!h.writes.some(sql=>sql.includes("age_verification_status='verified'")));
});
test("missing DOB or denied sensitive result does not change eligibility or create a retry", async () => {
  for(const [dob,unavailable] of [[null,false],[null,true],[{year:1990,month:2,day:30},false],[{year:2099,month:1,day:1},false]] as const){
    const h=harness(dob,unavailable);
    await assert.rejects(h.api.syncProviderAgeVerificationFromStripe("vs_test"),/temporarily unavailable/);
    assert.equal(h.writes.length,0);
    await assert.rejects(h.api.startProviderAgeVerification({providerId:"provider",origin:"https://example.invalid"}),/temporarily unavailable/);
    assert.equal(h.writes.length,0);
  }
});
