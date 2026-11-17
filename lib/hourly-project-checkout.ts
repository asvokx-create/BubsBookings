import "server-only";
import { database } from "@/lib/database";
import { getStripe, getStripeMode } from "@/lib/stripe";
import { getOrCreateConsumerStripeCustomer } from "@/lib/customer-stripe";
import { calculateBookingFinancialSnapshot, type BookingFinancialPlan } from "@/lib/booking-financials";
import { BOOKING_CHECKOUT_VERSION } from "@/lib/booking-fees";
import { reconcileExpiredComplimentaryProGrants } from "@/lib/complimentary-pro";
import { hourlyCheckoutDecision } from "@/lib/hourly-checkout-policy";

export class HourlyPaymentError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
type Project = { provider_user_id: string; id: string; provider_id: string; customer_id: string; service_id: string; title: string; status: string; version: number; submitted_minutes: number; submitted_subtotal_cents: number; hourly_rate_cents: number; payment_booking_id: string | null; delivery_method: string; service_address: string; plan: BookingFinancialPlan; stripe_account_id: string | null; stripe_connect_mode: string | null; age_verification_status: string; is_active: boolean };
type Attempt = { id: string; stripe_mode: string; stripe_customer_id: string; origin: string; checkout_session_id: string | null; created_at: Date };
type Booking = { id: string; payment_status: string; stripe_mode: string; price_cents: number; customer_total_cents: number; customer_service_fee_cents: number; provider_plan_snapshot: string; provider_fee_basis_points: number };

// Approval and the attempt identity are durable BEFORE contacting Stripe. A crash
// cannot silently create a second invoice or a new idempotency key on retry.
export async function checkoutHourlyProject(input: { projectId: string; version: number; user: { id: string; email: string; name: string }; origin: string }) {
  const ownership = await database.query<{ provider_id: string }>("SELECT provider_id::text FROM hourly_projects WHERE id::text=$1 AND customer_id=$2", [input.projectId, input.user.id]);
  if (!ownership.rows[0]) throw new HourlyPaymentError("Project not found.", 404);
  await reconcileExpiredComplimentaryProGrants(ownership.rows[0].provider_id);
  const mode = getStripeMode();
  const stripe = getStripe();
  const customerId = await getOrCreateConsumerStripeCustomer({ userId: input.user.id, email: input.user.email, name: input.user.name });
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('hourly-provider:' || $1))", [ownership.rows[0].provider_id]);
    const selected = await client.query<Project>(`SELECT h.*, p.user_id AS provider_user_id, CASE
      WHEN p.plan IN ('owner','business') THEN p.plan
      WHEN EXISTS (SELECT 1 FROM complimentary_pro_grants g WHERE g.provider_id=p.id AND g.revoked_at IS NULL AND g.starts_at<=now() AND (g.expires_at IS NULL OR g.expires_at>now())) THEN 'pro'
      WHEN p.stripe_subscription_id IS NOT NULL AND p.stripe_billing_mode=$3 AND p.stripe_subscription_status IN ('active','trialing','past_due') THEN 'pro'
      ELSE 'starter' END AS plan, p.stripe_account_id, p.stripe_connect_mode, p.age_verification_status, p.is_active
      FROM hourly_projects h JOIN provider_profiles p ON p.id=h.provider_id
      WHERE h.id::text=$1 AND h.customer_id=$2 FOR UPDATE OF h`, [input.projectId, input.user.id, mode]);
    const project = selected.rows[0];
    if (!project) throw new HourlyPaymentError("Project not found.", 404);
    const restricted = await client.query("SELECT 1 FROM account_restrictions WHERE user_id=ANY($1::text[]) AND status IN ('suspended','banned') AND (expires_at IS NULL OR expires_at>now()) LIMIT 1", [[input.user.id,project.provider_user_id]]);
    if (restricted.rowCount) throw new HourlyPaymentError("An account on this project is restricted.", 403);
    if (project.version !== input.version || !["submitted", "approved"].includes(project.status)) throw new HourlyPaymentError("The timesheet changed. Refresh and review it before approving.");
    if (!Number.isSafeInteger(project.submitted_minutes) || project.submitted_minutes < 1 || !Number.isSafeInteger(project.submitted_subtotal_cents) || project.submitted_subtotal_cents < 0) throw new HourlyPaymentError("The submitted total is too low for online payment.");
    if (!project.is_active || project.age_verification_status !== "verified" || !project.stripe_account_id || project.stripe_connect_mode !== mode) throw new HourlyPaymentError("The provider must finish payout verification before payment.");
    const account = await stripe.accounts.retrieve(project.stripe_account_id);
    if (!account.charges_enabled || !account.payouts_enabled) throw new HourlyPaymentError("The provider must finish payout verification before payment.");
    if (!project.payment_booking_id) {
      if (project.status !== "submitted") throw new HourlyPaymentError("This project needs payment support review.");
      const financial = calculateBookingFinancialSnapshot(project.submitted_subtotal_cents, project.plan);
      const created = await client.query<{ id: string }>(`INSERT INTO bookings
        (customer_id,provider_id,service_id,starts_at,ends_at,status,completed_at,service_address,notes,price_cents,
        delivery_method,base_price_cents,pricing_type_snapshot,billable_duration_minutes,provider_plan_snapshot,
        provider_fee_basis_points,provider_fee_cap_cents,platform_fee_cents,provider_payout_cents,customer_service_fee_cents,
        customer_total_cents,payment_flow,payment_release_status,stripe_mode)
        VALUES ($1,$2,$3,now()-($4::integer * interval '1 minute'),now(),'completed',now(),$5,$6,$7,$8,$7,'FIXED',$4,$9,$10,$11,$12,$13,$14,$15,'held_transfer_v1','awaiting_payment',$16)
        RETURNING id::text`, [project.customer_id,project.provider_id,project.service_id,project.submitted_minutes,
        project.service_address,`Final approved timesheet: ${project.title}`,project.submitted_subtotal_cents,project.delivery_method,
        financial.providerPlan,financial.providerFeeBasisPoints,financial.providerFeeCapCents,financial.providerFeeCents,
        financial.providerNetCents,financial.customerServiceFeeCents,financial.customerTotalCents,mode]);
      project.payment_booking_id = created.rows[0].id;
      await client.query("UPDATE hourly_projects SET status='approved',approved_at=now(),updated_at=now(),payment_booking_id=$2 WHERE id=$1", [project.id,project.payment_booking_id]);
      await client.query(`INSERT INTO booking_events (booking_id,actor_user_id,event_type,message,metadata)
        VALUES ($1,$2,'timesheet_approved','Customer approved the final hourly project timesheet.',$3::jsonb)`,
        [project.payment_booking_id,input.user.id,JSON.stringify({projectId:project.id,version:project.version,minutes:project.submitted_minutes,subtotalCents:project.submitted_subtotal_cents})]);
    }
    const booking = (await client.query<Booking>("SELECT * FROM bookings WHERE id=$1 FOR UPDATE", [project.payment_booking_id])).rows[0];
    if (booking.stripe_mode !== mode) throw new HourlyPaymentError("This payment belongs to a different Stripe environment. Contact support.");
    if (!["unpaid", "pending", "failed"].includes(booking.payment_status)) throw new HourlyPaymentError("This project has already been paid or refunded.");
    let attempt: Attempt | undefined = (await client.query<Attempt>("SELECT * FROM hourly_project_checkout_attempts WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [project.id])).rows[0];
    if (attempt && attempt.stripe_mode !== mode) throw new HourlyPaymentError("This payment belongs to a different Stripe environment. Contact support.");
    if (attempt?.checkout_session_id) {
      const existing = await stripe.checkout.sessions.retrieve(attempt.checkout_session_id);
      let decision = hourlyCheckoutDecision(existing);
      // A completed delayed-method checkout is never replaced while its intent
      // can still succeed. A signed failure plus a confirmed cancellation makes
      // a fresh attempt safe; network uncertainty leaves the old attempt intact.
      if (decision === "blocked" && existing.status === "complete" && existing.payment_status === "unpaid" && booking.payment_status === "failed") {
        const intentId = typeof existing.payment_intent === "string" ? existing.payment_intent : existing.payment_intent?.id;
        if (intentId) {
          let intent = await stripe.paymentIntents.retrieve(intentId);
          if (intent.status === "requires_payment_method") intent = await stripe.paymentIntents.cancel(intentId, {}, { idempotencyKey: `hourly-failed-intent-${mode}-${intentId}` });
          if (intent.status === "canceled") decision = "replace";
        }
      }
      if (decision === "reuse") {
        await client.query("COMMIT");
        return { url: existing.url, bookingId: booking.id };
      }
      if (decision !== "replace") throw new HourlyPaymentError("Payment is processing or already completed. Refresh shortly; do not pay again.");
      attempt = undefined;
    }
    if (!attempt) {
      attempt = (await client.query<Attempt>(`INSERT INTO hourly_project_checkout_attempts (project_id,stripe_mode,stripe_customer_id,origin)
        VALUES ($1,$2,$3,$4) RETURNING *`, [project.id,mode,customerId,input.origin])).rows[0];
    }
    await client.query("COMMIT");
    // Serialize concurrent retries, but retain the committed attempt if Stripe or
    // the DB fails. Never let Stripe's 24-hour idempotency retention cause a charge.
    await client.query("BEGIN");
    await client.query("SELECT id FROM bookings WHERE id=$1 FOR UPDATE", [booking.id]);
    attempt = (await client.query<Attempt>("SELECT * FROM hourly_project_checkout_attempts WHERE id=$1", [attempt.id])).rows[0];
    if (attempt.checkout_session_id) {
      const existing = await stripe.checkout.sessions.retrieve(attempt.checkout_session_id);
      if (hourlyCheckoutDecision(existing) !== "reuse") throw new HourlyPaymentError("Payment is processing or checkout expired. Refresh before trying again.");
      await client.query("COMMIT");
      return { url: existing.url, bookingId: booking.id };
    }
    if (Date.now() - new Date(attempt.created_at).getTime() >= 23 * 60 * 60 * 1000) throw new HourlyPaymentError("Payment status needs support review before another attempt can be made.");
    const metadata = { kind: "booking_payment", bookingId: booking.id, hourlyProjectId: project.id, timesheetVersion: String(project.version), paymentFlow: "held_transfer_v1", checkoutVersion: BOOKING_CHECKOUT_VERSION, customerServiceFeeCents: String(booking.customer_service_fee_cents), providerPlan: booking.provider_plan_snapshot, providerFeeBasisPoints: String(booking.provider_fee_basis_points) };
    const checkout = await stripe.checkout.sessions.create({
      mode: "payment", customer: attempt.stripe_customer_id, integration_identifier: "hourly_projects_qxmbtznr",
      line_items: [
        { quantity: 1, price_data: { currency: "usd", unit_amount: booking.price_cents, product_data: { name: project.title, description: `Final approved timesheet: ${project.submitted_minutes} minutes at $${(project.hourly_rate_cents/100).toFixed(2)}/hour.` } } },
        { quantity: 1, price_data: { currency: "usd", unit_amount: booking.customer_service_fee_cents, product_data: { name: "BubsBookings service fee", description: "One service fee for this project" } } },
      ],
      payment_intent_data: { transfer_group: `booking_${booking.id}`, metadata }, metadata,
      success_url: `${attempt.origin}/account/projects/${project.id}?payment=success`,
      cancel_url: `${attempt.origin}/account/projects/${project.id}?payment=cancelled`,
    }, { idempotencyKey: `hourly-project-checkout-${mode}-${attempt.id}` });
    await client.query("UPDATE hourly_project_checkout_attempts SET checkout_session_id=$2 WHERE id=$1", [attempt.id,checkout.id]);
    await client.query(`UPDATE bookings SET stripe_checkout_session_id=$2,payment_status='pending',processing_fee_status='pending'
      WHERE id=$1 AND payment_status IN ('unpaid','pending','failed')`, [booking.id,checkout.id]);
    await client.query("COMMIT");
    return { url: checkout.url, bookingId: booking.id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
