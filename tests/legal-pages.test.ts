import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";

const publicPolicyPages = [
  "terms",
  "privacy",
  "provider-agreement",
  "partner-agreement",
  "cookies",
  "ai-transparency",
  "accessibility",
  "content-removal",
  "cancellations-refunds",
  "payment-billing",
  "provider-safety",
  "marketing-communications",
  "dmca",
  "disputes",
  "promise",
];

async function findTsxFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) return findTsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  }));
  return files.flat();
}

test("public policy pages never expose prohibited publication labels", async () => {
  const forbiddenDraftingLabels = /NEEDS? LEGAL REVIEW|LEGAL REVIEW REQUIRED|TODO LEGAL|ATTORNEY REVIEW|DRAFT ONLY|INTERNAL (?:DRAFT|NOTE)|REVIEW BEFORE PRODUCTION|PLACEHOLDER LEGAL|NOT FINAL/i;
  const sources = await Promise.all(publicPolicyPages.map((page) => readFile(new URL(`../app/${page}/page.tsx`, import.meta.url), "utf8")));

  for (const [index, source] of sources.entries()) {
    assert.doesNotMatch(source, forbiddenDraftingLabels, `${publicPolicyPages[index]} contains a prohibited publication label`);
  }
});

test("user-facing pages and components never expose legal-review or draft disclaimers", async () => {
  const forbiddenPublicationLanguage = /NEEDS?\s+(?:AN?\s+)?LEGAL\s+REVIEW|LEGAL\s+REVIEW\s+REQUIRED|REQUIRES?\s+(?:AN?\s+)?LEGAL\s+REVIEW|ATTORNEY\s+REVIEW|COUNSEL\s+REVIEW|PENDING\s+LEGAL\s+REVIEW|SUBJECT\s+TO\s+LEGAL\s+REVIEW|CONSULT\s+(?:AN?\s+)?(?:ATTORNEY|LAWYER|LEGAL\s+COUNSEL)|NOT\s+LEGAL\s+ADVICE|TODO\s+LEGAL|DRAFT\s+ONLY|INTERNAL\s+(?:DRAFT|NOTE)|REVIEW\s+BEFORE\s+PRODUCTION|PLACEHOLDER\s+LEGAL|NOT\s+FINAL/i;
  const roots = [new URL("../app/", import.meta.url), new URL("../components/", import.meta.url)];
  const files = (await Promise.all(roots.map(findTsxFiles))).flat();

  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, forbiddenPublicationLanguage, `${file.pathname} contains prohibited publication language`);
  }
});

test("legal pages disclose current affiliate funding, privacy, and analytics behavior", async () => {
  const [terms, privacy, partner, cookies, contentRemoval] = await Promise.all([
    readFile(new URL("../app/terms/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/privacy/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/partner-agreement/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/cookies/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/content-removal/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(terms, /POLICY_EFFECTIVE_DATE/);
  assert.match(terms, /existing account that still needs confirmation may sign in to reach Account Settings/);
  assert.match(terms, /unpaid affiliate earnings as platform obligations/);
  assert.match(terms, /href="\/partner-agreement"/);
  assert.match(partner, /operational reserve calculation/);
  assert.match(partner, /not create an escrow, trust, deposit, custodial account/);
  assert.match(partner, /ftc\.gov\/business-guidance/);
  assert.match(partner, /Applicants must be at least 18/);
  assert.match(privacy, /detach the sign-in account while retaining the partner application/);
  assert.match(privacy, /existing account has not yet completed age confirmation/);
  assert.match(privacy, /does not include[\s\S]*every Stripe, affiliate, administrative/);
  assert.match(cookies, /<code>_ga<\/code>/);
  assert.match(cookies, /Optional browser analytics stays off unless you allow it/);
  assert.match(cookies, /account, booking, payment, refund, dispute, safety/);
  assert.match(cookies, /Cookie choices/);
  assert.match(privacy, /stay off unless you choose “Allow analytics.”/);
  assert.match(contentRemoval, /no later than 48 hours/);
  assert.match(contentRemoval, /copyright\.gov\/512/);
});

test("new policy pages describe the actual marketplace process and are linked from shared legal navigation", async () => {
  const [footer, cancellations, payments, providerSafety, marketing, dmca, bookingDetails] = await Promise.all([
    readFile(new URL("../components/site-footer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/cancellations-refunds/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/payment-billing/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/provider-safety/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/marketing-communications/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/dmca/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/booking-details.tsx", import.meta.url), "utf8"),
  ]);

  for (const pathname of ["/cancellations-refunds", "/payment-billing", "/provider-safety", "/marketing-communications", "/dmca"]) {
    assert.match(footer, new RegExp(`"${pathname}"`));
  }
  assert.match(cancellations, /48 hours after a provider marks service complete/);
  assert.match(cancellations, /original payment method/);
  assert.match(payments, /\$2\.99/);
  assert.match(payments, /10% BubsBookings platform fee with a maximum of \$200 per booking/);
  assert.match(payments, /6% BubsBookings platform fee with a maximum of \$100 per booking/);
  assert.match(payments, /not Stripe processing costs/);
  assert.match(providerSafety, /not a criminal background check, professional-license verification, insurance verification/);
  assert.match(marketing, /does not currently provide an SMS marketing campaign feature/);
  assert.match(dmca, /DMCA Designated Agent Directory/);
  assert.match(dmca, /does not by itself state that BubsBookings qualifies for any DMCA safe harbor/);
  assert.match(bookingDetails, /Cancellation &amp; Refund Policy/);
  assert.match(bookingDetails, /Payment &amp; Billing Policy/);
});

test("published legal versions and guide compensation language stay current", async () => {
  const [policyConsent, providerAgreement, guides] = await Promise.all([
    readFile(new URL("../lib/policy-consent.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/provider-agreement/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/guides.ts", import.meta.url), "utf8"),
  ]);

  assert.match(policyConsent, /POLICY_VERSION = "2026-11-09"/);
  assert.match(policyConsent, /PROVIDER_AGREEMENT_VERSION = "2026-11-09"/);
  assert.match(policyConsent, /POLICY_EFFECTIVE_DATE = "November 9, 2026"/);
  assert.match(providerAgreement, /effectiveDate=\{POLICY_EFFECTIVE_DATE\}/);
  assert.doesNotMatch(guides, /\$10 activation bonus|20% share|60-day attribution window/);
  assert.equal((guides.match(/updatedAt: "2026-10-07"/g) ?? []).length, 21);
});

test("optional analytics is consent-gated without disabling necessary storage or affiliate attribution", async () => {
  const [consent, google, tracker, search, share, booking, layout, footer] = await Promise.all([
    readFile(new URL("../components/analytics-consent.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/google-analytics.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/analytics-tracker.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/search-results-analytics.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/listing-share-button.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/booking-details.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/site-footer.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(consent, /Continue without analytics/);
  assert.match(consent, /Allow analytics/);
  assert.match(consent, /removeItem\("bubs-analytics-id"\)/);
  assert.match(consent, /name === "_ga" \|\| name\?\.startsWith\("_ga_"\)/);
  assert.match(consent, /Necessary sign-in, security, preferences, referral attribution, and account or transaction records are not changed/);
  assert.match(google, /consent !== "granted"/);
  assert.match(tracker, /consent !== "granted"/);
  assert.match(search, /consent !== "granted"/);
  assert.match(search, /queryLength/);
  assert.doesNotMatch(search, /metadata = \{ query,/);
  assert.doesNotMatch(tracker, /useSearchParams/);
  assert.match(share, /analyticsAllowed\(\)/);
  assert.match(booking, /analyticsAllowed\(\)/);
  assert.match(layout, /<AnalyticsConsentManager \/>/);
  assert.match(footer, /<AnalyticsChoicesButton/);
});

test("provider and partner onboarding expose and retain the relevant agreements", async () => {
  const [form, route, migration, providerOnboarding] = await Promise.all([
    readFile(new URL("../components/partner-application-form.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/affiliates/apply/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../database/migrations/102_affiliate_agreement_acceptance_history.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/providers/join/onboarding-form.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(form, /name="partnerAgreementAccepted" type="checkbox"/);
  assert.match(form, /name="termsAccepted" type="checkbox"/);
  assert.match(form, /name="privacyAcknowledged" type="checkbox"/);
  assert.match(form, /I have read and agree to the/);
  assert.match(route, /validateAffiliateAgreementConsent/);
  assert.match(route, /partner_agreement_accepted_at, partner_agreement_version/);
  assert.match(route, /PARTNER_AGREEMENT_VERSION/);
  assert.match(migration, /affiliate_agreement_acceptances/);
  assert.match(migration, /terms_accepted_at timestamptz/);
  assert.match(migration, /privacy_acknowledged_at timestamptz/);
  assert.match(providerOnboarding, /href="\/provider-agreement"/);
  assert.match(providerOnboarding, /href="\/payment-billing"/);
});
