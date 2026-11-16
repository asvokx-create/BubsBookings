import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { affiliateRequiresAgreementReacceptance } from "../lib/affiliate-agreement-reacceptance.ts";
import { AFFILIATE_LEGAL_DOCUMENTS } from "../lib/legal-document-versions.ts";

const existing = {
  partner_agreement_version: AFFILIATE_LEGAL_DOCUMENTS.partnerAgreement.version,
  terms_version: AFFILIATE_LEGAL_DOCUMENTS.termsOfService.version,
  privacy_version: "2026-10-22",
  agreement_reacceptance_required_at: null,
};
test("factual privacy revision does not force existing partners to reaccept", () => {
  assert.equal(affiliateRequiresAgreementReacceptance(existing), false);
  assert.equal(affiliateRequiresAgreementReacceptance({ ...existing, privacy_version: AFFILIATE_LEGAL_DOCUMENTS.privacyPolicy.version }), false);
});
test("explicit administrator reacceptance request always wins", () => {
  assert.equal(affiliateRequiresAgreementReacceptance({ ...existing, agreement_reacceptance_required_at: new Date() }), true);
  assert.equal(affiliateRequiresAgreementReacceptance({ ...existing, partner_agreement_version: null, agreement_reacceptance_required_at: new Date() }), true);
});
test("compatibility does not waive other terms, partner, or missing privacy acknowledgments", () => {
  for (const changes of [
    { terms_version: "older" }, { partner_agreement_version: "older" },
    { privacy_version: null }, { privacy_version: "2026-10-14" },
  ]) assert.equal(affiliateRequiresAgreementReacceptance({ ...existing, ...changes }), true);
});
test("legacy accounts stay unchanged without manufactured acceptance", () => {
  assert.equal(affiliateRequiresAgreementReacceptance({ ...existing, partner_agreement_version: null, privacy_version: null }), false);
});
test("dashboard and authenticated acceptance route share compatibility decision", () => {
  for (const path of ["app/affiliate/page.tsx", "app/api/affiliates/agreements/route.ts"]) {
    assert.match(readFileSync(path, "utf8"), /affiliateRequiresAgreementReacceptance\(profile\)/);
  }
});
