import "server-only";

import { database, isDatabaseConfigured } from "@/lib/database";
import type { ServiceDeliveryType } from "@/lib/service-delivery";

export type PublicSeoListing = {
  serviceSlug: string;
  serviceUpdatedAt: Date;
  category: string;
  deliveryType: ServiceDeliveryType;
  city: string;
  state: string;
  imageUrls: string[];
  companySlug: string;
  companyUpdatedAt: Date;
  providerSlug: string;
  providerProfileVisible: boolean;
  providerUpdatedAt: Date;
};

export async function getPublicSeoInventory(): Promise<PublicSeoListing[]> {
  if (!isDatabaseConfigured()) return [];
  const result = await database.query<{
    service_slug: string;
    service_updated_at: Date;
    category: string;
    delivery_type: ServiceDeliveryType;
    city: string;
    state: string;
    image_urls: string[] | null;
    company_slug: string;
    company_updated_at: Date;
    provider_slug: string;
    provider_profile_visible: boolean;
    provider_updated_at: Date;
  }>(
    `SELECT service.slug AS service_slug, service.updated_at AS service_updated_at,
            service.category, service.delivery_type,
            CASE WHEN provider.plan IN ('pro', 'business', 'owner') THEN COALESCE(service.city, provider.city) ELSE provider.city END AS city,
            CASE WHEN provider.plan IN ('pro', 'business', 'owner') THEN COALESCE(service.state, provider.state) ELSE provider.state END AS state,
            COALESCE((SELECT array_agg(image.public_url ORDER BY image.sort_order, image.created_at)
              FROM service_images image WHERE image.service_id = service.id), ARRAY[]::text[]) AS image_urls,
            company.slug AS company_slug, company.updated_at AS company_updated_at,
            provider.public_profile_slug AS provider_slug,
            provider.public_profile_visible AS provider_profile_visible,
            provider.updated_at AS provider_updated_at
     FROM services service
     JOIN provider_companies company ON company.id = service.company_id AND company.is_active = true
     JOIN provider_profiles provider ON provider.id = service.provider_id
       AND provider.is_active = true AND provider.age_verification_status = 'verified'
     WHERE service.is_active = true AND service.provider_deleted_at IS NULL
     ORDER BY service.updated_at DESC, service.slug`,
  );

  return result.rows.map((row) => ({
    serviceSlug: row.service_slug,
    serviceUpdatedAt: row.service_updated_at,
    category: row.category,
    deliveryType: row.delivery_type,
    city: row.city,
    state: row.state,
    imageUrls: row.image_urls ?? [],
    companySlug: row.company_slug,
    companyUpdatedAt: row.company_updated_at,
    providerSlug: row.provider_slug,
    providerProfileVisible: row.provider_profile_visible,
    providerUpdatedAt: row.provider_updated_at,
  }));
}
