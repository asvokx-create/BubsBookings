import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { PLAN_ENTITLEMENTS, type ProviderPlan } from "../lib/plans.ts";
import * as financials from "../lib/booking-financials.ts";

const source = readFileSync(new URL("../app/pricing/page.tsx", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const require = createRequire(import.meta.url);

type Fixture = { plan: ProviderPlan; trialEligible: boolean } | null;

async function renderPricing(fixture: Fixture, selected?: string | string[]) {
  const pageModule = { exports: {} as { default: (props: { searchParams: Promise<{ plan?: string | string[] }> }) => Promise<ReactElement> } };
  const deps: Record<string, unknown> = {
    "next/link": (props: Record<string, unknown>) => createElement("a", props),
    "next/headers": { headers: async () => new Headers() },
    "@/lib/auth": { isAuthConfigured: () => true, auth: { api: { getSession: async () => fixture ? { user: { id: "fixture", email: "fixture@example.invalid" } } : null } } },
    "@/lib/admin": { isOwnerEmail: () => fixture?.plan === "owner" },
    "@/lib/database": { database: { query: async () => ({ rows: fixture ? [{ plan: fixture.plan, pro_trial_used_at_test: fixture.trialEligible ? null : new Date(0) }] : [] }) } },
    "@/lib/plans": { PLAN_ENTITLEMENTS },
    "@/lib/stripe": { getStripeMode: () => "test" },
    "@/components/public-site-header": () => null,
    "@/lib/booking-financials": financials,
    "@/lib/seo": { publicPageMetadata: () => ({}) },
    "@/lib/complimentary-pro": { reconcileExpiredComplimentaryProGrants: async () => {} },
  };
  vm.runInNewContext(js, { module: pageModule, exports: pageModule.exports, require: (id: string) => id in deps ? deps[id] : require(id) });
  const html = renderToStaticMarkup(await pageModule.exports.default({ searchParams: Promise.resolve({ plan: selected }) }));
  return { html, copy: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") };
}

test("pricing shows equal comparison categories, real billing numbers and a bounded example", async () => {
  const { html, copy } = await renderPricing(null, ["pro", "ignored"]);
  assert.match(copy, /Pro selected/);
  assert.match(copy, /Starter .* \$0 per month/);
  assert.match(copy, /Pro .* \$9\.99 per month/);
  assert.match(copy, /10% on completed paid bookings, capped at \$200 per booking/);
  assert.match(copy, /6% on completed paid bookings, capped at \$100 per booking/);
  assert.match(copy, /5 photos across all listings/);
  assert.match(copy, /Starter costs \$30\. Pro costs \$27\.99/);
  assert.match(copy, /excludes Stripe processing and any extra seats/);
  assert.match(copy, /Stripe processing cost allocated to the service is deducted from provider earnings/);
  assert.match(copy, /Customers pay a separate \$2\.99 .* no separate card-processing surcharge/);
  assert.match(html, /href="\/providers\/join\?plan=starter"/);
  assert.match(html, /href="\/providers\/join\?plan=pro" aria-describedby="pro-payment-terms"/);
  assert.match(copy, /Eligible providers get one 30-day trial\. A card is required\..*unless you cancel/);
  assert.doesNotMatch(copy, /\$0 always|Save at \$250|annual savings|most popular/i);
  for (const title of ["Booking fee", "Listings", "Team access", "Booking and client tools", "Reminders and insights"]) {
    assert.equal((html.match(new RegExp(">" + title + "</dt>", "g")) ?? []).length, 2);
  }
  assert.doesNotMatch((await renderPricing(null, "invalid")).copy, /selected/);
});

test("known providers get the correct next action without changing checkout or eligibility", async () => {
  const eligible = await renderPricing({ plan: "starter", trialEligible: true }, "pro");
  assert.match(eligible.html, /href="\/provider\/dashboard\/billing" aria-describedby="pro-payment-terms"/);
  assert.match(eligible.copy, /Continue to billing for trial/);
  assert.match(eligible.copy, /booking fee still applies during the trial/);
  assert.doesNotMatch(eligible.copy, /Create a provider profile for Pro/);

  const used = await renderPricing({ plan: "starter", trialEligible: false }, "starter");
  assert.match(used.copy, /Starter selected/);
  assert.match(used.copy, /Choose Pro/);
  assert.match(used.copy, /renews monthly. Cancel renewal in Billing/);
  assert.doesNotMatch(used.copy, /trial/i);

  for (const fixture of [{ plan: "pro", trialEligible: true }, { plan: "pro", trialEligible: false }, { plan: "owner", trialEligible: true }, { plan: "business", trialEligible: true }] as const) {
    const { html, copy } = await renderPricing(fixture, "pro");
    assert.match(copy, /Your current plan.*Manage billing/);
    assert.doesNotMatch(copy, /Choose Pro|Continue to billing for trial|A card is required|30-day trial|Create a provider profile for Pro/);
    assert.doesNotMatch(html, /aria-describedby="pro-payment-terms"/);
  }
});
