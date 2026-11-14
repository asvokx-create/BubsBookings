import "server-only";

import type Stripe from "stripe";
import { isAtLeastEighteen } from "./age-eligibility";
import { database } from "./database";
import { getStripe, getStripeMode, getStripeIdentityResults } from "./stripe";
import { markAffiliateListingPublished } from "./affiliates";
import { recordAnalytics } from "./analytics";
import { sendTransactionalEmail } from "./email";
import { identityResultsError } from "./stripe-identity-config";

export type ProviderAgeVerificationStatus = "not_started" | "pending" | "requires_input" | "verified" | "failed";

type StoredProvider = {
  id: string;
  stripe_identity_verification_session_id: string | null;
  stripe_identity_verification_mode: "test" | "live" | null;
  age_verification_status: ProviderAgeVerificationStatus;
  age_verification_source: "stripe_identity" | "admin_exception" | null;
};

export function ageVerificationStatusForStripeSession(session: Stripe.Identity.VerificationSession): ProviderAgeVerificationStatus {
  if (session.status === "verified") return "verified";
  if (session.status === "processing") return "pending";
  if (session.status === "requires_input") return "requires_input";
  return "failed";
}

function dobFromVerifiedSession(session: Stripe.Identity.VerificationSession) {
  const dob = session.verified_outputs?.dob;
  if (!dob || typeof dob.year !== "number" || typeof dob.month !== "number" || typeof dob.day !== "number"
      || !Number.isInteger(dob.year) || !Number.isInteger(dob.month) || !Number.isInteger(dob.day)) return null;
  const date = new Date(Date.UTC(dob.year, dob.month - 1, dob.day));
  if (date.getUTCFullYear() !== dob.year || date.getUTCMonth() + 1 !== dob.month
      || date.getUTCDate() !== dob.day || date.getTime() > Date.now()) return null;
  return `${String(dob.year).padStart(4, "0")}-${String(dob.month).padStart(2, "0")}-${String(dob.day).padStart(2, "0")}`;
}

async function setProviderAgeVerification(providerId: string, status: ProviderAgeVerificationStatus, failureCode: string | null = null) {
  const client = await database.connect();
  let firstListing: { id: string; category: string; delivery_type: string; city: string; state: string } | undefined;
  let providerUserId: string | undefined;
  let delivery: { email: string; sessionId: string; status: ProviderAgeVerificationStatus } | undefined;
  try {
    await client.query("BEGIN");
    const current = await client.query<{ user_id: string; email: string; age_verification_status: ProviderAgeVerificationStatus; stripe_identity_verification_session_id: string | null }>(`SELECT provider.user_id, account.email,
        provider.age_verification_status, provider.stripe_identity_verification_session_id
      FROM provider_profiles provider
      JOIN "user" account ON account.id=provider.user_id
      WHERE provider.id::text=$1
      FOR UPDATE OF provider`, [providerId]);
    const prior = current.rows[0];
    if (!prior) throw new Error("PROVIDER_NOT_FOUND");
    providerUserId = prior.user_id;
    if (status === "verified") {
      const provider = await client.query<{ user_id: string }>(`UPDATE provider_profiles
        SET age_verification_status='verified', age_identity_verified_at=now(), age_verification_failure_code=NULL,
          age_verification_source='stripe_identity', updated_at=now()
        WHERE id::text=$1 RETURNING user_id`, [providerId]);
      // Only activate listings that this gate previously held back. Manually
      // deactivated listings remain inactive.
      const published = await client.query<{ id: string; category: string; delivery_type: string; city: string; state: string }>(`UPDATE services SET is_active=true, age_verification_blocked=false, updated_at=now()
        WHERE provider_id::text=$1 AND age_verification_blocked=true
        RETURNING id::text,category,delivery_type,city,state`, [providerId]);
      await markAffiliateListingPublished(providerId, client);
      firstListing = published.rows[0];
      providerUserId = provider.rows[0]?.user_id;
    } else {
      await client.query(`UPDATE provider_profiles
        SET age_verification_status=$2, age_identity_verified_at=NULL, age_verification_failure_code=$3,
          age_verification_source=NULL, updated_at=now()
        WHERE id::text=$1`, [providerId, status, failureCode]);
      // Preserve listings that were already inactive for a reason unrelated to
      // age verification. Only public listings and listings already held by
      // this gate are eligible for automatic restoration after verification.
      await client.query(`UPDATE services SET is_active=false, age_verification_blocked=true, updated_at=now()
        WHERE provider_id::text=$1 AND provider_deleted_at IS NULL
          AND (is_active=true OR age_verification_blocked=true)`, [providerId]);
    }
    if (prior.age_verification_status !== status && prior.stripe_identity_verification_session_id) {
      const notification = status === "verified"
        ? { title: "Age verification complete", message: "Your age requirement is complete. Listings held only by age verification are now eligible to be public." }
        : status === "pending"
          ? { title: "Age verification under review", message: "Stripe is reviewing your verification. We will update your status when the review finishes." }
          : status === "requires_input"
            ? { title: "Age verification needs attention", message: "Stripe needs more information. Continue age verification from your provider dashboard." }
            : { title: "Age verification was not completed", message: "Your age verification could not be completed. Open your provider dashboard to try again." };
      await client.query(`INSERT INTO notifications (user_id, type, title, message, href, dedupe_key)
        VALUES ($1, 'provider_age_verification', $2, $3, '/provider/dashboard/billing', $4)
        ON CONFLICT (dedupe_key) DO NOTHING`, [prior.user_id, notification.title, notification.message,
        `provider-age-${prior.stripe_identity_verification_session_id}-${status}`]);
      delivery = { email: prior.email, sessionId: prior.stripe_identity_verification_session_id, status };
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  if (delivery && (delivery.status === "verified" || delivery.status === "requires_input" || delivery.status === "failed")) {
    const content = delivery.status === "verified"
      ? { subject: "Your BubsBookings age verification is complete", heading: "Age verification complete", message: "Your age requirement is complete. Listings held only by age verification are now eligible to be public. Open your dashboard to review any remaining listing requirements.", action: "Review provider dashboard" }
      : delivery.status === "requires_input"
        ? { subject: "Your BubsBookings age verification needs attention", heading: "Continue age verification", message: "Stripe needs more information to complete your age verification. Open your provider dashboard to continue securely.", action: "Continue verification" }
        : { subject: "Your BubsBookings age verification was not completed", heading: "Try age verification again", message: "Your age verification could not be completed. Open your provider dashboard to review the status and start another attempt.", action: "Review verification" };
    await sendTransactionalEmail({
      to: delivery.email,
      userId: providerUserId,
      emailType: `provider_age_${delivery.sessionId}_${delivery.status}`,
      idempotencyKey: `provider-age-${delivery.sessionId}-${delivery.status}`,
      subject: content.subject,
      heading: content.heading,
      message: content.message,
      actionLabel: content.action,
      actionUrl: "/provider/dashboard/billing",
    });
  }

  if (firstListing && providerUserId) {
    await recordAnalytics({ eventName: "first_listing_published", userId: providerUserId,
      targetType: "service", targetId: firstListing.id,
      metadata: { category: firstListing.category, deliveryType: firstListing.delivery_type,
        ...(firstListing.delivery_type === "REMOTE" ? {} : { city: firstListing.city, state: firstListing.state }) } }).catch((error) => {
      console.error("Provider verification analytics could not be recorded", { providerId, error });
    });
  }
}

function sessionBelongsToProvider(session: Stripe.Identity.VerificationSession, providerId: string, mode: "test" | "live") {
  return session.client_reference_id === providerId
    && session.metadata.providerId === providerId
    && session.metadata.purpose === "provider_age_eligibility"
    && session.livemode === (mode === "live");
}

export async function resetMismatchedStripeAgeVerification(providerId: string, storedMode: "test" | "live" | null) {
  const mode = getStripeMode();
  if (!storedMode || storedMode === mode) return false;
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const reset = await client.query(`UPDATE provider_profiles
      SET age_verification_status='not_started', age_identity_verified_at=NULL,
          age_verification_failure_code='stripe_mode_changed', age_verification_source=NULL, updated_at=now()
      WHERE id::text=$1 AND age_verification_source='stripe_identity'
        AND stripe_identity_verification_mode IS DISTINCT FROM $2`, [providerId, mode]);
    if (reset.rowCount) {
      await client.query(`UPDATE services SET is_active=false, age_verification_blocked=true, updated_at=now()
        WHERE provider_id::text=$1 AND provider_deleted_at IS NULL
          AND (is_active=true OR age_verification_blocked=true)`, [providerId]);
    }
    await client.query("COMMIT");
    return Boolean(reset.rowCount);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Reconciles one Stripe Identity session. Its verified DOB is used in memory
 * only to establish the 18+ result; it is never persisted or logged.
 */
export async function syncProviderAgeVerificationFromStripe(sessionId: string) {
  const mode = getStripeMode();
  const providerResult = await database.query<StoredProvider>(`SELECT id::text, stripe_identity_verification_session_id,
      stripe_identity_verification_mode, age_verification_status, age_verification_source
    FROM provider_profiles
    WHERE stripe_identity_verification_session_id=$1 AND stripe_identity_verification_mode=$2`, [sessionId, mode]);
  const provider = providerResult.rows[0];
  if (!provider) return null;
  // Historical exceptions remain readable so existing records are not changed
  // by reconciliation. New exceptions cannot be created by the admin API.
  if (provider.age_verification_source === "admin_exception") return "verified" as const;

  let session = await getStripe().identity.verificationSessions.retrieve(sessionId);
  if (!sessionBelongsToProvider(session, provider.id, mode)) {
    console.error("Stripe Identity session ownership did not match the provider", { providerId: provider.id, sessionId });
    return null;
  }

  if (session.status === "verified") {
    // DOB is a separately gated field. Expanding verified_outputs alone omits it.
    // Sanitize errors so SDK request/response details cannot reach logs or users.
    try {
      session = await getStripeIdentityResults().identity.verificationSessions.retrieve(sessionId, {
        expand: ["verified_outputs.dob"],
      });
    } catch {
      throw identityResultsError();
    }
    if (!sessionBelongsToProvider(session, provider.id, mode) || session.status !== "verified") {
      throw identityResultsError();
    }
    const dob = dobFromVerifiedSession(session);
    // An integration/access failure is not proof of ineligibility. Keep the gate
    // closed, preserve the session for reconciliation, and do not demand another ID.
    if (!dob) throw identityResultsError();
    if (dob && isAtLeastEighteen(dob)) {
      await setProviderAgeVerification(provider.id, "verified");
      return "verified" as const;
    }
    // A verified, usable DOB is required before deciding age eligibility.
    await setProviderAgeVerification(provider.id, "failed", "underage");
    return "failed" as const;
  }

  const status = ageVerificationStatusForStripeSession(session);
  await setProviderAgeVerification(provider.id, status, session.last_error?.code ?? null);
  return status;
}

export async function startProviderAgeVerification(input: { providerId: string; origin: string }) {
  const mode = getStripeMode();
  const providerResult = await database.query<StoredProvider>(`SELECT id::text, stripe_identity_verification_session_id,
      stripe_identity_verification_mode, age_verification_status, age_verification_source
    FROM provider_profiles WHERE id::text=$1`, [input.providerId]);
  const provider = providerResult.rows[0];
  if (!provider) throw new Error("PROVIDER_NOT_FOUND");
  if (provider.age_verification_status === "verified"
      && (provider.age_verification_source === "admin_exception" || provider.stripe_identity_verification_mode === mode)) {
    return { status: "verified" as const, url: null };
  }

  // Reject absent/wrong-mode key configuration before requesting a new document.
  // Actual read permissions require a synthetic verification test before rollout.
  try { getStripeIdentityResults(); } catch { throw identityResultsError(); }
  if (provider.stripe_identity_verification_session_id && provider.stripe_identity_verification_mode === mode) {
    const session = await getStripe().identity.verificationSessions.retrieve(provider.stripe_identity_verification_session_id);
    if (sessionBelongsToProvider(session, provider.id, mode)) {
      const status = await syncProviderAgeVerificationFromStripe(session.id);
      if (status === "verified") return { status, url: null };
      if (session.status === "requires_input" && session.url) return { status: "requires_input" as const, url: session.url };
      if (session.status === "processing") return { status: "pending" as const, url: null };
    }
  }

  const session = await getStripe().identity.verificationSessions.create({
    type: "document",
    client_reference_id: provider.id,
    return_url: `${input.origin}/provider/dashboard/billing?stripe=age-verification-return`,
    metadata: { providerId: provider.id, purpose: "provider_age_eligibility" },
    options: { document: { allowed_types: ["driving_license", "id_card", "passport"] } },
  // A retried, expired session needs a fresh Stripe URL. The previous session
  // ID makes that retry idempotent while concurrent first attempts share the
  // same initial key.
  }, { idempotencyKey: `provider-age-verification-${mode}-${provider.id}-${provider.stripe_identity_verification_session_id ?? "initial"}` });
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE provider_profiles
      SET stripe_identity_verification_session_id=$2, stripe_identity_verification_mode=$3,
          age_verification_status='requires_input', age_identity_verified_at=NULL, age_verification_failure_code=NULL,
          age_verification_source=NULL, updated_at=now()
      WHERE id::text=$1`, [provider.id, session.id, mode]);
    await client.query(`UPDATE services SET is_active=false, age_verification_blocked=true, updated_at=now()
      WHERE provider_id::text=$1 AND provider_deleted_at IS NULL
        AND (is_active=true OR age_verification_blocked=true)`, [provider.id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { status: "requires_input" as const, url: session.url };
}
