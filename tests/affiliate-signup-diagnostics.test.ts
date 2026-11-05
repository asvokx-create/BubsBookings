import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { classifyAffiliateTraffic } from "../lib/affiliate-traffic.ts";

test("affiliate traffic diagnostics store only coarse device and browser categories", async () => {
  assert.deepEqual(
    classifyAffiliateTraffic("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"),
    { deviceCategory: "mobile", browserCategory: "safari" },
  );
  assert.deepEqual(
    classifyAffiliateTraffic("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36"),
    { deviceCategory: "mobile", browserCategory: "chrome" },
  );
  assert.deepEqual(
    classifyAffiliateTraffic("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/140.0"),
    { deviceCategory: "desktop", browserCategory: "edge" },
  );

  const migration = await readFile(new URL("../database/migrations/106_affiliate_signup_diagnostics.sql", import.meta.url), "utf8");
  assert.match(migration, /signup_submitted_at/);
  assert.match(migration, /account_user_id text REFERENCES "user"\(id\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS affiliate_signup_failures/);
  assert.doesNotMatch(migration, /^\s+(?:ip_address|user_agent|date_of_birth|password|email_address|form_value)\s+/im);
});

test("provider signup diagnostics distinguish page visits, submissions, failures, and accounts", async () => {
  const funnelRoute = await readFile(new URL("../app/api/affiliates/funnel/route.ts", import.meta.url), "utf8");
  const signupActions = await readFile(new URL("../components/provider-signup-actions.tsx", import.meta.url), "utf8");
  const authForm = await readFile(new URL("../app/auth-form.tsx", import.meta.url), "utf8");
  const adminRoute = await readFile(new URL("../app/api/admin/affiliates/route.ts", import.meta.url), "utf8");
  const admin = await readFile(new URL("../components/affiliate-admin.tsx", import.meta.url), "utf8");

  assert.match(funnelRoute, /\["signup_submitted", "signup_submitted_at=COALESCE\(signup_submitted_at,now\(\)\)"\]/);
  assert.match(funnelRoute, /eventName !== "signup_failed"/);
  assert.match(funnelRoute, /INSERT INTO affiliate_signup_failures/);
  assert.match(signupActions, /recordProviderSignupSubmitted/);
  assert.match(signupActions, /recordProviderSignupFailed/);
  assert.match(authForm, /recordProviderSignupSubmitted\(provider\)/);
  assert.match(authForm, /recordProviderSignupSubmitted\("email"\)/);
  assert.match(authForm, /await recordProviderSignupSubmitted\(provider\)/);
  assert.match(authForm, /await recordProviderSignupSubmitted\("email"\)/);
  assert.match(signupActions, /export async function recordProviderSignupSubmitted/);
  assert.match(signupActions, /Promise\.race/);
  assert.match(signupActions, /setTimeout\(resolve, 1_000\)/);
  assert.match(authForm, /signupMethod === "google" \? "Continue with Google"/);
  assert.match(adminRoute, /total_referral_clicks/);
  assert.match(adminRoute, /signup_submissions/);
  assert.match(adminRoute, /signup_failures/);
  assert.match(adminRoute, /listings_created/);
  assert.match(adminRoute, /campaign\.program_id IS NULL OR/);
  assert.match(admin, /First-touch visits and signup stages are unique per retained browser attribution window/);
  assert.match(admin, /Signup failures by category/);
  assert.match(admin, /Received traffic breakdown/);
});

test("account creation attribution is recorded by the authoritative server hook", async () => {
  const auth = await readFile(new URL("../lib/auth.ts", import.meta.url), "utf8");
  const accountFunnel = await readFile(new URL("../lib/affiliate-funnel.ts", import.meta.url), "utf8");
  const onboarding = await readFile(new URL("../app/api/providers/onboarding/route.ts", import.meta.url), "utf8");

  assert.match(auth, /databaseHooks:[\s\S]*user:[\s\S]*create:[\s\S]*async after\(user, context\)/);
  assert.match(auth, /recordAffiliateAccountCreated/);
  assert.match(accountFunnel, /account_created_at=COALESCE\(click\.account_created_at,now\(\)\)/);
  assert.match(accountFunnel, /account_user_id=COALESCE\(click\.account_user_id,\$2\)/);
  assert.match(accountFunnel, /click\.created_at <= \$3::timestamptz/);
  assert.match(onboarding, /account_user_id=COALESCE\(account_user_id,\$2\)/);
});

test("signup diagnostics do not change referral or commission compensation", async () => {
  const migration = await readFile(new URL("../database/migrations/106_affiliate_signup_diagnostics.sql", import.meta.url), "utf8");
  const commissionEngine = await readFile(new URL("../lib/affiliates.ts", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /UPDATE\s+affiliate_(profiles|referrals|commissions|payouts)/i);
  assert.doesNotMatch(commissionEngine, /affiliate_signup_failures|signup_submitted_at|device_category|browser_category/);
});
