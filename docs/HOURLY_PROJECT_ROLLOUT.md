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

## Sandbox QA evidence addendum (November 9, 2026)

These results cover an isolated local app, disposable synthetic accounts, and the verified Stripe sandbox. No live payment or production deployment was performed.

### Verified

- CI for commit `2f79ee0` completed with 649 passing tests and zero skipped tests. The subsequent refund-hardening change passed 661 local tests with four real-PostgreSQL opt-ins skipped; its exact-commit PostgreSQL CI remains required. Independent review found no remaining blocker in that patch.
- A one-minute project at $60/hour produced a single $3.99 Checkout: $1.00 labor plus the $2.99 customer service fee.
- Concurrent and repeated Checkout requests reused one session and one settlement. Checkout cancellation did not record payment; resuming the same session allowed payment. After payment, a new Checkout request returned 409 without creating another attempt.
- Hosted Checkout disabled payment submission while processing. Reloading or revisiting the completed session did not offer another payment.
- A second session rejected the documented insufficient-funds test card without recording a successful payment. Recovery with the successful test card in that same session produced one successful payment event and one Checkout attempt.
- Signed payment webhooks recorded the successful sandbox payments. Customer and provider receipt APIs returned the matching project and payment details. Authenticated API checks used synthetic accounts only.
- The supported customer completion action reconciled the first payment's actual processing fee from pending to final: 42 cents total Stripe processing cost, 11 cents allocated to the provider, 10 cents platform fee, and a 79-cent provider transfer. Repeating completion retained the same transfer and exactly one payout event.
- Public desktop (1536-pixel) and mobile (390-pixel) layouts passed the public-copy and horizontal-overflow checks. New hourly cards describe tracked projects rather than a legacy minimum purchase; the listing explains corrections, final approval, and payment.

### Pending refund reconciliation

Both synthetic refund requests received Stripe `approval_required` responses. These are pending external human review, not evidence of missing key permissions or definitively failed refunds. Stripe states that approval can execute the requested action automatically. Neither refund was retried.

The current local records still show failed refund status from the pre-hardening code and must not be treated as authoritative proof that no refund can occur. Reconcile the original requests and subsequent Stripe events before any further refund attempt. The first payment already transferred 79 cents; recovery of that transfer requires review after refund approval. The second payment has no provider transfer and is locally frozen following the refund request. Do not manually alter financial facts to make either test pass.

### Remaining release gates

- Validate the refund-hardening change independently, including pending external approval, uncertain outcomes, signed refund events, and transfer recovery. Reconcile both outstanding sandbox requests before declaring refund coverage complete.
- Authenticated customer/provider visual workflows have not yet been exercised. API sessions do not substitute for visual checks of timers, refresh, corrections, approval, and mobile layouts.
- Async payment and dispute cases have not been exercised in this actual sandbox session. The full prelaunch checklist above still applies, including cases covered only by automated tests.
- This addendum is QA evidence, not release approval. Deployment remains gated on the outstanding checks, passing validation of the final commit, and the explicit rollout process above.
