import "server-only";

import { getServiceCategoryIconConfig } from "./service-category-icons";
import { database, isDatabaseConfigured } from "./database";
import { distanceMiles } from "./service-areas";
import { findUsCity } from "./us-cities";
import { getServiceCategorySearchMatches } from "./service-categories";
import type { ServiceDeliveryType } from "./service-delivery";
import type { RecurrenceOption, ServiceAddOn, ServicePackage } from "./service-commerce";
import { isProviderScreeningCurrent } from "./provider-screening-freshness";
import { publicPersonalName } from "./public-provider-identity";
import type { PricingType } from "./service-pricing";
import { reconcileExpiredComplimentaryProGrants } from "./complimentary-pro";
import { MAX_SEARCH_RADIUS_MILES } from "./search-radius";

const PRIORITY_DISTANCE_BAND_MILES = 10;

export type ServiceListing = {
  id: string;
  slug: string;
  title: string;
  category: string;
  deliveryType: ServiceDeliveryType;
  remoteDeliveryDetails: string;
  description: string;
  price: number;
  durationMinutes: number;
  pricingType: PricingType;
  hourlyRateCents: number | null;
  minimumDurationMinutes: number | null;
  maximumDurationMinutes: number | null;
  billingIncrementMinutes: number | null;
  defaultDurationMinutes: number | null;
  providerId: string;
  providerSlug: string;
  providerProfileVisible: boolean;
  provider: string;
  providerProfileImageUrl: string;
  providerAverageRating: number | null;
  providerReviewCount: number;
  companySlug?: string;
  city: string;
  state: string;
  imageUrls: string[];
  emailVerified: boolean;
  phoneVerified: boolean;
  identityVerified: boolean;
  businessVerified: boolean;
  profileScreened: boolean;
  cancellationWindowHours: number;
  cancellationPolicy: string;
  noShowPolicy: string;
  serviceRadiusMiles: number;
  serviceAreaCities: string[];
  bookingQuestions: string[];
  priorityPlacement: boolean;
  distanceMiles?: number;
};

export type ServiceDetails = ServiceListing & {
  estimatedMinMinutes: number | null;
  estimatedMaxMinutes: number | null;
  completedJobCount: number;
  reviewCount: number;
  averageRating: number | null;
  screeningCheckedAt: Date | null;
  serviceKind: "standard" | "consultation";
  preparationNotes: string;
  recurrenceOptions: RecurrenceOption[];
  packages: ServicePackage[];
  addOns: ServiceAddOn[];
};

type ServiceRow = {
  id: string;
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
  minimum_duration_minutes: number | null;
  maximum_duration_minutes: number | null;
  billing_increment_minutes: number | null;
  default_duration_minutes: number | null;
  provider_id: string;
  provider_slug: string;
  provider_profile_visible: boolean;
  business_name: string;
  provider_profile_image_url: string | null;
  provider_average_rating: number | null;
  provider_review_count: number;
  company_slug?: string;
  city: string;
  state: string;
  email_verified: boolean;
  phone_verified: boolean;
  identity_verified: boolean;
  business_verified: boolean;
  is_verified: boolean;
  screening_status: "not_screened" | "passed" | "needs_changes";
  screening_checked_at: Date | null;
  cancellation_window_hours: number;
  cancellation_policy: string;
  no_show_policy: string;
  service_radius_miles: number;
  image_urls: string[] | null;
  booking_questions: unknown;
  service_area_cities?: string[] | null;
  provider_plan: string;
};

function mapService(row: ServiceRow): ServiceListing {
  const screeningCurrent = isProviderScreeningCurrent(row.screening_checked_at);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: row.category,
    deliveryType: row.delivery_type,
    remoteDeliveryDetails: row.remote_delivery_details,
    description: row.description,
    price: (row.pricing_type === "HOURLY" ? row.hourly_rate_cents ?? row.price_cents : row.price_cents) / 100,
    durationMinutes: row.duration_minutes,
    pricingType: row.pricing_type,
    hourlyRateCents: row.hourly_rate_cents,
    minimumDurationMinutes: row.minimum_duration_minutes,
    maximumDurationMinutes: row.maximum_duration_minutes,
    billingIncrementMinutes: row.billing_increment_minutes,
    defaultDurationMinutes: row.default_duration_minutes,
    providerId: row.provider_id,
    providerSlug: row.provider_slug,
    providerProfileVisible: row.provider_profile_visible,
    provider: row.business_name,
    providerProfileImageUrl: row.provider_profile_image_url ?? "",
    providerAverageRating: row.provider_average_rating,
    providerReviewCount: row.provider_review_count,
    companySlug: row.company_slug,
    city: row.city,
    state: row.state,
    emailVerified: row.email_verified,
    phoneVerified: screeningCurrent && row.phone_verified,
    identityVerified: screeningCurrent && row.identity_verified,
    businessVerified: screeningCurrent && row.business_verified,
    profileScreened: screeningCurrent && row.is_verified && row.screening_status === "passed",
    cancellationWindowHours: row.cancellation_window_hours,
    cancellationPolicy: row.cancellation_policy,
    noShowPolicy: row.no_show_policy,
    serviceRadiusMiles: row.service_radius_miles,
    imageUrls: row.image_urls ?? [],
    bookingQuestions: Array.isArray(row.booking_questions) ? row.booking_questions.filter((question): question is string => typeof question === "string") : [],
    serviceAreaCities: row.service_area_cities ?? [],
    priorityPlacement: ["pro", "business", "owner"].includes(row.provider_plan),
  };
}

export async function getServices(options: { query?: string; category?: string; delivery?: "ALL" | ServiceDeliveryType | "IN_PERSON" | "REMOTE"; location?: string; radiusMiles?: number; maxPrice?: number; maxDuration?: number; sort?: string; limit?: number } = {}) {
  if (!isDatabaseConfigured()) return [];
  await reconcileExpiredComplimentaryProGrants();

  const values: Array<string | number | string[]> = [];
  const conditions = ["s.is_active = true", "s.provider_deleted_at IS NULL", "p.is_active = true", "p.age_verification_status = 'verified'"];
  const requestedLimit = options.limit ?? 50;
  const radiusMiles = options.radiusMiles && Number.isFinite(options.radiusMiles) ? Math.min(Math.max(options.radiusMiles, 1), MAX_SEARCH_RADIUS_MILES) : undefined;
  const searchOrigin = options.location && radiusMiles ? findUsCity(options.location) : undefined;
  if (options.delivery === "REMOTE") conditions.push("s.delivery_type IN ('REMOTE','BOTH')");
  else if (options.delivery === "IN_PERSON") conditions.push("s.delivery_type IN ('IN_PERSON','BOTH')");
  else if (options.delivery === "BOTH") conditions.push("s.delivery_type = 'BOTH'");
  if (options.category && options.category !== "All services") {
    values.push(options.category);
    conditions.push(`LOWER(s.category) = LOWER($${values.length})`);
  }
  if (options.query) {
    values.push(`%${options.query}%`);
    const textSearchParameter = values.length;
    const categoryMatches = getServiceCategorySearchMatches(options.query);
    if (categoryMatches.length > 0) {
      values.push(categoryMatches);
      conditions.push(`(s.title ILIKE $${textSearchParameter} OR s.category ILIKE $${textSearchParameter} OR s.description ILIKE $${textSearchParameter} OR s.business_name ILIKE $${textSearchParameter} OR s.category = ANY($${values.length}::text[]))`);
    } else {
      conditions.push(`(s.title ILIKE $${textSearchParameter} OR s.category ILIKE $${textSearchParameter} OR s.description ILIKE $${textSearchParameter} OR s.business_name ILIKE $${textSearchParameter})`);
    }
  }
  if (options.location && !searchOrigin && options.delivery !== "REMOTE") {
    const city = options.location.split(",")[0]?.trim();
    if (city) {
      values.push(city);
      conditions.push(`LOWER(CASE WHEN p.plan IN ('pro', 'business', 'owner') THEN COALESCE(s.city, p.city) ELSE p.city END) = LOWER($${values.length})`);
    }
  }
  if (options.maxPrice && Number.isFinite(options.maxPrice)) {
    values.push(Math.round(options.maxPrice * 100));
    conditions.push(`s.pricing_type <> 'QUOTE_ONLY' AND CASE WHEN s.pricing_type='HOURLY' THEN s.hourly_rate_cents ELSE s.price_cents END <= $${values.length}`);
  }
  if (options.maxDuration && Number.isFinite(options.maxDuration)) {
    values.push(options.maxDuration);
    conditions.push(`CASE WHEN s.pricing_type='HOURLY' THEN s.estimated_max_minutes ELSE s.duration_minutes END <= $${values.length}`);
  }
  // Distance and explicit service-area matching happen after the database query.
  // A database limit here would discard eligible nearby listings whenever they
  // fall outside the first global result page. Keep the normal limit for
  // non-geographic searches, but evaluate every eligible candidate before
  // applying the requested result limit to a geographic search.
  const appliesGeographicFilter = Boolean(searchOrigin && radiusMiles && options.delivery !== "REMOTE");
  const limitClause = appliesGeographicFilter ? "" : (() => {
    values.push(requestedLimit);
    return `LIMIT $${values.length}`;
  })();

  const planPriority = "CASE WHEN p.plan IN ('pro', 'business', 'owner') THEN 0 ELSE 1 END";
  const displayedPrice = "CASE WHEN s.pricing_type='QUOTE_ONLY' THEN NULL WHEN s.pricing_type='HOURLY' THEN s.hourly_rate_cents ELSE s.price_cents END";
  const orderBy = options.sort === "price-low" ? `${displayedPrice} ASC NULLS LAST, ${planPriority}, s.created_at DESC` : options.sort === "price-high" ? `${displayedPrice} DESC NULLS LAST, ${planPriority}, s.created_at DESC` : `${planPriority}, s.created_at DESC`;
  const result = await database.query<ServiceRow>(
    `SELECT s.id::text, s.slug, s.title, s.category, s.delivery_type, s.remote_delivery_details, s.description, s.price_cents,
            s.duration_minutes, s.pricing_type, s.hourly_rate_cents, s.minimum_duration_minutes, s.maximum_duration_minutes, s.billing_increment_minutes, s.default_duration_minutes,
            p.id::text AS provider_id, p.public_profile_slug AS provider_slug, p.public_profile_visible AS provider_profile_visible,
            s.business_name, owner.image AS provider_profile_image_url, company.slug AS company_slug,
            (SELECT round(avg(review.rating)::numeric, 1)::float FROM reviews review WHERE review.provider_id = p.id AND review.is_hidden = false) AS provider_average_rating,
            (SELECT count(*)::int FROM reviews review WHERE review.provider_id = p.id AND review.is_hidden = false) AS provider_review_count,
            CASE WHEN p.plan IN ('pro', 'business', 'owner') THEN COALESCE(s.city, p.city) ELSE p.city END AS city,
            CASE WHEN p.plan IN ('pro', 'business', 'owner') THEN COALESCE(s.state, p.state) ELSE p.state END AS state,
            CASE WHEN p.plan IN ('pro', 'business', 'owner') THEN s.booking_questions ELSE '[]'::jsonb END AS booking_questions, owner."emailVerified" AS email_verified,
            p.plan AS provider_plan, p.is_verified, p.screening_status, p.screening_checked_at, p.phone_verified, p.identity_verified, p.business_verified,
            p.cancellation_window_hours, p.cancellation_policy, p.no_show_policy, p.service_radius_miles,
            COALESCE((SELECT array_agg(lower(area.city || ', ' || area.state)) FROM provider_location_service_areas area WHERE area.location_id = s.location_id), ARRAY[]::text[]) AS service_area_cities,
            COALESCE((
              SELECT array_agg(si.public_url ORDER BY si.sort_order, si.created_at)
              FROM service_images si WHERE si.service_id = s.id
            ), ARRAY[]::text[]) AS image_urls
     FROM services s
     JOIN provider_companies company ON company.id = s.company_id AND company.is_active = true
     JOIN provider_profiles p ON p.id = s.provider_id
     JOIN "user" owner ON owner.id = p.user_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY ${orderBy}
     ${limitClause}`,
    values,
  );
  const services = result.rows.map(mapService);
  if (!appliesGeographicFilter || !searchOrigin || !radiusMiles) return services;
  const nearbyServices = services.flatMap((service) => {
    if (service.deliveryType === "REMOTE") return [{ ...service }];
    if (service.deliveryType === "BOTH" && options.delivery !== "IN_PERSON") return [{ ...service }];
    const serviceArea = findUsCity(`${service.city}, ${service.state}`);
    if (!serviceArea) return [];
    const distance = distanceMiles(searchOrigin, serviceArea);
    const explicitAreaMatch = service.serviceAreaCities.includes(`${searchOrigin.city}, ${searchOrigin.state}`.toLowerCase());
    return ((distance <= radiusMiles && distance <= service.serviceRadiusMiles) || explicitAreaMatch) ? [{ ...service, distanceMiles: distance }] : [];
  });
  if (options.sort === "nearest" || !options.sort) nearbyServices.sort((left, right) =>
    Number(left.distanceMiles === undefined) - Number(right.distanceMiles === undefined)
      || Math.floor((left.distanceMiles ?? 0) / PRIORITY_DISTANCE_BAND_MILES)
      - Math.floor((right.distanceMiles ?? 0) / PRIORITY_DISTANCE_BAND_MILES)
      || Number(right.priorityPlacement) - Number(left.priorityPlacement)
      || (left.distanceMiles ?? 0) - (right.distanceMiles ?? 0));
  return nearbyServices.slice(0, requestedLimit);
}

export async function getServiceBySlug(slug: string): Promise<ServiceDetails | null> {
  if (!isDatabaseConfigured()) return null;
  await reconcileExpiredComplimentaryProGrants();
  const result = await database.query<ServiceRow & { estimated_min_minutes: number | null; estimated_max_minutes: number | null }>(
    `SELECT s.id::text, s.slug, s.title, s.category, s.delivery_type, s.remote_delivery_details, s.description, s.price_cents,
            s.duration_minutes, s.pricing_type, s.hourly_rate_cents, s.minimum_duration_minutes, s.maximum_duration_minutes, s.billing_increment_minutes, s.default_duration_minutes, s.estimated_min_minutes, s.estimated_max_minutes,
            p.id::text AS provider_id, p.public_profile_slug AS provider_slug, p.public_profile_visible AS provider_profile_visible,
            s.business_name, owner.image AS provider_profile_image_url, company.slug AS company_slug,
            (SELECT round(avg(review.rating)::numeric, 1)::float FROM reviews review WHERE review.provider_id = p.id AND review.is_hidden = false) AS provider_average_rating,
            (SELECT count(*)::int FROM reviews review WHERE review.provider_id = p.id AND review.is_hidden = false) AS provider_review_count,
            CASE WHEN p.plan IN ('pro', 'business', 'owner') THEN COALESCE(s.city, p.city) ELSE p.city END AS city,
            CASE WHEN p.plan IN ('pro', 'business', 'owner') THEN COALESCE(s.state, p.state) ELSE p.state END AS state,
            CASE WHEN p.plan IN ('pro', 'business', 'owner') THEN s.booking_questions ELSE '[]'::jsonb END AS booking_questions, owner."emailVerified" AS email_verified,
            p.plan AS provider_plan, p.is_verified, p.screening_status, p.screening_checked_at, p.phone_verified, p.identity_verified, p.business_verified,
            p.cancellation_window_hours, p.cancellation_policy, p.no_show_policy, p.service_radius_miles,
            COALESCE((
              SELECT array_agg(si.public_url ORDER BY si.sort_order, si.created_at)
              FROM service_images si WHERE si.service_id = s.id
            ), ARRAY[]::text[]) AS image_urls
     FROM services s
     JOIN provider_companies company ON company.id = s.company_id AND company.is_active = true
     JOIN provider_profiles p ON p.id = s.provider_id
     JOIN "user" owner ON owner.id = p.user_id
     WHERE s.slug = $1 AND s.is_active = true AND s.provider_deleted_at IS NULL
       AND p.is_active = true AND p.age_verification_status = 'verified'
     LIMIT 1`,
    [slug],
  );
  if (!result.rows[0]) return null;
  const service = mapService(result.rows[0]);
  const commerceResult = await database.query<{
    service_kind: "standard" | "consultation";
    preparation_notes: string;
    recurrence_options: RecurrenceOption[];
    packages: ServicePackage[] | null;
    add_ons: ServiceAddOn[] | null;
  }>(`SELECT s.service_kind, s.preparation_notes, s.recurrence_options,
      (SELECT jsonb_agg(jsonb_build_object(
        'id', package.id::text, 'name', package.name, 'description', package.description,
        'priceCents', package.price_cents, 'durationMinutes', package.duration_minutes,
        'deliveryDays', package.delivery_days, 'revisionCount', package.revision_count,
        'features', package.features) ORDER BY package.sort_order)
       FROM service_packages package WHERE package.service_id=s.id AND package.is_active=true) AS packages,
      (SELECT jsonb_agg(jsonb_build_object(
        'id', addon.id::text, 'name', addon.name, 'description', addon.description,
        'priceCents', addon.price_cents, 'additionalMinutes', addon.additional_minutes,
        'allowsQuantity', addon.allows_quantity, 'maxQuantity', addon.max_quantity) ORDER BY addon.sort_order)
       FROM service_add_ons addon WHERE addon.service_id=s.id AND addon.is_active=true) AS add_ons
    FROM services s WHERE s.id=$1`, [service.id]);
  const evidence = await database.query<{
    completed_job_count: string;
    review_count: string;
    average_rating: string | null;
    screening_checked_at: Date | null;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM bookings b WHERE b.service_id = $1 AND b.status = 'completed')::text AS completed_job_count,
       (SELECT COUNT(*) FROM reviews r WHERE r.service_id = $1 AND r.is_hidden = false)::text AS review_count,
       (SELECT AVG(r.rating) FROM reviews r WHERE r.service_id = $1 AND r.is_hidden = false)::text AS average_rating,
       (SELECT p.screening_checked_at FROM provider_profiles p WHERE p.id = $2 LIMIT 1) AS screening_checked_at`,
    [service.id, service.providerId],
  );
  const details = evidence.rows[0];
  const commerce = commerceResult.rows[0];
  return {
    ...service,
    estimatedMinMinutes: result.rows[0].estimated_min_minutes ?? null,
    estimatedMaxMinutes: result.rows[0].estimated_max_minutes ?? null,
    completedJobCount: Number(details?.completed_job_count ?? 0),
    reviewCount: Number(details?.review_count ?? 0),
    averageRating: details?.average_rating ? Number(details.average_rating) : null,
    screeningCheckedAt: details?.screening_checked_at ?? null,
    serviceKind: commerce?.service_kind ?? "standard",
    preparationNotes: commerce?.preparation_notes ?? "",
    recurrenceOptions: commerce?.recurrence_options?.length ? commerce.recurrence_options : ["one_time"],
    packages: commerce?.packages ?? [],
    addOns: commerce?.add_ons ?? [],
  };
}

export async function getServiceById(id: string) {
  if (!isDatabaseConfigured()) return null;
  await reconcileExpiredComplimentaryProGrants();
  const result = await database.query<ServiceRow>(
    `SELECT s.id::text, s.slug, s.title, s.category, s.delivery_type, s.remote_delivery_details, s.description, s.price_cents,
            s.duration_minutes, s.pricing_type, s.hourly_rate_cents, s.minimum_duration_minutes, s.maximum_duration_minutes, s.billing_increment_minutes, s.default_duration_minutes,
            p.id::text AS provider_id, p.public_profile_slug AS provider_slug, p.public_profile_visible AS provider_profile_visible,
            s.business_name, owner.image AS provider_profile_image_url,
            (SELECT round(avg(review.rating)::numeric, 1)::float FROM reviews review WHERE review.provider_id = p.id AND review.is_hidden = false) AS provider_average_rating,
            (SELECT count(*)::int FROM reviews review WHERE review.provider_id = p.id AND review.is_hidden = false) AS provider_review_count,
            CASE WHEN p.plan IN ('pro', 'business', 'owner') THEN COALESCE(s.city, p.city) ELSE p.city END AS city,
            CASE WHEN p.plan IN ('pro', 'business', 'owner') THEN COALESCE(s.state, p.state) ELSE p.state END AS state,
            CASE WHEN p.plan IN ('pro', 'business', 'owner') THEN s.booking_questions ELSE '[]'::jsonb END AS booking_questions, owner."emailVerified" AS email_verified,
            p.plan AS provider_plan, p.is_verified, p.screening_status, p.screening_checked_at, p.phone_verified, p.identity_verified, p.business_verified,
            p.cancellation_window_hours, p.cancellation_policy, p.no_show_policy, p.service_radius_miles,
            COALESCE((
              SELECT array_agg(si.public_url ORDER BY si.sort_order, si.created_at)
              FROM service_images si WHERE si.service_id = s.id
            ), ARRAY[]::text[]) AS image_urls
     FROM services s
     JOIN provider_profiles p ON p.id = s.provider_id
     JOIN "user" owner ON owner.id = p.user_id
     WHERE s.id::text = $1 AND s.is_active = true AND s.provider_deleted_at IS NULL
       AND p.is_active = true AND p.age_verification_status = 'verified'
     LIMIT 1`,
    [id],
  );
  return result.rows[0] ? mapService(result.rows[0]) : null;
}

export async function getProviderBySlug(slug: string, options: { includeHidden?: boolean; ownerProviderId?: string } = {}) {
  if (!isDatabaseConfigured()) return null;
  await reconcileExpiredComplimentaryProGrants();
  const providerResult = await database.query<{
    id: string;
    public_profile_slug: string;
    owner_name: string;
    public_personal_name_visible: boolean;
    business_name: string;
    bio: string;
    city: string;
    state: string;
    is_verified: boolean;
    screening_status: "not_screened" | "passed" | "needs_changes";
    screening_checked_at: Date | null;
    email_verified: boolean;
    phone_verified: boolean;
    identity_verified: boolean;
    business_verified: boolean;
    profile_image_url: string | null;
    cancellation_window_hours: number;
    cancellation_policy: string;
    no_show_policy: string;
    public_profile_visible: boolean;
    years_experience: number | null;
    experience_summary: string;
    specialties: string[];
    languages: string[];
    provider_highlights: string[];
  }>(
    `SELECT p.id::text, p.public_profile_slug, owner.name AS owner_name,
            COALESCE(settings.public_personal_name_visible, false) AS public_personal_name_visible,
            p.business_name, p.bio, p.city, p.state,
            p.is_verified, p.screening_status, p.screening_checked_at, owner."emailVerified" AS email_verified, p.phone_verified,
            p.identity_verified, p.business_verified, p.cancellation_window_hours,
            p.cancellation_policy, p.no_show_policy, owner.image AS profile_image_url,
            p.public_profile_visible, p.years_experience, p.experience_summary,
            p.specialties, p.languages, p.provider_highlights
     FROM provider_profiles p
     JOIN "user" owner ON owner.id = p.user_id
     LEFT JOIN user_settings settings ON settings.user_id = owner.id
     WHERE (lower(p.public_profile_slug) = lower($1) OR p.id::text = $1)
       AND p.is_active = true
       AND p.age_verification_status = 'verified'
       AND (
         ($2::text IS NOT NULL AND p.id::text = $2)
         OR
         ($2::text IS NULL
           AND ($3::boolean = true OR p.public_profile_visible = true)
           AND EXISTS (SELECT 1 FROM services active_service WHERE active_service.provider_id = p.id
             AND active_service.is_active = true AND active_service.provider_deleted_at IS NULL))
       )
     LIMIT 1`,
    [slug, options.ownerProviderId ?? null, options.includeHidden === true],
  );
  const provider = providerResult.rows[0];
  if (!provider) return null;

  const services = await getServicesForProvider(provider.id);
  const reviewsResult = await database.query<{ id: string; rating: number; body: string; customer_name: string; service_title: string; created_at: Date }>(
    `SELECT r.id::text, r.rating, r.body, customer.name AS customer_name,
            s.title AS service_title, r.created_at
     FROM reviews r
     JOIN bookings b ON b.id = r.booking_id AND b.status = 'completed'
     JOIN "user" customer ON customer.id = r.customer_id
     JOIN services s ON s.id = r.service_id
     WHERE r.provider_id::text = $1 AND r.is_hidden = false
     ORDER BY r.created_at DESC
     LIMIT 20`,
    [provider.id],
  );
  const portfolioResult = await database.query<{ id: string; public_url: string; caption: string; alt_text: string; service_id: string | null; service_title: string | null }>(
    `SELECT item.id::text, item.public_url, item.caption, item.alt_text, item.service_id::text,
            service.title AS service_title
     FROM provider_portfolio_items item
     LEFT JOIN services service ON service.id = item.service_id AND service.is_active = true
     WHERE item.provider_id = $1 AND item.moderation_status = 'active'
     ORDER BY item.sort_order, item.created_at`,
    [provider.id],
  );
  const recommendationsResult = await database.query<{id:string;display_name:string;relationship:string;body:string;created_at:Date}>(
    `SELECT id::text,display_name,relationship,body,created_at FROM provider_recommendations
     WHERE provider_id::text=$1 AND moderation_status='approved' ORDER BY created_at DESC LIMIT 12`,
    [provider.id],
  );
  const evidenceResult = await database.query<{ completed_booking_count: string; service_areas: string[] | null; available_weekdays: number[] | null }>(
    `SELECT
       (SELECT count(*)::text FROM bookings booking WHERE booking.provider_id = $1 AND booking.status = 'completed') AS completed_booking_count,
       (SELECT array_agg(DISTINCT area.city || ', ' || area.state ORDER BY area.city || ', ' || area.state)
        FROM provider_location_service_areas area
        JOIN provider_locations location ON location.id = area.location_id
        JOIN provider_companies company ON company.id = location.company_id
        WHERE company.provider_id = $1 AND company.is_active = true AND location.is_active = true
          AND EXISTS (SELECT 1 FROM services local_service WHERE local_service.location_id = location.id AND local_service.is_active = true AND local_service.delivery_type IN ('IN_PERSON','BOTH'))) AS service_areas,
       (SELECT array_agg(DISTINCT availability.weekday ORDER BY availability.weekday)
        FROM availability WHERE availability.provider_id = $1) AS available_weekdays`,
    [provider.id],
  );
  const privateCustomerName = (name: string) => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return parts.length > 1 ? `${parts[0]} ${parts.at(-1)?.charAt(0)}.` : parts[0] || "BubsBookings customer";
  };
  const evidence = evidenceResult.rows[0];
  const screeningCurrent = isProviderScreeningCurrent(provider.screening_checked_at);
  return {
    id: provider.id,
    publicSlug: provider.public_profile_slug,
    publicOwnerName: publicPersonalName(provider.owner_name, provider.public_personal_name_visible),
    businessName: services[0]?.provider ?? provider.business_name,
    bio: provider.bio,
    city: provider.city,
    state: provider.state,
    isVerified: screeningCurrent && provider.is_verified && provider.screening_status === "passed",
    emailVerified: provider.email_verified,
    phoneVerified: screeningCurrent && provider.phone_verified,
    identityVerified: screeningCurrent && provider.identity_verified,
    businessVerified: screeningCurrent && provider.business_verified,
    profileImageUrl: provider.profile_image_url ?? "",
    cancellationWindowHours: provider.cancellation_window_hours,
    cancellationPolicy: provider.cancellation_policy,
    noShowPolicy: provider.no_show_policy,
    yearsExperience: provider.years_experience,
    experienceSummary: provider.experience_summary,
    specialties: provider.specialties ?? [],
    languages: provider.languages ?? [],
    highlights: provider.provider_highlights ?? [],
    completedBookingCount: Number(evidence?.completed_booking_count ?? 0),
    serviceAreas: evidence?.service_areas ?? [],
    hasRemoteServices: services.some((service) => service.deliveryType === "REMOTE" || service.deliveryType === "BOTH"),
    hasInPersonServices: services.some((service) => service.deliveryType === "IN_PERSON" || service.deliveryType === "BOTH"),
    availableWeekdays: evidence?.available_weekdays ?? [],
    portfolio: portfolioResult.rows.map((item) => ({ id: item.id, url: item.public_url, caption: item.caption, altText: item.alt_text, serviceId: item.service_id, serviceTitle: item.service_title })),
    reviews: reviewsResult.rows.map((review) => ({ id: review.id, rating: review.rating, body: review.body, customerName: privateCustomerName(review.customer_name), serviceTitle: review.service_title, createdAt: review.created_at })),
    recommendations: recommendationsResult.rows.map((item)=>({id:item.id,displayName:item.display_name,relationship:item.relationship,body:item.body,createdAt:item.created_at})),
    services,
  };
}

async function getServicesForProvider(providerId: string) {
  const result = await database.query<ServiceRow>(
    `SELECT s.id::text, s.slug, s.title, s.category, s.delivery_type, s.remote_delivery_details, s.description, s.price_cents,
            s.duration_minutes, s.pricing_type, s.hourly_rate_cents, s.minimum_duration_minutes, s.maximum_duration_minutes, s.billing_increment_minutes, s.default_duration_minutes,
            p.id::text AS provider_id, p.public_profile_slug AS provider_slug, p.public_profile_visible AS provider_profile_visible,
            s.business_name, CASE WHEN p.plan IN ('pro', 'business', 'owner') THEN COALESCE(s.city, p.city) ELSE p.city END AS city,
            CASE WHEN p.plan IN ('pro', 'business', 'owner') THEN COALESCE(s.state, p.state) ELSE p.state END AS state,
            CASE WHEN p.plan IN ('pro', 'business', 'owner') THEN s.booking_questions ELSE '[]'::jsonb END AS booking_questions, owner."emailVerified" AS email_verified,
            p.plan AS provider_plan, p.is_verified, p.screening_status, p.screening_checked_at, p.phone_verified, p.identity_verified, p.business_verified,
            p.cancellation_window_hours, p.cancellation_policy, p.no_show_policy, p.service_radius_miles,
            COALESCE((
              SELECT array_agg(si.public_url ORDER BY si.sort_order, si.created_at)
              FROM service_images si WHERE si.service_id = s.id
            ), ARRAY[]::text[]) AS image_urls
     FROM services s
     JOIN provider_profiles p ON p.id = s.provider_id
     JOIN "user" owner ON owner.id = p.user_id
     WHERE p.id = $1 AND p.is_active = true AND p.age_verification_status = 'verified'
       AND s.is_active = true AND s.provider_deleted_at IS NULL
     ORDER BY s.created_at DESC`,
    [providerId],
  );
  return result.rows.map(mapService);
}

export async function getFavoriteServices(customerId: string) {
  if (!isDatabaseConfigured()) return [];
  await reconcileExpiredComplimentaryProGrants();
  const result = await database.query<ServiceRow>(
    `SELECT s.id::text, s.slug, s.title, s.category, s.delivery_type, s.remote_delivery_details, s.description, s.price_cents,
            s.duration_minutes, s.pricing_type, s.hourly_rate_cents, s.minimum_duration_minutes, s.maximum_duration_minutes, s.billing_increment_minutes, s.default_duration_minutes,
            p.id::text AS provider_id, p.public_profile_slug AS provider_slug, p.public_profile_visible AS provider_profile_visible,
            s.business_name, CASE WHEN p.plan IN ('pro', 'business', 'owner') THEN COALESCE(s.city, p.city) ELSE p.city END AS city,
            CASE WHEN p.plan IN ('pro', 'business', 'owner') THEN COALESCE(s.state, p.state) ELSE p.state END AS state,
            CASE WHEN p.plan IN ('pro', 'business', 'owner') THEN s.booking_questions ELSE '[]'::jsonb END AS booking_questions, owner."emailVerified" AS email_verified,
            p.plan AS provider_plan, p.is_verified, p.screening_status, p.screening_checked_at, p.phone_verified, p.identity_verified, p.business_verified,
            p.cancellation_window_hours, p.cancellation_policy, p.no_show_policy, p.service_radius_miles,
            COALESCE((
              SELECT array_agg(si.public_url ORDER BY si.sort_order, si.created_at)
              FROM service_images si WHERE si.service_id = s.id
            ), ARRAY[]::text[]) AS image_urls
     FROM favorites f
     JOIN services s ON s.id = f.service_id
     JOIN provider_profiles p ON p.id = s.provider_id
     JOIN "user" owner ON owner.id = p.user_id
     WHERE f.customer_id = $1 AND s.is_active = true AND s.provider_deleted_at IS NULL
       AND p.is_active = true AND p.age_verification_status = 'verified'
     ORDER BY f.created_at DESC`,
    [customerId],
  );
  return result.rows.map(mapService);
}

export function formatDuration(minutes: number) {
  if (minutes >= 1440) {
    const days = Math.floor(minutes / 1440);
    const remainingHours = Math.round(((minutes % 1440) / 60) * 100) / 100;
    return remainingHours ? `${days} ${days === 1 ? "day" : "days"}, ${remainingHours} ${remainingHours === 1 ? "hour" : "hours"}` : `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/** Compatibility lookup for existing message links. Public pages should use getProviderBySlug. */
export async function getProviderById(id: string) {
  return getProviderBySlug(id, { includeHidden: true });
}

export function getServiceVisual(category: string) {
  // Legacy callers still use the category background. The icon always comes from ServiceCategoryIcon.
  return { gradient: getServiceCategoryIconConfig(category).background };
}
