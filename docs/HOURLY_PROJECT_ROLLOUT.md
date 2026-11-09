# Tracked hourly projects: release plan

## Implemented behavior

- New hourly listings start a tracked project, not a prepaid booking. Fixed-price and quote-only bookings remain unchanged.
- The customer sets a maximum authorized number of work hours. This is a cap, not a purchase or estimate of required hours. The customer can raise it; providers cannot.
- The hourly rate is locked when the project is requested. Existing prepaid bookings retain their original snapshots and payment history.
- The provider accepts, tracks work with a server-timed start/stop timer, and can add or correct manual entries. A running timer has its original allowance frozen and cannot accrue beyond it, even if left unattended.
- The provider submits one final timesheet. The customer can request corrections before approval. After approval, entries and the billed amount are locked.
- Time is summed in seconds across entries, then rounded up once to a whole minute. The dollar amount is rounded to the nearest cent. Legacy minimum-duration and 15/30/60-minute increment settings do not apply to new tracked projects.
- The customer actively opens Stripe Checkout and pays. There is no automatic charge, subscription, or weekly invoice schedule.
- The existing $2.99 customer service fee applies once per project. Existing provider platform fee percentages/caps and actual Stripe processing-fee allocation apply to the single final settlement.
- The paid settlement uses existing refund, dispute, reporting, and held-payout infrastructure. The 48-hour review period begins only after confirmed payment. Checkout approval does not transfer money to the provider.
- Customer/project ownership, stale versions, running-timer uniqueness, immutable payment attempts, and signed Stripe events protect against unauthorized edits and duplicate payments.

## Approved legal copy

Add to Terms section 4 and Provider Agreement section 3:

> New hourly work uses tracked projects. The hourly rate is recorded when the customer requests the project. The customer sets a maximum approved number of work hours, which is not a purchase of hours or a guarantee of completion. Only the customer may increase that limit. Providers must accurately record the work performed and must not bill beyond the approved limit. Tracked time is combined across entries and rounded up once to the next whole minute, with the resulting price rounded to the nearest cent. The provider submits one final timesheet for the customer to review. The customer may request corrections before approval. Approval locks that timesheet, and payment occurs only when the customer completes Stripe Checkout. No automatic charge is authorized by starting a project or timer.

Add to Terms section 5 and Provider Agreement payment section:

> Each tracked hourly project has one final payment. The $2.99 customer service fee is charged once for that payment. The provider platform fee and cap apply once to the project service subtotal, with Stripe processing costs allocated under the existing policy. The 48-hour customer review period for a completed project starts when payment is confirmed, not when a timer stops or a timesheet is submitted. Existing prepaid bookings retain the amounts and terms originally recorded for them.

Qualify existing prepaid-hourly paragraphs as applying to legacy bookings only. Bump applicable consent versions and effective date, and regenerate any pinned legal-document content hashes at publication. Do not silently overwrite the archived terms attached to existing agreements.

## Verification before launch

- Run the full test suite under Node 24.22.1, ESLint, TypeScript generation/checking, and production build.
- Apply migration 111 twice to a disposable database. Verify all historical booking financial facts are byte-for-byte unchanged.
- Run real SQL workflows for request, provider acceptance, start/stop, unattended cap, cap increase, manual correction, stale versions, submission, rejection, and approval lock.
- Run a real PostgreSQL concurrent-request test for multiple starts, repeated submissions, and concurrent checkout calls. PGlite tests do not prove PostgreSQL lock behavior.
- In an isolated Stripe sandbox, test customer approval/payment, checkout cancellation and resume, expired session retry, a lost response retry, duplicate signed webhooks, async completion/failure, refund, dispute, and 48-hour payout gating. Never test with a live charge.
- Exercise desktop and mobile UI: unauthenticated return path, repeated clicks, refresh with running timer, back/forward, stale timesheet refresh, and cancelled checkout.
- Policy wording was approved by the owner on November 9, 2026; verify it matches the implemented flow before publication. Verify the customer sees the cap, per-minute rounding, final service fee, and approval locking before proceeding.
- Verify the exact commit on origin/main and passing CI before release; check the DigitalOcean deployment commit and public health endpoint after rollout.

## Known recovery boundary

An unresolved Stripe request older than the safe idempotency window is held for support review rather than assigned a new payment attempt. Operators must reconcile the original Stripe session before allowing a new charge. No manually marking a project paid.

## Account data handling

Account exports include project records, time entries, and history while preserving preacceptance address redaction. Self-service account deletion is blocked before any external Stripe deletion if hourly-project records exist; support must reconcile shared work/payment evidence and handle deletion safely. A full automated retention/anonymization workflow is not part of this release.

Owner approved the described billing rules and corresponding Terms and Provider Agreement update on November 9, 2026. Applicable consent versions and the terms source hash are updated in this branch; previously recorded agreement data is unchanged.
