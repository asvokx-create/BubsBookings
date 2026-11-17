import type Stripe from "stripe";

export type CallPaymentInput = {
  id: string; billingMode: "free" | "paid"; stripeMode: "test" | "live";
  totalCents: number; serviceSubtotalCents: number; customerServiceFeeCents: number; currency: "usd";
  stripeCustomerId: string; checkoutSessionId?: string | null; paymentIntentId?: string | null;
  successUrl: string; cancelUrl: string; operationCreatedAt: string; integrationIdentifier: string;
};
export type PaymentEvidence = {
  id: string; mode: "test" | "live"; callId: string; currency: "usd"; totalCents: number;
  status: "authorized" | "captured" | "cancelled" | "failed" | "pending";
  captureBefore: string | null; amountReceivedCents: number; chargeId: string | null;
};
export type RefundEvidence = { id: string; status: "pending" | "succeeded" | "failed" | "cancelled"; amountCents: number };
export class CallPaymentVerificationError extends Error {}
function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CallPaymentVerificationError(message);
};
const objectId = (value: unknown) => typeof value === "string" ? value : value && typeof value === "object" && "id" in value && typeof value.id === "string" ? value.id : null;

/** All writes require a durable engine claim and stable key before invoking this adapter. */
export function createCalendlyCallPaymentAdapter({ stripe, mode, now = () => Date.now() }: { stripe: Stripe; mode: "test" | "live"; now?: () => number }) {
  function validateCall(call: CallPaymentInput) {
    requireFact(call.billingMode === "paid", "Free calls cannot enter Stripe payment flow.");
    requireFact(call.stripeMode === mode && call.currency === "usd", "Payment environment or currency changed.");
    requireFact(/^[A-Za-z0-9_-]{1,100}$/.test(call.id) && /^cus_[A-Za-z0-9]+$/.test(call.stripeCustomerId), "Invalid payment identity.");
    requireFact(Number.isSafeInteger(call.serviceSubtotalCents) && call.serviceSubtotalCents >= 50 && Number.isSafeInteger(call.customerServiceFeeCents) && call.customerServiceFeeCents >= 0
      && Number.isSafeInteger(call.totalCents) && call.totalCents === call.serviceSubtotalCents + call.customerServiceFeeCents, "Invalid immutable call total.");
  }
  function writeOptions(key: string) {
    requireFact(typeof key === "string" && key.length >= 16 && key.length <= 255, "A stable durable operation key is required.");
    return { idempotencyKey: key, maxNetworkRetries: 0 };
  }
  function verifySession(call: CallPaymentInput, session: Stripe.Checkout.Session) {
    requireFact(session.livemode === (mode === "live") && session.mode === "payment" && session.client_reference_id === call.id
      && session.metadata?.calendly_call_id === call.id && session.metadata?.payment_flow === "calendly_manual_v1"
      && objectId(session.customer) === call.stripeCustomerId && session.currency === call.currency && session.amount_total === call.totalCents,
    "Checkout does not match this call's payment snapshot.");
    if (call.checkoutSessionId) requireFact(session.id === call.checkoutSessionId, "Checkout identity changed.");
  }
  function evidence(call: CallPaymentInput, intent: Stripe.PaymentIntent, allowCompensation = false): PaymentEvidence {
    requireFact(intent.livemode === (mode === "live") && intent.metadata?.calendly_call_id === call.id
      && intent.metadata?.payment_flow === "calendly_manual_v1" && objectId(intent.customer) === call.stripeCustomerId
      && intent.currency === call.currency && intent.amount === call.totalCents && intent.capture_method === "manual",
    "PaymentIntent does not match the authorized call snapshot.");
    if (call.paymentIntentId) requireFact(intent.id === call.paymentIntentId, "PaymentIntent identity changed.");
    const charge = intent.latest_charge && typeof intent.latest_charge === "object" ? intent.latest_charge : null;
    if (charge) requireFact(charge.livemode === (mode === "live") && objectId(charge.payment_intent) === intent.id && charge.currency === call.currency && charge.amount === call.totalCents, "Charge identity does not match the call.");
    // Only a card with an authoritative capture deadline is eligible for scheduling.
    // Checkout remains dynamic; unsupported methods never qualify as authorized.
    const deadline = charge?.payment_method_details?.card?.capture_before;
    const captureBefore = Number.isSafeInteger(deadline) && Number(deadline) > 0 ? new Date(Number(deadline) * 1000).toISOString() : null;
    let status: PaymentEvidence["status"] = "pending";
    if (intent.status === "succeeded") {
      requireFact(intent.amount_received === call.totalCents && charge?.captured === true && charge.paid === true, "Capture total or evidence is incomplete.");
      // A succeeded intent is not proof that funds remain available for fulfillment.
      requireFact(charge.disputed !== true, "Disputed payment requires manual review.");
      if (!allowCompensation) requireFact(charge.refunded !== true && (charge.amount_refunded ?? 0) === 0, "Refunded payment cannot confirm an appointment.");
      status = "captured";
    } else if (intent.status === "canceled") status = "cancelled";
    else if (intent.status === "requires_capture") {
      // A validly linked but unsupported/partial hold remains cancellable, never bookable.
      status = intent.amount_capturable === call.totalCents && intent.amount_received === 0
        && charge?.paid === true && charge.captured === false && captureBefore !== null
        && Date.parse(captureBefore) > now() ? "authorized" : "failed";
    } else if (intent.status === "requires_payment_method" && intent.last_payment_error) status = "failed";
    return { id: intent.id, mode, callId: call.id, currency: call.currency, totalCents: call.totalCents, status, captureBefore, amountReceivedCents: intent.amount_received, chargeId: objectId(intent.latest_charge) };
  }
  async function readInternal(call: CallPaymentInput, allowCompensation = false): Promise<PaymentEvidence | null> {
    validateCall(call);
    let id = call.paymentIntentId;
    if (call.checkoutSessionId) {
      const session = await stripe.checkout.sessions.retrieve(call.checkoutSessionId);
      verifySession(call, session);
      const linked = objectId(session.payment_intent);
      if (id) requireFact(linked === id, "Checkout and PaymentIntent linkage differs.");
      id = linked;
    }
    if (!id) return null;
    const intent = await stripe.paymentIntents.retrieve(id, { expand: ["latest_charge"] });
    return evidence(call, intent, allowCompensation);
  }
  const read = (call: CallPaymentInput) => readInternal(call);
  async function createCheckout(call: CallPaymentInput, key: string) {
    validateCall(call);
    if (call.checkoutSessionId) {
      const existing = await stripe.checkout.sessions.retrieve(call.checkoutSessionId);
      verifySession(call, existing);
      if (call.paymentIntentId) requireFact(objectId(existing.payment_intent) === call.paymentIntentId, "Checkout and PaymentIntent linkage differs.");
      requireFact(existing.status === "open", "Checkout is complete or expired; reconcile instead of creating a replacement.");
      requireFact(existing.url && new URL(existing.url).origin === "https://checkout.stripe.com", "Checkout URL was not verified.");
      return { id: existing.id, url: existing.url, paymentIntentId: objectId(existing.payment_intent) };
    }
    requireFact(!call.paymentIntentId, "An existing payment must be reconciled instead of replaced.");
    const age = now() - Date.parse(call.operationCreatedAt);
    requireFact(Number.isFinite(age) && age >= 0 && age < 20 * 60 * 60 * 1000, "Checkout outcome requires reconciliation outside the safe retry window.");
    requireFact(/^calendly_calls_[a-z]{8}$/.test(call.integrationIdentifier), "Stable integration identifier is required.");
    const success = new URL(call.successUrl), cancel = new URL(call.cancelUrl);
    requireFact(success.origin === cancel.origin && !success.username && !success.password && !cancel.username && !cancel.password
      && (success.protocol === "https:" || (mode === "test" && success.hostname === "127.0.0.1" && success.protocol === "http:")), "Invalid checkout return origin.");
    const session = await stripe.checkout.sessions.create({
      mode: "payment", customer: call.stripeCustomerId, client_reference_id: call.id,
      success_url: call.successUrl, cancel_url: call.cancelUrl,
      integration_identifier: call.integrationIdentifier,
      metadata: { calendly_call_id: call.id, payment_flow: "calendly_manual_v1" },
      payment_intent_data: { capture_method: "manual", metadata: { calendly_call_id: call.id, payment_flow: "calendly_manual_v1" } },
      line_items: [
        { price_data: { currency: call.currency, unit_amount: call.serviceSubtotalCents, product_data: { name: "Scheduled call" } }, quantity: 1 },
        ...(call.customerServiceFeeCents ? [{ price_data: { currency: call.currency, unit_amount: call.customerServiceFeeCents, product_data: { name: "BubsBookings customer service fee" } }, quantity: 1 }] : []),
      ],
      custom_text: { submit: { message: "Authorize a temporary hold. You are charged only after the appointment is verified. A calendar invitation may arrive before charging completes; if charging fails we cancel and notify you in BubsBookings." } },
    }, writeOptions(key));
    verifySession(call, session);
    requireFact(session.url && new URL(session.url).origin === "https://checkout.stripe.com", "Checkout URL was not verified.");
    return { id: session.id, url: session.url, paymentIntentId: objectId(session.payment_intent) };
  }
  async function capture(call: CallPaymentInput, key: string) {
    const before = await read(call);
    requireFact(before, "Authorization is not known.");
    if (before.status === "captured") return before;
    requireFact(before.status === "authorized" && before.captureBefore && Date.parse(before.captureBefore) - now() > 60_000, "Authorization is not safely capturable.");
    const intent = await stripe.paymentIntents.capture(before.id, { amount_to_capture: call.totalCents, expand: ["latest_charge"] }, writeOptions(key));
    return evidence({ ...call, paymentIntentId: before.id }, intent);
  }
  async function cancel(call: CallPaymentInput, key: string) {
    const before = await read(call);
    if (!before) {
      // No persisted session is NOT evidence that an ambiguous create failed.
      requireFact(call.checkoutSessionId, "Unknown checkout outcome requires reconciliation.");
      let session = await stripe.checkout.sessions.retrieve(call.checkoutSessionId);
      verifySession(call, session);
      if (session.status === "open") session = await stripe.checkout.sessions.expire(session.id, {}, writeOptions(key));
      verifySession(call, session);
      const linked = objectId(session.payment_intent);
      if (linked) return cancel({ ...call, paymentIntentId: linked }, key);
      requireFact(session.status === "expired", "Checkout may still produce a payment; reconcile first.");
      return null;
    }
    if (before.status === "cancelled") return before;
    requireFact(before.status !== "captured", "Captured funds require a refund, not cancellation.");
    const intent = await stripe.paymentIntents.cancel(before.id, { cancellation_reason: "abandoned", expand: ["latest_charge"] }, writeOptions(key));
    return evidence({ ...call, paymentIntentId: before.id }, intent);
  }
  function refundEvidence(call: CallPaymentInput, refund: Stripe.Refund, intentId: string, key: string): RefundEvidence {
    requireFact(objectId(refund.payment_intent) === intentId && refund.currency === call.currency && refund.amount === call.totalCents
      && refund.metadata?.calendly_call_id === call.id && refund.metadata?.call_compensation_key === key, "Refund identity does not match this compensation operation.");
    const status = refund.status === "succeeded" ? "succeeded" : refund.status === "failed" ? "failed" : refund.status === "canceled" ? "cancelled" : "pending";
    return { id: refund.id, status, amountCents: refund.amount };
  }
  async function readRefund(call: CallPaymentInput, key: string): Promise<RefundEvidence | null> {
    const payment = await readInternal(call, true);
    requireFact(payment && payment.status === "captured", "Cannot reconcile refund without confirmed capture.");
    let cursor: string | undefined;
    const found: RefundEvidence[] = [];
    for (let page = 0; page < 10; page++) {
      const refunds = await stripe.refunds.list({ payment_intent: payment.id, limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
      for (const refund of refunds.data) if (refund.metadata?.call_compensation_key === key) found.push(refundEvidence(call, refund, payment.id, key));
      requireFact(found.length <= 1, "Multiple compensation refunds require review.");
      if (!refunds.has_more) return found[0] ?? null;
      cursor = refunds.data.at(-1)?.id;
      requireFact(cursor, "Invalid refund pagination.");
    }
    throw new CallPaymentVerificationError("Refund history exceeds reconciliation limit.");
  }
  async function refund(call: CallPaymentInput, key: string): Promise<RefundEvidence> {
    const prior = await readRefund(call, key);
    if (prior) return prior;
    // If another refund exists, do not issue an additional compensation refund.
    const payment = await read(call);
    requireFact(payment && payment.status === "captured", "Cannot refund without confirmed capture.");
    const value = await stripe.refunds.create({ payment_intent: payment.id, amount: call.totalCents,
      metadata: { calendly_call_id: call.id, call_compensation_key: key } }, writeOptions(key));
    return refundEvidence(call, value, payment.id, key);
  }
  return { createCheckout, read, capture, cancel, refund, readRefund };
}

export async function createDefaultCalendlyCallPaymentAdapter() {
  const { getStripe, getStripeMode } = await import("./stripe");
  return createCalendlyCallPaymentAdapter({ stripe: getStripe(), mode: getStripeMode() });
}
