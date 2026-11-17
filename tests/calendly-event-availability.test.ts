import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { CALENDLY_OAUTH_SCOPES } from "../lib/calendly-api.ts";
import { calendlyEventTypeUri, calendlyPreviewWindow, eligibleCalendlyPreviewEvent, excludeCalendlyPreviewConflicts, hasCalendlyEventTypeReadScope, listCalendlyPreviewEvents, normalizeCalendlyPreviewSlots, readCalendlyPreview, readCalendlyPreviewEvent, safeCalendlyPreviewTimezone, type CalendlyRead } from "../lib/calendly-event-availability.ts";
import { PUBLIC_CALENDLY_PREVIEW_QUERY, CALENDLY_PREVIEW_CONFLICTS_QUERY, SAVE_CALENDLY_PREVIEW_QUERY } from "../lib/calendly-preview-queries.ts";

const owner = "https://api.calendly.com/users/test-owner";
const uri = "https://api.calendly.com/event_types/test-event";
const event = { uri, name: "Public consultation", active: true, secret: false, duration: 30, kind: "solo", pooling_type: null, profile: { type: "User", owner } };
const now = Date.parse("2026-11-01T05:00:00Z");
const window = calendlyPreviewWindow(now);
function fakeRead(handler: (path: string) => unknown): CalendlyRead { return async <T>(path: string) => handler(path) as T; }

test("preview recognizes an existing read grant without expanding OAuth permissions", () => {
  assert.equal(hasCalendlyEventTypeReadScope("users:read event_types:read"), true);
  assert.equal(hasCalendlyEventTypeReadScope("event_types:write"), true);
  for (const scope of ["", "scheduled_events:read", "availability:read", "event_types:read-extra"]) assert.equal(hasCalendlyEventTypeReadScope(scope), false);
  assert.deepEqual(CALENDLY_OAUTH_SCOPES, ["users:read", "scheduled_events:read", "webhooks:write"]);
});

test("event selection rejects arbitrary origins, credentials, query strings and path injection", () => {
  assert.equal(calendlyEventTypeUri(uri), uri);
  for (const input of [null, "http://api.calendly.com/event_types/a", "https://attacker.example/event_types/a", `${uri}?x=y`, `${uri}#fragment`, `${uri}/../users/me`, "https://user@api.calendly.com/event_types/a", "https://api.calendly.com/event_types/%2e%2e", "//api.calendly.com/event_types/a"]) assert.equal(calendlyEventTypeUri(input), null);
});

test("only a provider's active public fixed-duration personal event can be selected", () => {
  assert.deepEqual(eligibleCalendlyPreviewEvent(event, owner), { uri, name: event.name, durationMinutes: 30, collectsPayment: null });
  for (const changes of [{ active: false }, { secret: true }, { secret: undefined }, { kind: "group" }, { pooling_type: "round_robin" }, { duration: 0 }, { duration: 30.5 }, { duration: 1441 }, { duration_options: [15, 30] }, { profile: { type: "User", owner: "another-owner" } }, { profile: { type: "Team", owner } }]) {
    assert.equal(eligibleCalendlyPreviewEvent({ ...event, ...changes }, owner), null);
  }
});

test("availability window is future UTC and stays within the documented 31-day maximum across DST", () => {
  assert.equal(window.startsAt, "2026-11-01T05:01:00.000Z");
  assert.equal(Date.parse(window.endsAt) - Date.parse(window.startsAt), 7 * 86_400_000);
  assert.throws(() => calendlyPreviewWindow(NaN));
});

test("availability normalizes, sorts and deduplicates without exposing external scheduling URLs", () => {
  const slot = (start_time: string, more = {}) => ({ status: "available", invitees_remaining: 1, start_time, scheduling_url: "https://private.example/secret", ...more });
  const result = normalizeCalendlyPreviewSlots([
    slot("2026-11-01T06:30:00Z"), slot("2026-11-01T05:30:00Z"), slot("2026-11-01T05:30:00Z"),
    slot("2026-11-01T05:31:00Z", { status: "unavailable" }), slot("2026-11-01T05:32:00Z", { invitees_remaining: 0 }),
    slot("2026-10-31T05:30:00Z"), slot(window.endsAt), slot("not-a-date"), slot("2026-11-01T05:40:00"),
  ], 30, window);
  assert.deepEqual(result.map(slot => slot.startsAt), ["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]);
  assert.equal(result[0].endsAt, "2026-11-01T06:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(result), /secret|scheduling_url/);
  assert.throws(() => normalizeCalendlyPreviewSlots({}, 30, window));
});

test("known owner conflicts use half-open intervals, including adjacent appointments", () => {
  const slots = [{ startsAt: "2026-11-01T05:30:00Z", endsAt: "2026-11-01T06:00:00Z" }];
  assert.equal(excludeCalendlyPreviewConflicts(slots, [{ startsAt: "2026-11-01T06:00:00Z", endsAt: "2026-11-01T06:30:00Z" }]).length, 1);
  assert.equal(excludeCalendlyPreviewConflicts(slots, [{ startsAt: "2026-11-01T05:29:00Z", endsAt: "2026-11-01T05:31:00Z" }]).length, 0);
});

test("pagination rebuilds paths from opaque tokens and restricts events to the connected owner", async () => {
  const paths: string[] = [];
  const events = await listCalendlyPreviewEvents(fakeRead(path => {
    paths.push(path);
    return paths.length === 1 ? { collection: [event], pagination: { next_page_token: "cursor&user=attacker", next_page: "https://attacker.example" } }
      : { collection: [{ ...event, uri: `${uri}-other`, profile: { type: "User", owner: "other" } }], pagination: {} };
  }), owner);
  assert.equal(events.length, 1);
  assert.equal(new URL(paths[1], "https://api.calendly.com").searchParams.get("user"), owner);
  assert.equal(new URL(paths[1], "https://api.calendly.com").searchParams.get("page_token"), "cursor&user=attacker");
  assert.ok(paths.every(path => path.startsWith("/event_types?")));
});

test("invalid pagination and upstream errors do not return a misleading partial list", async () => {
  await assert.rejects(listCalendlyPreviewEvents(fakeRead(() => ({ collection: [event], pagination: { next_page: "https://attacker.example" } })), owner));
  await assert.rejects(listCalendlyPreviewEvents(fakeRead(() => ({ collection: [event], pagination: { next_page_token: "same" } })), owner));
  await assert.rejects(listCalendlyPreviewEvents(fakeRead(() => { throw new Error("403"); }), owner), /403/);
});

test("fresh event validation precedes availability and never sends invitee/customer details", async () => {
  const paths: string[] = [];
  const result = await readCalendlyPreview(fakeRead(path => {
    paths.push(path);
    return paths.length === 1 ? { resource: event } : { collection: [{ status: "available", invitees_remaining: 1, start_time: "2026-11-01T05:30:00Z" }] };
  }), owner, uri, now);
  assert.equal(result.slots.length, 1);
  assert.equal(paths[0], "/event_types/test-event");
  const params = new URL(paths[1], "https://api.calendly.com").searchParams;
  assert.equal(params.get("event_type"), uri);
  assert.deepEqual([...params.keys()].sort(), ["end_time", "event_type", "start_time"]);
  await assert.rejects(readCalendlyPreviewEvent(fakeRead(() => ({ resource: { ...event, uri: `${uri}-substitute` } })), owner, uri));
});

test("revoked, inactive or private event responses fail closed before listing times", async () => {
  let calls = 0;
  await assert.rejects(readCalendlyPreview(fakeRead(() => { calls++; return { resource: { ...event, secret: true } }; }), owner, uri, now));
  assert.equal(calls, 1);
  await assert.rejects(readCalendlyPreview(fakeRead(() => { throw new Error("429"); }), owner, uri, now), /429/);
});

test("invalid provider time zones fall back safely; DST times retain distinct UTC instants", () => {
  assert.equal(safeCalendlyPreviewTimezone("America/New_York"), "America/New_York");
  assert.equal(safeCalendlyPreviewTimezone("invalid"), "UTC");
  const format = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", timeZoneName: "shortOffset" });
  assert.notEqual(format.format(new Date("2026-11-01T05:30:00Z")), format.format(new Date("2026-11-01T06:30:00Z")));
});

test("preview routes are opt-in, owner-authorized, read-only upstream, bounded and explicit", () => {
  const source = (path: string) => readFileSync(path, "utf8");
  const settings = source("app/api/integrations/calendly/availability-preview/route.ts");
  const server = source("lib/calendly-service-preview.ts");
  const integration = source("lib/calendly.ts");
  const ui = source("components/calendly-availability-preview.tsx");
  assert.equal((settings.match(/access\?\.isOwner/g) ?? []).length, 2);
  assert.match(source("lib/calendly-preview-queries.ts"), /service\.provider_id::text=\$2/);
  assert.match(server, /CALENDLY_AVAILABILITY_PREVIEW_ENABLED === "true"/);
  // The shared integration also contains a separately gated booking transport.
  // Inspect the actual preview function, not unrelated exports in the module.
  const parsed = ts.createSourceFile("calendly.ts", integration, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const previewFunction = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "calendlyPreviewRead");
  assert.ok(previewFunction, "The read-only preview transport must exist.");
  const preview = previewFunction.getText(parsed);
  assert.match(preview, /userId: expectedOwnerUri, bucket: "calendly_preview_upstream", limit: 20/);
  assert.match(preview, /method: "GET", redirect: "error"/);
  assert.doesNotMatch(preview, /POST|invitees|scheduled_events:write|calendlyCallRequest/);
  assert.doesNotMatch(settings + server, /calendlyCallRequest|createCalendlyCallOnce|calendly-call-runtime/);
  assert.match(server, /snapshotKey\(stillPublic\) !== key/);
  assert.match(ui, /No meeting is reserved here/);
  assert.match(ui, /do not create a Calendly booking/);
  assert.match(ui, /AbortController/);
  assert.match(ui, /60_000/);
});

test("preview migration and public eligibility execute against synthetic PostgreSQL data", async () => {
  const db = new PGlite();
  const provider = "00000000-0000-0000-0000-000000000001", company = "00000000-0000-0000-0000-000000000002";
  const service = "00000000-0000-0000-0000-000000000003", connection = "00000000-0000-0000-0000-000000000004";
  try {
    await db.exec(`CREATE TABLE provider_profiles(id uuid PRIMARY KEY,is_active boolean,age_verification_status text);
      CREATE TABLE provider_companies(id uuid PRIMARY KEY,is_active boolean);
      CREATE TABLE services(id uuid PRIMARY KEY,provider_id uuid,company_id uuid,is_active boolean,provider_deleted_at timestamptz,delivery_type text);
      CREATE TABLE provider_calendly_connections(id uuid PRIMARY KEY,provider_id uuid,calendly_user_uri text,connected_at timestamptz,disconnected_at timestamptz,account_timezone text,granted_scope text);
      CREATE TABLE provider_time_off(provider_id uuid,team_member_id uuid,starts_at timestamptz,ends_at timestamptz);
      CREATE TABLE bookings(id uuid PRIMARY KEY,provider_id uuid,status text,starts_at timestamptz,ends_at timestamptz);
      CREATE TABLE booking_assignees(booking_id uuid,is_owner boolean);
      INSERT INTO provider_profiles VALUES('${provider}',true,'verified');
      INSERT INTO provider_companies VALUES('${company}',true);
      INSERT INTO services VALUES('${service}','${provider}','${company}',true,NULL,'REMOTE');
      INSERT INTO provider_calendly_connections VALUES('${connection}','${provider}','${owner}','2026-11-01',NULL,'UTC','event_types:read');`);
    const migration = readFileSync("database/migrations/114_calendly_service_availability_previews.sql", "utf8");
    await db.exec(migration); await db.exec(migration);
    const query = () => db.query(PUBLIC_CALENDLY_PREVIEW_QUERY, [service]);
    assert.equal((await query()).rows.length, 0, "no service auto-enabled");
    await db.query("INSERT INTO service_calendly_availability_previews(service_id,connection_id,calendly_user_uri,connection_connected_at,event_type_uri,event_type_name) VALUES($1,$2,$3,'2026-11-01',$4,'Test')", [service, connection, owner, uri]);
    assert.equal((await query()).rows.length, 1);
    for (const [update, restore] of [
      ["UPDATE services SET is_active=false", "UPDATE services SET is_active=true"],
      ["UPDATE services SET delivery_type='IN_PERSON'", "UPDATE services SET delivery_type='REMOTE'"],
      ["UPDATE services SET provider_deleted_at=now()", "UPDATE services SET provider_deleted_at=NULL"],
      ["UPDATE provider_profiles SET age_verification_status='pending'", "UPDATE provider_profiles SET age_verification_status='verified'"],
      ["UPDATE provider_companies SET is_active=false", "UPDATE provider_companies SET is_active=true"],
      ["UPDATE provider_calendly_connections SET disconnected_at=now()", "UPDATE provider_calendly_connections SET disconnected_at=NULL"],
      ["UPDATE provider_calendly_connections SET connected_at='2026-11-02'", "UPDATE provider_calendly_connections SET connected_at='2026-11-01'"],
      ["UPDATE provider_calendly_connections SET calendly_user_uri='other-owner'", `UPDATE provider_calendly_connections SET calendly_user_uri='${owner}'`],
      ["UPDATE provider_calendly_connections SET provider_id='00000000-0000-0000-0000-000000000099'", `UPDATE provider_calendly_connections SET provider_id='${provider}'`],
    ]) { await db.exec(update); assert.equal((await query()).rows.length, 0, update); await db.exec(restore); }
    await db.exec(`INSERT INTO provider_time_off VALUES('${provider}',NULL,'2026-11-01T05:30:00Z','2026-11-01T06:00:00Z');
      INSERT INTO provider_time_off VALUES('${provider}','00000000-0000-0000-0000-000000000099','2026-11-01T05:30:00Z','2026-11-01T06:00:00Z');
      INSERT INTO bookings VALUES('00000000-0000-0000-0000-000000000005','${provider}','confirmed','2026-11-01T07:00:00Z','2026-11-01T07:30:00Z');
      INSERT INTO booking_assignees VALUES('00000000-0000-0000-0000-000000000005',true);`);
    assert.equal((await db.query(CALENDLY_PREVIEW_CONFLICTS_QUERY, [service, window.startsAt, window.endsAt])).rows.length, 2);
    await db.exec("UPDATE provider_calendly_connections SET connected_at='2026-11-01T00:00:00.123456Z'");
    const precise = (await db.query<{ connected_at: string }>("SELECT connected_at::text FROM provider_calendly_connections")).rows[0].connected_at;
    assert.match(precise, /123456/);
    assert.equal((await db.query(SAVE_CALENDLY_PREVIEW_QUERY, [service, provider, connection, uri, "Test", owner, precise])).rows.length, 1);
    assert.equal((await query()).rows.length, 1, "exact fractional timestamp generation survives save and read");
    assert.equal((await db.query(SAVE_CALENDLY_PREVIEW_QUERY, [service, provider, connection, uri, "Test", owner, "2026-11-01T00:00:00.123Z"])).rows.length, 0);
    assert.equal((await db.query(SAVE_CALENDLY_PREVIEW_QUERY, [service, "00000000-0000-0000-0000-000000000099", connection, uri, "Test", owner, precise])).rows.length, 0);
    await assert.rejects(db.query("UPDATE service_calendly_availability_previews SET event_type_uri='https://attacker.example/event'"));
  } finally { await db.close(); }
});
