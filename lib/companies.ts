import "server-only";

import { database, isDatabaseConfigured } from "@/lib/database";
import { isProviderScreeningCurrent } from "@/lib/provider-screening-freshness";
import type { PricingType } from "@/lib/service-pricing";

export type CompanyPage = {
  id: string;
  slug: string;
  name: string;
  bio: string;
  city: string;
  state: string;
  publicOwnerName: string | null;
  providerSlug: string;
  providerProfileVisible: boolean;
  verified: boolean;
  locations: Array<{ id: string; name: string; city: string; state: string; serviceRadiusMiles: number }>;
  services: Array<{
    id: string;
    slug: string;
    title: string;
    category: string;
    description: string;
    price: number;
    pricingType: PricingType;
    hourlyRateCents: number | null;
    minimumDurationMinutes: number | null;
    imageUrl: string;
    locationName: string | null;
    location: string;
    deliveryType: "IN_PERSON" | "REMOTE" | "BOTH";
  }>;
};

export async function getCompanyBySlug(slug: string): Promise<CompanyPage | null> {
  if (!isDatabaseConfigured()) return null;
  const companyResult = await database.query<{
    id: string; slug: string; name: string; bio: string; city: string; state: string;
    public_owner_name: string | null; provider_slug: string; provider_profile_visible: boolean; is_verified: boolean; screening_status: string; screening_checked_at: Date | null;
  }>(
    `SELECT company.id::text, company.slug, company.name, company.bio, company.city, company.state,
            CASE WHEN COALESCE(settings.public_personal_name_visible, false) THEN owner.name ELSE NULL END AS public_owner_name,
            provider.public_profile_slug AS provider_slug, provider.public_profile_visible AS provider_profile_visible,
            provider.is_verified, provider.screening_status, provider.screening_checked_at
     FROM provider_companies company
     JOIN provider_profiles provider ON provider.id = company.provider_id
       AND provider.is_active = true AND provider.age_verification_status = 'verified'
     JOIN "user" owner ON owner.id = provider.user_id
     LEFT JOIN user_settings settings ON settings.user_id = owner.id
     WHERE company.slug = $1 AND company.is_active = true
     LIMIT 1`,
    [slug],
  );
  const company = companyResult.rows[0];
  if (!company) return null;
  const screeningCurrent = isProviderScreeningCurrent(company.screening_checked_at);
  const locationResult = await database.query<{ id: string; name: string; city: string; state: string; service_radius_miles: number }>(
    `SELECT id::text, name, city, state, service_radius_miles FROM provider_locations
     WHERE company_id::text = $1 AND is_active = true ORDER BY is_primary DESC, created_at`, [company.id],
  );
  const serviceResult = await database.query<{
    id: string; slug: string; title: string; category: string; description: string;
    price_cents: number; pricing_type: PricingType; hourly_rate_cents: number | null; minimum_duration_minutes: number | null; image_url: string | null; location_name: string | null; city: string | null; state: string | null; delivery_type: "IN_PERSON" | "REMOTE" | "BOTH";
  }>(
    `SELECT service.id::text, service.slug, service.title, service.category, service.description,
            service.price_cents, service.pricing_type, service.hourly_rate_cents, service.minimum_duration_minutes,
            service.delivery_type, location.name AS location_name, location.city, location.state,
            (SELECT image.public_url FROM service_images image WHERE image.service_id = service.id ORDER BY image.sort_order, image.created_at LIMIT 1) AS image_url
     FROM services service
     LEFT JOIN provider_locations location ON location.id = service.location_id AND location.is_active = true
     WHERE service.company_id::text = $1 AND service.is_active = true
       AND service.provider_deleted_at IS NULL
     ORDER BY service.created_at DESC`,
    [company.id],
  );
  return {
    id: company.id,
    slug: company.slug,
    name: company.name,
    bio: company.bio,
    city: company.city,
    state: company.state,
    publicOwnerName: company.public_owner_name,
    providerSlug: company.provider_slug,
    providerProfileVisible: company.provider_profile_visible,
    verified: screeningCurrent && company.is_verified && company.screening_status === "passed",
    locations: locationResult.rows.map((location) => ({ id: location.id, name: location.name, city: location.city, state: location.state, serviceRadiusMiles: location.service_radius_miles })),
    services: serviceResult.rows.map((service) => ({
      id: service.id,
      slug: service.slug,
      title: service.title,
      category: service.category,
      description: service.description,
      price: service.price_cents / 100,
      pricingType: service.pricing_type,
      hourlyRateCents: service.hourly_rate_cents,
      minimumDurationMinutes: service.minimum_duration_minutes,
      imageUrl: service.image_url ?? "",
      locationName: service.location_name,
      location: service.delivery_type === "REMOTE" ? "Available online" : `${service.city}, ${service.state}`,
      deliveryType: service.delivery_type,
    })),
  };
}
