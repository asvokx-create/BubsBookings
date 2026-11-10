import assert from "node:assert/strict";
import test from "node:test";

import {
  POLICY_EFFECTIVE_DATE,
  POLICY_VERSION,
  PARTNER_AGREEMENT_VERSION,
  PROVIDER_AGREEMENT_VERSION,
  createPolicyConsentFields,
} from "../lib/policy-consent.ts";
import {
  createPolicyConsentAttestation,
  hasValidPolicyConsentAttestation,
  POLICY_CONSENT_COOKIE,
} from "../lib/policy-consent-attestation.ts";

test("legal policy versions match their displayed effective dates", () => {
  assert.equal(POLICY_VERSION, "2026-11-09");
  assert.equal(PROVIDER_AGREEMENT_VERSION, "2026-11-09");
  assert.equal(PARTNER_AGREEMENT_VERSION, "2026-10-22");
  assert.equal(POLICY_EFFECTIVE_DATE, "November 9, 2026");
});

test("new account consent records use the current policy version", () => {
  const consent = createPolicyConsentFields();
  assert.equal(consent.policyVersion, POLICY_VERSION);
  assert.ok(Number.isFinite(Date.parse(consent.termsAcceptedAt)));
  assert.equal(consent.termsAcceptedAt, consent.privacyAcknowledgedAt);
  assert.equal(consent.termsAcceptedAt, consent.aiSafetyAcknowledgedAt);
});

test("server-verifiable consent attestation expires and cannot be replaced with a client timestamp", () => {
  const now = new Date("2026-10-17T12:00:00.000Z");
  const token = createPolicyConsentAttestation(now);
  assert.equal(hasValidPolicyConsentAttestation(`${POLICY_CONSENT_COOKIE}=${token}`, new Date("2026-10-17T12:10:00.000Z")), true);
  assert.equal(hasValidPolicyConsentAttestation(`${POLICY_CONSENT_COOKIE}=not-a-valid-token`, now), false);
  assert.equal(hasValidPolicyConsentAttestation(`${POLICY_CONSENT_COOKIE}=${token}`, new Date("2026-10-17T12:31:00.000Z")), false);
});
