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

## Refund reconciliation safeguards

A Stripe approval requirement, pending refund, or uncertain network outcome stays blocked for reconciliation rather than becoming retryable. An approved Stripe request may execute later. Operators must verify the original Stripe refund before retrying; rejected or expired approval requests also require review. Signed cumulative refund and transfer-reversal events must not reduce recorded totals or clear unrelated payout holds. A successful customer refund does not prove that an already-paid provider transfer was recovered.

## Account data handling

Account exports include project records, time entries, and history while preserving preacceptance address redaction. Self-service account deletion is blocked before any external Stripe deletion if hourly-project records exist; support must reconcile shared work/payment evidence and handle deletion safely. A full automated retention/anonymization workflow is not part of this release.

Owner approved the described billing rules and corresponding Terms and Provider Agreement update on November 9, 2026. Applicable consent versions and the terms source hash are updated in this branch; previously recorded agreement data is unchanged.

## Sandbox QA evidence addendum (November 9, 2026)

These results cover an isolated local app, disposable synthetic accounts, and the verified Stripe sandbox. No live payment or production deployment was performed.

### Verified

- CI for commit `a8795e7` completed with 745 passing tests and zero failures. Three PGlite-only concurrency cases were intentionally skipped; all three actual PostgreSQL counterparts passed. The migration checks, full lint, TypeScript, production build, and dependency audit also passed.
- A one-minute project at $60/hour produced a single $3.99 Checkout: $1.00 labor plus the $2.99 customer service fee.
- Concurrent and repeated Checkout requests reused one session and one settlement. Checkout cancellation did not record payment; resuming the same session allowed payment. After payment, a new Checkout request returned 409 without creating another attempt.
- Hosted Checkout disabled payment submission while processing. Reloading or revisiting the completed session did not offer another payment.
- A second session rejected the documented insufficient-funds test card without recording a successful payment. Recovery with the successful test card in that same session produced one successful payment event and one Checkout attempt.
- Signed payment webhooks recorded the successful sandbox payments. Customer and provider receipt APIs returned the matching project and payment details. Authenticated API checks used synthetic accounts only.
- The supported customer completion action reconciled the first payment's actual processing fee from pending to final: 42 cents total Stripe processing cost, 11 cents allocated to the provider, 10 cents platform fee, and a 79-cent provider transfer. Repeating completion retained the same transfer and exactly one payout event.
- Public desktop (1536-pixel) and mobile (390-pixel) layouts passed the public-copy and horizontal-overflow checks. New hourly cards describe tracked projects rather than a legacy minimum purchase; the listing explains corrections, final approval, and payment.

### Refund and transfer-reversal reconciliation

Both synthetic refund requests initially returned Stripe `approval_required`, requiring external human review rather than a permission change. Following user approval, signed refund webhooks confirmed both full $3.99 refunds: $1.00 labor and the $2.99 service fee each. Neither original refund was retried.

Both refunds were verified as succeeded in the sandbox Dashboard: first `re_3UZieWKl3MBTGjp01hxNSvH9`, second `re_3UZikHKl3MBTGjp01lu4rXZj`. The first payment's full 79-cent provider-transfer reversal was confirmed at 03:38:19 UTC as `trr_1UZjPSKl3MBTGjp0SmmVn9LF`. The second payment had no provider transfer and reconciled directly to refunded/reversed.

The old development process initially returned HTTP 500 for the reversal because it retained stale compiled handler code. A fresh development process with a separate output directory loaded the current source successfully. Using only synthetic, nonfunctional credentials, it processed the hash-verified original sandbox event through the real HTTP signature-checking webhook endpoint with a locally generated test signature. This was a controlled local replay, not a fresh delivery from Stripe or a production-server test.

The fresh replay returned HTTP 200. Local state preserved the original provider payout principal of 79 cents, recorded 79 cents reversed, changed release status to reversed, and cleared the recovery warning. Exactly one transfer_reversed audit event recorded the original transfer ID and amountReversed 79. Original event `evt_3UZieWKl3MBTGjp01CrSopHk` was marked processed at 04:06:36.718 UTC. The temporary synthetic server was stopped and temporary export/replay routes removed; the existing QA app, listener, and disposable database were preserved.

Asynchronous refund IDs remain absent from the local booking records despite confirmed refund amounts and statuses. Successful customer refunds alone do not establish provider-transfer recovery; the separate reversal evidence above does. No financial facts were manually edited to make these checks pass.

### Remaining release gates

- Ordinary payouts and early-dispute matching use the existing Charge and PaymentIntent reads. Releasing a historically disputed payment after a favorable closure additionally requires Disputes Read for current verification. Missing permission fails closed and freezes the affected payout pending reconciliation; permission changes alone do not clear that freeze. Existing production permission coverage has not been inspected. Do not expand scopes automatically.

- The final automatic/manual/admin refund and durable payout safety repairs are implemented and independently source-reviewed. Final local aggregate validation passed: 745 tests passed, zero failed, and 11 expected skips await PostgreSQL CI or are PGlite-only concurrency copies. Full source ESLint, standalone TypeScript, and the separate-directory production build passed. Exact-commit PostgreSQL CI is still required before release. No production changes were made.
- Assess asynchronous refund-ID recording and complete authenticated visual verification of the refund/reversal warning display. Controlled replay coverage does not replace verification of fresh Stripe delivery to the final deployed handler.
- Authenticated customer/provider visual workflows have not yet been exercised. API sessions do not substitute for visual checks of timers, refresh, corrections, approval, and mobile layouts.
- A documented synchronous-dispute test card produced a real sandbox dispute one second before Checkout completion. This exposed an early-event ordering bug, now fixed and covered by signed-handler tests on real PostgreSQL. A fresh sandbox payment against the corrected code again delivered the dispute early and returned HTTP 500 without retaining a processed marker. After payment linkage, controlled replay of the original SDK-retrieved event through the real HTTP signature-checking handler returned 200, froze the payout, and recorded exactly one dispute audit; an identical replay returned duplicate:true. No transfer occurred and no financial state was manually edited. This verifies local replay, not a fresh Stripe redelivery. Async payment completion/failure has only automated coverage in this session; a Bank option was observed but not exercised. The full prelaunch checklist above still applies.
- This addendum is QA evidence, not release approval. Deployment remains gated on the outstanding checks, passing validation of the final commit, and the explicit rollout process above.

### Local test continuity

The original memory-only disposable database stopped after the initial payment and reversal evidence was collected. Those Stripe outcomes and saved evidence remain valid, but its synthetic local rows are no longer available. A new durable disposable database was migrated from scratch and seeded only with fake users, a fake provider/service, and a new unpaid UI project. No historical paid bookings or financial fields were recreated. New sandbox cases must use new projects and actual application/payment flows.

### Payment recovery operating boundaries

Pending, approval-required, or uncertain Stripe outcomes keep a durable reconciliation hold rather than allowing another financial request. A payout claim survives an external success followed by a local audit or notification failure; known transfer evidence is retained separately from that ancillary work. Late signed transfer/reversal events validate the expected payment identity, preserve original transfer principal, and maintain cumulative recovery and unrelated holds.

Further partial refunds on a transferred payment with an ambiguous earlier refund/reversal history stop before Stripe because a transfer-time refund basis was not historically recorded. Full remaining refunds remain supported. New external partial refunds also require reconciliation before further proportional calculations or payouts; older or duplicate events do not recreate a completed owned operation's warning. These are safety boundaries, not changes to fees or the approved refund policy. Do not clear an uncertainty marker or issue a replacement transaction without verifying the original Stripe outcome.

## November 10 follow-up: evidence and durable refund recovery

The following fresh sandbox evidence belongs to published head `04a43b211d445abe72ab3b663062c64f4a62e4c0`, **not** the later recovery implementation:

- Authenticated provider/customer visual QA covered timer, cap, correction, resubmission and approval of a one-minute project. Checkout charged $3.99 in the BookMe sandbox using a documented test card. No live funds or customer data were used.
- Fresh Checkout and transfer events reached the final local handler with HTTP 200. Actual Stripe fee was 42 cents; provider processing allocation 11 cents; platform fee 10 cents; provider transfer 79 cents.
- The existing held refund was approved once in Stripe, becoming successful refund `re_3Ua3XlKl3MBTGjp01AeXGRkR` for 399 cents. Fresh `charge.refunded` reached the local handler with HTTP 200. The app correctly showed refunded totals and flagged transfer recovery, but did not recover the refund receipt ID or resume the provider reversal.
- The exact outstanding 79-cent transfer was then manually reversed once as `trr_1Ua5J3Kl3MBTGjp0RgqWfRw3`. Its fresh reversal event returned HTTP 200 and reconciled the original transfer. The temporary key was expired and the key-bearing helper, listener and app processes stopped. Synthetic evidence/data were preserved.

### New implementation, still requiring final validation

Migration 113 introduces immutable authorized refund operations. It does **not** backfill executable work from historical bookings or the sandbox case above. The booking claim and operation snapshot commit together before the first Stripe request. Refunds carry an operation ID; settlement requires the authoritative matching refund object, amount, currency, payment identity and environment. A cumulative charge event is not sufficient to settle a still-unconfirmed bound operation.

Successful refund receipts, audit entries and notifications are transactionally recoverable. Separate provider-transfer recovery has a durable one-shot attempt marker and fixed amount/key. An approval-required or lost-response attempt is never resent automatically, including after Stripe's idempotency window. Stripe's approval engine can execute under a different key from the original request, so repeating the original key is not safe. Signed transfer evidence or authenticated reads reconcile recovery and its audit without another money movement. Unknown/unbound refunds remain operator review.

Admin dispute decisions retain their original immutable intent and an ownership marker. Only that still-owned decision can be finalized after refund/recovery success. Later admin edits must not be overwritten. The same case cannot authorize another partial refund simply because receipt work completed. Transferred payments with prior refund/reversal activity still require operator reconciliation before another partial refund; full remaining refunds recover only the outstanding recorded transfer principal.

The payout scheduler also scans refund reconciliation fairly, marking each selected operation checked even when Stripe reads fail. Persistent review items cannot starve later operations. It reads authoritative refund evidence and never resubmits an attempted refund/reversal. Outstanding review items surface in the payment-release operations check. `charge.refunded` remains supported and discovers matching refund objects. **Subscribe to `refund.created`, `refund.updated` and `refund.failed` as well**, and verify the subscriptions and scheduler before release; do not silently change Stripe settings or credentials.

Stripe documents that an initially successful refund can later fail (test card `4000000000005126`; see https://docs.stripe.com/testing and https://docs.stripe.com/refunds). Refund events therefore retrieve the current object before interpreting status. An authoritative non-success after confirmation records a durable settlement-review flag, explicit customer/provider warning and audit, and blocks new refunds or provider recovery. Historical amount and reversal evidence is preserved rather than inventing a financial rollback. Those historical totals are **not proof of a completed customer reimbursement** while the review flag is open. Operators must reconcile Stripe's returned funds and arrange any necessary alternative reimbursement separately. A stale success event cannot clear this hold or resend money.

The immutable settlement-review flag also independently vetoes payout claims and their final send recheck, even if a later request/rejection changes the booking's mutable refund status or warning. Historical `payment_status = refunded` cannot make another customer-resolution decision succeed while that flag or a failed-refund warning remains open.

### Operator recovery checklist

1. Match environment, operation ID, booking, PaymentIntent, charge, approved amount and refund ID. Inspect the original Stripe request/approval, not a replacement request.
2. If `refund_attempted_at` is present but no outcome is known, do not reset it or invoke another refund. Resolve the original approval or verify the refund in Stripe.
3. If the customer refund succeeded, independently check the exact transfer and cumulative reversed amount against the operation's frozen target. A customer refund alone does not prove provider recovery.
4. If `reversal_attempted_at` is present, do not resend it. Verify the original reversal/approval and let signed evidence or reconciliation record its result. A crash between marking the attempt and sending it remains explicit operator review, not permission to replay.
5. Preserve newer disputes, holds and unbound refund warnings. Do not change financial totals or ownership markers merely to make the queue green.
6. Complete migration-twice preservation, focused and aggregate tests, real PostgreSQL concurrency CI, independent review and fresh sandbox validation of the **new** recovery code before release. The old-head sandbox results above do not prove the new outbox or decision workflow.
