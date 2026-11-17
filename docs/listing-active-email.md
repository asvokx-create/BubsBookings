# Listing activation email

This adds one transactional Resend notice per listing, using the existing sender,
email renderer/delivery log, and authenticated provider-welcome scheduled endpoint.
It is not a marketing campaign or a bulk backfill. The notice confirms publication,
links to the live listing, earnings dashboard and free marketing/QR tools, and does
not imply earnings or payouts already exist.

## Rollout

- Obtain approval to push/deploy and verify a database backup before migration 117.
- Migration 117 creates the queue, public-eligibility view, and one-time rollout marker.
  Already-public listings are suppressed, without sending. Re-running migrations
  does not baseline later listings. Existing private listings can qualify when they
  subsequently become public. No pass, verification status or listing state is changed.
- The existing scheduled `/api/cron/provider-welcome-emails` POST discovers and
  processes up to 25 notices per call. Delivery follows the configured scheduled-job
  cadence, not the exact instant the provider presses a button. No new scheduler,
  paid service, subscription, or environment variable is required.
- Eligibility matches public service-page gates: active service/provider/company,
  not provider-deleted, age status verified (Stripe or an admin exception). Existing
  application code is responsible for moderation/plan restrictions on those flags.
- A unique service ID prevents repeated notices on edits or pause/reactivation.
  There is no automated resend or backfill for already-public listings. An admin may explicitly select one public listing in an account view to send its first notice.

## Failure handling

The claim, payload, attempt count, and first-attempt timestamp commit before the
Resend request. Session advisory locks plus `FOR UPDATE SKIP LOCKED` prevent
concurrent delivery. A crashed `sending` claim can retry after 15 minutes. The
frozen payload and stable key allow an accepted-but-unrecorded request to replay
without resending. Retry delays are 15, 30, 60, 120, and 240 minutes, with at most
five attempts and an absolute 23-hour retry cutoff. This stays within Resend's
24-hour idempotency window: https://resend.com/docs/dashboard/emails/idempotency-keys

A changed recipient/owner or listing URL moves a retry to `review_required` rather
than sending stale data. Private listings are excluded again at each claim. With
missing email configuration, no attempts are consumed. The queue's `sent` means
Resend accepted the message, not proof of inbox delivery. `email_delivery_log` and
the queue's provider message ID support investigation. Never reset a
`review_required` row blindly: inspect Resend first, especially after the dedupe
window. Admin account views include a “Listing activation emails” section with a button
for each public listing that has not received a notice. Confirmation names the
listing and recipient. The server rechecks owner/public eligibility, queues only
that listing, and audits the authenticated actor in the same transaction. A
baselined never-attempted row may be queued; sent, in-flight and review-required
rows are never reset. UI status distinguishes queued/sending from Resend
acceptance, which does not prove inbox delivery. No bulk button is provided.
Closing or switching account views ignores stale send/load completion.

## Validation

Synthetic-only PGlite tests execute migration and queue SQL for baseline/reruns,
all visibility gates, verification/admin-compatible activation, once-only delivery,
frozen retry payload, private-state retries, crash-after-acceptance recovery,
retry expiry, recipient/slug changes, missing configuration, and denied sender lock.
The email helper is mocked: no real mail or production data is used.
`node scripts/test-listing-active-email-postgres.mjs` additionally tests true
cross-process workers on a temporary PostgreSQL 17.7 loopback cluster: overlapping
cron calls produce one request; SIGKILL releases the advisory lock while preserving
the committed claim; retry reuses the same payload/key; expired retries do not send.
Set `LISTING_EMAIL_TEST_DATABASE_URL` to a dedicated nondefault-port loopback cluster
only. The script creates and removes its own synthetic schema. No persistent
PostgreSQL dependency is added to the application.

The PostgreSQL harness also covers simultaneous explicit admin clicks plus a
repeated request: one sender invocation and one actor audit. Unit tests cover
wrong-owner/private rejection, targeted selection, sent/uncertain state handling,
and closed/switched account async refresh. Route-auth assertions are structural;
no production admin session or real external delivery is exercised.
