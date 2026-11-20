# Calendly call booking rollout

## Status and boundaries

Implementation is disabled by default. This document is not deployment approval.
`CALENDLY_CALL_BOOKINGS_ENABLED=false` and `CALENDLY_CALL_RECOVERY_ENABLED=false` are the shipped defaults.
No production appointment, invitation, charge, authorization or refund was exercised during local development.

The flow is deliberately distinct from ordinary service booking and hourly projects:

1. Provider explicitly publishes a call offer from a private draft. Existing drafts never auto-publish.
2. Customer chooses a returned available slot and accepts the disclosure. Provider accepts the request; an internal buffered owner-slot reservation is acquired.
3. Free calls never initialize Stripe or create financial objects. Paid calls use hosted Checkout with manual capture for a temporary authorization of the immutable disclosed total.
4. Server reconciliation verifies the full authorization, mode, currency, amount and actual capture deadline. It rechecks eligibility, slot, buffers, owner, connection generation and supported Zoom event configuration.
5. A durable claim precedes the single Calendly creation attempt. Calendly can send its invitation before capture. Once the exact appointment and Zoom location are verified, paid calls capture promptly, not at the future appointment date.
6. Definitive booking failures release authorization; failed capture cancels the verified appointment. Captured failures use durable refund recovery. Unknown results never authorize a duplicate booking or blind money retry.
7. A captured paid call becomes a **future confirmed** native booking with held funds, not a completed job. Existing completion/dispute/payout rules apply after the appointment, with completion prohibited before its end.

## Cancellation and uncertainty

Authenticated paid cancellation snapshots the requesting party, reason and exact existing notice-window policy. It verifies external cancellation before native cancellation. Timely customer/provider cancellation uses the existing durable native refund pipeline; a successful API response alone is not refund proof. Late customer cancellation never invents a refund or payout: the appointment can be canceled while financial settlement remains visible for review.

Direct Calendly cancellation/rescheduling has no authenticated BubsBookings actor/policy decision. It remains review-only; linked funds are frozen. Native direct rescheduling/reopening is blocked. Do not tell customers that an uncertain or partially reconciled refund is complete.

No documented Calendly create-idempotency guarantee exists. A timeout, missing search result, disconnected account, ambiguous duplicate, altered owner/time, or incomplete pagination is not proof of absence. The opaque operation marker is correlation only, never authorization. Unknown appointment outcomes retain the internal reservation until authoritatively reconciled.

Confirmed-free calls remain valid after their start time or offer unpublishing. Provider completion after the end releases their hold. Confirmed-paid lifecycle delegates to the native booking.

## Recovery and notifications

Signed Calendly/Stripe webhooks only queue authoritative rereads; payloads alone never capture/refund. The production Node process runs bounded recovery every30 seconds, with no overlapping run in one instance. Atomic due claims and separate bounded advisory-lock connections protect multiple instances. The existing protected payment-release cron also invokes recovery before payout processing.

Notifications are durable **in-app BubsBookings** notifications to both participants, not promised email/SMS. Standard Calendly notifications remain controlled by Calendly. Review cases also alert existing administrators and appear in `/admin/calendly-calls`, an authenticated read-only queue with no retry-payment buttons or secret payloads.

To pause new scheduling while draining existing work, set bookings false and recovery true. Participant status/read/cancel access remains available. Do not turn recovery off while unresolved appointments, authorizations, refunds or held funds remain. Normal OAuth scopes are intentionally not silently expanded.

## Temporary calendar read failures

Network failures and GET responses408,429 and5xx (including the local owner rate limit) can defer verification of an already-confirmed, otherwise healthy appointment. They do not by themselves permanently freeze its payment. A durable `calendar_check_pending` flag blocks native completion and new payout processing until authoritative verification succeeds. Authentication, identity/mapping changes and malformed responses remain review cases. No existing financial freeze is automatically removed.

Transient checks retry after at least60 seconds, scaling to12 seconds per active accepted call for the owner so sustained failures cannot monopolize the budget. Successful routine checks wait at least5 minutes, scaling to12 seconds per active accepted call for the Calendly owner, leaving capacity within the shared20-request/minute limit. Local rate-limit deferrals retry at the next fixed-minute budget window without losing queue priority. Due work is claimed oldest-attempted first. Review checks use the same workload scaling with a5-minute minimum. Webhooks may expedite checks; large workloads can therefore still be rate limited and need monitoring.

Confirmation and temporary-check updates lock native booking before call, then recheck terminal/cancellation state. Stale reconciliation must not reopen or freeze a completed/cancelled call. Real PostgreSQL concurrency testing remains required.

## Reconstruction provenance

The original uncommitted November17 review checkout was unavailable. These safety fixes were reconstructed on November18 from PR24 commit `f3906adbdb925de86b077fb9f4533b57e5e79018` and review findings, then independently reverified. This is not claimed to be the original lost tree. A local commit and private transfer archive preserve this reconstruction; neither publication nor deployment is authorized.

## Required rollout checks

- Apply additive migrations114,115 and118–122 on an isolated restored database before production; repeat migrations and verify existing booking/timeoff writers.
- Verify the selected provider's current Calendly identity/generation, explicit required read/write grants, account/API eligibility, one-to-one unpaid Calendly event, fixed duration, buffers and Zoom setup. Calendly event payment must be off because BubsBookings owns the paid flow.
- Verify signed webhook delivery and production heartbeat/cron monitoring. Ensure administrative review notifications reach an active account.
- Exercise isolated sandbox authorization→appointment→capture, declined/expired authorization, slot race, unknown create/capture/cancel response, refund recovery, account disconnect/reconnect, webhook reversal/duplication and Zoom generation delay. Use synthetic records and designated test invitees only; never real customer funds or unsolicited invitations.
- Run real PostgreSQL concurrent booking/assignment/timeoff/acceptance/cancellation/completion tests. PGlite checks SQL and migrations but is not proof of multiprocess PostgreSQL locks. Existing booking→call versus cancellation call→booking locks may produce PostgreSQL deadlock victims; verify rollback and retry behavior.
- Run the complete tests, aggregate lint, production build and production dependency audit against the exact lockfile. Local verification uses Next16.4.5, not the older shared dependency cache.
- Owner authorization is still required before code publication or deployment. Enabling the feature and reconnecting/granting Calendly scopes are separate rollout steps.

## Operational review

Inspect the existing call/operation/cancellation/payment ledgers and authoritative provider records. Never replace the stable operation key or clear an attempted marker to force a retry. Do not release an unknown hold, bypass the native guard, replay a Calendly create, issue a second refund, or unfreeze funds based only on an empty search or a success redirect. Resolve financial policy questions with the owner rather than assuming a payout/refund decision.

Account export includes participant call/consent/cancellation records with no OAuth tokens, video credentials or raw upstream payloads. Account deletion stops before external credential deletion when shared call records require retention/reconciliation, following the existing hourly-project support workflow.
