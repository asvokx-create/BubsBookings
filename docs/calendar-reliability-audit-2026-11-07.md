# BubsBookings Calendar Reliability Audit

Date: November 7, 2026

Code status: **READY TO PUSH**

Production verification verdict: **ADDITIONAL VERIFICATION REQUIRED**

The code changes are build-clean and ready for a controlled test-environment deployment. A disposable database plus an authorized Calendly test account were not available locally, so the requested live appointment lifecycle and simultaneous database transaction test remain unverified. No production records, appointments, availability settings, payments, or external calendars were modified.

## Scheduling architecture

- Public availability is generated server-side in 30-minute increments from service/provider or team-member hours.
- The complete selected duration, including hourly duration and add-on minutes, is checked against working hours, time off, confirmed BubsBookings appointments, and synchronized Calendly appointments.
- Customer booking creation rechecks availability inside a database transaction protected by a provider-scoped PostgreSQL advisory lock.
- A customer request remains `requested` and does not reserve the slot for other customers. The product explains that the provider must confirm the request before the time is reserved.
- Provider acceptance acquires the same provider lock, rechecks every assigned professional, confirms only one request, and cancels competing requests for the accepted professional and interval.
- Confirmed bookings reserve the interval independently of payment state. Stripe checkout is available only after confirmation, uses idempotency keys, and never sets calendar ownership from a webhook.
- Canceled bookings release availability. Completed appointments are historical and do not block future intervals.
- Calendly OAuth uses PKCE, encrypted rotating tokens, server-side state, paginated active/canceled event synchronization, signed webhooks, and delivery deduplication.
- Provider calendars expose internal bookings, time off, and external Calendly appointments as distinct event kinds.

## Confirmed bugs and fixes

### Stale Calendly data could be treated as current

Previously, conflict prevention used the latest imported Calendly rows without enforcing synchronization freshness. A revoked token, failed API request, delayed webhook, or stale manual sync could therefore allow owner slots to be shown or confirmed using old data.

Fixes:

- Conflict-enabled connections are now reconciled by the existing 15-minute scheduled operation when their last successful sync is older than 10 minutes or an error exists.
- Calendly network calls have a 15-second request timeout, and scheduled reconciliation uses a bounded three-worker batch so a stalled external request cannot wait forever or create unbounded concurrency.
- Owner availability fails closed after 20 minutes without a successful clean sync.
- The same freshness rule is enforced in public slot discovery, booking requests, provider acceptance, owner assignment, quote-created bookings, and reschedule discovery/approval through the shared staff check.
- Team members who do not depend on the owner's Calendly account remain independently bookable.
- Providers now see whether conflict protection is current or stale and receive a clear recovery action.

### Ambiguous daylight-saving times were silently resolved

The booking API previously relied on PostgreSQL `AT TIME ZONE`, which can silently choose an offset for a repeated fall-back wall-clock time.

Fixes:

- Invalid, skipped, and repeated local times are rejected explicitly.
- Ambiguous times are removed from customer and reschedule slot responses.
- The customer slot list displays the provider timezone.
- Appointment duration continues to be applied to the UTC instant, preventing silent clock shifts.

### Calendly plan guidance was outdated

The UI still said automatic webhooks required Standard, Teams, or Enterprise. Calendly's November 3, 2026 release made webhooks available on all plans, including Free.

Fixes:

- Removed the paid-plan claim.
- A 403 is now treated as a permission/connection failure with reconnect and manual-sync guidance.
- Manual sync remains available as a fallback.

Official references:

- https://developer.calendly.com/release-notes/2026/11/3
- https://developer.calendly.com/api-docs/calendly-api/webhooks/create-webhook-subscription
- https://developer.calendly.com/docs/api-guides/see-how-webhook-payloads-change-when-invitees-reschedule-events

## Conflict and payment behavior

- Simultaneous schedule mutations are serialized by a provider-scoped transaction advisory lock and followed by a server-side overlap recheck.
- All exclusive intervals use half-open overlap logic: existing start `<` candidate end and existing end `>` candidate start.
- Existing active Calendly events block only the provider owner when the provider enabled conflict prevention.
- If conflict protection is enabled but current Calendly availability cannot be verified, owner availability is paused rather than advertised as real-time.
- Failed or abandoned Stripe checkout does not release a confirmed appointment. This is the existing business rule: provider confirmation reserves the appointment before payment. There is no separate temporary checkout-hold status or unpaid-booking expiration policy.
- No fee, payout, refund, subscription, affiliate, or Stripe calculation was changed.

## Configured and unsupported scheduling rules

Enforced existing rules:

- Service duration and hourly duration
- Add-on duration
- Provider and team-member working hours
- Provider time off
- Confirmed internal appointments
- Active synchronized Calendly appointments when enabled
- Booking ownership and authorization

No persisted configuration was found for preparation/travel buffers, minimum booking notice, breaks, or maximum appointments per day. These rules were not invented or silently enforced.

## Files changed

- `app/api/bookings/route.ts`
- `app/api/services/[serviceId]/availability/route.ts`
- `app/api/providers/bookings/[bookingId]/route.ts`
- `app/api/bookings/[bookingId]/reschedule/availability/route.ts`
- `app/api/cron/booking-reminders/route.ts`
- `app/api/integrations/calendly/route.ts`
- `app/services/[slug]/booking-card.tsx`
- `components/calendly-integration-panel.tsx`
- `lib/booking-staff.ts`
- `lib/calendly.ts`
- `lib/zoned-date-time.ts`
- `tests/calendar-reliability.test.ts`
- `tests/calendly-integration.test.ts`
- `tests/zoned-date-time.test.ts`

Database migrations required: **none**.

## Exact verification results

- TypeScript: `npx tsc --noEmit` — passed, exit 0.
- ESLint: `npm run lint` — passed, exit 0.
- Targeted calendar, Calendly, reschedule, and timezone tests — 42 passed, 0 failed.
- Full automated suite: `npm test` — 590 passed, 0 failed.
- Production build: `npm run build` — passed, exit 0; 169 static pages generated. Build-time Better Auth schema checks logged expected database-connection warnings because the sandbox had no database connection, but the build completed successfully.
- `git diff --check` — passed; only line-ending notices were emitted.

## Remaining verification

Before production deployment, use a disposable environment to perform:

1. Connect an authorized Calendly test account.
2. Create, reschedule, and cancel a synthetic Calendly appointment.
3. Confirm public BubsBookings slots block and release correctly.
4. Run two simultaneous provider confirmations against the same synthetic interval and verify only one commits.
5. Exercise failed, abandoned, successful, delayed, and duplicate Stripe checkout/webhook cases with test-mode Stripe.
6. Check the customer calendar and provider calendar at mobile and desktop widths with synthetic records.
7. Confirm the production scheduler invokes `/api/cron/booking-reminders` every 15 minutes with `CRON_SECRET`.

Until those environment-backed checks run, production cross-platform synchronization cannot be claimed as fully verified.
