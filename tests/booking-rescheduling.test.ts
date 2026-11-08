import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("reschedule requests are durable, auditable, expiring, and unique while pending", async () => {
  const migration = await read("database/migrations/109_two_sided_booking_rescheduling.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS booking_reschedule_requests/);
  assert.match(migration, /requester_role IN \('customer', 'provider'\)/);
  assert.match(migration, /'pending', 'approved', 'declined', 'withdrawn', 'expired', 'time_unavailable'/);
  assert.match(migration, /original_starts_at timestamptz NOT NULL/);
  assert.match(migration, /proposed_starts_at timestamptz NOT NULL/);
  assert.match(migration, /expires_at timestamptz NOT NULL DEFAULT \(now\(\) \+ interval '72 hours'\)/);
  assert.match(migration, /UNIQUE INDEX IF NOT EXISTS booking_reschedule_requests_pending_key/);
  assert.match(migration, /WHERE status = 'pending'/);
});

test("customers and provider owners can propose a time without moving the booking", async () => {
  const route = await read("app/api/bookings/[bookingId]/reschedule/route.ts");
  assert.match(route, /booking\.customer_id=\$2 OR provider\.user_id=\$2/);
  assert.match(route, /requesterRole = session\.user\.id === booking\.customer_id \? "customer" : "provider"/);
  assert.match(route, /booking\.status !== "confirmed"/);
  assert.match(route, /INSERT INTO booking_reschedule_requests/);
  const requestSection = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function PATCH"));
  assert.doesNotMatch(requestSection, /UPDATE bookings SET starts_at/);
  assert.match(requestSection, /The original time remains confirmed until you approve/);
});

test("only the other party may approve or decline and only the requester may withdraw", async () => {
  const route = await read("app/api/bookings/[bookingId]/reschedule/route.ts");
  assert.match(route, /recipientId = proposal\.requester_role === "customer" \? proposal\.provider_user_id : proposal\.customer_id/);
  assert.match(route, /action === "withdraw" \? proposal\.requested_by !== session\.user\.id : recipientId !== session\.user\.id/);
  assert.match(route, /Only the other party can approve or decline this request/);
  assert.match(route, /Only the requester can withdraw this request/);
});

test("approval is atomic and rechecks assigned staff, internal bookings, time off, and Calendly", async () => {
  const route = await read("app/api/bookings/[bookingId]/reschedule/route.ts");
  const staff = await read("lib/booking-staff.ts");
  assert.match(route, /FOR UPDATE OF proposal,booking/);
  assert.match(route, /pg_advisory_xact_lock/);
  assert.match(route, /unavailableBookingProfessionals/);
  assert.match(route, /status = unavailable\.length \? "time_unavailable" : "approved"/);
  assert.match(route, /UPDATE bookings SET starts_at=\$2,ends_at=\$3/);
  assert.match(staff, /provider_time_off/);
  assert.match(staff, /other\.status = 'confirmed'/);
  assert.match(staff, /provider_calendly_events/);
  assert.match(staff, /block_conflicting_bookings = true/);
});

test("calendar slot discovery and final approval both respect synchronized Calendly conflicts", async () => {
  const publicAvailability = await read("app/api/services/[serviceId]/availability/route.ts");
  const rescheduleAvailability = await read("app/api/bookings/[bookingId]/reschedule/availability/route.ts");
  for (const source of [publicAvailability, rescheduleAvailability]) {
    assert.match(source, /provider_calendly_connections/);
    assert.match(source, /provider_calendly_events/);
    assert.match(source, /block_conflicting_bookings=true/);
    assert.match(source, /external_event\.status='active'/);
  }
  assert.match(rescheduleAvailability, /other\.id<>info\.id/);
  assert.match(rescheduleAvailability, /booking\.status='confirmed'/);
});

test("proposed times are not calendar events or external Calendly mutations", async () => {
  const route = await read("app/api/bookings/[bookingId]/reschedule/route.ts");
  const calendar = await read("app/api/calendar/route.ts");
  assert.doesNotMatch(calendar, /booking_reschedule_requests/);
  assert.doesNotMatch(route, /syncCalendlyConnection|apiRequest|webhook_subscription|external_event_uri/);
  assert.match(route, /The proposed time is no longer available\. The original booking remains confirmed/);
});

test("schedule approval preserves every booking financial snapshot and never invokes Stripe", async () => {
  const route = await read("app/api/bookings/[bookingId]/reschedule/route.ts");
  assert.doesNotMatch(route, /price_cents\s*=|platform_fee_cents\s*=|provider_payout_cents\s*=|customer_service_fee_cents\s*=/);
  assert.doesNotMatch(route, /stripe|charge|transfer|refund/i);
  assert.match(route, /UPDATE bookings SET starts_at=\$2,ends_at=\$3/);
});

test("requests expire through scheduled operations and notify both parties idempotently", async () => {
  const helper = await read("lib/booking-rescheduling.ts");
  const cron = await read("app/api/cron/booking-reminders/route.ts");
  assert.match(helper, /SET status='expired'/);
  assert.match(helper, /booking-reschedule-\$\{request\.id\}-expired-\$\{userId\}/);
  assert.match(helper, /sendRescheduleEmails\(id, "expired"\)/);
  assert.match(cron, /expireRescheduleRequests\(\)/);
});

test("reschedule emails include reference, original and proposed times, timezone, status, and secure account links", async () => {
  const helper = await read("lib/booking-rescheduling.ts");
  assert.match(helper, /Booking #\$\{reference\}/);
  assert.match(helper, /Original: \$\{original\}/);
  assert.match(helper, /Proposed: \$\{proposed\}/);
  assert.match(helper, /Timezone: \$\{row\.timezone\}/);
  assert.match(helper, /Status: \$\{copy\[outcome\]\.status\}/);
  assert.match(helper, /booking-reschedule-\$\{requestId\}-\$\{outcome\}-\$\{recipient\.id\}/);
  assert.match(helper, /\/account\/bookings\//);
  assert.match(helper, /\/provider\/dashboard\/bookings\//);
});

test("booking details provide a two-sided accessible mobile workflow and full request history", async () => {
  const component = await read("components/booking-details.tsx");
  const bookingApi = await read("app/api/bookings/[bookingId]/route.ts");
  assert.match(component, /booking\.viewerRole !== "worker"/);
  assert.match(component, /Request reschedule/);
  assert.match(component, /BookingDatePicker/);
  assert.match(component, /Available reschedule time/);
  assert.match(component, /original appointment remains confirmed/);
  assert.match(component, /Approve new time/);
  assert.match(component, /Withdraw request/);
  assert.match(component, /Rescheduling history/);
  assert.match(component, /overflow-y-auto/);
  assert.match(bookingApi, /rescheduleHistory/);
  assert.match(bookingApi, /booking_reschedule_requests/);
});

test("legacy one-sided mutation paths are disabled", async () => {
  const customer = await read("app/api/bookings/[bookingId]/route.ts");
  const provider = await read("app/api/providers/bookings/[bookingId]/route.ts");
  assert.doesNotMatch(customer, /request_reschedule/);
  assert.doesNotMatch(provider, /approve_reschedule|decline_reschedule/);
});
