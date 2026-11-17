import { requestListingActiveEmail } from "@/lib/listing-active-email";
import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/admin";
import { database } from "@/lib/database";
import { enforceRateLimit } from "@/lib/request-security";
import { sendAccountWelcome } from "@/lib/welcome-message";
import { getComplimentaryProHistory, getComplimentaryProStatus, reconcileExpiredComplimentaryProGrants } from "@/lib/complimentary-pro";
import { retryProviderWelcomeEmail } from "@/lib/provider-welcome-email";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  if (!await enforceRateLimit({ request, userId: session.user.id, bucket: "admin-account-details", limit: 120 })) {
    return NextResponse.json({ error: "Too many account lookups. Please wait a minute." }, { status: 429 });
  }

  const { userId } = await params;
  if (!userId || userId.length > 200) return NextResponse.json({ error: "Invalid account." }, { status: 400 });

  try {
    const accountResult = await database.query(
      `SELECT u.id, u.name, u.email, u."emailVerified" AS email_verified, u.image, u.phone,
              u.role, u."twoFactorEnabled" AS two_factor_enabled, u.terms_accepted_at,
              u.privacy_acknowledged_at, u.ai_safety_acknowledged_at, u.policy_version,
              u.location_city, u.location_state, u.location_postal_code, u.location_country,
              u.location_source, u.location_updated_at,
              u."createdAt" AS created_at, u."updatedAt" AS updated_at,
              ar.status AS restriction_status, ar.reason AS restriction_reason,
              ar.expires_at AS restriction_expires_at, ar.created_at AS restriction_created_at
       FROM "user" u
       LEFT JOIN account_restrictions ar ON ar.user_id = u.id
         AND (ar.expires_at IS NULL OR ar.expires_at > now())
       WHERE u.id = $1`,
      [userId],
    );
    if (!accountResult.rowCount) return NextResponse.json({ error: "Account not found." }, { status: 404 });

    const providerResult = await database.query(
      `SELECT id::text, business_name, bio, phone, city, state, service_radius_miles,
              plan, is_active, is_verified, phone_verified, identity_verified,
              business_verified, screening_status, screening_score, screening_summary,
              screening_checked_at, stripe_subscription_status,
              (stripe_subscription_checkout_session_id IS NOT NULL) AS stripe_subscription_checkout_pending,
              stripe_charges_enabled,
              stripe_payouts_enabled, stripe_current_period_end,
              age_verification_status, age_verification_source, age_verification_exception_eligible,
              age_verification_exception_note, age_verification_exception_granted_at,
              age_identity_verified_at, age_verification_failure_code, stripe_identity_verification_mode,
              extra_team_seats,
              (SELECT count(DISTINCT lower(member.email))::int FROM provider_team_members member
               WHERE member.provider_id = provider_profiles.id AND member.status IN ('pending', 'active')) AS reserved_worker_count,
              (stripe_account_id IS NOT NULL) AS stripe_connected,
              provider_agreement_accepted_at, provider_agreement_version,
              pro_trial_used_at_test, pro_trial_used_at_live, public_profile_slug, public_profile_visible,
              years_experience, experience_summary, specialties, languages, provider_highlights, created_at, updated_at,
              EXISTS (
                SELECT 1
                FROM services service
                JOIN provider_companies company ON company.id = service.company_id AND company.is_active = true
                WHERE service.provider_id = provider_profiles.id
                  AND service.provider_deleted_at IS NULL
                  AND (service.is_active = true OR service.age_verification_blocked = true)
                  AND service.delivery_type IN ('IN_PERSON', 'BOTH')
              ) AS has_in_person_services
       FROM provider_profiles WHERE user_id = $1`,
      [userId],
    );
    const providerId = providerResult.rows[0]?.id as string | undefined;
    if (providerId) {
      await reconcileExpiredComplimentaryProGrants(providerId);
      const refreshedPlan = await database.query<{ plan: string }>("SELECT plan FROM provider_profiles WHERE id::text = $1", [providerId]);
      if (providerResult.rows[0] && refreshedPlan.rows[0]) providerResult.rows[0].plan = refreshedPlan.rows[0].plan;
    }

    const [settings, counts, services, bookings, reviews, reports, disputes, supportRequests, activity, welcomeEmail, providerWelcomeEmail, affiliateAttribution, portfolio] = await Promise.all([
      database.query(
        `SELECT city, state, search_radius_miles, booking_notifications, message_notifications,
                theme, time_zone, created_at, updated_at,
                (consumer_stripe_customer_id IS NOT NULL) AS consumer_stripe_connected,
                consumer_stripe_mode
         FROM user_settings WHERE user_id = $1`,
        [userId],
      ),
      database.query(
        `SELECT
          (SELECT count(*)::int FROM bookings b WHERE b.customer_id = $1 OR ($2::uuid IS NOT NULL AND b.provider_id = $2::uuid)) AS bookings,
          (SELECT count(*)::int FROM services s WHERE $2::uuid IS NOT NULL AND s.provider_id = $2::uuid AND s.provider_deleted_at IS NULL) AS listings,
          (SELECT count(*)::int FROM reviews r WHERE r.customer_id = $1 OR ($2::uuid IS NOT NULL AND r.provider_id = $2::uuid)) AS reviews,
          (SELECT count(*)::int FROM safety_reports sr WHERE sr.reporter_id = $1 OR sr.reported_user_id = $1) AS safety_reports,
          (SELECT count(*)::int FROM booking_disputes d WHERE d.opened_by = $1 OR d.against_user_id = $1) AS disputes,
          (SELECT count(*)::int FROM support_requests sr WHERE sr.user_id = $1) AS support_requests`,
        [userId, providerId ?? null],
      ),
      database.query(
        `SELECT id::text, slug, title, category, business_name, price_cents,pricing_type,hourly_rate_cents,minimum_duration_minutes,
                duration_minutes, is_active, created_at, updated_at,
                EXISTS(SELECT 1 FROM listing_active_email_eligible eligible WHERE eligible.service_id=services.id) AS publicly_visible,
                (SELECT status FROM listing_active_email_deliveries delivery WHERE delivery.service_id=services.id) AS activation_email_status
         FROM services WHERE $1::uuid IS NOT NULL AND provider_id = $1::uuid AND provider_deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 50`,
        [providerId ?? null],
      ),
      database.query(
        `SELECT b.id::text, s.title AS service_title, b.status, b.payment_status,
                b.price_cents, b.starts_at, b.ends_at, b.created_at,
                CASE WHEN b.customer_id = $1 THEN provider_owner.name ELSE customer.name END AS other_party_name,
                CASE WHEN b.customer_id = $1 THEN 'Customer' ELSE 'Provider' END AS account_role
         FROM bookings b
         JOIN services s ON s.id = b.service_id
         JOIN "user" customer ON customer.id = b.customer_id
         JOIN provider_profiles p ON p.id = b.provider_id
         JOIN "user" provider_owner ON provider_owner.id = p.user_id
         WHERE b.customer_id = $1 OR ($2::uuid IS NOT NULL AND b.provider_id = $2::uuid)
         ORDER BY b.created_at DESC LIMIT 50`,
        [userId, providerId ?? null],
      ),
      database.query(
        `SELECT r.id::text, r.rating, r.body, r.is_hidden, r.created_at,
                s.title AS service_title, customer.name AS customer_name,
                CASE WHEN r.customer_id = $1 THEN 'Written by account' ELSE 'About provider' END AS relationship
         FROM reviews r
         JOIN services s ON s.id = r.service_id
         JOIN "user" customer ON customer.id = r.customer_id
         WHERE r.customer_id = $1 OR ($2::uuid IS NOT NULL AND r.provider_id = $2::uuid)
         ORDER BY r.created_at DESC LIMIT 50`,
        [userId, providerId ?? null],
      ),
      database.query(
        `SELECT sr.id::text, sr.category, sr.details, sr.status, sr.created_at,
                reporter.name AS reporter_name, reported.name AS reported_name,
                CASE WHEN sr.reporter_id = $1 THEN 'Submitted by account' ELSE 'Filed about account' END AS relationship
         FROM safety_reports sr
         JOIN "user" reporter ON reporter.id = sr.reporter_id
         JOIN "user" reported ON reported.id = sr.reported_user_id
         WHERE sr.reporter_id = $1 OR sr.reported_user_id = $1
         ORDER BY sr.created_at DESC LIMIT 50`,
        [userId],
      ),
      database.query(
        `SELECT d.id::text, d.category, d.details, d.requested_resolution, d.status,
                d.admin_note, d.resolution_outcome, d.resolved_at, d.created_at, s.title AS service_title,
                opener.name AS opened_by_name, against_user.name AS against_name
         FROM booking_disputes d
         JOIN bookings b ON b.id = d.booking_id
         JOIN services s ON s.id = b.service_id
         JOIN "user" opener ON opener.id = d.opened_by
         JOIN "user" against_user ON against_user.id = d.against_user_id
         WHERE d.opened_by = $1 OR d.against_user_id = $1
         ORDER BY d.created_at DESC LIMIT 50`,
        [userId],
      ),
      database.query(
        `SELECT id::text, subject, message, status, admin_reply, created_at, updated_at
         FROM support_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [userId],
      ),
      database.query(
        `SELECT id::text, action, target_type, target_id, metadata, created_at
         FROM activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [userId],
      ),
      database.query(
        `SELECT status, created_at
         FROM email_delivery_log
         WHERE user_id = $1 AND email_type = 'account_welcome'
         ORDER BY created_at DESC LIMIT 1`,
        [userId],
      ),
      database.query(
        `SELECT status, attempt_count, queued_at, attempted_at, sent_at, delivered_at, updated_at,
                CASE WHEN last_error='' THEN NULL ELSE last_error END AS last_error
         FROM provider_welcome_email_deliveries
         WHERE user_id=$1 LIMIT 1`,
        [userId],
      ),
      database.query(
        `SELECT affiliate.display_name AS affiliate_name, affiliate.affiliate_code, program.name AS program_name,
                referral.attributed_at, referral.qualified_at, referral.revenue_share_started_at,
                referral.revenue_share_ends_at, referral.status, provider.created_at AS provider_signup_at
         FROM affiliate_referrals referral
         JOIN affiliate_profiles affiliate ON affiliate.id = referral.affiliate_id
         JOIN affiliate_programs program ON program.id = referral.program_id
         JOIN provider_profiles provider ON provider.id = referral.provider_id
         WHERE $1::uuid IS NOT NULL AND referral.provider_id = $1::uuid LIMIT 1`,
        [providerId ?? null],
      ),
      database.query(
        `SELECT id::text, public_url AS url, caption, alt_text, moderation_status, created_at
         FROM provider_portfolio_items WHERE $1::uuid IS NOT NULL AND provider_id = $1::uuid
         ORDER BY sort_order, created_at`,
        [providerId ?? null],
      ),
    ]);

    await database.query(
      `INSERT INTO admin_audit_log (actor_user_id, action, target_type, target_id, details)
       VALUES ($1, 'account_details_viewed', 'account', $2, '{}'::jsonb)`,
      [session.user.id, userId],
    );

    const complimentaryPro = providerId ? await getComplimentaryProStatus(providerId) : null;
    const complimentaryProHistory = providerId ? await getComplimentaryProHistory(providerId) : [];

    return NextResponse.json({
      account: accountResult.rows[0],
      settings: settings.rows[0] ?? null,
      consumerStripe: {
        connected: Boolean(settings.rows[0]?.consumer_stripe_connected),
        mode: settings.rows[0]?.consumer_stripe_mode ?? null,
      },
      provider: providerResult.rows[0] ?? null,
      complimentaryPro,
      complimentaryProHistory,
      counts: counts.rows[0],
      services: services.rows,
      bookings: bookings.rows,
      reviews: reviews.rows,
      reports: reports.rows,
      disputes: disputes.rows,
      supportRequests: supportRequests.rows,
      activity: activity.rows,
      welcomeEmail: welcomeEmail.rows[0] ?? null,
      providerWelcomeEmail: providerWelcomeEmail.rows[0] ?? { status: "not_attempted", attempt_count: 0 },
      affiliateAttribution: affiliateAttribution.rows[0] ?? null,
      portfolio: portfolio.rows,
      privacyNote: "Passwords, authentication secrets, payment-card and bank details, private conversations, booking addresses, and booking notes are intentionally excluded.",
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Admin account detail lookup failed", error);
    return NextResponse.json({ error: "The account details could not be loaded." }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  if (!await enforceRateLimit({ request, userId: session.user.id, bucket: "admin-welcome-email", limit: 10, windowSeconds: 3600 })) {
    return NextResponse.json({ error: "Too many welcome-email requests. Please try again later." }, { status: 429 });
  }

  const { userId } = await params;
  if (!userId || userId.length > 200) return NextResponse.json({ error: "Invalid account." }, { status: 400 });

  const body = await request.json().catch(() => null) as { action?: string; serviceId?: string; confirmed?: boolean } | null;
  const account = await database.query<{ name: string; email: string; provider_id: string | null; provider_active: boolean }>(
    `SELECT account.name, account.email, provider.id::text AS provider_id, COALESCE(provider.is_active,false) AS provider_active
     FROM "user" account
     LEFT JOIN provider_profiles provider ON provider.user_id=account.id
     WHERE account.id = $1`,
    [userId],
  );
  if (!account.rows[0]) return NextResponse.json({ error: "Account not found." }, { status: 404 });

  if (body?.action === "send_listing_active_email") {
    if (body.confirmed !== true || !body.serviceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.serviceId)) {
      return NextResponse.json({ error: "Confirm the listing activation email and select a valid listing." }, { status: 400 });
    }
    const result = await requestListingActiveEmail({ serviceId: body.serviceId, userId, actorUserId: session.user.id });
    if (result.status === "not_public") return NextResponse.json({ error: "This listing is not public or does not belong to this provider." }, { status: 409 });
    if (result.status === "review_required") return NextResponse.json({ error: "This delivery needs review in Resend before it can be retried." }, { status: 409 });
    return NextResponse.json({ ok: true, status: result.status, message: result.status === "sent"
      ? "Activation email accepted by Resend (or previously sent). No duplicate was sent."
      : "Activation email queued. It will only send while the listing is public." });
  }

  if (body?.action === "retry_provider_welcome") {
    const provider = account.rows[0];
    if (!provider.provider_id || !provider.provider_active) return NextResponse.json({ error: "An active provider profile is required." }, { status: 409 });
    const current = await database.query<{ status: string }>(
      "SELECT status FROM provider_welcome_email_deliveries WHERE user_id=$1 LIMIT 1",
      [userId],
    );
    if (["sent", "delivered", "sending"].includes(current.rows[0]?.status ?? "")) {
      return NextResponse.json({ error: "This provider welcome email was already sent or is being delivered." }, { status: 409 });
    }
    const delivery = await retryProviderWelcomeEmail({ userId, providerId: provider.provider_id });
    await database.query(
      `INSERT INTO admin_audit_log (actor_user_id, action, target_type, target_id, details)
       VALUES ($1, 'provider_welcome_email_retried', 'account', $2, $3::jsonb)`,
      [session.user.id, userId, JSON.stringify({ status: delivery.status })],
    );
    if (delivery.status === "failed") return NextResponse.json({ error: "The provider welcome email failed and was kept for automatic retry." }, { status: 502 });
    if (delivery.status === "skipped") return NextResponse.json({ error: "Email delivery is not configured. The message was kept for automatic retry." }, { status: 503 });
    if (delivery.status === "not_due") return NextResponse.json({ error: "The provider welcome email is already being processed." }, { status: 409 });
    return NextResponse.json({ ok: true, status: delivery.status, message: "Provider welcome email sent." });
  }

  const delivery = await sendAccountWelcome({ id: userId, name: account.rows[0].name, email: account.rows[0].email });
  await database.query(
    `INSERT INTO admin_audit_log (actor_user_id, action, target_type, target_id, details)
     VALUES ($1, 'account_welcome_email_requested', 'account', $2, $3::jsonb)`,
    [session.user.id, userId, JSON.stringify({ status: delivery.status })],
  );

  if (delivery.status === "failed") return NextResponse.json({ error: "The welcome email could not be delivered." }, { status: 502 });
  if (delivery.status === "skipped") return NextResponse.json({ error: "Email delivery is not configured." }, { status: 503 });
  return NextResponse.json({
    ok: true,
    status: delivery.status,
    message: delivery.status === "already_sent" ? "This account already received its welcome email." : "Welcome email sent.",
  });
}
