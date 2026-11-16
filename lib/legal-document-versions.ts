import { PARTNER_AGREEMENT_VERSION, TERMS_OF_SERVICE_VERSION, PRIVACY_POLICY_VERSION } from "./policy-consent.ts";

export const AFFILIATE_LEGAL_DOCUMENTS = {
  partnerAgreement: {
    key: "partner_agreement",
    version: PARTNER_AGREEMENT_VERSION,
    publicPath: "/partner-agreement",
    sourcePath: "app/partner-agreement/page.tsx",
    contentHash: "978d5acf7b38e979776543f0d36fa1e3f646a0b2443872732471c9c0cc076cf5",
  },
  termsOfService: {
    key: "terms_of_service",
    version: TERMS_OF_SERVICE_VERSION,
    publicPath: "/terms",
    sourcePath: "app/terms/page.tsx",
    contentHash: "d51452e04d17ea7b1d0213a045bdae0671f0eaaf655c26d571d842d933a2cdd3",
  },
  privacyPolicy: {
    key: "privacy_policy",
    version: PRIVACY_POLICY_VERSION,
    publicPath: "/privacy",
    sourcePath: "app/privacy/page.tsx",
    contentHash: "f93473d3ec3842bdefeb278fc1a6bd9c45ffbfc61c87ebd41b0ccbb90e9c009e",
  },
} as const;

export const AFFILIATE_LEGAL_DOCUMENT_LIST = Object.values(AFFILIATE_LEGAL_DOCUMENTS);
