import "server-only";

import { database, isDatabaseConfigured } from "@/lib/database";
import type { PublicSlugRouteKind } from "@/lib/public-slug-route";

export async function publicSlugExists(kind: PublicSlugRouteKind, slug: string): Promise<boolean | null> {
  if (!isDatabaseConfigured()) return null;

  const conditions: Record<PublicSlugRouteKind, string> = {
    services: `EXISTS (
      SELECT 1
      FROM services service
      JOIN provider_companies company ON company.id = service.company_id AND company.is_active = true
      JOIN provider_profiles provider ON provider.id = service.provider_id
      WHERE service.slug = $1
        AND service.is_active = true
        AND service.provider_deleted_at IS NULL
        AND provider.is_active = true
        AND provider.age_verification_status = 'verified'
    )`,
    providers: `EXISTS (
      SELECT 1
      FROM provider_profiles provider
      WHERE (lower(provider.public_profile_slug) = lower($1) OR provider.id::text = $1)
        AND provider.is_active = true
        AND provider.age_verification_status = 'verified'
        AND provider.public_profile_visible = true
        AND EXISTS (
          SELECT 1 FROM services service
          WHERE service.provider_id = provider.id
            AND service.is_active = true
            AND service.provider_deleted_at IS NULL
        )
    )`,
    companies: `EXISTS (
      SELECT 1
      FROM provider_companies company
      JOIN provider_profiles provider ON provider.id = company.provider_id
      WHERE company.slug = $1
        AND company.is_active = true
        AND provider.is_active = true
        AND provider.age_verification_status = 'verified'
    )`,
  };

  try {
    const result = await database.query<{ exists: boolean }>(`SELECT ${conditions[kind]} AS exists`, [slug]);
    return result.rows[0]?.exists ?? false;
  } catch {
    console.error("Public route existence check failed", kind);
    return null;
  }
}
