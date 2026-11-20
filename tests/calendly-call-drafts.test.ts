import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
import * as drafts from "../lib/calendly-call-drafts.ts";
import * as queries from "../lib/calendly-call-draft-queries.ts";
import * as protocol from "../lib/calendly-event-availability.ts";
import { calculateBookingFinancialSnapshot } from "../lib/booking-financials.ts";

const owner = "https://api.calendly.com/users/synthetic-owner";
const uri = "https://api.calendly.com/event_types/synthetic-event";
const event = { uri, active: true, secret: false, kind: "solo", name: "Synthetic call", duration: 30, is_paid: false, profile: { type: "User", owner } };
const provider = "00000000-0000-0000-0000-000000000001", service = "00000000-0000-0000-0000-000000000002", connection = "00000000-0000-0000-0000-000000000003";
const generation = "2026-11-14 01:02:03.123456+00";
const revision = "00000000-0000-0000-0000-000000000004";
const payload = { serviceId: service, eventTypeUri: uri, billingMode: "paid", servicePriceCents: 5000, revision: null };

test("call billing requires an explicit mode and consistent integer USD cents", () => {
  assert.deepEqual(drafts.parseCalendlyCallBillingDraft({ billingMode: "free", servicePriceCents: 0 }), { billingMode: "free", servicePriceCents: 0 });
  for (const price of [50, 5000, 100_000_000]) assert.deepEqual(drafts.parseCalendlyCallBillingDraft({ billingMode: "paid", servicePriceCents: price }), { billingMode: "paid", servicePriceCents: price });
  for (const input of [null, [], {}, { billingMode: "free", servicePriceCents: 50 }, { billingMode: "free" }, { billingMode: "unknown", servicePriceCents: 5000 },
    ...[0, 49, -50, 50.5, "5000", NaN, Infinity, 100_000_001].map(servicePriceCents => ({ billingMode: "paid", servicePriceCents }))]) assert.equal(drafts.parseCalendlyCallBillingDraft(input), null);
});

test("dollar entry converts exactly without rounding, exponent or empty-input coercion", () => {
  for (const [input, expected] of [["0.50", 50], ["12", 1200], ["12.3", 1230], ["12.34", 1234], ["1000000.00",100_000_000]] as const) assert.equal(drafts.parseCallPriceDollars(input), expected);
  for (const input of ["", " ", "0", "0.49", "1.005", "5e2", "-5", "12.", ".50", "$10", "1,000", "1000000.01"]) assert.equal(drafts.parseCallPriceDollars(input), null, input);
});

test("only literal Calendly is_paid=false qualifies; unknown and paid remain fail-closed", () => {
  for (const is_paid of [undefined, null, true, "false", 0]) assert.equal(drafts.hasVerifiedNoCalendlyPayment(protocol.eligibleCalendlyPreviewEvent({ ...event, is_paid }, owner)!), false);
  assert.equal(drafts.hasVerifiedNoCalendlyPayment(protocol.eligibleCalendlyPreviewEvent(event, owner)!), true);
});

function loadRoute(options: { owner?: boolean; enabled?: boolean; scope?: string; serviceExists?: boolean; event?: unknown; limited?: boolean; saved?: boolean; saveError?: boolean; upstreamError?: boolean } = {}) {
  let apiCalls = 0;
  const sqlCalls: { sql: string; values: unknown[] }[] = [];
  const mocks: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
    "@/lib/provider-access": { getProviderAccess: async () => options.owner === false ? null : { isOwner: true, providerId: provider, session: { user: { id: "synthetic-user" } } } },
    "@/lib/database": { database: { query: async (sql: string, values: unknown[]) => {
      sqlCalls.push({ sql, values });
      if (sql.startsWith("SELECT id::text,calendly_user_uri")) return { rows: [{ id: connection, calendly_user_uri: owner, granted_scope: options.scope ?? "event_types:read", connected_at: generation }] };
      if (sql.startsWith("SELECT id::text FROM services")) return { rows: options.serviceExists === false ? [] : [{ id: service }] };
      if (sql === queries.SAVE_CALENDLY_CALL_DRAFT_QUERY || sql === queries.DELETE_CALENDLY_CALL_DRAFT_QUERY) {
        if (options.saveError) throw new Error("secret database data");
        return { rowCount: options.saved === false ? 0 : 1, rows: [{ revision }] };
      }
      return { rows: [{ id: service, title: "Synthetic service" }] };
    } } },
    "@/lib/calendly": { calendlyPreviewRead: async () => { apiCalls++; if (options.upstreamError) throw new Error("secret token"); return { resource: options.event ?? event, collection: [options.event ?? event], pagination: {} }; } },
    "@/lib/calendly-event-availability": protocol,
    "@/lib/calendly-call-drafts": drafts,
    "@/lib/calendly-call-draft-queries": queries,
    "@/lib/request-security": { enforceRateLimit: async () => options.limited !== true },
  };
  const output = ts.transpileModule(readFileSync("app/api/integrations/calendly/call-drafts/route.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} as { GET: (request: Request) => Promise<Response>; PUT: (request: Request) => Promise<Response> } };
  new Function("require", "module", "exports", "process", output)((name: string) => { if (!(name in mocks)) throw new Error(`Unexpected dependency ${name}`); return mocks[name]; }, mod, mod.exports, { env: { CALENDLY_CALL_DRAFTS_ENABLED: options.enabled === false ? "false" : "true" } });
  return { ...mod.exports, calls: () => ({ apiCalls, sqlCalls, writes: sqlCalls.filter(call => [queries.SAVE_CALENDLY_CALL_DRAFT_QUERY, queries.DELETE_CALENDLY_CALL_DRAFT_QUERY].includes(call.sql)) }) };
}
const request = (body: unknown = payload) => new Request("https://example.test/api/integrations/calendly/call-drafts", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("real draft handlers are owner-only, separately gated and rate-limited before DB or API access", async () => {
  for (const method of ["GET", "PUT"] as const) for (const [option, status] of [[{ owner: false },403], [{ enabled: false },method === "GET" ? 200 : 404], [{ limited: true },429]] as const) {
    const route = loadRoute(option); const response = await route[method](request());
    assert.equal(response.status, status); assert.equal(route.calls().apiCalls, 0); assert.equal(route.calls().sqlCalls.length, 0);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});

test("draft writes reject malformed amounts, missing revision, wrong provider, missing grants and external payment", async () => {
  for (const input of [null, { ...payload, revision: undefined }, { ...payload, revision: 1 }, { ...payload, servicePriceCents: 49 }, { ...payload, billingMode: "free" }, { ...payload, eventTypeUri: "https://attacker.example" }]) {
    const route = loadRoute(); assert.equal((await route.PUT(request(input))).status, 400); assert.equal(route.calls().apiCalls, 0); assert.equal(route.calls().writes.length, 0);
  }
  for (const options of [{ serviceExists: false }, { scope: "users:read scheduled_events:read webhooks:write" }]) {
    const route = loadRoute(options); assert.equal((await route.PUT(request())).status, options.serviceExists === false ? 404 : 409); assert.equal(route.calls().apiCalls, 0); assert.equal(route.calls().writes.length, 0);
  }
  for (const changes of [{ is_paid: true }, { is_paid: undefined }, { is_paid: "false" }, { active: false }, { secret: true }, { duration_options: [15, 30] }, { profile: { type: "User", owner: "another-provider" } }]) {
    const route = loadRoute({ event: { ...event, ...changes } }); assert.equal((await route.PUT(request())).status, 409); assert.equal(route.calls().writes.length, 0);
  }
});

test("real draft GET only offers verified no-payment events, preserves saved drafts when grants are missing", async () => {
  const valid = loadRoute(); const body = await (await valid.GET(request())).json();
  assert.equal(body.status, "draft_only"); assert.equal(body.eventTypes.length, 1);
  for (const is_paid of [true, undefined]) {
    const route = loadRoute({ event: { ...event, is_paid } }); assert.deepEqual((await (await route.GET(request())).json()).eventTypes, []);
  }
  const missing = loadRoute({ scope: "" }); const unavailable = await (await missing.GET(request())).json();
  assert.equal(unavailable.ready, false); assert.equal(unavailable.services.length, 1); assert.equal(missing.calls().apiCalls, 0);
});

test("real draft PUT preserves exact generation and only writes draft preferences, not live service/payment state", async () => {
  for (const billing of [{ billingMode: "paid", servicePriceCents: 5000 }, { billingMode: "free", servicePriceCents: 0 }]) {
    const route = loadRoute(); const response = await route.PUT(request({ ...payload, ...billing }));
    assert.equal(response.status, 200); assert.equal((await response.json()).status, "draft_only");
    assert.equal(route.calls().apiCalls, 1); assert.equal(route.calls().writes.length, 1);
    assert.deepEqual(route.calls().writes[0].values, [service, provider, connection, uri, event.name, owner, generation, 30, billing.billingMode, billing.servicePriceCents, null]);
  }
});

test("stale/uncertain saves are explicit, sanitized, and removal needs no API permission", async () => {
  for (const options of [{ saved: false }, { saveError: true }, { upstreamError: true }]) {
    const route = loadRoute(options); const response = await route.PUT(request());
    assert.equal(response.status, options.saveError ? 503 : 409);
    const text = await response.text(); assert.doesNotMatch(text, /secret/);
    if (options.saveError) assert.match(text, /could not be confirmed/);
  }
  const route = loadRoute({ scope: "" }); assert.equal((await route.PUT(request({ serviceId: service, revision, remove: true }))).status, 200);
  assert.equal(route.calls().apiCalls, 0); assert.equal(route.calls().writes[0].sql, queries.DELETE_CALENDLY_CALL_DRAFT_QUERY);
});

test("synthetic PostgreSQL enforces draft separation, tenant/generation checks, constraints and revision concurrency", async () => {
  const db = new PGlite();
  const save = (mode = "paid", price = 5000, token: string | null = null, changes: { provider?: string; generation?: string } = {}) =>
    db.query<{ revision: string }>(queries.SAVE_CALENDLY_CALL_DRAFT_QUERY, [service, changes.provider ?? provider, connection, uri, event.name, owner, changes.generation ?? generation, 30, mode, price, token]);
  try {
    await db.exec(`CREATE TABLE services(id uuid PRIMARY KEY,provider_id uuid,title text,delivery_type text,provider_deleted_at timestamptz,price_cents integer);
      CREATE TABLE provider_calendly_connections(id uuid PRIMARY KEY,provider_id uuid,calendly_user_uri text,connected_at timestamptz,disconnected_at timestamptz);
      INSERT INTO services VALUES('${service}','${provider}','Synthetic service','REMOTE',NULL,7000);
      INSERT INTO provider_calendly_connections VALUES('${connection}','${provider}','${owner}','${generation}',NULL);`);
    const migration = readFileSync("database/migrations/115_calendly_call_drafts.sql", "utf8");
    await db.exec(migration); await db.exec(migration);
    assert.equal((await db.query("SELECT * FROM service_calendly_call_drafts")).rows.length, 0);
    const first = (await save()).rows[0].revision;
    assert.match(first, /^[0-9a-f-]{36}$/);
    assert.equal((await save()).rows.length, 0, "concurrent create does not replace an existing draft");
    const second = (await save("free", 0, first)).rows[0].revision;
    assert.notEqual(second, first); assert.equal((await save("paid", 5000, first)).rows.length, 0, "stale edit rejected");
    for (const [mode, price] of [["free",1], ["paid",0], ["paid",49], ["paid",100_000_001], ["other",0]] as const) await assert.rejects(save(mode, price, second));
    assert.equal((await save("paid",5000,second,{ provider: connection })).rows.length, 0, "tenant checked again in write");
    assert.equal((await save("paid",5000,second,{ generation: "2026-11-14 01:02:03.123+00" })).rows.length, 0, "exact generation required");
    assert.equal((await db.query(queries.LIST_CALENDLY_CALL_DRAFTS_QUERY, [connection])).rows.length, 0, "other provider cannot read draft");
    assert.equal((await db.query<{ connection_current: boolean }>(queries.LIST_CALENDLY_CALL_DRAFTS_QUERY, [provider])).rows[0].connection_current, true);
    await db.exec("UPDATE provider_calendly_connections SET connected_at=connected_at+interval '1 microsecond'");
    assert.equal((await db.query<{ connection_current: boolean }>(queries.LIST_CALENDLY_CALL_DRAFTS_QUERY, [provider])).rows[0].connection_current, false);
    assert.equal((await save("paid",5000,second)).rows.length, 0, "reconnected account invalidates old save");
    await db.exec(`UPDATE provider_calendly_connections SET connected_at='${generation}'`);
    assert.equal((await db.query(queries.DELETE_CALENDLY_CALL_DRAFT_QUERY, [service,provider,first])).rows.length, 0, "stale removal rejected");
    assert.equal((await db.query(queries.DELETE_CALENDLY_CALL_DRAFT_QUERY, [service,connection,second])).rows.length, 0, "other provider cannot remove draft");
    assert.equal((await db.query(queries.DELETE_CALENDLY_CALL_DRAFT_QUERY, [service,provider,second])).rows.length, 1);
    assert.equal((await save("paid",5000,second)).rows.length, 0, "stale tab cannot recreate removed draft");
    const recreated = (await save()).rows[0].revision; assert.notEqual(recreated, first); assert.notEqual(recreated, second);
    assert.equal((await save("free",0,first)).rows.length, 0, "revision is not reused across removal and recreation");
    assert.equal((await db.query<{ price_cents: number }>("SELECT price_cents FROM services")).rows[0].price_cents, 7000, "live service price unchanged");
    await db.exec("UPDATE provider_calendly_connections SET disconnected_at=now()");
    assert.equal((await save("free",0,recreated)).rows.length, 0);
  } finally { await db.close(); }
});

test("call drafts do not silently change checkout fees or expose a Calendly scheduling handoff", () => {
  const financials = calculateBookingFinancialSnapshot(5000, "starter");
  assert.equal(financials.customerServiceFeeCents, 299); assert.equal(financials.customerTotalCents, 5299); assert.equal(financials.providerFeeCents, 500);
  // Evidence for the separate free-booking lifecycle requirement, not a free charge implementation.
  assert.equal(calculateBookingFinancialSnapshot(0, "starter").customerTotalCents, 299);
  const route = readFileSync("app/api/integrations/calendly/call-drafts/route.ts", "utf8");
  assert.doesNotMatch(route, /scheduled_events:write|POST.*invitees|stripe|scheduling_url/);
  const publicPreview = readFileSync("lib/calendly-service-preview.ts", "utf8");
  assert.doesNotMatch(publicPreview, /call.draft|billing.mode|service.price/i);
  assert.doesNotMatch(queries.SAVE_CALENDLY_CALL_DRAFT_QUERY, /UPDATE services|INSERT INTO bookings|availability_previews/);
  assert.match(readFileSync(".env.example", "utf8"), /CALENDLY_CALL_DRAFTS_ENABLED=false/);
});
