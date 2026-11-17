import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as protocol from "../lib/calendly-event-availability.ts";
import * as queries from "../lib/calendly-preview-queries.ts";

// Execute the real route/module with explicit synthetic boundary mocks. No
// database, auth account, network request or existing OAuth grant is used.
function loadModule(path: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const output = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const compiledModule = { exports: {} as Record<string, (...args: unknown[]) => Promise<unknown>> };
  const requireMock = (name: string) => { if (!(name in mocks)) throw new Error(`Unexpected real dependency: ${name}`); return mocks[name]; };
  new Function("require", "module", "exports", ...Object.keys(globals), output)(requireMock, compiledModule, compiledModule.exports, ...Object.values(globals));
  return compiledModule.exports;
}
const next = { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
const providerAccess = { isOwner: true, providerId: "synthetic-provider", session: { user: { id: "synthetic-user" } } };
const settingsPath = "app/api/integrations/calendly/availability-preview/route.ts";
const publicPath = "app/api/services/[serviceId]/calendly-preview/route.ts";
const request = () => new Request("https://example.test/api/preview");
const owner = "https://api.calendly.com/users/synthetic-user";
const uri = "https://api.calendly.com/event_types/synthetic-event";

function settings(overrides: { owner?: boolean; enabled?: boolean; scope?: string; serviceExists?: boolean } = {}) {
  let apiCalls = 0, saves = 0, queriesRun = 0;
  const mod = loadModule(settingsPath, {
    "next/server": next,
    "@/lib/provider-access": { getProviderAccess: async () => overrides.owner === false ? { ...providerAccess, isOwner: false } : providerAccess },
    "@/lib/database": { database: { query: async (sql: string) => {
      queriesRun++;
      if (sql === queries.SAVE_CALENDLY_PREVIEW_QUERY) { saves++; return { rowCount: 1, rows: [{ service_id: "synthetic-service" }] }; }
      if (sql.startsWith("SELECT id::text,calendly_user_uri")) return { rows: [{ id: "synthetic-connection", calendly_user_uri: owner, connected_at: "2026-11-13 01:02:03.123456+00", granted_scope: overrides.scope ?? "event_types:read" }] };
      if (sql.startsWith("SELECT id::text FROM services")) return { rows: overrides.serviceExists === false ? [] : [{ id: "synthetic-service" }] };
      return { rows: [], rowCount: 0 };
    } } },
    "@/lib/calendly": { calendlyPreviewRead: async () => { apiCalls++; return { resource: { uri, active: true, secret: false, kind: "solo", name: "Synthetic event", duration: 30, profile: { type: "User", owner } }, collection: [], pagination: {} }; } },
    "@/lib/calendly-service-preview": { calendlyAvailabilityPreviewEnabled: () => overrides.enabled !== false },
    "@/lib/calendly-event-availability": protocol,
    "@/lib/calendly-preview-queries": queries,
    "@/lib/request-security": { enforceRateLimit: async () => true, recordActivity: async () => undefined },
  });
  return { mod, counters: () => ({ apiCalls, saves, queriesRun }) };
}
const put = (data: unknown) => new Request("https://example.test/api/preview", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

test("real settings handlers reject non-owners and default-off access without touching account data", async () => {
  for (const method of ["GET", "PUT"]) {
    const blocked = settings({ owner: false });
    const response = await blocked.mod[method](request()) as Response;
    assert.equal(response.status, 403);
    assert.equal(blocked.counters().queriesRun, 0);
  }
  const disabled = settings({ enabled: false });
  assert.deepEqual(await (await disabled.mod.GET(request()) as Response).json(), { enabled: false });
  assert.equal(disabled.counters().queriesRun, 0);
});

test("real settings handler rejects missing grants and another provider's service before upstream access", async () => {
  const missing = settings({ scope: "users:read scheduled_events:read webhooks:write" });
  const response = await missing.mod.PUT(put({ serviceId: "synthetic-service", eventTypeUri: uri })) as Response;
  assert.equal(response.status, 409); assert.equal(missing.counters().apiCalls, 0); assert.equal(missing.counters().saves, 0);
  const unauthorized = settings({ serviceExists: false });
  assert.equal((await unauthorized.mod.PUT(put({ serviceId: "unowned-service", eventTypeUri: uri })) as Response).status, 404);
  assert.equal(unauthorized.counters().apiCalls, 0);
});

test("real settings handler validates selection, preserves exact generation and only saves after verification", async () => {
  const valid = settings();
  assert.equal((await valid.mod.PUT(put({ serviceId: "synthetic-service", eventTypeUri: uri })) as Response).status, 200);
  assert.equal(valid.counters().apiCalls, 1); assert.equal(valid.counters().saves, 1);
  const invalid = settings();
  assert.equal((await invalid.mod.PUT(put({ serviceId: "synthetic-service", eventTypeUri: "https://attacker.test" })) as Response).status, 400);
  assert.equal(invalid.counters().apiCalls, 0);
  assert.equal((await invalid.mod.PUT(put(null)) as Response).status, 400);
});

test("real public handler distinguishes disabled, limited, empty configuration, upstream failure and success", async () => {
  for (const [mode, expected] of [["disabled",404], ["limited",429], ["missing",404], ["error",503], ["ok",200]] as const) {
    let calls = 0;
    const mod = loadModule(publicPath, {
      "next/server": next,
      "@/lib/calendly-service-preview": { calendlyAvailabilityPreviewEnabled: () => mode !== "disabled", getPublicCalendlyPreview: async () => { calls++; if (mode === "error") throw new Error("secret bearer token"); return mode === "missing" ? null : { mode: "preview_only", slots: [] }; } },
      "@/lib/request-security": { enforceRateLimit: async () => mode !== "limited", publicRequestRateLimitKey: () => "synthetic-ip" },
    });
    const response = await mod.GET(request(), { params: Promise.resolve({ serviceId: "synthetic-service" }) }) as Response;
    assert.equal(response.status, expected, mode);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.doesNotMatch(await response.text(), /secret bearer token/);
    if (mode === "disabled" || mode === "limited") assert.equal(calls, 0);
  }
});

function servicePreview() {
  let time = Date.parse("2026-11-13T12:00:00Z"), calls = 0, publicAccess = true, fail = false;
  const mapping = { service_id: "synthetic-service", connection_id: "synthetic-connection", event_type_uri: uri, calendly_user_uri: owner, connected_at: "2026-11-13 11:00:00.123456+00", updated_at: "2026-11-13 11:30:00.456789+00", account_timezone: "UTC", granted_scope: "event_types:read" };
  let release: (() => void) | undefined;
  let wait: Promise<void> | undefined;
  const clock = class extends Date { static now() { return time; } };
  const mod = loadModule("lib/calendly-service-preview.ts", {
    "server-only": {},
    "@/lib/database": { database: { query: async (sql: string) => ({ rows: sql === queries.PUBLIC_CALENDLY_PREVIEW_QUERY ? (publicAccess ? [mapping] : []) : [] }) } },
    "@/lib/calendly": { calendlyPreviewRead: async () => { throw new Error("Should use synthetic protocol"); } },
    "@/lib/calendly-preview-queries": queries,
    "@/lib/calendly-event-availability": { ...protocol, readCalendlyPreview: async () => {
      calls++; if (wait) await wait; if (fail) throw new Error("Synthetic upstream failure");
      return { event: { name: "Synthetic", durationMinutes: 30 }, window: { startsAt: new Date(time).toISOString(), endsAt: new Date(time + 7*86400000).toISOString() }, slots: [{ startsAt: new Date(time + 3600000).toISOString(), endsAt: new Date(time + 5400000).toISOString() }], checkedAt: new Date(time).toISOString() };
    } },
  }, { process: { env: { CALENDLY_AVAILABILITY_PREVIEW_ENABLED: "true" } }, Date: clock });
  return { mod, calls: () => calls, advance: () => { time += 31_000; }, fail: () => { fail = true; }, unpublish: () => { publicAccess = false; }, pause: () => { wait = new Promise<void>(resolve => { release = resolve; }); }, release: () => release?.() };
}

test("real preview service coalesces requests and never serves an expired snapshot after failure", async () => {
  const preview = servicePreview();
  const first = await Promise.all([preview.mod.getPublicCalendlyPreview("synthetic-service", request()), preview.mod.getPublicCalendlyPreview("synthetic-service", request())]);
  assert.equal(preview.calls(), 1); assert.deepEqual(first[0], first[1]);
  preview.advance(); preview.fail();
  await assert.rejects(preview.mod.getPublicCalendlyPreview("synthetic-service", request()), /Synthetic upstream failure/);
  assert.equal(preview.calls(), 2);
});

test("real preview service withholds results when unpublishing occurs during an upstream request", async () => {
  const preview = servicePreview(); preview.pause();
  const pending = preview.mod.getPublicCalendlyPreview("synthetic-service", request());
  await new Promise(resolve => setTimeout(resolve, 0));
  preview.unpublish(); preview.release();
  assert.equal(await pending, null);
});
