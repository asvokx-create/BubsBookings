# Stripe Identity age-result recovery

Current code previously expanded only `verified_outputs`; Stripe requires explicit `verified_outputs.dob` with a restricted key. Ordinary secret keys cannot retrieve DOB. A missing result must not be treated as proof of underage status or lead to repeated ID submissions.

## Deployment prerequisites (not performed)
- Keep the existing `STRIPE_SECRET_KEY` for session creation and payments.
- Configure a separate matching-mode `STRIPE_IDENTITY_RESTRICTED_KEY` securely, with **Identity Verification Results: Read** and **Recent Detailed Verification Results: Read** only. No Files permission or document-image access needed.
- Stripe restricts sensitive results older than 48 hours unless the key is IP-restricted and additionally granted **All Detailed Verification Results: Read**. Verify fixed application egress IP support before choosing an allowlist. Public ingress IPs are not egress IPs. Do not broadly weaken restrictions to recover an old result.
- This adds access to sensitive Identity results and requires owner approval before key creation/configuration. Never paste the key into chat.
- Test with synthetic sandbox Identity sessions; verify no DOB appears in app logs, responses, storage, notifications or audit records.
- Deployment alone cannot recover records if the key/permissions/age window are unsuitable. Reconciliation of an existing session can restore listings and send notices, so carry it out only in the approved workflow and verify the result. Do not mark support requests resolved before success.

The app rejects absent, wrong-type, or wrong-mode key configuration before starting a new session. Key-format validation cannot prove permissions; a synthetic verification must establish them before rollout. If an existing verified session returns no DOB or access fails, the app fails closed and preserves the session for reconciliation. No schema migration and no automatic batch recovery is included. No account is manually marked verified.

Reference: https://docs.stripe.com/identity/access-verification-results
