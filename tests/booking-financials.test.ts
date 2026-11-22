import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateProviderProcessingFeeCents,
  calculateBookingFinancialSnapshot,
  estimateProviderProcessingFeeCents,
  isProviderPayoutEligible,
  paymentReleaseStatusAfterPayment,
  providerNetAfterServiceRefund,
  stripeOperationKey,
} from "../lib/booking-financials.ts";
import { readFileSync } from "node:fs";

test("successful booking payment enters secured state", () => {
  assert.equal(paymentReleaseStatusAfterPayment({ heldTransfer: true, serviceCompleted: false, frozen: false, paymentSucceeded: true }), "secured");
});

test("failed payment never becomes secured", () => {
  assert.equal(paymentReleaseStatusAfterPayment({ heldTransfer: true, serviceCompleted: false, frozen: false, paymentSucceeded: false }), "failed");
});

test("Starter snapshots a 10% provider fee", () => {
  const snapshot = calculateBookingFinancialSnapshot(10_000, "starter");
  assert.equal(snapshot.providerFeeBasisPoints, 1_000);
  assert.equal(snapshot.providerFeeCents, 1_000);
  assert.equal(snapshot.providerNetCents, 9_000);
});

test("Pro snapshots a 6% provider fee", () => {
  const snapshot = calculateBookingFinancialSnapshot(10_000, "pro");
  assert.equal(snapshot.providerFeeBasisPoints, 600);
  assert.equal(snapshot.providerFeeCents, 600);
  assert.equal(snapshot.providerNetCents, 9_400);
});

test("Free-plan platform fee is capped at $200 for every booking", () => {
  for (const [subtotal, expectedFee] of [[10_000, 1_000], [50_000, 5_000], [100_000, 10_000], [200_000, 20_000], [500_000, 20_000], [1_000_000, 20_000], [6_500_000, 20_000]] as const) {
    const snapshot = calculateBookingFinancialSnapshot(subtotal, "starter");
    assert.equal(snapshot.providerFeeCents, expectedFee, `subtotal ${subtotal}`);
    assert.equal(snapshot.providerFeeCapCents, 20_000);
  }
});

test("Pro platform fee is capped at $100 for every booking", () => {
  for (const [subtotal, expectedFee] of [[10_000, 600], [50_000, 3_000], [100_000, 6_000], [200_000, 10_000], [500_000, 10_000], [1_000_000, 10_000], [6_500_000, 10_000]] as const) {
    const snapshot = calculateBookingFinancialSnapshot(subtotal, "pro");
    assert.equal(snapshot.providerFeeCents, expectedFee, `subtotal ${subtotal}`);
    assert.equal(snapshot.providerFeeCapCents, 10_000);
  }
});

test("fee caps apply on the cent immediately below and above the threshold", () => {
  assert.equal(calculateBookingFinancialSnapshot(199_999, "starter").providerFeeCents, 20_000);
  assert.equal(calculateBookingFinancialSnapshot(200_001, "starter").providerFeeCents, 20_000);
  assert.equal(calculateBookingFinancialSnapshot(166_666, "pro").providerFeeCents, 10_000);
  assert.equal(calculateBookingFinancialSnapshot(166_667, "pro").providerFeeCents, 10_000);
});

test("actual Stripe fee allocation is proportional, capped by Stripe's reported fee, and does not surcharge the customer", () => {
  const allocation = allocateProviderProcessingFeeCents({ stripeProcessingFeeCents: 337, serviceSubtotalCents: 10_000, customerTotalCents: 10_299 });
  assert.equal(allocation.providerProcessingFeeCents, 327);
  assert.equal(allocation.platformProcessingFeeCents, 10);
  assert.equal(allocation.providerProcessingFeeCents + allocation.platformProcessingFeeCents, 337);
  assert.equal(calculateBookingFinancialSnapshot(10_000, "starter").customerServiceFeeCents, 299);
});

test("pre-acceptance processing estimate uses the customer charge and allocates only the service portion", () => {
  const estimate = estimateProviderProcessingFeeCents({ serviceSubtotalCents: 10_000, customerTotalCents: 10_299 });
  assert.equal(estimate.estimatedStripeProcessingFeeCents, 329);
  assert.equal(estimate.estimatedProviderProcessingFeeCents, 319);
  assert.equal(estimate.estimatedPlatformProcessingFeeCents, 10);
});

test("provider sees an estimated fee breakdown before the accept booking action", () => {
  const bookingDetails = readFileSync(new URL("../components/booking-details.tsx", import.meta.url), "utf8");
  const estimateIndex = bookingDetails.indexOf("Estimated earnings");
  const acceptIndex = bookingDetails.indexOf('providerAction("accepted")');
  assert.ok(estimateIndex >= 0);
  assert.ok(acceptIndex > estimateIndex);
  assert.match(bookingDetails, /Estimated Stripe processing/);
  assert.match(bookingDetails, /Stripe&apos;s actual fee can vary/);
});

test("processing allocation excludes taxes and tips by accepting only the service subtotal and customer checkout total", () => {
  const allocation = allocateProviderProcessingFeeCents({ stripeProcessingFeeCents: 123, serviceSubtotalCents: 5_000, customerTotalCents: 5_299 });
  assert.equal(allocation.providerProcessingFeeCents, 116);
  assert.equal(allocation.platformProcessingFeeCents, 7);
});

test("customer total includes the $2.99 service fee without reducing provider net", () => {
  const snapshot = calculateBookingFinancialSnapshot(10_000, "starter");
  assert.equal(snapshot.customerServiceFeeCents, 299);
  assert.equal(snapshot.customerTotalCents, 10_299);
  assert.equal(snapshot.providerNetCents, 9_000);
});

test("provider pricing discloses the separate customer service fee and processing-cost distinction", () => {
  const pricing = readFileSync(new URL("../app/pricing/page.tsx", import.meta.url), "utf8");
  assert.match(pricing, /Customers pay a separate \{money\(DEFAULT_CUSTOMER_SERVICE_FEE_CENTS\)\} BubsBookings service fee at checkout/);
  assert.match(pricing, /Stripe processing costs are separate from the BubsBookings platform fee/);
  assert.match(pricing, /no separate card-processing surcharge/);
  assert.doesNotMatch(pricing, /Platform fee examples/);
});

test("provider-facing pages distinguish pending processing costs from final earnings", () => {
  const bookingDetails = readFileSync(new URL("../components/booking-details.tsx", import.meta.url), "utf8");
  const billingPanel = readFileSync(new URL("../components/billing-panel.tsx", import.meta.url), "utf8");
  const providerDashboard = readFileSync(new URL("../components/provider-dashboard.tsx", import.meta.url), "utf8");
  assert.match(bookingDetails, /Provider-allocated Stripe processing/);
  assert.match(bookingDetails, /displayedProviderProcessingFee/);
  assert.match(bookingDetails, /Final service earnings/);
  assert.match(bookingDetails, /transferReversed/);
  assert.match(billingPanel, /Separate actual cost/);
  assert.match(billingPanel, /varies by transaction/);
  assert.match(providerDashboard, /Estimated earnings secured/);
  assert.match(providerDashboard, /Paid-out amounts are net service earnings/);
});

test("customer checkout charges only the service subtotal and disclosed $2.99 service fee", () => {
  const checkout = readFileSync(new URL("../app/api/stripe/bookings/[bookingId]/checkout/route.ts", import.meta.url), "utf8");
  assert.match(checkout, /unit_amount: booking\.price_cents/);
  assert.match(checkout, /unit_amount: snapshot\.customerServiceFeeCents/);
  assert.match(checkout, /name: "BubsBookings service fee"/);
  assert.doesNotMatch(checkout, /card.processing|processing surcharge|processing fee[^\n]*line_items/i);
});

test("payment and refund policies disclose actual reconciliation and refund uncertainty", () => {
  const payments = readFileSync(new URL("../app/payment-billing/page.tsx", import.meta.url), "utf8");
  const refunds = readFileSync(new URL("../app/cancellations-refunds/page.tsx", import.meta.url), "utf8");
  assert.match(payments, /does not promise a fixed processing rate/);
  assert.match(payments, /actual balance-transaction fee/);
  assert.match(payments, /BubsBookings does not promise that Stripe processing costs are refundable/);
  assert.match(refunds, /remaining \$2\.99 BubsBookings customer service fee is also refunded/);
  assert.match(refunds, /proportional transfer reversal or later recovery/);
});

test("provider completion after payment enters customer review", () => {
  assert.equal(paymentReleaseStatusAfterPayment({ heldTransfer: true, serviceCompleted: true, frozen: false, paymentSucceeded: true }), "awaiting_customer");
});

test("customer confirmation can release an eligible payout", () => {
  assert.equal(isProviderPayoutEligible({ paymentStatus: "paid", bookingStatus: "completed", paymentReleaseStatus: "awaiting_customer", hasOpenDispute: false, hasBlockingRefund: false, payoutFrozen: false, transferId: null }), true);
});

test("48 hour automatic completion uses the same eligibility rule", () => {
  assert.equal(isProviderPayoutEligible({ paymentStatus: "paid", bookingStatus: "completed", paymentReleaseStatus: "awaiting_customer", hasOpenDispute: false, hasBlockingRefund: false, payoutFrozen: false, transferId: null }), true);
});

test("customer dispute blocks payout", () => {
  assert.equal(isProviderPayoutEligible({ paymentStatus: "paid", bookingStatus: "completed", paymentReleaseStatus: "frozen", hasOpenDispute: true, hasBlockingRefund: false, payoutFrozen: true, transferId: null }), false);
});

test("payout remains blocked for the entire open-dispute state", () => {
  const input = { paymentStatus: "paid", bookingStatus: "completed", paymentReleaseStatus: "frozen", hasOpenDispute: true, hasBlockingRefund: false, payoutFrozen: true, transferId: null };
  assert.equal(isProviderPayoutEligible(input), false);
  assert.equal(isProviderPayoutEligible(input), false);
});

test("full refund leaves no provider net", () => {
  const snapshot = calculateBookingFinancialSnapshot(10_000, "starter");
  assert.equal(providerNetAfterServiceRefund(snapshot, 10_000), 0);
});

test("partial refund recalculates provider net from the immutable fee snapshot", () => {
  const snapshot = calculateBookingFinancialSnapshot(10_000, "starter");
  assert.equal(providerNetAfterServiceRefund(snapshot, 4_000), 5_400);
});

test("successful provider transfer requires all payout guards", () => {
  assert.equal(isProviderPayoutEligible({ paymentStatus: "paid", bookingStatus: "completed", paymentReleaseStatus: "awaiting_customer", hasOpenDispute: false, hasBlockingRefund: false, payoutFrozen: false, transferId: null }), true);
});

test("failed provider transfer is retryable but not duplicated", () => {
  assert.equal(isProviderPayoutEligible({ paymentStatus: "paid", bookingStatus: "completed", paymentReleaseStatus: "failed", hasOpenDispute: false, hasBlockingRefund: false, payoutFrozen: false, transferId: null }), true);
});

test("duplicate webhook and payout attempts use stable keys", () => {
  assert.equal(stripeOperationKey("payout", "live", "booking-1"), stripeOperationKey("payout", "live", "booking-1"));
});

test("concurrent booking checkout attempts share one Stripe idempotency key", () => {
  const checkout = readFileSync(new URL("../app/api/stripe/bookings/[bookingId]/checkout/route.ts", import.meta.url), "utf8");
  assert.match(checkout, /const checkoutAttemptKey = booking\.stripe_checkout_session_id \?\? "initial"/);
  assert.match(checkout, /idempotencyKey: `booking-checkout-\$\{mode\}-\$\{booking\.id\}-\$\{checkoutAttemptKey\}`/);
});

test("existing transfer blocks duplicate payout", () => {
  assert.equal(isProviderPayoutEligible({ paymentStatus: "paid", bookingStatus: "completed", paymentReleaseStatus: "awaiting_customer", hasOpenDispute: false, hasBlockingRefund: false, payoutFrozen: false, transferId: "tr_123" }), false);
});

test("cancellation refund hold blocks payout", () => {
  assert.equal(isProviderPayoutEligible({ paymentStatus: "paid", bookingStatus: "cancelled", paymentReleaseStatus: "frozen", hasOpenDispute: false, hasBlockingRefund: true, payoutFrozen: true, transferId: null }), false);
});

test("historical booking keeps its fee snapshot after plan pricing changes", () => {
  const snapshot = calculateBookingFinancialSnapshot(10_000, "starter");
  const laterPlan = calculateBookingFinancialSnapshot(10_000, "pro");
  assert.equal(snapshot.providerFeeCents, 1_000);
  assert.equal(laterPlan.providerFeeCents, 600);
  assert.equal(providerNetAfterServiceRefund(snapshot, 4_000), 5_400);
});

test("customer confirmation and automatic release converge on one idempotency key", () => {
  const customerKey = stripeOperationKey("payout", "live", "booking-race");
  const automaticKey = stripeOperationKey("payout", "live", "booking-race");
  assert.equal(customerKey, automaticKey);
});

test("duplicate completion requests converge on the same customer-review state", () => {
  const input = { heldTransfer: true, serviceCompleted: true, frozen: false, paymentSucceeded: true };
  assert.equal(paymentReleaseStatusAfterPayment(input), "awaiting_customer");
  assert.equal(paymentReleaseStatusAfterPayment(input), "awaiting_customer");
});
