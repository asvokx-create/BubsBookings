# Booking payout finalization recovery

## Failure addressed

The provider transfer and its booking identity must commit before affiliate,
audit, and notification work. Previously, a failure in that later transaction
left the booking paid out, and retry returned early without repairing the
missing local records.

Migration 112 adds a small finalization queue. A new payout claim writes its
original trigger, transfer principal, and prior refund total before calling
Stripe. Transfer evidence still commits separately. Finalization locks the
booking and atomically commits the commission, audit, notifications, and queue
completion. Repeating finalization does not send money.

## Recovery paths and safeguards

- Explicit payout retries, signed transfer confirmation/reversal webhooks, and
  the existing payout cron consume the same queue.
- Unknown transfer outcomes remain non-retryable. The queue cannot finalize
  until matching transfer evidence is recorded. Do not clear the durable claim
  or resend a transfer merely because finalization is pending.
- Temporary refund/dispute holds remain pending until resolved. Terminal full
  refunds, reversals, and lost disputes retain the historical transfer audit
  without creating eligible earnings or sending a stale success notification.
- New partial refunds/reversals suppress stale success messages; commission
  calculation uses current booking state. An already-adjusted payout retains
  its original refund snapshot.
- The original release trigger determines customer review-expiry messaging.
  A later cron/admin retry cannot turn a customer release into an automatic one.
- Historical payouts are not backfilled. No pending queue record means no new
  audit, commission, or notification is manufactured by this recovery path.
- Apply migration 112 before running the changed payout/webhook code. The normal
  startup migration runner includes it. The migration is safe to apply twice and
  does not update existing booking financial snapshots.

The `payment_releases` operations check includes a `finalization` result with
eligible, finalized, and failed counts/booking IDs. A pending row with no transfer
identity still needs transfer reconciliation, not another payout attempt.

## Verification (2026-11-09)

- Node.js 24.22.1 runtime policy passed.
- Full `npm test` with PGlite and isolated PostgreSQL 17.11: 902 passed, 0 failed,
  7 deliberate PGlite-only concurrency skips; corresponding PostgreSQL cases ran.
- Real affiliate commission SQL is exercised in payout fault tests. Stripe and
  unrelated affiliate milestone/email boundaries are replaced with test fakes.
- Fault injection covers transfer-evidence persistence, commission insertion,
  audit/notification insertion, and queue completion. Retries produce one
  transfer, one commission, and one payout audit, with deduplicated notifications.
- Concurrent retry/webhook finalization/cron, signed webhook replay, unknown and
  late transfer evidence, temporary/terminal holds, mode mismatch, and migration
  repeat/no-backfill checks passed.
- `npm run test:booking-fee-migration`, `npm run lint`, `npx tsc --noEmit`,
  `git diff --check`, and `npm audit --omit=dev --audit-level=high` passed.
- An initial production build was blocked during static generation by a denied
  production HTTPS request. After explicit permission for one public-logo request,
  one retry of the unchanged Next production build completed with exit 0 under an
  outside-repository QA network guard and synthetic environment.
- The guard allowed exactly one unauthenticated GET of
  `https://bubsbookings.com/brand-icon.png`: HTTP 200, PNG, 308,519 bytes. It supplied
  no application headers or request body, omitted credentials, prohibited
  redirects and other external destinations, and required the normal managed
  proxy route. A cross-process atomic claim/cache limited the request count;
  there were zero cache hits. No second build or logo fetch was performed.
- Eight socket attempts were blocked alongside the expected synthetic database
  schema warnings. No database connection was permitted during this build.
  The build used no production application credentials and changed no source.
- This is a guarded production-build pass, not live database/authentication,
  browser, or full Stripe end-to-end validation. Stripe webhook tests use locally
  signed synthetic events, not fresh Stripe deliveries. The network guard/cache
  and synthetic environment are test harness limitations, not application code.

All database/Stripe validation used synthetic data. No live payment, merge,
deployment, or branch push was performed for this patch.
