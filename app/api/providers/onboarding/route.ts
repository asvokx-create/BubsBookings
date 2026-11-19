import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { database } from "@/lib/database";
import { checkAndRecordContent } from "@/lib/content-safety";
import { isOwnerEmail } from "@/lib/admin";
import { PLAN_ENTITLEMENTS, type ProviderPlan } from "@/lib/plans";
import { findUsCity } from "@/lib/us-cities";
import { screenProviderProfile } from "@/lib/provider-screening";
import { sendTransactionalEmail } from "@/lib/email";
import { PROVIDER_AGREEMENT_VERSION } from "@/lib/policy-consent";
import { runAutomatedProviderVerification } from "@/lib/provider-verification";
import { checkAndRecordListingFinancialCrimeRisk } from "@/lib/financial-crime-screening";
import { enforceRateLimit } from "@/lib/request-security";
import { recordAnalytics } from "@/lib/analytics";
import { AFFILIATE_COOKIE, lockAffiliateAttribution, normalizeAffiliateCode } from "@/lib/affiliates";
import { slugifyProviderName } from "@/lib/provider-profile-options";
import { isServiceDeliveryType } from "@/lib/service-delivery";
import { isHourlyBillingIncrement, isPricingType, validateListingHourlyPricing } from "@/lib/service-pricing";
import { deliverProviderWelcomeEmail, enqueueProviderWelcomeEmail } from "@/lib/provider-welcome-email";
import { reconcileExpiredComplimentaryProGrants } from "@/lib/complimentary-pro";
import { listingLimitExceeded, lockProviderListingLimit } from "@/lib/provider-listing-limits";

const weekdayNumbers: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function slugify(value: string) {
  const base = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 54);
  return `${base || "service"}-${randomUUID().slice(0, 8)}`;
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Log in before creating a provider profile." }, { status: 401 });
  }
  await reconcileExpiredComplimentaryProGrants();

  const body = (await request.json()) as Record<string, unknown>;
  const business = typeof body.business === "string" ? body.business.trim() : "";
  const requestedLocationId = typeof body.locationId === "string" ? body.locationId.trim() : "";
  const category = typeof body.category === "string" ? body.category.trim() : "";
  const submittedServiceArea = typeof body.city === "string" ? body.city.trim() : "";
  const deliveryType = isServiceDeliveryType(body.deliveryType) ? body.deliveryType : "IN_PERSON";
  const remoteDeliveryDetails = typeof body.remoteDeliveryDetails === "string" ? body.remoteDeliveryDetails.trim().slice(0, 1000) : "";
  const accountLocation = await database.query<{ city: string | null; state: string | null; age_verified_at: Date | null }>(
    `SELECT location_city AS city, location_state AS state, age_verified_at FROM "user" WHERE id=$1`, [session.user.id],
  );
  if (!accountLocation.rows[0]?.age_verified_at) return NextResponse.json({ error: "You must be at least 18 years old to use BubsBookings." }, { status: 403 });
  const accountArea = [accountLocation.rows[0]?.city, accountLocation.rows[0]?.state].filter(Boolean).join(", ");
  const serviceArea = submittedServiceArea || accountArea;
  const coordinates = findUsCity(serviceArea);
  const service = typeof body.service === "string" ? body.service.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const durationMinutes = Number(body.durationMinutes);
  const phone = typeof body.phone === "string" ? body.phone.replace(/\D/g, "") : "";
  const price = Number(body.price);
  const pricingType = isPricingType(body.pricingType) ? body.pricingType : "FIXED";
  const hourlyRateCents = Math.round(Number(body.hourlyRate) * 100);
  const minimumDurationMinutes = Number(body.minimumDurationMinutes);
  const maximumDurationMinutes = body.maximumDurationMinutes === null || body.maximumDurationMinutes === "" ? null : Number(body.maximumDurationMinutes);
  const billingIncrementMinutes = Number(body.billingIncrementMinutes);
  const defaultDurationMinutes = Number(body.defaultDurationMinutes);
  const serviceRadiusMiles = deliveryType === "REMOTE" ? 25 : Number(body.serviceRadiusMiles ?? 25);
  const acceptedProviderAgreement = body.acceptedProviderAgreement === true;
  const referralCode = normalizeAffiliateCode(body.referralCode);
  const availabilitySlots = Array.isArray(body.availabilitySlots) ? body.availabilitySlots.flatMap((slot) => {
    if (!slot || typeof slot !== "object") return [];
    const candidate = slot as Record<string, unknown>;
    const day = typeof candidate.day === "string" ? candidate.day : "";
    const startTime = typeof candidate.startTime === "string" ? candidate.startTime : "";
    const endTime = typeof candidate.endTime === "string" ? candidate.endTime : "";
    return day in weekdayNumbers ? [{ day, startTime, endTime }] : [];
  }) : [];
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/;

  let hourlyValid = pricingType !== "HOURLY";
  if (pricingType === "HOURLY" && isHourlyBillingIncrement(billingIncrementMinutes)) {
    try { validateListingHourlyPricing({ pricingType, hourlyRateCents, minimumDurationMinutes, maximumDurationMinutes, billingIncrementMinutes, defaultDurationMinutes }); hourlyValid = true; } catch { hourlyValid = false; }
  }
  const fixedPricingValid = pricingType !== "FIXED" || Number.isFinite(price) && price >= 0.5;
  const durationValid = Number.isInteger(durationMinutes) && durationMinutes >= 15 && durationMinutes <= 2_147_483_647;
  if (!business || !category || category.length > 80 || !serviceArea || !coordinates || !service || !description || phone.length !== 10 || !fixedPricingValid || !durationValid || !Number.isInteger(serviceRadiusMiles) || serviceRadiusMiles < 1 || serviceRadiusMiles > 250 || !hourlyValid || remoteDeliveryDetails.length > 1000 || availabilitySlots.length === 0 || availabilitySlots.some((slot) => !validTime.test(slot.startTime) || !validTime.test(slot.endTime) || slot.startTime >= slot.endTime)) {
    return NextResponse.json({ error: "Complete all provider, service, and availability fields." }, { status: 400 });
  }
  if (!await enforceRateLimit({ request, userId: session.user.id, bucket: "provider-onboarding", limit: 6, windowSeconds: 3600 })) return NextResponse.json({ error: "Too many setup attempts. Please try again later." }, { status: 429 });
  if (!acceptedProviderAgreement) {
    return NextResponse.json({ error: "Accept the Provider Agreement before creating a provider profile." }, { status: 400 });
  }
  const safety = await checkAndRecordContent({ userId: session.user.id, surface: "provider_listing", fields: [business, service, description, serviceArea] });
  if (!safety.allowed) return NextResponse.json({ error: safety.message }, { status: 422 });
  const financialRisk = await checkAndRecordListingFinancialCrimeRisk({
    userId: session.user.id,
    surface: "provider_listing_financial_risk",
    input: { businessName: business, title: service, category, description, priceCents: pricingType === "HOURLY" ? hourlyRateCents : pricingType === "QUOTE_ONLY" ? 0 : Math.round(price * 100) },
  });
  if (!financialRisk.allowed) {
    return NextResponse.json({ error: financialRisk.message, financialRisk: { level: financialRisk.level, score: financialRisk.score } }, { status: 422 });
  }
  const screening = screenProviderProfile({
    emailVerified: Boolean(session.user.emailVerified),
    phone,
    business,
    service,
    description,
    serviceArea,
  });
  if (!screening.allowed) {
    await sendTransactionalEmail({
      to: session.user.email,
      userId: session.user.id,
      emailType: "provider_screening_needs_changes",
      subject: "Your BubsBookings provider profile needs a few changes",
      heading: "A few details need attention",
      message: `${screening.summary} Return to provider setup, make the changes, and submit again for an immediate automated check.`,
      actionLabel: "Update provider profile",
      actionUrl: "/providers/join",
    });
    return NextResponse.json({ error: screening.summary, screening }, { status: 422 });
  }
  const existingProfile = await database.query<{ plan: ProviderPlan; city: string; state: string; public_profile_slug: string; age_verification_status: string }>("SELECT plan, city, state, public_profile_slug, age_verification_status FROM provider_profiles WHERE user_id = $1", [session.user.id]);
  const plan: ProviderPlan = isOwnerEmail(session.user.email)
    ? "owner"
    : existingProfile.rows[0]?.plan ?? "starter";

  const locationParts = serviceArea.split(",").map((part) => part.trim()).filter(Boolean);
  const state = locationParts.length > 1 ? locationParts.pop()! : "WA";
  const city = locationParts.join(", ") || serviceArea;
  const existing = existingProfile.rows[0];
  const listingAgeVerified = existing?.age_verification_status === "verified";
  if (deliveryType !== "REMOTE" && existing && !PLAN_ENTITLEMENTS[plan].multipleLocations && `${existing.city}, ${existing.state}`.toLowerCase() !== `${city}, ${state}`.toLowerCase()) {
    return NextResponse.json({ error: "Starter uses one shared service location. Use your existing location or upgrade to Pro for multiple locations.", upgradeRequired: true }, { status: 403 });
  }
  const client = await database.connect();
  let affiliateAttributionLocked = false;
  const affiliateCookieValue = request.headers.get("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${AFFILIATE_COOKIE}=`))?.slice(AFFILIATE_COOKIE.length + 1);
  const affiliateAttributionToken = affiliateCookieValue ? decodeURIComponent(affiliateCookieValue) : undefined;

  try {
    await client.query("BEGIN");
    await client.query('UPDATE "user" SET role = $1, phone = $2, "updatedAt" = now() WHERE id = $3', ["provider", phone, session.user.id]);

    let publicProfileSlug = existing?.public_profile_slug;
    if (!publicProfileSlug) {
      const base = slugifyProviderName(business);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`provider-profile-slug:${base}`]);
      const matches = await client.query<{ public_profile_slug: string }>(
        "SELECT public_profile_slug FROM provider_profiles WHERE lower(public_profile_slug) = lower($1) OR lower(public_profile_slug) LIKE lower($1 || '-%')",
        [base],
      );
      const used = new Set(matches.rows.map((row) => row.public_profile_slug.toLowerCase()));
      publicProfileSlug = base;
      for (let suffix = 2; used.has(publicProfileSlug.toLowerCase()); suffix += 1) publicProfileSlug = `${base}-${suffix}`;
    }

    const profileResult = await client.query<{ id: string }>(
      `INSERT INTO provider_profiles (user_id, business_name, bio, phone, city, state, plan, latitude, longitude, service_radius_miles, public_profile_slug,
          screening_status, screening_score, screening_summary, screening_checked_at, provider_agreement_accepted_at, provider_agreement_version, is_verified, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'passed', $12, $13, now(), now(), $14, true, true)
       ON CONFLICT (user_id) DO UPDATE SET
         bio = EXCLUDED.bio,
         phone = EXCLUDED.phone,
         plan = EXCLUDED.plan,
         service_radius_miles = EXCLUDED.service_radius_miles,
         screening_status = EXCLUDED.screening_status,
         screening_score = EXCLUDED.screening_score,
         screening_summary = EXCLUDED.screening_summary,
         screening_checked_at = EXCLUDED.screening_checked_at,
         provider_agreement_accepted_at = EXCLUDED.provider_agreement_accepted_at,
         provider_agreement_version = EXCLUDED.provider_agreement_version,
         is_verified = true,
         is_active = true
       RETURNING id`,
      [session.user.id, business, description, phone, city, state, plan, coordinates.latitude, coordinates.longitude, serviceRadiusMiles, publicProfileSlug, screening.score, screening.summary, PROVIDER_AGREEMENT_VERSION],
    );
    const providerId = profileResult.rows[0].id;

    const companyResult = await client.query<{ id: string }>(
      `INSERT INTO provider_companies (provider_id, name, slug, bio, city, state, service_radius_miles, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       ON CONFLICT (provider_id, (lower(name))) DO UPDATE SET
         is_active = true, updated_at = now()
       RETURNING id::text`,
      [providerId, business, slugify(business), description, city, state, serviceRadiusMiles],
    );
    const companyId = companyResult.rows[0].id;

    const savedLocation = requestedLocationId ? await client.query<{ id: string; city: string; state: string; latitude: number; longitude: number; service_radius_miles: number }>(
      `SELECT location.id::text, location.city, location.state, location.latitude, location.longitude, location.service_radius_miles
       FROM provider_locations location
       WHERE location.id::text = $1 AND location.company_id::text = $2 AND location.is_active = true`,
      [requestedLocationId, companyId],
    ) : null;
    if (requestedLocationId && !savedLocation?.rows[0]) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Choose an active service location for this company." }, { status: 400 });
    }
    let serviceLocation = savedLocation?.rows[0];
    if (!serviceLocation) {
      const locationResult = await client.query<{ id: string; city: string; state: string; latitude: number; longitude: number; service_radius_miles: number }>(
        `INSERT INTO provider_locations (company_id, name, city, state, latitude, longitude, service_radius_miles, is_primary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOT EXISTS (SELECT 1 FROM provider_locations WHERE company_id = $1 AND is_active = true))
         ON CONFLICT (company_id, (lower(name))) DO UPDATE SET is_active = true
         RETURNING id::text, city, state, latitude, longitude, service_radius_miles`,
        [companyId, `${city}, ${state}`, city, state, coordinates.latitude, coordinates.longitude, serviceRadiusMiles],
      );
      serviceLocation = locationResult.rows[0];
    }

    const listingLimit = await lockProviderListingLimit(client, providerId);
    if (!listingLimit) throw new Error("PROVIDER_NOT_FOUND");
    const isFirstListing = listingLimit.totalListingCount === 0;
    if (listingLimitExceeded(listingLimit.listingCount, listingLimit.serviceLimit)) {
      await client.query("ROLLBACK");
      return NextResponse.json({
        error: `Your ${PLAN_ENTITLEMENTS[listingLimit.effectivePlan].name} plan allows up to ${listingLimit.serviceLimit} current services. Delete a listing or upgrade from Billing to add another.`,
        upgradeRequired: true,
      }, { status: 403 });
    }

    const serviceResult = await client.query<{ id: string }>(
      `INSERT INTO services (provider_id, company_id, location_id, business_name, slug, category, delivery_type, remote_delivery_details, title, description, price_cents, duration_minutes, city, state, latitude, longitude,
          pricing_type,hourly_rate_cents,minimum_duration_minutes,maximum_duration_minutes,billing_increment_minutes,default_duration_minutes,is_active,age_verification_blocked)
       VALUES ($1, $2, CASE WHEN $7='REMOTE' THEN NULL ELSE $3::uuid END, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING id::text`,
      [providerId, companyId, serviceLocation.id, business, slugify(service), category, deliveryType, remoteDeliveryDetails, service, description,
        pricingType === "HOURLY" ? hourlyRateCents : pricingType === "QUOTE_ONLY" ? 0 : Math.round(price * 100), pricingType === "HOURLY" ? defaultDurationMinutes : durationMinutes,
        serviceLocation.city, serviceLocation.state, serviceLocation.latitude, serviceLocation.longitude, pricingType,
        pricingType === "HOURLY" ? hourlyRateCents : null, pricingType === "HOURLY" ? minimumDurationMinutes : null,
        pricingType === "HOURLY" ? maximumDurationMinutes : null, pricingType === "HOURLY" ? billingIncrementMinutes : null,
        pricingType === "HOURLY" ? defaultDurationMinutes : null, listingAgeVerified, !listingAgeVerified],
    );

    if (!existing) {
      const attribution = await lockAffiliateAttribution({ client, providerId, manualCode: referralCode, attributionToken: affiliateAttributionToken });
      if (attribution.invalidManualCode) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "That creator or partner referral code is not active. Remove it or enter a valid code." }, { status: 400 });
      }
      affiliateAttributionLocked = attribution.attributed;
      if (affiliateAttributionToken && /^[0-9a-f-]{36}$/i.test(affiliateAttributionToken)) {
        await client.query(`UPDATE affiliate_clicks SET
            account_created_at=COALESCE(account_created_at,
              CASE WHEN EXISTS (SELECT 1 FROM "user" account
                WHERE account.id=$2 AND account."createdAt">=affiliate_clicks.created_at) THEN now() END),
            account_user_id=COALESCE(account_user_id,$2),
            onboarding_started_at=COALESCE(onboarding_started_at,now()),
            company_created_at=COALESCE(company_created_at,now()),
            first_listing_created_at=COALESCE(first_listing_created_at,now())
          WHERE attribution_token=$1::uuid`, [affiliateAttributionToken, session.user.id]);
      }
    }

    await client.query("DELETE FROM availability WHERE provider_id = $1 AND service_id = $2", [providerId, serviceResult.rows[0].id]);
    for (const slot of availabilitySlots) {
      await client.query(
        `INSERT INTO availability (provider_id, service_id, weekday, start_time, end_time)
         VALUES ($1, $2, $3, $4, $5)`,
        [providerId, serviceResult.rows[0].id, weekdayNumbers[slot.day], slot.startTime, slot.endTime],
      );
    }

    if (!existing) {
      await enqueueProviderWelcomeEmail({ userId: session.user.id, providerId }, client);
    }

    await client.query("COMMIT");
    await runAutomatedProviderVerification(providerId).catch((error) => {
      console.error("Initial automated provider verification failed", providerId, error);
    });
    if (!existing) await deliverProviderWelcomeEmail(session.user.id).catch((error) => console.error("Provider welcome email delivery failed", {
      userId: session.user.id,
      message: error instanceof Error ? error.message : "Unknown error",
    }));
    if (!existing) await recordAnalytics({ eventName: "provider_profile_completed", userId: session.user.id, targetType: "provider", targetId: providerId });
    if (isFirstListing) await recordAnalytics({ eventName: "first_listing_created", userId: session.user.id, targetType: "service", targetId: serviceResult.rows[0].id, metadata: { category, deliveryType, ...(deliveryType === "REMOTE" ? {} : { city, state }) } });
    await recordAnalytics({ eventName: `${deliveryType.toLowerCase()}_listing_created`, userId: session.user.id, targetType: "service", targetId: serviceResult.rows[0].id, metadata: { category } });
    const response = NextResponse.json({ ok: true, serviceId: serviceResult.rows[0].id });
    if (affiliateAttributionLocked) response.cookies.delete(AFFILIATE_COOKIE);
    return response;
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Provider onboarding failed", error);
    return NextResponse.json({ error: "We could not save your provider profile. Please try again." }, { status: 500 });
  } finally {
    client.release();
  }
}
