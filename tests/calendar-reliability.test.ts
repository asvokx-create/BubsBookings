import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("customer availability blocks confirmed internal and active Calendly overlaps", () => {
  const route = source("app/api/services/[serviceId]/availability/route.ts");
  assert.match(route, /b\.status = 'confirmed'/);
  assert.match(route, /external_event\.status='active'/);
  assert.match(route, /blocked\.starts_at < gs\.starts_at \+ make_interval/);
  assert.match(route, /b\.starts_at < gs\.starts_at \+ make_interval/);
});

test("stale conflict-enabled Calendly data fails owner availability closed", () => {
  for (const path of [
    "app/api/services/[serviceId]/availability/route.ts",
    "app/api/bookings/route.ts",
    "lib/booking-staff.ts",
    "app/api/providers/bookings/[bookingId]/route.ts",
    "app/api/bookings/[bookingId]/reschedule/availability/route.ts",
  ]) {
    const contents = source(path);
    assert.match(contents, /block_conflicting_bookings\s*=\s*true|block_conflicting_bookings=true/);
    assert.match(contents, /last_sync_succeeded_at\s*(?:IS NULL|<)/);
    assert.match(contents, /20 minutes/);
    assert.match(contents, /last_sync_error IS NOT NULL/);
  }
});

test("the scheduled operation reconciles enabled Calendly connections", () => {
  const integration = source("lib/calendly.ts");
  const cron = source("app/api/cron/booking-reminders/route.ts");
  assert.match(integration, /export async function syncDueCalendlyConnections/);
  assert.match(integration, /last_sync_succeeded_at < now\(\)-interval '10 minutes'/);
  assert.match(integration, /LIMIT 12/);
  assert.match(integration, /Math\.min\(3, due\.rows\.length\)/);
  assert.match(integration, /AbortSignal\.timeout\(CALENDLY_REQUEST_TIMEOUT_MS\)/);
  assert.match(cron, /syncDueCalendlyConnections\(\)/);
});

test("booking confirmation and assignment serialize provider schedule mutations", () => {
  const providerRoute = source("app/api/providers/bookings/[bookingId]/route.ts");
  const bookingRoute = source("app/api/bookings/route.ts");
  const rescheduleRoute = source("app/api/bookings/[bookingId]/reschedule/route.ts");
  assert.match(providerRoute, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(bookingRoute, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(rescheduleRoute, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(providerRoute, /unavailableBookingProfessionals/);
  assert.match(rescheduleRoute, /unavailableBookingProfessionals/);
});

test("payment state remains separate from schedule ownership", () => {
  const checkout = source("app/api/stripe/bookings/[bookingId]/checkout/route.ts");
  const webhook = source("app/api/stripe/webhook/route.ts");
  assert.match(checkout, /booking\.status !== "confirmed"/);
  assert.match(checkout, /idempotencyKey/);
  assert.match(webhook, /markBookingPaid/);
  assert.doesNotMatch(webhook, /UPDATE bookings SET status\s*=\s*'confirmed'/);
});

test("calendar displays internal and external appointments as distinct event kinds", () => {
  const calendar = source("app/api/calendar/route.ts");
  assert.match(calendar, /kind: "booking"/);
  assert.match(calendar, /kind: "calendly"/);
});
