import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { database } from "@/lib/database";
import { checkAndRecordContent } from "@/lib/content-safety";
import { PLAN_ENTITLEMENTS, type ProviderPlan } from "@/lib/plans";
import { checkAndRecordListingFinancialCrimeRisk } from "@/lib/financial-crime-screening";
import { enforceRateLimit } from "@/lib/request-security";
import { runAutomatedProviderVerification } from "@/lib/provider-verification";
import { isServiceDeliveryType, type ServiceDeliveryType } from "@/lib/service-delivery";
import { isRecurrenceOption, type RecurrenceOption } from "@/lib/service-commerce";
import { resolveHourlyListingEstimate, type HourlyListingEstimate } from "@/lib/hourly-listing-estimate";
import { isHourlyBillingIncrement, isPricingType, validateListingHourlyPricing, type PricingType } from "@/lib/service-pricing";
import { reconcileExpiredComplimentaryProGrants } from "@/lib/complimentary-pro";

async function getSessionUserId() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) await reconcileExpiredComplimentaryProGrants();
  return session?.user.id ?? null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ serviceId: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { serviceId } = await params;
  const result = await database.query<{
    id: string;
    business_name: string;
    slug: string;
    title: string;
    category: string;
    delivery_type: ServiceDeliveryType;
    remote_delivery_details: string;
    description: string;
    price_cents: number;
    duration_minutes: number;
    pricing_type: PricingType;
    hourly_rate_cents: number | null;
    estimated_min_minutes: number | null;
    estimated_max_minutes: number | null;
    minimum_duration_minutes: number | null;
    maximum_duration_minutes: number | null;
    billing_increment_minutes: number | null;
    default_duration_minutes: number | null;
    city: string;
    state: string;
    booking_questions: string[];
    plan: ProviderPlan;
    location_id: string | null;
    location_name: string | null;
    locations: Array<{ id: string; name: string; location: string }>;
    service_kind: "standard" | "consultation";
    preparation_notes: string;
    recurrence_options: RecurrenceOption[];
    packages: unknown[] | null;
    add_ons: unknown[] | null;
  }>(
    `SELECT s.id::text, s.business_name, s.slug, s.title, s.category, s.delivery_type, s.remote_delivery_details, s.description,
            s.price_cents, s.duration_minutes, s.pricing_type, s.hourly_rate_cents, s.minimum_duration_minutes,
            s.maximum_duration_minutes, s.billing_increment_minutes, s.default_duration_minutes,
            s.estimated_min_minutes, s.estimated_max_minutes,
            COALESCE(s.city, p.city) AS city, COALESCE(s.state, p.state) AS state,
            s.booking_questions, p.plan, s.service_kind, s.preparation_notes, s.recurrence_options,
            (SELECT jsonb_agg(jsonb_build_object('id', package.id::text, 'name', package.name, 'description', package.description, 'price', package.price_cents::numeric/100, 'durationMinutes', package.duration_minutes, 'deliveryDays', package.delivery_days, 'revisionCount', package.revision_count, 'features', package.features) ORDER BY package.sort_order) FROM service_packages package WHERE package.service_id=s.id AND package.is_active=true) AS packages,
            (SELECT jsonb_agg(jsonb_build_object('id', addon.id::text, 'name', addon.name, 'description', addon.description, 'price', addon.price_cents::numeric/100, 'additionalMinutes', addon.additional_minutes, 'allowsQuantity', addon.allows_quantity, 'maxQuantity', addon.max_quantity) ORDER BY addon.sort_order) FROM service_add_ons addon WHERE addon.service_id=s.id AND addon.is_active=true) AS add_ons,
            location.id::text AS location_id, location.name AS location_name,
            (SELECT jsonb_agg(jsonb_build_object('id', choice.id::text, 'name', choice.name, 'location', choice.city || ', ' || choice.state)
              ORDER BY choice.is_primary DESC, choice.created_at)
             FROM provider_locations choice WHERE choice.company_id = s.company_id AND choice.is_active = true) AS locations
     FROM services s
     JOIN provider_profiles p ON p.id = s.provider_id
     LEFT JOIN provider_locations location ON location.id = s.location_id
     WHERE s.id::text = $1 AND p.user_id = $2 AND (s.is_active = true OR s.age_verification_blocked = true)
     LIMIT 1`,
    [serviceId, userId],
  );

  const service = result.rows[0];
  if (!service) return NextResponse.json({ error: "Listing not found." }, { status: 404 });
  return NextResponse.json({
    id: service.id,
    businessName: service.business_name,
    slug: service.slug,
    title: service.title,
    category: service.category,
    deliveryType: service.delivery_type,
    remoteDeliveryDetails: service.remote_delivery_details,
    description: service.description,
    price: service.price_cents / 100,
    durationMinutes: service.duration_minutes,
    pricingType: service.pricing_type,
    hourlyRate: service.hourly_rate_cents === null ? null : service.hourly_rate_cents / 100,
    estimatedMinMinutes: service.estimated_min_minutes,
    estimatedMaxMinutes: service.estimated_max_minutes,
    minimumDurationMinutes: service.minimum_duration_minutes,
    maximumDurationMinutes: service.maximum_duration_minutes,
    billingIncrementMinutes: service.billing_increment_minutes,
    defaultDurationMinutes: service.default_duration_minutes,
    location: `${service.city}, ${service.state}`,
    locationId: service.location_id,
    locationName: service.location_name,
    locations: service.locations ?? [],
    bookingQuestions: service.booking_questions ?? [],
    customQuestionsAllowed: PLAN_ENTITLEMENTS[service.plan].customBookingQuestions,
    multipleLocationsAllowed: PLAN_ENTITLEMENTS[service.plan].multipleLocations,
    serviceKind: service.service_kind,
    preparationNotes: service.preparation_notes,
    recurrenceOptions: service.recurrence_options,
    packages: service.packages ?? [],
    addOns: service.add_ons ?? [],
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ serviceId: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!await enforceRateLimit({ request, userId, bucket: "provider-listing-change", limit: 20 })) return NextResponse.json({ error: "Too many listing changes. Please wait a minute." }, { status: 429 });

  const { serviceId } = await params;
  const body = (await request.json()) as Record<string, unknown>;
  const businessName = typeof body.businessName === "string" ? body.businessName.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const category = typeof body.category === "string" ? body.category.trim() : "";
  const deliveryType = isServiceDeliveryType(body.deliveryType) ? body.deliveryType : null;
  const remoteDeliveryDetails = typeof body.remoteDeliveryDetails === "string" ? body.remoteDeliveryDetails.trim().slice(0, 1000) : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const locationId = typeof body.locationId === "string" ? body.locationId.trim() : "";
  const price = Number(body.price);
  const durationMinutes = Number(body.durationMinutes);
  const pricingType = isPricingType(body.pricingType) ? body.pricingType : "FIXED";
  const hourlyRateCents = Math.round(Number(body.hourlyRate) * 100);
  const minimumDurationMinutes = Number(body.minimumDurationMinutes);
  const maximumDurationMinutes = body.maximumDurationMinutes === null || body.maximumDurationMinutes === "" ? null : Number(body.maximumDurationMinutes);
  const billingIncrementMinutes = Number(body.billingIncrementMinutes);
  const defaultDurationMinutes = Number(body.defaultDurationMinutes);
  const bookingQuestions = Array.isArray(body.bookingQuestions) ? body.bookingQuestions.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean) : [];
  const serviceKind = body.serviceKind === "consultation" ? "consultation" : "standard";
  const preparationNotes = typeof body.preparationNotes === "string" ? body.preparationNotes.trim() : "";
  const recurrenceOptions = Array.isArray(body.recurrenceOptions) ? [...new Set(body.recurrenceOptions.filter(isRecurrenceOption))] : ["one_time"];
  if (!recurrenceOptions.includes("one_time")) recurrenceOptions.unshift("one_time");
  const packages = Array.isArray(body.packages) ? body.packages.slice(0, 3).map((entry) => {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return { name: String(item.name ?? "").trim(), description: String(item.description ?? "").trim(), priceCents: Math.round(Number(item.price) * 100), durationMinutes: Number(item.durationMinutes), deliveryDays: item.deliveryDays === null || item.deliveryDays === "" ? null : Number(item.deliveryDays), revisionCount: item.revisionCount === null || item.revisionCount === "" ? null : Number(item.revisionCount), features: Array.isArray(item.features) ? item.features.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 10) : [] };
  }) : [];
  const addOns = Array.isArray(body.addOns) ? body.addOns.slice(0, 10).map((entry) => {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return { name: String(item.name ?? "").trim(), description: String(item.description ?? "").trim(), priceCents: Math.round(Number(item.price) * 100), additionalMinutes: Number(item.additionalMinutes ?? 0), allowsQuantity: item.allowsQuantity === true, maxQuantity: Number(item.maxQuantity ?? 1) };
  }) : [];

  const packagesValid = packages.length <= 3 && packages.every((item) => item.name && item.name.length <= 60 && item.description.length <= 500 && Number.isSafeInteger(item.priceCents) && item.priceCents >= 50 && Number.isInteger(item.durationMinutes) && item.durationMinutes > 0 && (item.deliveryDays === null || Number.isInteger(item.deliveryDays) && item.deliveryDays >= 0 && item.deliveryDays <= 365) && (item.revisionCount === null || Number.isInteger(item.revisionCount) && item.revisionCount >= 0 && item.revisionCount <= 100));
  const addOnsValid = addOns.length <= 10 && addOns.every((item) => item.name && item.name.length <= 80 && item.description.length <= 500 && Number.isSafeInteger(item.priceCents) && item.priceCents >= 0 && Number.isInteger(item.additionalMinutes) && item.additionalMinutes >= 0 && item.additionalMinutes <= 43200 && Number.isInteger(item.maxQuantity) && item.maxQuantity >= 1 && item.maxQuantity <= 20);
  let estimate: HourlyListingEstimate | undefined;
  try { estimate = resolveHourlyListingEstimate(body, pricingType === "HOURLY"); }
  catch (cause) { return NextResponse.json({ error: cause instanceof Error ? cause.message : "Invalid estimate." }, { status: 400 }); }
  let hourlyValid = pricingType !== "HOURLY";
  if (pricingType === "HOURLY" && isHourlyBillingIncrement(billingIncrementMinutes)) {
    try {
      validateListingHourlyPricing({ pricingType, hourlyRateCents, minimumDurationMinutes, maximumDurationMinutes, billingIncrementMinutes, defaultDurationMinutes });
      hourlyValid = true;
    } catch { hourlyValid = false; }
  }
  const fixedPricingValid = pricingType !== "FIXED" || Number.isFinite(price) && price > 0 && price <= 1_000_000;
  const durationValid = Number.isInteger(durationMinutes) && durationMinutes >= 15 && durationMinutes <= 2_147_483_647;
  if (!businessName || businessName.length > 120 || !title || title.length > 120 || !category || category.length > 80 || !deliveryType || description.length < 10 || description.length > 2000 || preparationNotes.length > 1000 || (deliveryType !== "REMOTE" && !locationId) || !fixedPricingValid || !durationValid || bookingQuestions.length > 3 || bookingQuestions.some((question) => question.length > 180) || !packagesValid || !addOnsValid || !hourlyValid || (pricingType === "HOURLY" && packages.length > 0)) {
    return NextResponse.json({ error: "Complete every field with valid listing details." }, { status: 400 });
  }
  let effectivePriceCents = pricingType === "HOURLY" ? hourlyRateCents : pricingType === "QUOTE_ONLY" ? 0 : Math.round(price * 100);
  const effectiveDurationMinutes = pricingType === "HOURLY" ? defaultDurationMinutes : durationMinutes;
  const safety = await checkAndRecordContent({ userId, surface: "provider_listing", fields: [businessName, title, description, preparationNotes, ...packages.flatMap((item) => [item.name,item.description,...item.features]), ...addOns.flatMap((item) => [item.name,item.description])] });
  if (!safety.allowed) return NextResponse.json({ error: safety.message }, { status: 422 });
  const financialRisk = await checkAndRecordListingFinancialCrimeRisk({
    userId,
    surface: "provider_listing_financial_risk",
    input: { businessName, title, category, description, priceCents: effectivePriceCents },
  });
  if (!financialRisk.allowed) {
    return NextResponse.json({ error: financialRisk.message, financialRisk: { level: financialRisk.level, score: financialRisk.score } }, { status: 422 });
  }

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const ownership = await client.query<{ provider_id: string; plan: ProviderPlan; business_name: string; company_id: string; current_location_id: string | null; current_price_cents: number }>(
      `SELECT s.provider_id::text, p.plan, company.name AS business_name, company.id::text AS company_id, s.location_id::text AS current_location_id,
              s.price_cents AS current_price_cents
       FROM services s JOIN provider_profiles p ON p.id = s.provider_id
       JOIN provider_companies company ON company.id = s.company_id
       WHERE s.id::text = $1 AND p.user_id = $2 AND (s.is_active = true OR s.age_verification_blocked = true)
       FOR UPDATE`,
      [serviceId, userId],
    );
    if (!ownership.rows[0]) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Listing not found." }, { status: 404 });
    }
    if (pricingType === "QUOTE_ONLY") effectivePriceCents = ownership.rows[0].current_price_cents;
    if (ownership.rows[0].business_name !== businessName) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "A listing cannot be moved between company pages. Create a new listing under the correct company." }, { status: 400 });
    }
    const entitlements = PLAN_ENTITLEMENTS[ownership.rows[0].plan];
    if (bookingQuestions.length && !entitlements.customBookingQuestions) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Custom booking questions require Pro.", upgradeRequired: true }, { status: 403 });
    }
    if (deliveryType !== "REMOTE" && !entitlements.multipleLocations && ownership.rows[0].current_location_id && locationId !== ownership.rows[0].current_location_id) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Multiple locations require Pro.", upgradeRequired: true }, { status: 403 });
    }
    const selectedLocation = deliveryType === "REMOTE" ? null : await client.query<{ city: string; state: string; latitude: number; longitude: number }>(
      `SELECT city, state, latitude, longitude FROM provider_locations
       WHERE id::text = $1 AND company_id::text = $2 AND is_active = true`,
      [locationId, ownership.rows[0].company_id],
    );
    if (deliveryType !== "REMOTE" && !selectedLocation?.rows[0]) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Choose an active location from this company." }, { status: 400 });
    }
    const selected = selectedLocation?.rows[0];

    await client.query(
      `UPDATE services
       SET business_name = $1, title = $2, category = $3, delivery_type = $4, remote_delivery_details = $5, description = $6,
           price_cents = $7, duration_minutes = $8, booking_questions = $9::jsonb,
           location_id = CASE WHEN $4='REMOTE' THEN NULL ELSE $10::uuid END,
           city = CASE WHEN $4='REMOTE' THEN city ELSE $11 END, state = CASE WHEN $4='REMOTE' THEN state ELSE $12 END,
           latitude = CASE WHEN $4='REMOTE' THEN latitude ELSE $13 END, longitude = CASE WHEN $4='REMOTE' THEN longitude ELSE $14 END,
           service_kind=$16, preparation_notes=$17, recurrence_options=$18::text[],
           pricing_type=$19, hourly_rate_cents=$20, minimum_duration_minutes=$21,
           maximum_duration_minutes=$22, billing_increment_minutes=$23, default_duration_minutes=$24,
           estimated_min_minutes=CASE WHEN $25::boolean THEN $26::integer ELSE estimated_min_minutes END,
           estimated_max_minutes=CASE WHEN $25::boolean THEN $27::integer ELSE estimated_max_minutes END
       WHERE id::text = $15`,
      [businessName, title, category, deliveryType, remoteDeliveryDetails, description, effectivePriceCents, effectiveDurationMinutes, JSON.stringify(bookingQuestions), locationId || null, selected?.city ?? null, selected?.state ?? null, selected?.latitude ?? null, selected?.longitude ?? null, serviceId, serviceKind, preparationNotes, recurrenceOptions, pricingType,
        pricingType === "HOURLY" ? hourlyRateCents : null, pricingType === "HOURLY" ? minimumDurationMinutes : null,
        pricingType === "HOURLY" ? maximumDurationMinutes : null, pricingType === "HOURLY" ? billingIncrementMinutes : null,
        pricingType === "HOURLY" ? defaultDurationMinutes : null, estimate !== undefined, estimate?.estimatedMinMinutes ?? null, estimate?.estimatedMaxMinutes ?? null],
    );
    await client.query("DELETE FROM service_packages WHERE service_id::text=$1", [serviceId]);
    for (const [index, item] of packages.entries()) await client.query(`INSERT INTO service_packages
      (service_id,name,description,price_cents,duration_minutes,delivery_days,revision_count,features,sort_order)
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`, [serviceId,item.name,item.description,item.priceCents,item.durationMinutes,item.deliveryDays,item.revisionCount,JSON.stringify(item.features),index]);
    await client.query("DELETE FROM service_add_ons WHERE service_id::text=$1", [serviceId]);
    for (const [index, item] of addOns.entries()) await client.query(`INSERT INTO service_add_ons
      (service_id,name,description,price_cents,additional_minutes,allows_quantity,max_quantity,sort_order)
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8)`, [serviceId,item.name,item.description,item.priceCents,item.additionalMinutes,item.allowsQuantity,item.allowsQuantity ? item.maxQuantity : 1,index]);
    await client.query("COMMIT");
    await runAutomatedProviderVerification(ownership.rows[0].provider_id).catch((error) => {
      console.error("Post-listing-update verification failed", ownership.rows[0].provider_id, error);
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Listing update failed", error);
    return NextResponse.json({ error: "We could not update this listing. Please try again." }, { status: 500 });
  } finally {
    client.release();
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ serviceId: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!await enforceRateLimit({ request, userId, bucket: "provider-listing-change", limit: 20 })) return NextResponse.json({ error: "Too many listing changes. Please wait a minute." }, { status: 429 });

  const { serviceId } = await params;
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ provider_id: string; company_id: string; business_name: string; is_active: boolean; age_verification_blocked: boolean }>(
      `SELECT s.provider_id::text, s.company_id::text, s.business_name,
              s.is_active, s.age_verification_blocked
       FROM services s JOIN provider_profiles p ON p.id = s.provider_id
       WHERE s.id::text = $1 AND p.user_id = $2 AND s.provider_deleted_at IS NULL
       FOR UPDATE OF s, p`,
      [serviceId, userId],
    );
    const removed = result.rows[0];
    if (!removed) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Listing not found." }, { status: 404 });
    }
    await client.query(
      "UPDATE services SET is_active=false, age_verification_blocked=false, provider_deleted_at=now(), updated_at=now() WHERE id::text=$1",
      [serviceId],
    );
    await client.query(
      `UPDATE provider_team_members member
       SET status = 'inactive', updated_at = now()
       WHERE member.provider_id::text = $1 AND member.company_id::text = $2 AND member.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM services remaining
             WHERE remaining.provider_id = member.provider_id
               AND remaining.company_id = member.company_id
             AND remaining.is_active = true
         )`,
      [removed.provider_id, removed.company_id],
    );
    await client.query("COMMIT");
    await runAutomatedProviderVerification(removed.provider_id).catch((error) => {
      console.error("Post-listing-removal verification failed", removed.provider_id, error);
    });
    return NextResponse.json({ ok: true, action: "deleted" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Listing removal failed", error);
    return NextResponse.json({ error: "We could not remove this listing. Please try again." }, { status: 500 });
  } finally {
    client.release();
  }
}
