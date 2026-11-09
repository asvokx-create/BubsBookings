import { recordBookingChargeRefund } from "@/lib/booking-refund-reconciliation";
import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { database } from "@/lib/database";
import { isPurchasableProviderPlan } from "@/lib/plans";
import { getStripe, getStripeMode } from "@/lib/stripe";
import { recordAnalytics } from "@/lib/analytics";
import { runAutomatedProviderVerification } from "@/lib/provider-verification";
import { extraSeatQuantity } from "@/lib/stripe-team-seats";
import { subscriptionProvidesProAccess } from "@/lib/team-seat-rules";
import { sendTransactionalEmail } from "@/lib/email";
import { syncAffiliateCommissionForBooking } from "@/lib/affiliates";
import { finalizeAffiliatePayoutTransfer, reverseAffiliatePayoutTransfer } from "@/lib/affiliate-payouts";
import { releaseTipTransfer } from "@/lib/tip-payments";
import { syncProviderAgeVerificationFromStripe } from "@/lib/provider-age-verification";
import { reconcileBookingProcessingFee } from "@/lib/booking-processing-fees";
import { parseVerifiedStripeEvent, stripeEventMatchesMode, stripeTransferMatches } from "@/lib/stripe-webhook-security";
import { subscriptionPeriodEndUnix } from "@/lib/subscription-lifecycle";

export const runtime = "nodejs";

function idOf(value: string | { id: string } | null) {
  return typeof value === "string" ? value : value?.id ?? null;
}

async function markBookingPaymentFailed(options: {
  bookingId?: string;
  checkoutSessionId?: string;
  paymentIntentId?: string;
}) {
  const failed = await database.query<{ id: string; recurring_series_id: string | null; customer_id: string }>(
    `UPDATE bookings SET payment_status = 'failed'
     WHERE stripe_mode = $4 AND payment_status IN ('unpaid', 'pending', 'failed')
       AND (NOT EXISTS (SELECT 1 FROM hourly_projects h WHERE h.payment_booking_id=bookings.id)
         OR ($2::text <> '' AND stripe_checkout_session_id=$2))
       AND (($1::text <> '' AND id::text = $1)
         OR ($2::text <> '' AND stripe_checkout_session_id = $2)
         OR ($3::text <> '' AND stripe_payment_intent_id = $3))
     RETURNING id::text, recurring_series_id::text, customer_id`,
    [options.bookingId ?? "", options.checkoutSessionId ?? "", options.paymentIntentId ?? "", getStripeMode()],
  );
  for (const booking of failed.rows) {
    if (!booking.recurring_series_id) continue;
    await database.query(
      `UPDATE recurring_booking_series SET status = 'paused', updated_at = now()
       WHERE id::text = $1 AND status = 'active'`,
      [booking.recurring_series_id],
    );
    await database.query(
      `INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
       VALUES ($1, $2, 'payment_failed', 'Recurring plan paused',
         'This payment failed, so future recurring visits are paused until you review the booking.',
         '/account/bookings/' || $2::uuid::text, 'recurring-payment-failed-' || $2::uuid::text)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [booking.customer_id, booking.id],
    );
  }
}

async function updateSubscription(subscription: Stripe.Subscription, eventCreated: number | null = null) {
  const providerId = subscription.metadata.providerId;
  const plan = subscription.metadata.plan;
  if (!providerId || !isPurchasableProviderPlan(plan)) return;
  const active = subscriptionProvidesProAccess(subscription.status);
  const periodEnd = subscriptionPeriodEndUnix(subscription);
  const teamSeats = extraSeatQuantity(subscription);
  const mode = getStripeMode();
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const complimentary = await client.query<{ active: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM complimentary_pro_grants complimentary WHERE complimentary.provider_id::text = $1
        AND complimentary.revoked_at IS NULL AND complimentary.starts_at <= now()
        AND (complimentary.expires_at IS NULL OR complimentary.expires_at > now())) AS active`, [providerId]);
    const effectivePro = active || Boolean(complimentary.rows[0]?.active);
    const updated = await client.query<{ id: string }>(`UPDATE provider_profiles SET
        plan = CASE WHEN $12 THEN 'pro' ELSE 'starter' END,
        stripe_subscription_id = $2,
        stripe_subscription_checkout_session_id = NULL,
        stripe_subscription_status = $5,
        stripe_current_period_end = CASE WHEN $6::bigint IS NULL THEN NULL ELSE to_timestamp($6) END,
        stripe_cancel_at_period_end = $10,
        stripe_subscription_event_created_at = COALESCE($11, stripe_subscription_event_created_at),
        stripe_billing_mode = $7,
        extra_team_seats = CASE WHEN $4 THEN $8 ELSE 0 END,
        stripe_team_seat_item_id = CASE WHEN $4 THEN $9 ELSE NULL END,
        pro_trial_used_at_test = CASE WHEN $5 = 'trialing' AND $7 = 'test' THEN COALESCE(pro_trial_used_at_test, now()) ELSE pro_trial_used_at_test END,
        pro_trial_used_at_live = CASE WHEN $5 = 'trialing' AND $7 = 'live' THEN COALESCE(pro_trial_used_at_live, now()) ELSE pro_trial_used_at_live END
      WHERE id::text = $1 AND plan <> 'owner'
        AND ($11::bigint IS NULL OR stripe_subscription_event_created_at IS NULL OR $11 >= stripe_subscription_event_created_at)
        AND NOT ($11::bigint IS NOT NULL AND stripe_subscription_status = 'canceled' AND $5 <> 'canceled')
      RETURNING id::text`, [providerId, subscription.id, plan, active, subscription.status, periodEnd ?? null, mode,
        teamSeats.quantity, teamSeats.itemId, subscription.cancel_at_period_end, eventCreated, effectivePro]);
    if (updated.rows[0] && !effectivePro) {
      await client.query("UPDATE provider_team_members SET status = 'inactive' WHERE provider_id::text = $1 AND status IN ('pending', 'active')", [providerId]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function invoiceSubscriptionId(invoice: Stripe.Invoice) {
  const subscription = invoice.parent?.subscription_details?.subscription;
  return idOf(subscription ?? null);
}

async function syncSubscriptionInvoice(invoice: Stripe.Invoice, paymentFailed: boolean) {
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) return;
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
  if (subscription.metadata.kind !== "provider_subscription") return;
  await updateSubscription(subscription);
  if (!paymentFailed) return;
  await database.query(`INSERT INTO notifications (user_id, type, title, message, href, dedupe_key)
    SELECT provider.user_id, 'billing', 'Pro payment needs attention',
      'Stripe could not collect your Pro subscription payment. Update your payment method to avoid losing Pro and team access after the retry period.',
      '/provider/dashboard/billing', $2
    FROM provider_profiles provider WHERE provider.id::text = $1
    ON CONFLICT (dedupe_key) DO NOTHING`, [subscription.metadata.providerId ?? "", `provider-invoice-failed-${invoice.id}`]);
}

async function notifyTrialWillEnd(subscription: Stripe.Subscription) {
  const providerId = subscription.metadata.providerId;
  const trialEnd = subscription.trial_end;
  if (!providerId || !trialEnd) return;
  const mode = getStripeMode();
  const trialEndLabel = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "America/Los_Angeles" }).format(new Date(trialEnd * 1000));
  const monthlyTotalCents = subscription.items.data.reduce(
    (total, item) => total + (item.price.unit_amount ?? 0) * (item.quantity ?? 1),
    0,
  );
  const monthlyTotal = `$${(monthlyTotalCents / 100).toFixed(2)}`;
  const provider = await database.query<{ user_id: string; email: string }>(
    `SELECT p.user_id, u.email
     FROM provider_profiles p JOIN "user" u ON u.id = p.user_id
     WHERE p.id::text = $1 AND p.stripe_subscription_id = $2 AND p.stripe_billing_mode = $3`,
    [providerId, subscription.id, mode],
  );
  const recipient = provider.rows[0];
  if (!recipient) return;
  await database.query(
    `INSERT INTO notifications (user_id, type, title, message, href, dedupe_key)
     VALUES ($1, 'subscription_trial', 'Your Pro trial ends soon', $2, '/provider/dashboard/billing', $3)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [recipient.user_id, `Your Pro trial ends on ${trialEndLabel}. It will renew at ${monthlyTotal} per month unless you cancel before then.`, `pro-trial-ending-${mode}-${subscription.id}`],
  );
  await sendTransactionalEmail({
    to: recipient.email,
    userId: recipient.user_id,
    emailType: `pro_trial_ending_${mode}_${subscription.id}`,
    subject: "Your BubsBookings Pro trial ends soon",
    heading: "Your Pro trial ends soon",
    message: `Your 30-day Pro trial ends on ${trialEndLabel}. Your saved card will be charged ${monthlyTotal} for the first paid month after the trial unless you cancel before then.`,
    actionLabel: "Manage subscription",
    actionUrl: "/provider/dashboard/billing",
  });
}

async function markBookingPaid(checkout: Stripe.Checkout.Session) {
  if (checkout.metadata?.kind !== "booking_payment" || !checkout.metadata.bookingId) return;
  if (checkout.payment_status !== "paid") return;
  // A signed event can beat the response that persists its Checkout Session.
  // Retry rather than acknowledge and permanently lose that payment.
  if (checkout.metadata.hourlyProjectId) {
    const linked = await database.query<{ status: string; version: number; stripe_checkout_session_id: string | null }>(`SELECT h.status,h.version,b.stripe_checkout_session_id
      FROM hourly_projects h JOIN bookings b ON b.id=h.payment_booking_id
      WHERE h.id::text=$1 AND b.id::text=$2`, [checkout.metadata.hourlyProjectId,checkout.metadata.bookingId]);
    const project = linked.rows[0];
    if (!project || project.status !== "approved" || String(project.version) !== checkout.metadata.timesheetVersion
      || project.stripe_checkout_session_id !== checkout.id) throw new Error("Hourly payment approval/session is not yet reconciled.");
  }
  const paymentIntentId = idOf(checkout.payment_intent);
  if (!paymentIntentId || checkout.amount_total === null) {
    throw new Error("Stripe booking payment was missing its payment details.");
  }
  let chargeId: string | null = null;
  const paymentIntent = await getStripe().paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
  if (paymentIntent.status !== "succeeded" || paymentIntent.currency !== "usd"
    || paymentIntent.amount_received !== checkout.amount_total
    || paymentIntent.metadata.bookingId !== checkout.metadata.bookingId
    || paymentIntent.metadata.kind !== "booking_payment") {
    throw new Error("Stripe booking payment did not match the server-side booking record.");
  }
  chargeId = idOf(paymentIntent.latest_charge);
  if (!chargeId) throw new Error("Stripe booking payment was missing its charge record.");
  const heldTransfer = checkout.metadata.paymentFlow === "held_transfer_v1";
  const updated = await database.query(`UPDATE bookings SET payment_status = 'paid', stripe_payment_intent_id = $2,
      stripe_charge_id = $5, stripe_mode = $4, paid_at = now(),
      payment_release_status = CASE
        WHEN $6 AND payout_frozen_at IS NOT NULL THEN 'frozen'
        WHEN $6 AND status = 'completed' THEN 'awaiting_customer'
        WHEN $6 THEN 'secured'
        ELSE 'paid_out' END,
      completion_confirmation_due_at = CASE
        WHEN $6 AND status = 'completed' THEN now() + interval '48 hours'
        ELSE completion_confirmation_due_at END,
      payout_released_at = CASE WHEN $6 THEN NULL ELSE now() END
    WHERE id::text = $1 AND stripe_checkout_session_id = $3 AND stripe_mode = $4
      AND payment_status IN ('unpaid', 'pending', 'failed')
      AND customer_total_cents = $7
    RETURNING id`, [checkout.metadata.bookingId, paymentIntentId, checkout.id, getStripeMode(), chargeId, heldTransfer, checkout.amount_total]);
  if (!updated.rowCount) return;
  await reconcileBookingProcessingFee(checkout.metadata.bookingId, chargeId);
  await database.query(`INSERT INTO booking_events (booking_id, event_type, message, metadata)
    VALUES ($1::uuid, 'payment_received', 'Payment received through Stripe.', jsonb_build_object('checkoutSessionId', $2))`, [checkout.metadata.bookingId, checkout.id]);
  await database.query(`INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
    SELECT p.user_id, b.id, 'booking_payment', 'Customer payment received',
      '$' || to_char((b.price_cents - b.platform_fee_cents)::numeric / 100, 'FM999999990.00') || ' is secured for ' || s.title || '.',
      '/provider/dashboard/bookings/' || b.id::text, 'payment-received-' || b.id::text || '-provider'
    FROM bookings b JOIN provider_profiles p ON p.id = b.provider_id JOIN services s ON s.id = b.service_id
    WHERE b.id::text = $1 ON CONFLICT (dedupe_key) DO NOTHING`, [checkout.metadata.bookingId]);
  await database.query(`INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
    SELECT b.customer_id, b.id, 'booking_payment', 'Payment received',
      '$' || to_char(b.customer_total_cents::numeric / 100, 'FM999999990.00') || ' was processed through Stripe for ' || s.title || '.',
      '/account/bookings/' || b.id::text, 'payment-received-' || b.id::text || '-customer'
    FROM bookings b JOIN services s ON s.id = b.service_id
    WHERE b.id::text = $1 ON CONFLICT (dedupe_key) DO NOTHING`, [checkout.metadata.bookingId]);
  await recordAnalytics({ eventName: "payment_completed", targetType: "booking", targetId: checkout.metadata.bookingId, metadata: { amountTotal: checkout.amount_total } });
}

async function markBookingTipPaid(checkout: Stripe.Checkout.Session) {
  if (checkout.metadata?.kind !== "booking_tip" || !checkout.metadata.tipId || !checkout.metadata.bookingId) return;
  const paymentIntentId = idOf(checkout.payment_intent);
  if (!paymentIntentId) return;
  const paymentIntent = await getStripe().paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
  const chargeId = idOf(paymentIntent.latest_charge);
  const updated = await database.query<{ id: string; booking_id: string; amount_cents: number; customer_id: string; customer_email: string; service_title: string; risk_status: "clear" | "review" }>(`UPDATE booking_tips tip SET payment_status='paid',stripe_payment_intent_id=$2,stripe_charge_id=$3,paid_at=now(),failure_reason=NULL
      FROM bookings booking JOIN services service ON service.id=booking.service_id JOIN "user" customer ON customer.id=tip.customer_id
      WHERE tip.id::text=$1 AND tip.booking_id=booking.id AND tip.booking_id::text=$4
        AND tip.stripe_checkout_session_id=$5 AND tip.stripe_mode=$6 AND tip.payment_status='pending'
        AND tip.amount_cents=$7
      RETURNING tip.id::text,tip.booking_id::text,tip.amount_cents,tip.customer_id,customer.email AS customer_email,service.title AS service_title,tip.risk_status`,
    [checkout.metadata.tipId, paymentIntentId, chargeId, checkout.metadata.bookingId, checkout.id, getStripeMode(), checkout.amount_total ?? 0]);
  const tip = updated.rows[0];
  if (!tip) return;
  await database.query(`INSERT INTO booking_events (booking_id,event_type,message,metadata)
    VALUES ($1::uuid,'tip_paid','Customer tip payment received through Stripe.',jsonb_build_object('tipId',$2,'amountCents',$3,'checkoutSessionId',$4))`,
    [tip.booking_id, tip.id, tip.amount_cents, checkout.id]);
  await database.query(`INSERT INTO notifications (user_id,booking_id,type,title,message,href,dedupe_key)
    VALUES ($1,$2::uuid,'tip_paid','Tip payment successful',$3,'/account/bookings/' || $2::uuid::text,'tip-paid-' || $4)
    ON CONFLICT (dedupe_key) DO NOTHING`, [tip.customer_id, tip.booking_id, `Your $${(tip.amount_cents / 100).toFixed(2)} tip for ${tip.service_title} was processed through Stripe.`, tip.id]);
  void sendTransactionalEmail({ to: tip.customer_email, userId: tip.customer_id, bookingId: tip.booking_id, emailType: "tip_receipt", idempotencyKey: `tip-receipt-${tip.id}`, subject: "Your BubsBookings tip receipt", heading: "Thank you for your tip", message: `Your $${(tip.amount_cents / 100).toFixed(2)} tip for ${tip.service_title} was processed through Stripe. BubsBookings does not take a marketplace fee from tips.`, actionLabel: "View receipt", actionUrl: `/account/bookings/${tip.booking_id}` });
  if (tip.risk_status === "review") {
    await database.query(`INSERT INTO booking_events (booking_id,event_type,message,metadata)
      VALUES ($1::uuid,'tip_review_required','A high-value customer tip needs an administrator review before provider transfer.',jsonb_build_object('tipId',$2,'amountCents',$3))`, [tip.booking_id, tip.id, tip.amount_cents]);
    return;
  }
  await releaseTipTransfer(tip.id);
}

async function markBookingTipFailed(options: { tipId?: string; checkoutSessionId?: string; paymentIntentId?: string; reason: string }) {
  await database.query(`UPDATE booking_tips SET payment_status='failed',failure_reason=$4
    WHERE stripe_mode=$5 AND payment_status='pending' AND (($1::text<>'' AND id::text=$1)
      OR ($2::text<>'' AND stripe_checkout_session_id=$2) OR ($3::text<>'' AND stripe_payment_intent_id=$3))`,
    [options.tipId ?? "", options.checkoutSessionId ?? "", options.paymentIntentId ?? "", options.reason, getStripeMode()]);
}

async function recordTransferCreated(transfer: Stripe.Transfer) {
  const affiliatePayoutId = transfer.metadata?.affiliatePayoutId;
  if (transfer.metadata?.kind === "affiliate_payout" && affiliatePayoutId) {
    const expected = await database.query<{ amount_cents: number; stripe_account_id: string }>(`SELECT payout.amount_cents, affiliate.stripe_account_id
      FROM affiliate_payouts payout JOIN affiliate_profiles affiliate ON affiliate.id=payout.affiliate_id
      WHERE payout.id::text=$1 AND affiliate.stripe_connect_mode=$2`, [affiliatePayoutId, getStripeMode()]);
    if (!expected.rows[0] || !stripeTransferMatches(transfer, {
      amountCents: expected.rows[0].amount_cents,
      connectedAccountId: expected.rows[0].stripe_account_id,
    })) return;
    await finalizeAffiliatePayoutTransfer(affiliatePayoutId, transfer.id, getStripeMode());
    return;
  }
  if (transfer.metadata?.kind === "booking_tip_payout" && transfer.metadata.tipId) {
    await database.query(`UPDATE booking_tips tip SET stripe_transfer_id=COALESCE(stripe_transfer_id,$2),transfer_status='paid_out',transferred_at=COALESCE(transferred_at,now())
      FROM bookings booking JOIN provider_profiles provider ON provider.id=booking.provider_id
      WHERE tip.id::text=$1 AND tip.booking_id=booking.id AND tip.stripe_mode=$3
        AND tip.amount_cents-tip.refunded_amount_cents=$4 AND provider.stripe_account_id=$5
        AND provider.stripe_connect_mode=$3`, [transfer.metadata.tipId, transfer.id, getStripeMode(), transfer.amount,
      typeof transfer.destination === "string" ? transfer.destination : transfer.destination?.id ?? ""]);
    return;
  }
  const bookingId = transfer.metadata?.bookingId;
  if (!bookingId) return;
  await database.query(`UPDATE bookings SET stripe_transfer_id = COALESCE(stripe_transfer_id, $2),
      payment_release_status = CASE WHEN payment_release_status = 'processing' THEN 'paid_out' ELSE payment_release_status END,
      payout_released_at = CASE WHEN payment_release_status = 'processing' THEN COALESCE(payout_released_at, now()) ELSE payout_released_at END
    FROM provider_profiles provider
    WHERE bookings.id::text = $1 AND bookings.provider_id=provider.id AND bookings.stripe_mode = $3
      AND bookings.provider_payout_cents=$4 AND provider.stripe_account_id=$5 AND provider.stripe_connect_mode=$3`,
    [bookingId, transfer.id, getStripeMode(), transfer.amount,
      typeof transfer.destination === "string" ? transfer.destination : transfer.destination?.id ?? ""]);
}

async function recordTransferReversed(transfer: Stripe.Transfer) {
  const affiliatePayoutId = transfer.metadata?.affiliatePayoutId;
  if (transfer.metadata?.kind === "affiliate_payout" && affiliatePayoutId) {
    await reverseAffiliatePayoutTransfer(affiliatePayoutId, transfer.id, transfer.amount_reversed);
    return;
  }
  if (transfer.metadata?.kind === "booking_tip_payout" && transfer.metadata.tipId) {
    const fullyReversed = transfer.amount_reversed >= transfer.amount;
    await database.query(`UPDATE booking_tips SET transfer_status=CASE WHEN $3 THEN 'reversed' ELSE 'partially_reversed' END,
        transfer_failure_reason=CASE WHEN $3 THEN 'The provider tip transfer was reversed through Stripe.' ELSE 'Part of the provider tip transfer was reversed through Stripe.' END
      WHERE id::text=$1 AND stripe_transfer_id=$2 AND stripe_mode=$4`, [transfer.metadata.tipId, transfer.id, fullyReversed, getStripeMode()]);
    return;
  }
  const bookingId = transfer.metadata?.bookingId;
  if (!bookingId) return;
  const fullyReversed = transfer.amount_reversed >= transfer.amount;
  await database.query(`UPDATE bookings SET
      payment_release_status = CASE WHEN $3 THEN 'reversed' ELSE 'partially_released' END,
      provider_payout_cents = GREATEST(0, $4 - $5),
      payout_failure_reason = CASE WHEN $3 THEN 'The provider transfer was reversed through Stripe.'
        ELSE 'Part of the provider transfer was reversed through Stripe.' END
    WHERE id::text = $1 AND stripe_transfer_id = $2 AND stripe_mode = $6`,
    [bookingId, transfer.id, fullyReversed, transfer.amount, transfer.amount_reversed, getStripeMode()]);
  await database.query(`INSERT INTO booking_events (booking_id, event_type, message, metadata)
    SELECT $1::uuid, 'transfer_reversed', $2, jsonb_build_object('transferId', $3, 'amountReversed', $4::integer)
    WHERE NOT EXISTS (SELECT 1 FROM booking_events WHERE booking_id = $1::uuid AND event_type = 'transfer_reversed'
      AND metadata->>'transferId' = $3 AND (metadata->>'amountReversed')::integer = $4::integer)`,
    [bookingId, fullyReversed ? "The provider transfer was fully reversed." : "The provider transfer was partially reversed.", transfer.id, transfer.amount_reversed]);
}

async function recordPayoutFailed(event: Stripe.Event, payout: Stripe.Payout) {
  const connectedAccountId = typeof event.account === "string" ? event.account : null;
  if (!connectedAccountId) return;
  await database.query(`INSERT INTO notifications (user_id, type, title, message, href, dedupe_key)
    SELECT p.user_id, 'payout_failed', 'Stripe bank payout failed', $3,
      '/provider/dashboard/billing', 'stripe-payout-failed-' || $2
    FROM provider_profiles p WHERE p.stripe_account_id = $1 AND p.stripe_connect_mode = $4
    ON CONFLICT (dedupe_key) DO NOTHING`, [connectedAccountId, payout.id,
      `Stripe could not send payout ${payout.id} to your bank. Update your payout account or contact support.`, getStripeMode()]);
  await database.query(`INSERT INTO notifications (user_id,type,title,message,href,dedupe_key)
    SELECT affiliate.user_id,'payout_failed','Stripe bank payout failed',$3,'/affiliate','stripe-affiliate-payout-failed-'||$2
    FROM affiliate_profiles affiliate WHERE affiliate.stripe_account_id=$1 AND affiliate.stripe_connect_mode=$4
      AND affiliate.user_id IS NOT NULL ON CONFLICT (dedupe_key) DO NOTHING`, [connectedAccountId,payout.id,
    `Stripe could not send payout ${payout.id} to your bank. Open your partner dashboard and update your Stripe payout account.`,getStripeMode()]);
  await database.query(`INSERT INTO operations_checks (check_type, status, details)
    VALUES ('stripe_connected_payout', 'warning', $1::jsonb)`,
    [JSON.stringify({ payoutId: payout.id, accountId: connectedAccountId, failureCode: payout.failure_code, failureMessage: payout.failure_message })]);
}

async function recordTipRefund(charge: Stripe.Charge) {
  const paymentIntentId = idOf(charge.payment_intent);
  if (!paymentIntentId) return;
  const refunded = await database.query<{ id: string; booking_id: string; customer_id: string; provider_id: string; amount_cents: number; refunded_amount_cents: number }>(`UPDATE booking_tips SET
      payment_status=CASE WHEN $3 THEN 'refunded' ELSE 'partially_refunded' END,
      refunded_amount_cents=LEAST(amount_cents,$4),refunded_at=now()
    WHERE stripe_payment_intent_id=$1 AND stripe_mode=$2
    RETURNING id::text,booking_id::text,customer_id,provider_id::text,amount_cents,refunded_amount_cents`, [paymentIntentId, getStripeMode(), charge.refunded, charge.amount_refunded]);
  for (const tip of refunded.rows) {
    await database.query(`INSERT INTO notifications (user_id,booking_id,type,title,message,href,dedupe_key)
      VALUES ($1,$2::uuid,'tip_refunded','Tip refunded',$3,'/account/bookings/' || $2::uuid::text,'tip-refunded-customer-' || $4),
             ((SELECT user_id FROM provider_profiles WHERE id::text=$5),$2::uuid,'tip_refunded','Customer tip refunded',$6,'/provider/dashboard/bookings/' || $2::uuid::text,'tip-refunded-provider-' || $4)
      ON CONFLICT (dedupe_key) DO NOTHING`, [tip.customer_id, tip.booking_id,
      `$${(tip.refunded_amount_cents / 100).toFixed(2)} of your tip was returned to your original payment method.`, tip.id, tip.provider_id,
      `$${(tip.refunded_amount_cents / 100).toFixed(2)} of a customer tip was refunded.`]);
  }
}

async function recordTipDispute(dispute: Stripe.Dispute, closed = false) {
  const chargeId = idOf(dispute.charge);
  if (!chargeId) return;
  const affected = await database.query<{ id: string; booking_id: string; amount_cents: number; stripe_transfer_id: string | null; customer_id: string; provider_user_id: string }>(`UPDATE booking_tips tip SET payment_status=CASE WHEN $3 THEN payment_status ELSE 'disputed' END,
      stripe_dispute_id=$2,stripe_dispute_status=$4,
      transfer_failure_reason=CASE WHEN $3 THEN transfer_failure_reason ELSE 'Stripe chargeback under review.' END
    FROM provider_profiles provider
    WHERE tip.stripe_charge_id=$1 AND tip.stripe_mode=$5 AND provider.id=tip.provider_id
    RETURNING tip.id::text,tip.booking_id::text,tip.amount_cents,tip.stripe_transfer_id,tip.customer_id,provider.user_id AS provider_user_id`, [chargeId, dispute.id, closed, dispute.status, getStripeMode()]);
  if (closed) return;
  for (const tip of affected.rows) {
    await database.query(`INSERT INTO notifications (user_id,booking_id,type,title,message,href,dedupe_key)
      VALUES ($1,$2::uuid,'tip_dispute','Tip payment under review','Stripe opened a review for this tip payment.','/account/bookings/' || $2::uuid::text,'tip-dispute-customer-' || $3),
             ($4,$2::uuid,'tip_dispute','Tip payment under review','Stripe opened a review for a customer tip.','/provider/dashboard/bookings/' || $2::uuid::text,'tip-dispute-provider-' || $3)
      ON CONFLICT (dedupe_key) DO NOTHING`, [tip.customer_id, tip.booking_id, dispute.id, tip.provider_user_id]);
    if (!tip.stripe_transfer_id) continue;
    try {
      const transfer = await getStripe().transfers.retrieve(tip.stripe_transfer_id);
      const reversalAmount = Math.max(0, transfer.amount - transfer.amount_reversed);
      if (!reversalAmount) continue;
      await getStripe().transfers.createReversal(tip.stripe_transfer_id, {
        amount: reversalAmount,
        metadata: { kind: "booking_tip_dispute_reversal", tipId: tip.id, bookingId: tip.booking_id, stripeDisputeId: dispute.id },
      }, { idempotencyKey: `tip-dispute-reversal-${getStripeMode()}-${tip.id}-${dispute.id}` });
      await database.query("UPDATE booking_tips SET transfer_status='reversed',transfer_failure_reason='The provider tip transfer was reversed while Stripe reviews a chargeback.' WHERE id::text=$1", [tip.id]);
    } catch (error) {
      console.error("Tip dispute transfer reversal failed", tip.id, error);
      await database.query("UPDATE booking_tips SET transfer_failure_reason='Stripe opened a dispute; provider-transfer recovery needs administrator review.' WHERE id::text=$1", [tip.id]);
    }
  }
}

async function recordStripeDisputeOpened(dispute: Stripe.Dispute) {
  const chargeId = idOf(dispute.charge);
  if (!chargeId) return;
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const bookingIdResult = await client.query<{ id: string }>(
      "SELECT id::text FROM bookings WHERE stripe_charge_id = $1 AND stripe_mode = $2",
      [chargeId, getStripeMode()],
    );
    const bookingId = bookingIdResult.rows[0]?.id;
    if (!bookingId) {
      await client.query("COMMIT");
      return;
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`booking-payout:${bookingId}`]);
    const bookingResult = await client.query<{
      id: string; customer_id: string; provider_user_id: string; service_title: string;
      stripe_transfer_id: string | null; payment_release_status: string;
    }>(`SELECT b.id::text, b.customer_id, p.user_id AS provider_user_id, s.title AS service_title,
        b.stripe_transfer_id, b.payment_release_status
      FROM bookings b
      JOIN provider_profiles p ON p.id = b.provider_id
      JOIN services s ON s.id = b.service_id
      WHERE b.id::text = $1
      FOR UPDATE OF b`, [bookingId]);
    const booking = bookingResult.rows[0];
    if (!booking) {
      await client.query("COMMIT");
      return;
    }
    const payoutAlreadySent = Boolean(booking.stripe_transfer_id);
    await client.query(`UPDATE bookings SET
        stripe_dispute_id = $2,
        stripe_dispute_status = $3,
        stripe_dispute_reason = $4,
        stripe_dispute_opened_at = COALESCE(stripe_dispute_opened_at, now()),
        stripe_dispute_closed_at = NULL,
        payout_frozen_at = CASE
          WHEN stripe_transfer_id IS NULL AND payment_release_status IN ('secured', 'awaiting_customer', 'processing', 'failed') THEN now()
          ELSE payout_frozen_at END,
        payout_freeze_reason = CASE
          WHEN stripe_transfer_id IS NULL AND payment_release_status IN ('secured', 'awaiting_customer', 'processing', 'failed') THEN 'Stripe chargeback under review'
          ELSE payout_freeze_reason END,
        payment_release_status = CASE
          WHEN stripe_transfer_id IS NULL AND payment_release_status IN ('secured', 'awaiting_customer', 'processing', 'failed') THEN 'frozen'
          ELSE payment_release_status END,
        payout_failure_reason = CASE
          WHEN stripe_transfer_id IS NOT NULL THEN 'A Stripe chargeback was opened after the provider payout. An administrator must review transfer recovery.'
          ELSE payout_failure_reason END
      WHERE id::text = $1`, [booking.id, dispute.id, dispute.status, dispute.reason]);
    await syncAffiliateCommissionForBooking(booking.id, client);
    await client.query(`INSERT INTO booking_events (booking_id, event_type, message, metadata)
      VALUES ($1::uuid, 'stripe_dispute_opened', $2,
      jsonb_build_object('stripeDisputeId', $3, 'reason', $4, 'payoutAlreadySent', $5))`,
      [booking.id, payoutAlreadySent
        ? "A bank chargeback was opened after the provider payout. Administrator review is required."
        : "A bank chargeback was opened. The unreleased provider payout is frozen while Stripe reviews it.",
      dispute.id, dispute.reason, payoutAlreadySent]);
    await client.query(`INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
      VALUES ($1, $3::uuid, 'stripe_dispute', 'Bank chargeback opened', $4,
        '/provider/dashboard/bookings/' || $3::uuid::text, 'stripe-dispute-opened-' || $2 || '-provider'),
      ($5, $3::uuid, 'stripe_dispute', 'Bank chargeback opened', $6,
        '/account/bookings/' || $3::uuid::text, 'stripe-dispute-opened-' || $2 || '-customer')
      ON CONFLICT (dedupe_key) DO NOTHING`, [booking.provider_user_id, dispute.id, booking.id,
      payoutAlreadySent
        ? `A bank chargeback was opened for ${booking.service_title}. BubsBookings will review the completed payout and Stripe case.`
        : `A bank chargeback was opened for ${booking.service_title}. Your unreleased payout is frozen until Stripe reports the outcome.`,
      booking.customer_id, `Your bank opened a chargeback for ${booking.service_title}. Follow the case through your bank or card issuer; BubsBookings will follow Stripe's reported outcome.`]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function recordStripeDisputeClosed(dispute: Stripe.Dispute) {
  const chargeId = idOf(dispute.charge);
  if (!chargeId) return;
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const bookingIdResult = await client.query<{ id: string }>(
      "SELECT id::text FROM bookings WHERE stripe_charge_id = $1 AND stripe_mode = $2",
      [chargeId, getStripeMode()],
    );
    const bookingId = bookingIdResult.rows[0]?.id;
    if (!bookingId) {
      await client.query("COMMIT");
      return;
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`booking-payout:${bookingId}`]);
    const bookingResult = await client.query<{
      id: string; customer_id: string; provider_user_id: string; service_title: string;
      stripe_transfer_id: string | null;
    }>(`SELECT b.id::text, b.customer_id, p.user_id AS provider_user_id, s.title AS service_title,
        b.stripe_transfer_id
      FROM bookings b
      JOIN provider_profiles p ON p.id = b.provider_id
      JOIN services s ON s.id = b.service_id
      WHERE b.id::text = $1
      FOR UPDATE OF b`, [bookingId]);
    const booking = bookingResult.rows[0];
    if (!booking) {
      await client.query("COMMIT");
      return;
    }
    const providerWon = dispute.status === "won" || dispute.status === "warning_closed";
    const customerWon = dispute.status === "lost";
    await client.query(`UPDATE bookings b SET
        stripe_dispute_id = $2,
        stripe_dispute_status = $3,
        stripe_dispute_reason = $4,
        stripe_dispute_closed_at = now(),
        payout_frozen_at = CASE
          WHEN payout_freeze_reason = 'Stripe chargeback under review' AND $5 THEN NULL
          WHEN payout_freeze_reason = 'Stripe chargeback under review' AND $6
            AND refund_status NOT IN ('requested', 'processing')
            AND NOT EXISTS (
              SELECT 1 FROM booking_disputes d
              WHERE d.booking_id = b.id AND d.status IN ('open', 'reviewing')
            ) THEN NULL
          ELSE payout_frozen_at END,
        payout_freeze_reason = CASE
          WHEN payout_freeze_reason = 'Stripe chargeback under review' AND $5 THEN NULL
          WHEN payout_freeze_reason = 'Stripe chargeback under review' AND $6
            AND refund_status IN ('requested', 'processing') THEN 'Refund requested'
          WHEN payout_freeze_reason = 'Stripe chargeback under review' AND $6
            AND EXISTS (
              SELECT 1 FROM booking_disputes d
              WHERE d.booking_id = b.id AND d.status IN ('open', 'reviewing')
            ) THEN 'Open booking dispute'
          WHEN payout_freeze_reason = 'Stripe chargeback under review' AND $6 THEN NULL
          ELSE payout_freeze_reason END,
        payment_release_status = CASE
          WHEN $5 AND stripe_transfer_id IS NULL THEN 'reversed'
          WHEN $6 AND payment_release_status = 'frozen'
            AND payout_freeze_reason = 'Stripe chargeback under review'
            AND refund_status NOT IN ('requested', 'processing')
            AND NOT EXISTS (
              SELECT 1 FROM booking_disputes d
              WHERE d.booking_id = b.id AND d.status IN ('open', 'reviewing')
            ) THEN CASE WHEN b.status = 'completed' THEN 'awaiting_customer' ELSE 'secured' END
          ELSE payment_release_status END,
        payout_failure_reason = CASE
          WHEN $5 AND stripe_transfer_id IS NOT NULL THEN 'The bank upheld a chargeback after the provider payout. An administrator must review transfer recovery.'
          WHEN $6 AND payout_failure_reason LIKE 'A Stripe chargeback was opened%' THEN NULL
          ELSE payout_failure_reason END
      WHERE id::text = $1`, [booking.id, dispute.id, dispute.status, dispute.reason, customerWon, providerWon]);
    await syncAffiliateCommissionForBooking(booking.id, client);
    const outcomeMessage = customerWon
      ? (booking.stripe_transfer_id
        ? "The bank upheld the chargeback after the provider payout. Administrator review of transfer recovery is required."
        : "The bank upheld the chargeback. The held provider payout will not be released.")
      : "The bank closed the chargeback in the platform's favor. Any eligible held payout returned to the normal release process.";
    await client.query(`INSERT INTO booking_events (booking_id, event_type, message, metadata)
      VALUES ($1::uuid, 'stripe_dispute_closed', $2,
      jsonb_build_object('stripeDisputeId', $3, 'status', $4))`,
      [booking.id, outcomeMessage, dispute.id, dispute.status]);
    await client.query(`INSERT INTO notifications (user_id, booking_id, type, title, message, href, dedupe_key)
      VALUES ($1, $3::uuid, 'stripe_dispute', 'Bank chargeback closed', $4,
        '/provider/dashboard/bookings/' || $3::uuid::text, 'stripe-dispute-closed-' || $2 || '-provider'),
      ($5, $3::uuid, 'stripe_dispute', 'Bank chargeback closed', $6,
        '/account/bookings/' || $3::uuid::text, 'stripe-dispute-closed-' || $2 || '-customer')
      ON CONFLICT (dedupe_key) DO NOTHING`, [booking.provider_user_id, dispute.id, booking.id,
      `${outcomeMessage} Service: ${booking.service_title}.`, booking.customer_id,
      customerWon
        ? `Your bank upheld the chargeback for ${booking.service_title}. The card issuer's decision is final in Stripe.`
        : `Your bank chargeback for ${booking.service_title} closed without a customer refund through the dispute process.`]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function processEvent(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const checkout = event.data.object;
      if (checkout.payment_status === "paid") await markBookingPaid(checkout);
      if (checkout.payment_status === "paid") await markBookingTipPaid(checkout);
      if (checkout.metadata?.kind === "provider_subscription") {
        await database.query(`UPDATE provider_profiles SET
          stripe_subscription_checkout_session_id = NULL,
          stripe_subscription_id = COALESCE(stripe_subscription_id, $3),
          stripe_billing_mode = $4
          WHERE id::text = $1 AND stripe_subscription_checkout_session_id = $2`,
        [checkout.metadata.providerId ?? "", checkout.id, idOf(checkout.subscription), getStripeMode()]);
      }
      break;
    }
    case "checkout.session.async_payment_succeeded": {
      await markBookingPaid(event.data.object);
      await markBookingTipPaid(event.data.object);
      break;
    }
    case "checkout.session.async_payment_failed": {
      const checkout = event.data.object;
      if (checkout.metadata?.bookingId) {
        await markBookingPaymentFailed({ bookingId: checkout.metadata.bookingId, checkoutSessionId: checkout.id });
      }
      if (checkout.metadata?.kind === "booking_tip") await markBookingTipFailed({ tipId: checkout.metadata.tipId, checkoutSessionId: checkout.id, reason: "Stripe could not collect this tip." });
      break;
    }
    case "checkout.session.expired": {
      const checkout = event.data.object;
      if (checkout.metadata?.kind === "booking_payment" && checkout.metadata.bookingId) {
        await database.query("UPDATE bookings SET payment_status = 'unpaid' WHERE id::text = $1 AND stripe_checkout_session_id = $2 AND stripe_mode = $3 AND payment_status = 'pending'", [checkout.metadata.bookingId, checkout.id, getStripeMode()]);
      }
      if (checkout.metadata?.kind === "booking_tip") await database.query("UPDATE booking_tips SET payment_status='cancelled',failure_reason='Tip checkout expired.' WHERE id::text=$1 AND stripe_checkout_session_id=$2 AND stripe_mode=$3 AND payment_status='pending'", [checkout.metadata.tipId ?? "", checkout.id, getStripeMode()]);
      if (checkout.metadata?.kind === "provider_subscription") {
        await database.query(`UPDATE provider_profiles SET stripe_subscription_checkout_session_id = NULL
          WHERE id::text = $1 AND stripe_subscription_checkout_session_id = $2`, [checkout.metadata.providerId ?? "", checkout.id]);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
      await updateSubscription(event.data.object, event.created);
      break;
    case "customer.subscription.trial_will_end":
      await notifyTrialWillEnd(event.data.object);
      break;
    case "invoice.paid":
      await syncSubscriptionInvoice(event.data.object, false);
      break;
    case "invoice.payment_failed":
      await syncSubscriptionInvoice(event.data.object, true);
      break;
    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        const provider = await client.query<{ id: string; plan: string }>(`UPDATE provider_profiles SET plan = CASE WHEN EXISTS (
            SELECT 1 FROM complimentary_pro_grants complimentary
            WHERE complimentary.provider_id = provider_profiles.id AND complimentary.revoked_at IS NULL
              AND complimentary.starts_at <= now() AND (complimentary.expires_at IS NULL OR complimentary.expires_at > now())
          ) THEN 'pro' ELSE 'starter' END, stripe_subscription_id = NULL,
          stripe_subscription_checkout_session_id = NULL, stripe_subscription_status = $2,
          stripe_current_period_end = NULL, stripe_cancel_at_period_end = false,
          stripe_subscription_event_created_at = $4,
          extra_team_seats = 0, stripe_team_seat_item_id = NULL
          WHERE stripe_subscription_id = $1 AND stripe_billing_mode = $3 AND plan <> 'owner'
            AND (stripe_subscription_event_created_at IS NULL OR $4 >= stripe_subscription_event_created_at)
          RETURNING id::text, plan`, [subscription.id, subscription.status, getStripeMode(), event.created]);
        if (provider.rows[0] && provider.rows[0].plan !== "pro") {
          await client.query("UPDATE provider_team_members SET status = 'inactive' WHERE provider_id::text = $1 AND status IN ('pending', 'active')", [provider.rows[0].id]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      break;
    }
    case "account.updated": {
      const account = event.data.object;
      if (event.account && event.account !== account.id) break;
      const provider = await database.query<{ id: string }>("UPDATE provider_profiles SET stripe_charges_enabled = $2, stripe_payouts_enabled = $3 WHERE stripe_account_id = $1 AND stripe_connect_mode = $4 RETURNING id::text", [account.id, account.charges_enabled, account.payouts_enabled, getStripeMode()]);
      if (provider.rows[0]) await runAutomatedProviderVerification(provider.rows[0].id);
      const requirements = account.requirements?.currently_due ?? [];
      const affiliateReady = Boolean(account.details_submitted && account.payouts_enabled && account.capabilities?.transfers === "active" && requirements.length === 0);
      await database.query(`UPDATE affiliate_profiles SET stripe_details_submitted=$2,stripe_payouts_enabled=$3,
        stripe_requirements_due=$4,payment_status=$5 WHERE stripe_account_id=$1 AND stripe_connect_mode=$6`,
      [account.id,account.details_submitted,account.payouts_enabled,requirements,affiliateReady?"ready":"not_ready",getStripeMode()]);
      break;
    }
    case "identity.verification_session.processing":
    case "identity.verification_session.requires_input":
    case "identity.verification_session.verified":
    case "identity.verification_session.canceled":
    case "identity.verification_session.redacted": {
      await syncProviderAgeVerificationFromStripe(event.data.object.id);
      break;
    }
    case "charge.refunded": {
      const charge = event.data.object;
      const paymentIntentId = idOf(charge.payment_intent);
      const paymentIntent = paymentIntentId
        ? await getStripe().paymentIntents.retrieve(paymentIntentId)
        : null;
      const bookingId = paymentIntent?.metadata.kind === "booking_payment"
        ? paymentIntent.metadata.bookingId ?? ""
        : "";
      const refunded = await recordBookingChargeRefund({ paymentIntentId, mode: getStripeMode(), fullyRefunded: charge.refunded,
        amountRefunded: charge.amount_refunded, bookingId, chargeAmount: charge.amount });
      for (const booking of refunded.rows) await syncAffiliateCommissionForBooking(booking.id);
      await recordTipRefund(charge);
      break;
    }
    case "charge.dispute.created": {
      await recordStripeDisputeOpened(event.data.object);
      await recordTipDispute(event.data.object);
      break;
    }
    case "charge.dispute.closed": {
      await recordStripeDisputeClosed(event.data.object);
      await recordTipDispute(event.data.object, true);
      break;
    }
    case "transfer.created": {
      await recordTransferCreated(event.data.object);
      break;
    }
    case "transfer.reversed": {
      await recordTransferReversed(event.data.object);
      break;
    }
    case "payout.failed": {
      await recordPayoutFailed(event, event.data.object);
      break;
    }
    case "payment_intent.payment_failed": {
      const paymentIntent = event.data.object;
      await markBookingPaymentFailed({
        bookingId: paymentIntent.metadata.bookingId,
        paymentIntentId: paymentIntent.id,
      });
      if (paymentIntent.metadata.kind === "booking_tip") await markBookingTipFailed({ tipId: paymentIntent.metadata.tipId, paymentIntentId: paymentIntent.id, reason: "Stripe could not collect this tip." });
      break;
    }
  }
}

export async function POST(request: Request) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = request.headers.get("stripe-signature");
  if (!webhookSecret || !signature) return NextResponse.json({ error: "Stripe webhook is not configured." }, { status: 400 });
  let event: Stripe.Event;
  try {
    event = parseVerifiedStripeEvent(getStripe(), await request.text(), signature, webhookSecret);
  } catch (error) {
    console.error("Stripe webhook signature failed", error);
    return NextResponse.json({ error: "Invalid Stripe signature." }, { status: 400 });
  }
  if (!stripeEventMatchesMode(event, getStripeMode())) {
    return NextResponse.json({ error: "Stripe event mode did not match this environment." }, { status: 400 });
  }

  const claimed = await database.query(`INSERT INTO stripe_webhook_events (id, event_type)
    VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET created_at=now()
    WHERE stripe_webhook_events.status='processing'
      AND stripe_webhook_events.created_at < now() - interval '5 minutes'
    RETURNING id`, [event.id, event.type]);
  if (!claimed.rowCount) return NextResponse.json({ received: true, duplicate: true });
  try {
    await processEvent(event);
    await database.query("UPDATE stripe_webhook_events SET status = 'processed', processed_at = now() WHERE id = $1", [event.id]);
    return NextResponse.json({ received: true });
  } catch (error) {
    await database.query("DELETE FROM stripe_webhook_events WHERE id = $1", [event.id]);
    console.error("Stripe webhook processing failed", event.type, error);
    return NextResponse.json({ error: "Webhook processing failed." }, { status: 500 });
  }
}
