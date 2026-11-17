# Provider-selected free or paid calls

Prepared November 14, 2026 against main `b8e6ec3`, on top of the local availability-preview work. **Local only: not pushed, deployed, enabled or verified against a real Calendly account.**

## Product decision captured

The provider decides whether a call is free or paid. It is not restricted to a free introduction and is not tied to Doug's event or signature URL.

Recommended boundaries:
- A separate call offer for a selected remote/BOTH service, with explicit owner choice of event and free/paid pricing. Do not silently change the service's existing booking price.
- Free means zero customer charge, not zero service subtotal plus a platform fee.
- Paid means a fixed USD service price collected through BubsBookings checkout, preserving the existing customer fee, provider fee, payment snapshot, refund and payout protections. Do not send paid customers through Calendly's own payment processor.
- Calendly owns the external appointment and conferencing configuration; BubsBookings owns the customer booking and, for paid calls, the financial record. Neither alone is enough to claim complete confirmation.

## Implemented preparatory slice

The provider integration panel has **Free or paid call setup · Private draft**, behind a new, independently disabled `CALENDLY_CALL_DRAFTS_ENABLED=false` flag. The existing availability-preview flag remains off and unchanged.

Owner-only draft settings save:
- The provider's remote service and explicitly selected eligible Calendly event.
- `free` with exactly zero cents, or `paid` with an integer service price from 50 to 100,000,000 USD cents. Nothing defaults to free or paid. The upper limit matches the marketplace's existing price validation ceiling.
- The connected account identity and exact connection generation, event duration, payment-verification timestamp, and a non-reusable revision token.

Selection requires an active, public, personal, fixed-duration one-to-one event. A fresh API read must report literal `is_paid=false`. Unknown/missing or true is rejected. **This checks the reported setting; it does not change or disable payment in Calendly.** That report is only point-in-time evidence. A later live flow must verify it again before activation and every booking attempt.

`service_calendly_call_drafts` is separate from `service_calendly_availability_previews`, `services` pricing, bookings and Stripe. It has no activation column. No public route reads it. Saving/removing a draft cannot publish a preview, change a listing price, enable checkout, reserve a slot, create an invitee, or send a customer anywhere. Drafts remain removable after disconnect or loss of read permission.

Writes recheck tenant/service/connection ownership and precise PostgreSQL timestamps. Edits use atomic revision-matched UPDATE; creates use INSERT with conflict DO NOTHING. A stale edit cannot recreate a concurrently deleted draft. A new UUID revision prevents old tabs matching a later recreation. UI double-submit prevention and uncertain-response reload behavior supplement, not replace, database checks.

The draft is useful as the future owner configuration contract, not a completed scheduling feature. Both new flags must stay disabled pending an authorized rollout.

## Verified existing constraints

1. Native booking creation rejects non-quote subtotals below $0.50 (`app/api/bookings/route.ts`). A free call cannot reuse that path unchanged.
2. `calculateBookingFinancialSnapshot(0, plan)` still adds the current $2.99 customer service fee (`lib/booking-financials.ts`). Simply setting a zero service price is not free.
3. Provider completion currently requires `payment_status='paid'` and `payment_flow='held_transfer_v1'` (`app/api/providers/bookings/[bookingId]/route.ts`). Genuine free calls need an explicit no-payment lifecycle, not fake paid/refunded records.
4. Existing Calendly imports are external events, not customer bookings or paid orders. They do not map to Bubs bookings, payment attempts or management URLs. A newly created external appointment can block acceptance of the corresponding Bubs booking unless a narrowly scoped, verified same-booking exception is added.
5. Bubs confirmed bookings and internal holds are not written back to Calendly. Read-only previews do not provide cross-system reservation or prevent an external visitor selecting another slot.
6. Existing OAuth requests only `users:read`, `scheduled_events:read`, `webhooks:write`. Draft selection needs already-granted event-type read permission. OAuth app settings, requested scopes and actual account grants have not been changed.

## Official API evidence, rechecked November 14

- [Event-type details](https://developer.calendly.com/api-docs/calendly-api/event-types/get-event-type): `event_types:read`; exposes `is_paid`, duration, location, buffers, required questions and ownership information. A saved event name is not proof of a connected video integration.
- [Available times](https://developer.calendly.com/api-docs/calendly-api/event-types/list-event-type-available-times) and [scope catalog](https://developer.calendly.com/docs/authentication/scopes): current sources specify `event_types:read`. A stale search excerpt used `availability:read`; do not request both speculatively. Inspect actual `required_scopes` errors during authorized testing.
- [Create invitee](https://developer.calendly.com/api-docs/calendly-api/scheduled-events/create-event-invitee): `POST /invitees` needs `scheduled_events:write`; ordinary notifications, calendar invitations and workflows run. It is a real booking, not a silent slot hold. The selected location and required customer answers must match the event configuration.
- [Reschedule webhooks](https://developer.calendly.com/docs/api-guides/see-how-webhook-payloads-change-when-invitees-reschedule-events): both canceled and created notifications occur; old/new invitee identities distinguish a move from a true cancellation.
- [API FAQ](https://developer.calendly.com/docs/getting-started/frequently-asked-questions): no direct rescheduling endpoint; invitee management URLs are available. External management must be reconciled, not assumed disabled by Bubs UI.
- [Free-plan API announcement](https://community.calendly.com/developer-faq-62/scheduling-api-post-invitees-and-webhooks-now-available-on-the-free-plan-6162): Free/trial limits include five API-created bookings per user/day and 50 other API requests per user/minute. The actual test/provider account's limits and grants require verification. A platform trial notice is not proof of Doug's plan.

## Scoped path to a real integration

### 1. Agree on the remaining customer-facing policy

The free/paid decision is settled: providers choose. These questions are distinct:

- **Offer shape:** This draft assumes an optional, separately priced call associated with a service, not replacement pricing for the whole service. Confirm that before publishing prices or routing existing requests into it.
- **Acceptance and payment timing:** Recommendation is to retain provider acceptance for an initial rollout, matching current Bubs behavior. Paid Calendly appointment creation before checkout sends real invitations before payment. Decide whether that is acceptable, and whether/how unpaid appointments expire. Do not invent an automatic cancellation deadline. If payment must be guaranteed before invitation, design and test a card-authorization/capture flow instead; current automatic-charge checkout cannot reserve Calendly atomically.
- **Cancellation and rescheduling:** Reuse existing paid-service notice/refund rules where possible, explicitly defining the customer fee treatment, provider cancellation, no-show and external reschedule behavior for calls. Free calls have no monetary cancellation fee unless a separately approved product introduces one. Do not infer a refund from a reschedule cancellation webhook.
- **Video location:** Provider selects an eligible conferencing location. Verify connected Zoom/Meet/etc. and actual returned meeting details in a synthetic account; no native-video platform or provider event is assumed.

### 2. Add the shared reservation and synchronization foundation

Before either free or paid calls become bookable:

- Add a dedicated call-offer and booking snapshot, explicit lifecycle state, internal booking/hold ID, Calendly connection/event/invitee IDs, operation IDs, and (paid only) Stripe payment-attempt IDs. Retain revisioned price/fee/cancellation terms for already-requested calls when a provider changes the offer.
- Authenticate the customer, display the provider/event/time/price/fee summary and data-sharing disclosure, then collect only required name/email/timezone/answers after explicit booking intent. Do not put PII or secrets into scheduling URLs.
- Revalidate public-service eligibility, account generation, scope, event ownership, payment setting, fixed duration, conferencing location and latest availability. Intersect with internal owner working hours/time off/confirmed bookings/active holds, including appropriate buffer intervals.
- Serialize all internal owner-slot writers with a shared durable lock/constraint and active holds. The native booking, acceptance, reschedule and manual-event paths must honor those same reservations. No frontend-only check-and-insert protection.
- Use a durable outbox/saga for external operations. Do not keep a database transaction open while calling Calendly/Stripe. A lost `POST /invitees` response is an unknown outcome: reconcile via operation mapping and verified records before any retry; never assume an idempotency guarantee the API does not document.
- A Calendly success reserves only that system. Commit/confirm Bubs state only after verified identity mapping. If the local completion fails, keep an explicit recovery state, withhold a misleading confirmation, and perform compensating cancellation/reconciliation as appropriate. Exclude only that verified mapped external event from its own Bubs conflict check; unrelated external events must still block.
- Avoid claims of perfect atomicity across Calendly and Bubs: concurrent external bookings cannot share a database transaction with Bubs. Verify availability at the last possible point, handle external conflict responses, and use compensation and visible pending states for partial outcomes.

### 3. Deliver the genuine free path

- Add an explicit no-payment booking kind/flow with zero customer/service/provider/processing fees and no Checkout/PaymentIntent/payout records.
- Allow confirmation, cancellation and completion based on the free booking's own state, without fabricating `paid` or bypassing unrelated paid-booking protections.
- On Calendly success, store the mapping and verified conferencing details before declaring confirmation. On failure, release the internal reservation and show no booking. On uncertain outcome, keep recovery pending until reconciled.
- Cover notifications, calendar displays, accounting filters, reviews and cancellation/reschedule screens so they do not tell free customers to pay or create fictitious revenue.

### 4. Deliver paid calls without bypassing Bubs money flow

- Use the provider's explicit fixed call price as a new immutable booking snapshot. Reuse Bubs plan-based fees, customer fee, held-transfer/payout controls, Stripe account readiness and refund logic; do not convert the underlying service price or send payment to Calendly.
- Implement the chosen sequencing policy. Booking before payment requires clearly unpaid appointment state and an agreed expiry policy. Charging before a successful external booking requires a verified refund/compensation path and still risks temporary payment without a meeting. Authorization-before-booking/capture is another design, not behavior silently available today.
- Match every checkout/webhook to the exact booking version, price snapshot and external appointment. Prevent late checkout success from reviving a canceled, expired or rescheduled call, charging twice, or releasing a payout for a failed appointment.
- Block completion/payout until both appointment/payment state are valid. Retry refunds and cancellations durably with visible recovery states and operator alerts.

### 5. Reconcile cancellation/rescheduling in both directions

- Consume signed, deduplicated Calendly and Stripe webhooks. Handle duplicates, reversed order, delayed delivery and missing events through periodic reconciliation.
- Store old/new invitee relationships. A reschedule replaces the appointment without automatically refunding or charging again. Reserve/check the new internal interval and release the old one only through a coordinated transition. If an external reschedule conflicts with Bubs, flag pending recovery and notify rather than silently accepting two bookings.
- Bubs cancellation must confirm external cancellation as well as update the internal record; financial refund status remains separate until Stripe confirms it. An external cancellation must update the mapped Bubs booking and apply the agreed financial policy exactly once.
- Provider disconnection/revocation must pause new calls while preserving access to existing booking history and a recovery procedure. Do not delete mappings required to cancel or reconcile existing appointments.

## Rollout and verification boundary

No live config, OAuth permission, real customer record, Calendly event, payment or migration was changed. Migration `115_calendly_call_drafts.sql` has only been exercised in disposable synthetic PostgreSQL; reconcile migration numbering with unmerged work before release.

Before even enabling drafts: authorize the read-scope rollout, verify registered/requested/granted scope consistency with a synthetic provider, apply the migration in a test database, and test real browser desktop/mobile flows. Saving drafts does not authorize enabling real bookings later.

Before live booking: separately authorize required write scopes/account reauthorization; test synthetic Calendly plus Stripe sandbox; exercise every slot-race, timeout, duplicate webhook, reversed reschedule, payment expiry, failed refund, disconnect and recovery path. Never use Doug's real calendar or real customers as a test fixture.

Automated draft coverage includes pure money/payment-state validation, real route code with explicit boundary mocks, PGlite schema/ownership/generation/revision tests, and real component handlers with synthetic hooks/fetch (double click, edit, remove, unmount, stale/malformed/uncertain responses). These are not real multi-session PostgreSQL concurrency tests, browser rendering tests or live API tests.

Local verification: **631 tests passed, zero failed**, including 15 new draft tests. TypeScript, ESLint, production build and diff whitespace checks passed. Independent review found and verified fixes for concurrent draft deletion/edit behavior, disconnected management and unknown-response handling; no remaining must-fix was reported. No live database or Calendly client is configured in this workspace and both feature flags resolve false.
