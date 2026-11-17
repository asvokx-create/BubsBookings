import { AFFILIATE_LEGAL_DOCUMENTS } from "./legal-document-versions.ts";

type AgreementProfile = {
  partner_agreement_version: string | null;
  terms_version: string | null;
  privacy_version: string | null;
  agreement_reacceptance_required_at: Date | string | null;
};

export function affiliateRequiresAgreementReacceptance(profile: AgreementProfile) {
  if (profile.agreement_reacceptance_required_at) return true;
  // Preserve legacy accounts without fabricating acceptance history.
  if (profile.partner_agreement_version === null) return false;
  const currentPrivacy = AFFILIATE_LEGAL_DOCUMENTS.privacyPolicy.version;
  // This specific factual clarification does not require existing partners to
  // acknowledge privacy again. Do not carry this exception into future versions.
  const privacyCompatible = profile.privacy_version === currentPrivacy
    || (currentPrivacy === "2026-11-16" && profile.privacy_version === "2026-10-22");
  return profile.partner_agreement_version !== AFFILIATE_LEGAL_DOCUMENTS.partnerAgreement.version
    || profile.terms_version !== AFFILIATE_LEGAL_DOCUMENTS.termsOfService.version
    || !privacyCompatible;
}
