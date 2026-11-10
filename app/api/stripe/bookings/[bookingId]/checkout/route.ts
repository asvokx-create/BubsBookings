import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { AGE_CONFIRMATION_REQUIRED_MESSAGE, hasConfirmedAge } from "@/lib/account-age";
import { getOrCreateConsumerStripeCustomer } from "@/lib/customer-stripe";
import { database } from "@/lib/database";
import type { ProviderPlan } from "@/lib/plans";
import { getStripe, getStripeMode, isStripeReady } from "@/lib/stripe";
import { enforceRateLimit } from "@/lib/request-security";
import { recordAnalytics } from "@/lib/analytics";
import { BOOKING_CHECKOUT_VERSION } from "@/lib/booking-fees";
import { calculateBookingFinancialSnapshot, type BookingFinancialPlan } from "@/lib/booking-financials";

export async function POST(request: Request, context: RouteContext<"/api/stripe/bookings/[bookingId]/checkout">) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Log in to pay for this booking." }, { status: 401 });
  if (!await hasConfirmedAge(session.user.id)) return NextResponse.json({ error: AGE_CONFIRMATION_REQUIRED_MESSAGE }, { status: 403 });
  if (!isStripeReady()) return NextResponse.json({ error: "Stripe payments are not available yet." }, { status: 503 });
  if (!await enforceRateLimit({ request, userId: session.user.id, bucket: "stripe-booking-checkout", limit: 8 }))
    return NextResponse.json({ error: "Too many payment attempts. Please wait and try again." }, { status: 429 });
  const { bookingId } = await context.params;
  const project = await database.query<{ id: string }>("SELECT id::text FROM hourly_projects WHERE payment_booking_id::text=$1", [bookingId]);
  if (project.rows[0]) return NextResponse.json({ error: "Review and pay the final timesheet from the project page.", projectId: project.rows[0].id }, { status: 409 });
  const result = await database.query<{
    id: string; title: string; provider_name: string; price_cents: number; status: string;
    payment_status: string; quote_status: string; plan: ProviderPlan; stripe_account_id: string | null;
    age_verification_status: "not_started" | "pending" | "requires_input" | "verified" | "failed";
    stripe_connect_mode: "test" | "live" | null; stripe_mode: "test" | "live" | null;
    stripe_checkout_session_id: string | null; payment_flow: string | null;
    provider_plan_snapshot: BookingFinancialPlan | null; provider_fee_basis_points: number | null; provider_fee_cap_cents: number | null;
    platform_fee_cents: number; provider_payout_cents: number; customer_service_fee_cents: number;
    customer_total_cents: number | null;
    base_price_cents: number; add_on_total_cents: number; discount_cents: number; package_snapshot: { name?: string } | null; coupon_code_snapshot: string | null;
    pricing_type_snapshot: "FIXED" | "HOURLY" | "QUOTE_ONLY"; hourly_rate_cents_snapshot: number | null; billable_duration_minutes: number;
  }>(`SELECT b.id::text, s.title, s.business_name AS provider_name, b.price_cents, b.status,
      b.payment_status, b.quote_status, p.plan, p.stripe_account_id, p.age_verification_status, p.stripe_connect_mode, b.stripe_mode,
      b.stripe_checkout_session_id, b.payment_flow, b.provider_plan_snapshot, b.provider_fee_basis_points, b.provider_fee_cap_cents,
      b.platform_fee_cents, b.provider_payout_cents, b.customer_service_fee_cents, b.customer_total_cents,
      b.base_price_cents,b.add_on_total_cents,b.discount_cents,b.package_snapshot,b.coupon_code_snapshot,
      b.pricing_type_snapshot,b.hourly_rate_cents_snapshot,b.billable_duration_minutes
    FROM bookings b JOIN services s ON s.id = b.service_id JOIN provider_profiles p ON p.id = b.provider_id
    WHERE b.id::text = $1 AND b.customer_id = $2`, [bookingId, session.user.id]);
  const booking = result.rows[0];
  if (!booking) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  if (booking.pricing_type_snapshot === "QUOTE_ONLY") return NextResponse.json({ error: "Accept the provider's custom quote before checkout." }, { status: 409 });
  if (booking.status !== "confirmed" && booking.status !== "completed") return NextResponse.json({ error: "The provider must confirm this booking before payment." }, { status: 409 });
  if (booking.quote_status === "pending" || booking.quote_status === "declined") return NextResponse.json({ error: "Resolve the custom quote before payment." }, { status: 409 });
  const mode = getStripeMode();
  if (booking.stripe_mode === mode && booking.payment_status === "paid") return NextResponse.json({ error: "This booking is already paid." }, { status: 409 });
  if (booking.age_verification_status !== "verified") return NextResponse.json({ error: "This provider is still completing required eligibility verification." }, { status: 409 });
  if (!booking.stripe_account_id || booking.stripe_connect_mode !== mode) return NextResponse.json({ error: "This provider has not finished payout setup yet." }, { status: 409 });
  if (booking.price_cents < 50) return NextResponse.json({ error: "This booking total is too low for online payment." }, { status: 409 });
  const freshSnapshot = calculateBookingFinancialSnapshot(booking.price_cents, booking.provider_plan_snapshot ?? booking.plan);
  const snapshot = booking.payment_flow === "held_transfer_v1" && booking.provider_plan_snapshot && booking.customer_total_cents ? {
    ...freshSnapshot,
    providerPlan: booking.provider_plan_snapshot,
    providerFeeBasisPoints: booking.provider_fee_basis_points!,
    providerFeeCapCents: booking.provider_fee_cap_cents,
    providerFeeCents: booking.platform_fee_cents,
    providerNetCents: booking.provider_payout_cents,
    customerServiceFeeCents: booking.customer_service_fee_cents,
    customerTotalCents: booking.customer_total_cents,
  } : freshSnapshot;

  const stripe = getStripe();
  if (booking.stripe_mode === mode && booking.payment_status === "pending" && booking.stripe_checkout_session_id) {
    const existing = await stripe.checkout.sessions.retrieve(booking.stripe_checkout_session_id);
    if (existing.status === "open" && existing.url
      && existing.metadata?.paymentFlow === "held_transfer_v1"
      && existing.metadata?.checkoutVersion === BOOKING_CHECKOUT_VERSION
      && existing.metadata?.customerServiceFeeCents === String(snapshot.customerServiceFeeCents)) {
      return NextResponse.json({ url: existing.url });
    }
    if (existing.status === "open") await stripe.checkout.sessions.expire(existing.id).catch(() => undefined);
  }
  const account = await stripe.accounts.retrieve(booking.stripe_account_id);
  await database.query("UPDATE provider_profiles SET stripe_charges_enabled = $2, stripe_payouts_enabled = $3 WHERE stripe_account_id = $1 AND stripe_connect_mode = $4", [booking.stripe_account_id, account.charges_enabled, account.payouts_enabled, mode]);
  if (!account.charges_enabled || !account.payouts_enabled) return NextResponse.json({ error: "This provider is still finishing secure payout verification." }, { status: 409 });

  const origin = new URL(request.url).origin;
  const customerId = await getOrCreateConsumerStripeCustomer({
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
  });
  // The session ID is persisted immediately after this call. Until then,
  // concurrent requests see the same prior state, so Stripe can safely return
  // the same Checkout Session instead of creating a second payment attempt.
  const checkoutAttemptKey = booking.stripe_checkout_session_id ?? "initial";
  const checkout = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    saved_payment_method_options: { payment_method_save: "enabled" },
    line_items: [
      { quantity: 1, price_data: { currency: "usd", unit_amount: booking.price_cents, product_data: { name: booking.package_snapshot?.name ? `${booking.title} · ${booking.package_snapshot.name}` : booking.title, description: `Service from ${booking.provider_name}. ${booking.pricing_type_snapshot === "HOURLY" && booking.hourly_rate_cents_snapshot !== null ? `${booking.billable_duration_minutes} minutes at $${(booking.hourly_rate_cents_snapshot/100).toFixed(2)}/hr. ` : ""}Base $${(booking.base_price_cents/100).toFixed(2)}${booking.add_on_total_cents ? ` + add-ons $${(booking.add_on_total_cents/100).toFixed(2)}` : ""}${booking.discount_cents ? ` − ${booking.coupon_code_snapshot ? `${booking.coupon_code_snapshot} ` : ""}discount $${(booking.discount_cents/100).toFixed(2)}` : ""}.` } } },
      { quantity: 1, price_data: { currency: "usd", unit_amount: snapshot.customerServiceFeeCents, product_data: { name: "BubsBookings service fee", description: "Secure marketplace checkout and booking support" } } },
    ],
    payment_intent_data: {
      transfer_group: `booking_${booking.id}`,
      metadata: { kind: "booking_payment", bookingId: booking.id, paymentFlow: "held_transfer_v1", checkoutVersion: BOOKING_CHECKOUT_VERSION, customerServiceFeeCents: String(snapshot.customerServiceFeeCents), providerPlan: snapshot.providerPlan, providerFeeBasisPoints: String(snapshot.providerFeeBasisPoints), pricingType: booking.pricing_type_snapshot, billableDurationMinutes: String(booking.billable_duration_minutes) },
    },
    success_url: `${origin}/account/bookings/${booking.id}?payment=success`,
    cancel_url: `${origin}/account/bookings/${booking.id}?payment=cancelled`,
    metadata: { kind: "booking_payment", bookingId: booking.id, paymentFlow: "held_transfer_v1", checkoutVersion: BOOKING_CHECKOUT_VERSION, customerServiceFeeCents: String(snapshot.customerServiceFeeCents), providerPlan: snapshot.providerPlan, providerFeeBasisPoints: String(snapshot.providerFeeBasisPoints), pricingType: booking.pricing_type_snapshot, billableDurationMinutes: String(booking.billable_duration_minutes) },
  }, { idempotencyKey: `booking-checkout-${mode}-${booking.id}-${checkoutAttemptKey}` });
  await database.query(`UPDATE bookings SET stripe_checkout_session_id = $2, stripe_payment_intent_id = NULL,
    stripe_charge_id = NULL, stripe_transfer_id = NULL, stripe_mode = $3, payment_status = 'pending',
    payment_flow = 'held_transfer_v1', payment_release_status = 'awaiting_payment',
    platform_fee_cents = $4, provider_payout_cents = $5, customer_service_fee_cents = $6,
    provider_plan_snapshot = $7, provider_fee_basis_points = $8, provider_fee_cap_cents = $9, customer_total_cents = $10,
    stripe_processing_fee_cents = NULL, provider_processing_fee_cents = 0, processing_fee_status = 'pending',
    customer_service_fee_refunded_cents = 0, paid_at = NULL,
    completion_confirmation_due_at = NULL, customer_confirmed_at = NULL, payout_released_at = NULL,
    payout_failure_reason = NULL, payout_frozen_at = NULL, payout_frozen_by = NULL, payout_freeze_reason = NULL
    WHERE id::text = $1`, [booking.id, checkout.id, mode, snapshot.providerFeeCents, snapshot.providerNetCents,
      snapshot.customerServiceFeeCents, snapshot.providerPlan, snapshot.providerFeeBasisPoints, snapshot.providerFeeCapCents, snapshot.customerTotalCents]);
  await recordAnalytics({ eventName: "checkout_started", userId: session.user.id, targetType: "booking", targetId: booking.id, metadata: { serviceAmountCents: booking.price_cents, customerServiceFeeCents: snapshot.customerServiceFeeCents, amountCents: snapshot.customerTotalCents } });
  return NextResponse.json({ url: checkout.url });
}
