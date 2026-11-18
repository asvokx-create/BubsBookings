# Pro subscription webhook recovery

## Defect and scope

`updateSubscription` bound 12 values but never referenced parameter `$3` (metadata plan). PostgreSQL could not infer that unused parameter's type and returned SQLSTATE `42P18`. The transaction rolled back and the signed webhook returned HTTP 500.

Affected paths: valid `customer.subscription.created`, `customer.subscription.updated`, and provider-subscription `invoice.paid` / `invoice.payment_failed` events. The invoice path reads the current subscription from Stripe before calling the same update. Invoice failure notifications were not reached when this update failed.

This patch removes only the unused value and makes the remaining 11 parameters contiguous. Plan eligibility, complimentary grants, grace periods, trial tracking, team deactivation, owner protection, and event ordering rules are unchanged. No schema migration or bulk data update is required.

The bug can leave plan, status, billing period, cancellation flag, trial-use timestamps, and extra-seat data stale. It does not itself charge, refund, cancel, or modify a subscription at Stripe. A production impact count has not been established by these tests.

## Verification

- Run `node --experimental-strip-types --test tests/stripe-subscription-runtime.test.ts` on the repository's pinned Node version.
- Default tests use isolated in-memory PGlite, executing the real PostgreSQL SQL and schema migrations through the signed production handler. Stripe retrieval is synthetic, and external messaging/payment services are unavailable.
- For an actual local PostgreSQL server, set `BOOKME_MIGRATION_TEST_DATABASE=1` and `DATABASE_URL` to a disposable localhost database, then run the same command. The test creates a random private schema and drops only that schema afterward.
- CI runs both variants against PostgreSQL 17. Never point this test at a remote or production database.

## Assess before recovery

1. Verify the fixed commit is deployed and the webhook endpoint is healthy.
2. Inspect Stripe delivery history and application errors for `42P18` on the affected event types. Record event IDs, subscription IDs, environment, and timestamps in the incident record.
3. Failed events are removed from `stripe_webhook_events` by the handler so they remain retryable. Absence of a database event row is therefore not proof that Stripe never delivered an event.
4. Compare each candidate provider with the current subscription retrieved from the matching Stripe account and billing mode. Confirm provider ownership, metadata plan, current subscription ID, current status, cancellation setting, period end, extra seats, and active complimentary grants. Do not assume an old event snapshot is still current.
5. The authenticated billing status endpoint already refreshes a known subscription from Stripe and can repair some stale state. It requires a stored subscription ID, customer ID, and matching billing mode, does not repair all trial/event-history fields, and is not a complete substitute for reconciliation.

## Recover deliberately

Allow ordinary Stripe retries to succeed after deployment and verify the resulting provider state. If manual replay is needed, review one affected subscription at a time after confirming the current Stripe state. Do not bulk resend historical events, clear event-order watermarks, delete processed-event records, or directly grant Pro access.

A replayed subscription event uses its historical snapshot. Existing ordering and canceled-state guards reduce some stale-event risk but are not a general reconciliation mechanism, especially if a provider has moved to another subscription. Invoice events retrieve current subscription state, but replaying an old payment-failed invoice can also produce an outdated billing notification. Current-state invoice/status refresh does not advance the subscription event watermark; a historical snapshot newer than that watermark can still overwrite a newer refresh. Select only an appropriate, reviewed event, and inspect the state afterward.

If retries have expired or no suitable event remains, prepare a separately reviewed current-state reconciliation scoped to verified provider/subscription pairs. Any reconciliation must preserve owner and complimentary access, mode isolation, trial history, and team rules. Do not create a new subscription, payment, refund, credit, or cancellation to repair synchronization.

Verify that:
- delivery returns HTTP 200 and its event row becomes `processed`;
- stored plan, status, period end, cancellation, seats, and mode match the verified current state;
- complimentary access remains intact and no owner is downgraded;
- a duplicate delivery does not duplicate invoice notifications;
- no further `42P18` appears for these paths.

This change contains no automated recovery or production data changes.


## November 18, 2026 revalidation on current main

Reconstructed the prepared patch on freshly fetched main 3c3d0873d85f4c149beed85f4afaa5f0ac4442ce in an isolated checkout. The unmodified signed handler reproduced SQLSTATE 42P18; the minimal binding fix passed 50 signed-handler tests across PGlite and real localhost PostgreSQL 18.7, using Node 24.22.1. No external Stripe request occurred.

Full current-main suite: 1,115 total, 1,106 passed, nine skipped, zero failures, exit 0. The first run had one pre-existing Windows CRLF source-slice failure in listing-active-email.test.ts. Temporarily normalizing components/admin-dashboard.tsx to LF, with no semantic diff, made the complete rerun pass. Original file bytes were then restored. Focused tests and independent review passed. Repository ESLint, optimized build and final TypeScript checks exited 0. An initial type check before generated Next types existed failed; the final post-build type check passed.

No workflow edit is required: current CI already runs npm test with PostgreSQL enabled. No production impact count, real subscription test, recovery, push or deployment is claimed. After authorized deployment, current-state reconciliation still needs the deliberate procedure above; do not bulk replay historical events.
