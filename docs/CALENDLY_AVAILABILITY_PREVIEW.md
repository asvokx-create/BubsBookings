# Calendly event availability preview: local implementation and rollout boundary

Prepared November 13, 2026 against main `b8e6ec3`. Not pushed, deployed, or enabled.

## What this implements

A provider owner can explicitly select an eligible Calendly event for a specific remote/BOTH service. The service page can then show the event's actual open times in a **separate read-only preview**, below the existing booking card. Nothing is auto-selected, and no provider, event, URL, or customer is hardcoded.

Supported events: active, public (`secret=false`), fixed-duration, personal one-to-one events owned by the connected Calendly user. Team, pooled, group, variable-duration and secret events are deliberately excluded. The owner is told the selected name and open times become public.

The preview reads the next 7 days, shows up to 60 times in the provider's timezone, distinguishes repeated DST hours, excludes known confirmed BubsBookings owner bookings and owner time off, and expires displayed results after 60 seconds. It does **not** claim those are BubsBookings service booking slots; the native working-hour/booking workflow remains unchanged.

## What this does not implement

- No `POST /invitees`, Calendly booking, Zoom/Meet link creation, write scope, invitee submission or customer-data transmission to Calendly.
- No external-booking redirect, embedded Calendly checkout, duplicate fee/payment path, or modified Stripe behavior.
- No native-video hosting, replacement of BubsBookings availability/acceptance/reschedule rules, or two-way booking synchronization.
- No permission grant, account reconnection, real calendar test, real customer data, production migration or deployment was performed.

This is a safe preparatory first slice, **not completion of the promised end-to-end scheduling experience**.

## Official API findings (read November 13)

- [List User's Event Types](https://developer.calendly.com/api-docs/calendly-api/event-types/list-event-types): `GET /event_types`, scoped to the connected `user`; `event_types:read`.
- [List Event Type Available Times](https://developer.calendly.com/api-docs/calendly-api/event-types/list-event-type-available-times): `GET /event_type_available_times`; `event_types:read`; future date window of at most 31 days; no keyset pagination.
- [Authorization Scopes](https://developer.calendly.com/docs/authentication/scopes): confirms event-type details and available times use `event_types:read`. A previously cached search excerpt incorrectly showed `availability:read`; the freshly opened endpoint and scope catalog agree. Do not add unrelated availability or write scopes.
- [Free plan announcement](https://community.calendly.com/developer-faq-62/scheduling-api-post-invitees-and-webhooks-now-available-on-the-free-plan-6162): Free/trial limit 50 requests per user/minute for these read endpoints. The feature adds a shared database limit of 20 upstream calls per Calendly user/minute, plus public request throttling. Existing unrelated integration traffic still needs monitoring.

## Permissions and activation blockers

`CALENDLY_AVAILABILITY_PREVIEW_ENABLED` defaults off and must remain off pending authorized rollout. **The existing OAuth scope list is unchanged**: users:read, scheduled_events:read, webhooks:write. A normal connection with only those permissions cannot use this preview. Missing/unknown grants fail closed before token refresh or API calls.

Enabling the new read permission is a separate decision and implementation: approve the additional `event_types:read` scope, update the registered OAuth app/request flow consistently, then have an authorized test provider explicitly reauthorize. Do not tell existing users to reconnect the unchanged app and expect this permission to appear.

Before enabling in a test deployment:
1. Apply migration `114_calendly_service_availability_previews.sql` to a disposable database. It is idempotent and enables no service by itself. Reconcile its numbering with unmerged hourly-work migrations before release.
2. Use an authorized synthetic Calendly account with already-granted event-type read permission; do not use Doug's actual calendar without authorization.
3. Enable the feature in that test environment. Verify owner-only selection, removal, published/inactive service behavior, reconnect invalidation, deleted/private events, revoked grants, timeout/429 behavior and correct timezone display.
4. Verify desktop/mobile layout, keyboard operation, rapid/repeated actions and navigation during requests. Confirm the actual booking card remains primary and no preview action creates either system's booking.
5. Compare preview results with the selected Calendly event, including busy calendars, buffers, minimum notice and DST, plus known internal owner conflicts.

## Safety details

- Service/public-company/provider eligibility and same-provider connection ownership are checked server-side. Reconnection changes the exact PostgreSQL timestamp generation and invalidates saved selection until explicitly reselected.
- Upstream requests allow only the required Calendly GET endpoints, reject redirects, use existing timeouts and keep tokens on the server. Pagination is reconstructed from opaque cursors rather than following arbitrary URLs.
- Public output includes only the selected event name, duration, timezone and available timestamps. No account email, owner URI, attendee details, scheduling URLs or video links are returned.
- A bounded 30-second process-local cache coalesces requests; shared per-Calendly-user throttling covers multiple workers/connections. Failed refreshes never serve expired snapshots. Public eligibility/grants are rechecked after the upstream operation.
- The UI distinguishes an empty result from an upstream failure, clears older results before refresh, aborts requests on navigation and does not imply a reservation.

## Verification

Final local checks: 616 tests passed, zero failed; TypeScript, ESLint, production build and diff whitespace checks passed. The production build generated 170 static pages.

Automated coverage includes protocol/permission/URL validation, pagination, ownership, inactive/private event handling, UTC/DST, conflict boundaries and synthetic PostgreSQL migration/public-eligibility/generation checks. Real route/service modules also run against explicit synthetic auth/database/API mocks, including request coalescing, expiry failure and unpublishing during an upstream request. These are not substitutes for authorized live Calendly and browser end-to-end checks.
