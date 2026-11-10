import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { calculateAffiliateCommission, calculateEligibleProviderFeeRevenue } from "../lib/affiliate-rules.ts";

test("affiliate share uses BubsBookings provider fee revenue, not gross booking value", () => {
  const eligible = calculateEligibleProviderFeeRevenue({ providerMarketplaceFeeCents: 1000, bookingPriceCents: 10_000, refundedServiceAmountCents: 0 });
  assert.equal(eligible, 1000);
  assert.equal(calculateAffiliateCommission(eligible, 2000), 200);
});

test("partial refunds proportionally reduce eligible provider fee revenue", () => {
  const eligible = calculateEligibleProviderFeeRevenue({ providerMarketplaceFeeCents: 5000, bookingPriceCents: 50_000, refundedServiceAmountCents: 20_000 });
  assert.equal(eligible, 3000);
  assert.equal(calculateAffiliateCommission(eligible, 2000), 600);
});

test("affiliate architecture snapshots terms and keeps payout and reversal history", async () => {
  const migration = await readFile(new URL("../database/migrations/058_affiliate_partner_system.sql", import.meta.url), "utf8");
  const engine = await readFile(new URL("../lib/affiliates.ts", import.meta.url), "utf8");
  assert.match(migration, /activation_bonus_cents[\s\S]*revenue_share_basis_points[\s\S]*hold_period_days/);
  assert.match(migration, /affiliate_commissions[\s\S]*affiliate_payouts[\s\S]*affiliate_audit_log/);
  assert.match(engine, /provider_marketplace_fee/);
  assert.match(engine, /commission_type='reversal'/);
  assert.doesNotMatch(engine, /customer_service_fee_cents/);
});

test("affiliate earnings are synchronized only after the provider payout succeeds", async () => {
  const payout = await readFile(new URL("../lib/payment-release.ts", import.meta.url), "utf8");
  const finalization = await readFile(new URL("../lib/booking-payout-finalization.ts", import.meta.url), "utf8");
  const engine = await readFile(new URL("../lib/affiliates.ts", import.meta.url), "utf8");
  const reconciliation = await readFile(new URL("../lib/booking-payout-reconciliation.ts", import.meta.url), "utf8");
  const payoutMarkedPaid = payout.indexOf("const recorded = await recordBookingPayoutTransfer(");
  const evidenceCommitted = payout.indexOf('await client.query("COMMIT")', payoutMarkedPaid);
  const finalizeCall = payout.indexOf("await finalizeBookingPayoutInTransaction(bookingId, getStripeMode(), client)", evidenceCommitted);
  const transferEvidence = finalization.indexOf("if (!booking?.stripe_transfer_id) return false");
  const eligibleEvidence = finalization.indexOf("if (!booking.eligible && !booking.terminal) return false");
  const affiliateSync = finalization.indexOf("await syncAffiliateCommissionForBooking(bookingId, client)");

  assert.ok(payoutMarkedPaid >= 0, "provider payout must be marked paid");
  assert.match(reconciliation, /WHEN payment_release_status = 'processing' THEN 'paid_out'/);
  assert.ok(evidenceCommitted > payoutMarkedPaid && finalizeCall > evidenceCommitted, "payout finalization must run after transfer evidence commits");
  assert.ok(transferEvidence >= 0 && eligibleEvidence > transferEvidence && affiliateSync > eligibleEvidence, "affiliate sync must verify recorded transfer and eligible/terminal state inside the finalization transaction");
  assert.match(engine, /booking_status === "completed"/);
  assert.match(engine, /payment_status === "paid"/);
  assert.match(engine, /\["paid_out", "partially_released"\]\.includes\(row\.payment_release_status\)/);
  assert.match(engine, /row\.refunded_amount_cents < row\.price_cents/);
  assert.match(engine, /!disputeOpen && !disputeLost/);
});

test("affiliate attribution is active-only, single-use, and blocks self-referrals", async () => {
  const engine = await readFile(new URL("../lib/affiliates.ts", import.meta.url), "utf8");
  const clickRoute = await readFile(new URL("../app/api/affiliates/attribution/route.ts", import.meta.url), "utf8");
  const attributionStore = await readFile(new URL("../lib/affiliate-attribution-store.ts", import.meta.url), "utf8");
  const onboarding = await readFile(new URL("../app/api/providers/onboarding/route.ts", import.meta.url), "utf8");

  assert.match(clickRoute, /storeAffiliateAttribution/);
  assert.match(attributionStore, /affiliate\.status = 'active'/);
  assert.match(attributionStore, /click\.attribution_token = \$1::uuid/);
  assert.match(clickRoute, /retained: true/);
  assert.ok(attributionStore.indexOf('status: "retained"') < attributionStore.indexOf("const token = newAttributionToken()"), "a valid saved first touch must be retained before a new click can replace it");
  assert.match(engine, /affiliate\.status = 'active'/);
  assert.match(engine, /used_referral\.click_id = click\.id/);
  assert.match(engine, /affiliate\.user_id = referred_owner\.id/);
  assert.doesNotMatch(engine, /lower\(affiliate\.email\) = lower\(referred_owner\.email\)/);
  assert.match(onboarding, /affiliateAttributionLocked/);
  assert.match(onboarding, /response\.cookies\.delete\(AFFILIATE_COOKIE\)/);
});

test("affiliate click tracking still reaches the server when session storage is unavailable", async () => {
  const tracker = await readFile(new URL("../components/affiliate-attribution-tracker.tsx", import.meta.url), "utf8");
  assert.match(tracker, /function wasRecorded[\s\S]*?try[\s\S]*?sessionStorage\.getItem[\s\S]*?catch/);
  assert.match(tracker, /function rememberRecorded[\s\S]*?try[\s\S]*?sessionStorage\.setItem[\s\S]*?catch/);
  assert.ok(tracker.indexOf("fetch(\"/api/affiliates/attribution\"") < tracker.indexOf("rememberRecorded(key)"), "a failed request must not be marked as recorded");
});

test("eligible commissions recover after a provider wins a dispute", async () => {
  const engine = await readFile(new URL("../lib/affiliates.ts", import.meta.url), "utf8");
  assert.match(engine, /WHERE booking_id::text = \$1 AND status = 'disputed'/);
  assert.match(engine, /payable_at IS NOT NULL AND payable_at <= now\(\) THEN 'payable' ELSE 'hold'/);
  assert.match(engine, /reversal_reason = NULL/);
  assert.match(engine, /status = 'revenue_share_ended'/);
});

test("Stripe chargebacks freeze affiliate earnings and preserve a reversal ledger", async () => {
  const engine = await readFile(new URL("../lib/affiliates.ts", import.meta.url), "utf8");
  const webhook = await readFile(new URL("../app/api/stripe/webhook/route.ts", import.meta.url), "utf8");
  assert.match(webhook, /case "charge\.dispute\.created"/);
  assert.match(webhook, /case "charge\.dispute\.closed"/);
  assert.match(webhook, /Stripe chargeback under review/);
  assert.match(webhook, /const providerWon = dispute\.status === "won"/);
  assert.match(webhook, /const customerWon = dispute\.status === "lost"/);
  assert.match(webhook, /syncAffiliateCommissionForBooking\(booking\.id, client\)/);
  assert.match(engine, /commission_type,eligible_revenue_cents[\s\S]*?'reversal'/);
  assert.match(engine, /Stripe chargeback was lost\./);
});

test("revenue share starts and expires from the snapshotted program event", async () => {
  const engine = await readFile(new URL("../lib/affiliates.ts", import.meta.url), "utf8");
  assert.match(engine, /\["qualified", "first_completed_booking"\]\.includes\(row\.revenue_share_starts_at\)/);
  assert.match(engine, /row\.revenue_share_duration_months/);
  assert.match(engine, /affiliateRevenueShareWindow/);
  assert.match(engine, /now < new Date\(shareEnd\)/);
  assert.match(engine, /status = 'revenue_share_ended'/);
  assert.match(engine, /revenue_share_ends_at <= now\(\)/);
});

test("future standard referrals use a 14-day hold without rewriting existing referral snapshots", async () => {
  const migration = await readFile(new URL("../database/migrations/064_affiliate_hold_period_14_days.sql", import.meta.url), "utf8");
  assert.match(migration, /UPDATE affiliate_programs[\s\S]*hold_period_days = 14/);
  assert.match(migration, /WHERE name = 'Standard Creator Program'/);
  assert.doesNotMatch(migration, /UPDATE affiliate_referrals/);
});

test("partner application, dashboard, and public disclosure match activation behavior", async () => {
  const page = await readFile(new URL("../app/partners/page.tsx", import.meta.url), "utf8");
  const application = await readFile(new URL("../components/partner-application-form.tsx", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../app/affiliate/page.tsx", import.meta.url), "utf8");
  const cookieNotice = await readFile(new URL("../app/cookies/page.tsx", import.meta.url), "utf8");

  assert.match(page, /Who this is for/);
  assert.match(page, /FAQPage/);
  assert.match(page, /Apply to become a partner/);
  assert.match(application, /Submission is an application only; it does not approve or activate/);
  assert.match(dashboard, /awaiting activation/);
  assert.match(dashboard, /Lifetime earnings/);
  assert.match(dashboard, /revenue_share_ends_at IS NULL OR revenue_share_ends_at >= now\(\)/);
  assert.match(cookieNotice, /cleared after a successful provider attribution/);
});
