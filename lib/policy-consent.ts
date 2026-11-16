// Version of the current consent bundle, including the revised privacy policy.
export const POLICY_VERSION = "2026-11-16";
export const TERMS_OF_SERVICE_VERSION = "2026-10-22";
export const PROVIDER_AGREEMENT_VERSION = "2026-11-16";
export const PARTNER_AGREEMENT_VERSION = "2026-10-22";
export const POLICY_EFFECTIVE_DATE = "October 22, 2026";

export function createPolicyConsentFields() {
  const acceptedAt = new Date().toISOString();
  return {
    termsAcceptedAt: acceptedAt,
    privacyAcknowledgedAt: acceptedAt,
    aiSafetyAcknowledgedAt: acceptedAt,
    policyVersion: POLICY_VERSION,
  };
}

export const PRIVACY_POLICY_VERSION = "2026-11-16";
export const ADMIN_AGE_POLICY_EFFECTIVE_DATE = "November 16, 2026";
