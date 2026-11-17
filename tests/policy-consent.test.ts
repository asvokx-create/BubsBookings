import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";

import {
  POLICY_EFFECTIVE_DATE,
  PROVIDER_AGREEMENT_EFFECTIVE_DATE,
  POLICY_VERSION,
  TERMS_OF_SERVICE_VERSION,
  PRIVACY_POLICY_VERSION,
  ADMIN_AGE_POLICY_EFFECTIVE_DATE,
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
  assert.equal(PROVIDER_AGREEMENT_EFFECTIVE_DATE, "November 17, 2026");
  assert.equal(POLICY_VERSION, "2026-11-17");
  assert.equal(TERMS_OF_SERVICE_VERSION, "2026-11-09");
  assert.equal(PRIVACY_POLICY_VERSION, "2026-11-16");
  assert.equal(ADMIN_AGE_POLICY_EFFECTIVE_DATE, "November 16, 2026");
  assert.equal(PROVIDER_AGREEMENT_VERSION, "2026-11-17");
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

test("unexpired consent from the previous live bundle is not accepted for hourly terms", () => {
  const now = new Date("2026-11-17T12:00:00.000Z");
  const current = createPolicyConsentAttestation(now);
  const payload = JSON.parse(Buffer.from(current.split(".")[0], "base64url").toString("utf8"));
  payload.policyVersion = "2026-11-16";
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const secret = process.env.BETTER_AUTH_SECRET?.trim() || "bookme-local-development-secret-change-before-deploy";
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  assert.equal(hasValidPolicyConsentAttestation(`${POLICY_CONSENT_COOKIE}=${current}`, now), true);
  assert.equal(hasValidPolicyConsentAttestation(`${POLICY_CONSENT_COOKIE}=${encoded}.${signature}`, now), false);
});
