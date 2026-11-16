import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function harness(options: { admin?: boolean; failure?: string; verified?: boolean; exception?: boolean; overLimit?: boolean } = {}) {
  const calls: { sql: string; args: unknown[] }[] = [];
  let payments = 0;
  const query = async (sql: string, args: unknown[] = []) => {
    calls.push({ sql, args });
    if (sql.includes("FROM provider_profiles WHERE") && sql.includes("FOR UPDATE")) return { rows: [{
      id: "provider", user_id: "owner", age_verification_status: options.verified || options.exception ? "verified" : "failed",
      age_verification_source: options.exception ? "admin_exception" : null,
      age_verification_failure_code: options.failure ?? "verification_document_expired",
      stripe_identity_verification_session_id: "vs_old",
    }] };
    return { rows: [], rowCount: 1 };
  };
  const modules: Record<string, unknown> = {
    "node:crypto": {}, "next/server": { NextResponse: { json: (body: unknown, init: { status?: number } = {}) => ({ body, status: init.status ?? 200 }) } },
    "@/lib/admin": { getAdminSession: async () => options.admin === false ? null : { user: { id: "admin" } } },
    "@/lib/database": { database: { query, connect: async () => ({ query, release: () => {} }) } },
    "@/lib/request-security": { enforceRateLimit: async () => true },
    "@/lib/provider-listing-limits": { lockProviderListingLimit: async () => ({ overLimit: options.overLimit ?? false }), listingLimitExceeded: () => false },
    "@/lib/plans": {}, "@/lib/stripe": {},
    "@/lib/payment-release": { releaseBookingPayout: async () => { payments++; } },
    "@/lib/tip-payments": { refundBookingTip: async () => { payments++; }, releaseTipTransfer: async () => { payments++; } },
    "@/lib/content-safety": {}, "@/lib/financial-crime-screening": {},
  };
  const js = ts.transpileModule(fs.readFileSync("app/api/admin/route.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { exports: {} as { PATCH: (request: unknown) => Promise<{ status: number; body: unknown }> },
    require: (name: string) => { if (!(name in modules)) throw Error(name); return modules[name]; }, console };
  vm.runInNewContext(js, context);
  return { calls, run: (body: object = {}) => context.exports.PATCH({ json: async () => ({
    action: "provider_age_exception", targetId: "provider", status: "approve", reason: "Independently checked adult eligibility",
    confirmedAdult: true, ...body,
  }) }), paymentCalls: () => payments };
}

test("admin grant records its separate source, actor and audit without Stripe/payout calls", async () => {
  const h = harness();
  assert.equal((await h.run()).status, 200);
  const update = h.calls.find(c => c.sql.includes("age_verification_source='admin_exception'"))!;
  assert.ok(update);
  assert.match(update.sql, /age_identity_verified_at=NULL/);
  assert.equal(update.args[2], "admin");
  const audit = h.calls.find(c => c.sql.includes("INSERT INTO admin_audit_log"))!;
  assert.equal(audit.args[0], "admin");
  assert.equal(audit.args[1], "provider_age_exception_approved");
  assert.equal(h.calls.at(-1)?.sql, "COMMIT");
  assert.equal(h.paymentCalls(), 0);
});
for (const [name, options, body, expected] of [
  ["non-admin", { admin: false }, {}, 403],
  ["no reason", {}, { reason: " " }, 400],
  ["unconfirmed age", {}, { confirmedAdult: false }, 409],
  ["known underage", { failure: "underage" }, {}, 409],
  ["already verified", { verified: true }, {}, 409],
] as const) test("grant rejects " + name + " without changing provider", async () => {
  const h = harness(options);
  assert.equal((await h.run(body)).status, expected);
  assert.ok(!h.calls.some(c => c.sql.includes("UPDATE provider_profiles")));
});
test("over-limit provider can receive pass but listings are not automatically published", async () => {
  const h = harness({ overLimit: true });
  assert.equal((await h.run()).status, 200);
  assert.ok(!h.calls.some(c => c.sql.includes("UPDATE services")));
});
test("revocation detaches stale Stripe session, preserves it in audit, and restores gate", async () => {
  const h = harness({ exception: true });
  assert.equal((await h.run({ status: "revoke" })).status, 200);
  const update = h.calls.find(c => c.sql.includes("UPDATE provider_profiles"))!;
  assert.match(update.sql, /stripe_identity_verification_session_id=NULL/);
  assert.match(update.sql, /stripe_identity_verification_mode=NULL/);
  const gate = h.calls.find(c => c.sql.includes("UPDATE services"))!;
  assert.match(gate.sql, /is_active=false, age_verification_blocked=true/);
  assert.match(gate.sql, /is_active=true OR age_verification_blocked=true/);
  const audit = h.calls.find(c => c.sql.includes("INSERT INTO admin_audit_log"))!;
  assert.equal(audit.args[1], "provider_age_exception_revoked");
  assert.equal(JSON.parse(audit.args[4] as string).previousStripeSessionId, "vs_old");
  assert.equal(h.paymentCalls(), 0);
});
