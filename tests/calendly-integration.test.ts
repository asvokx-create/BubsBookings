import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CALENDLY_OAUTH_SCOPES, calendlyApiUrl, calendlyScheduledEventStatus, calendlyWebhookOwnerUris } from "../lib/calendly-api.ts";
import { verifyCalendlyWebhookSignature } from "../lib/calendly-webhook.ts";

const integration = readFileSync("lib/calendly.ts", "utf8");
const migration = readFileSync("database/migrations/107_calendly_calendar_integration.sql", "utf8");
const calendarApi = readFileSync("app/api/calendar/route.ts", "utf8");
const bookingApi = readFileSync("app/api/bookings/route.ts", "utf8");
const bookingStaff = readFileSync("lib/booking-staff.ts", "utf8");
const providerBookingApi = readFileSync("app/api/providers/bookings/[bookingId]/route.ts", "utf8");
const panel = readFileSync("components/calendly-integration-panel.tsx", "utf8");

test("Calendly webhook verifier accepts an authentic recent payload", () => {
  const rawBody = JSON.stringify({ event: "invitee.created", payload: { uri: "invitee-1" } });
  const timestamp = 1_800_000_000;
  const signingKey = "test-signing-key";
  const signature = createHmac("sha256", signingKey).update(`${timestamp}.${rawBody}`).digest("hex");
  assert.equal(verifyCalendlyWebhookSignature({ rawBody, header: `t=${timestamp},v1=${signature}`, signingKey, nowMs: timestamp * 1000 }), true);
});

test("Calendly OAuth uses PKCE and confidential-client authentication", () => {
  assert.match(integration, /code_challenge_method", "S256"/);
  assert.match(integration, /code_verifier:/);
  assert.match(integration, /Authorization: basicAuthorization\(\)/);
  assert.match(integration, /client_id: calendlyConfiguration\(\)\.clientId/);
  assert.match(integration, /reason === "invalid_client"/);
  assert.deepEqual(CALENDLY_OAUTH_SCOPES, ["users:read", "scheduled_events:read", "webhooks:write"]);
  assert.match(integration, /searchParams\.set\("scope", CALENDLY_OAUTH_SCOPES\.join\(" "\)\)/);
});

test("Calendly API pagination cannot redirect credentialed requests to another origin", () => {
  assert.equal(calendlyApiUrl("/scheduled_events").origin, "https://api.calendly.com");
  assert.equal(calendlyApiUrl("https://api.calendly.com/scheduled_events?page_token=next").hostname, "api.calendly.com");
  assert.throws(() => calendlyApiUrl("https://attacker.example/collect"), /invalid API URL/);
});

test("Calendly webhook verifier rejects tampering, missing signatures, and replays", () => {
  const rawBody = "{}";
  const timestamp = 1_800_000_000;
  const signingKey = "test-signing-key";
  const signature = createHmac("sha256", signingKey).update(`${timestamp}.${rawBody}`).digest("hex");
  assert.equal(verifyCalendlyWebhookSignature({ rawBody: '{"changed":true}', header: `t=${timestamp},v1=${signature}`, signingKey, nowMs: timestamp * 1000 }), false);
  assert.equal(verifyCalendlyWebhookSignature({ rawBody, header: null, signingKey, nowMs: timestamp * 1000 }), false);
  assert.equal(verifyCalendlyWebhookSignature({ rawBody, header: `t=${timestamp},v1=${signature}`, signingKey, nowMs: (timestamp + 181) * 1000 }), false);
});

test("OAuth uses server-side state, required PKCE, encrypted rotating credentials, and ownership", () => {
  assert.ok(integration.includes('url.searchParams.set("code_challenge_method", "S256")'));
  assert.match(integration, /provider_calendly_oauth_states/);
  assert.match(integration, /aes-256-gcm/);
  assert.match(integration, /refresh_token_encrypted=\$3/);
  assert.match(integration, /FOR UPDATE/);
  assert.match(readFileSync("app/api/integrations/calendly/route.ts", "utf8"), /access\?\.isOwner/);
});

test("appointments are imported idempotently and webhook deliveries are deduplicated", () => {
  assert.match(migration, /UNIQUE \(connection_id, external_event_uri\)/);
  assert.match(migration, /payload_hash text PRIMARY KEY/);
  assert.match(integration, /ON CONFLICT\(connection_id,external_event_uri\) DO UPDATE/);
  assert.match(integration, /WHERE calendly_webhook_deliveries\.status='failed'/);
  assert.match(integration, /source_updated_at/);
  assert.match(integration, /excluded\.source_updated_at IS NOT NULL AND excluded\.source_updated_at>=provider_calendly_events\.source_updated_at/);
});

test("manual synchronization explicitly imports active and canceled appointments", () => {
  assert.match(integration, /for \(const status of \["active", "canceled"\]/);
  assert.match(integration, /first\.searchParams\.set\("status", status\)/);
  assert.match(integration, /if \(nextUrl\) throw new Error\("Calendly synchronization exceeded/);
});

test("co-hosted and group events resolve safely", () => {
  const owners = calendlyWebhookOwnerUris({ event_memberships: [
    { user: "https://api.calendly.com/users/owner-a" },
    { user: "https://api.calendly.com/users/owner-b" },
    { user: "https://attacker.example/users/not-calendly" },
    { user: "https://api.calendly.com/users/owner-a" },
  ] });
  assert.deepEqual(owners, ["https://api.calendly.com/users/owner-a", "https://api.calendly.com/users/owner-b"]);
  assert.equal(calendlyScheduledEventStatus("invitee.canceled", "active"), "active");
  assert.equal(calendlyScheduledEventStatus("invitee.canceled", "canceled"), "canceled");
  assert.equal(calendlyScheduledEventStatus("invitee.canceled", undefined), "canceled");
});

test("Calendly supports webhooks on current plans and retains a manual sync fallback", () => {
  assert.match(panel, /Sync now/);
  assert.match(integration, /Webhooks are supported on all current Calendly plans/);
  assert.match(integration, /webhook_status='failed'/);
  assert.match(integration, /invitee\.created/);
  assert.match(integration, /invitee\.canceled/);
});

test("external appointments appear separately without payment semantics", () => {
  assert.match(calendarApi, /kind: "calendly"/);
  assert.match(panel, /never create charges, commissions, or payouts/);
  assert.doesNotMatch(migration, /INSERT INTO bookings/i);
  assert.doesNotMatch(integration, /stripe|platform_fee|provider_payout/i);
});

test("optional conflict blocking is enforced at request, assignment, acceptance, and reschedule checks", () => {
  for (const source of [bookingApi, bookingStaff, providerBookingApi]) {
    assert.match(source, /provider_calendly_events/);
    assert.match(source, /block_conflicting_bookings/);
    assert.match(source, /external_event\.status\s*=\s*'active'/);
  }
});

test("disconnect revokes access, stops display, and retains external history", () => {
  assert.match(integration, /oauth\/revoke/);
  assert.match(integration, /disconnected_at=now\(\)/);
  assert.match(calendarApi, /connection\.disconnected_at IS NULL/);
  assert.doesNotMatch(integration, /DELETE FROM provider_calendly_events/);
});

test("admin monitoring excludes OAuth credentials", () => {
  const page = readFileSync("app/admin/integrations/calendly/page.tsx", "utf8");
  assert.match(page, /webhook_status/);
  assert.match(page, /last_sync_succeeded_at/);
  assert.match(page, /last_sync_error/);
  assert.doesNotMatch(page, /access_token_encrypted|refresh_token_encrypted/);
});
