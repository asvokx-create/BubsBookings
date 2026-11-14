import "server-only";
import { database, isDatabaseConfigured } from "./database";
import { ageActivationStep, listingInactiveReasons, type ProviderAgeVerificationStatus } from "./provider-activation";

// Never look up a private listing without scoping it to the authenticated owner.
export const OWNER_LISTING_STATUS_SQL = `SELECT s.is_active, s.age_verification_blocked,
  p.is_active AS provider_is_active, COALESCE(c.is_active, false) AS company_is_active,
  p.age_verification_status
  FROM services s JOIN provider_profiles p ON p.id=s.provider_id
  LEFT JOIN provider_companies c ON c.id=s.company_id
  WHERE s.slug=$1 AND p.user_id=$2 AND s.provider_deleted_at IS NULL LIMIT 1`;

export async function getOwnerPrivateListingStatus(slug: string, userId: string) {
  if (!userId || !isDatabaseConfigured()) return null;
  const result = await database.query<{
    is_active: boolean; age_verification_blocked: boolean; provider_is_active: boolean;
    company_is_active: boolean; age_verification_status: ProviderAgeVerificationStatus;
  }>(OWNER_LISTING_STATUS_SQL, [slug, userId]);
  const row = result.rows[0];
  if (!row) return null;
  const reasons = listingInactiveReasons({
    isActive: row.is_active, ageVerificationBlocked: row.age_verification_blocked,
    providerIsActive: row.provider_is_active, companyIsActive: row.company_is_active,
    ageVerificationStatus: row.age_verification_status,
  });
  // A stale age-verification flag must not hide an inactive listing’s owner explanation.
  if (!reasons.length && !row.is_active) reasons.push("This service listing is inactive. Review its status in your dashboard.");
  if (!reasons.length) return null;
  return {
    reasons,
    ageDetail: row.age_verification_status !== "verified" ? ageActivationStep(row.age_verification_status).detail : null,
  };
}
