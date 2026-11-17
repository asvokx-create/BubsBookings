import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { parseCallPriceDollars } from "../lib/calendly-call-drafts.ts";

// Execute the real component and its event handlers with deterministic hook and
// fetch boundaries. This does not substitute for layout/browser testing.
type Element = { type: string; props: Record<string, unknown> };
const uri = "https://api.calendly.com/event_types/synthetic-call";
const revision = "00000000-0000-0000-0000-000000000004";
const blank = { id: "synthetic-service", title: "Synthetic", event_type_uri: null, event_type_name: null, billing_mode: null, service_price_cents: null, revision: null, connection_current: false };
const saved = { ...blank, event_type_uri: uri, event_type_name: "Synthetic call", billing_mode: "paid", service_price_cents: 1234, revision, connection_current: true };
type FetchCall = { method: string; body?: Record<string, unknown>; signal: AbortSignal };

function harness(options: { existing?: boolean; ready?: boolean; enabled?: boolean; save?: (call: FetchCall) => Promise<Response> } = {}) {
  const hooks: unknown[] = [], cleanups: (() => void)[] = [], fetches: FetchCall[] = [];
  let cursor = 0;
  const jsx = (type: string, props: Record<string, unknown>) => ({ type, props });
  const react = {
    useState: (initial: unknown) => { const index = cursor++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], (value: unknown) => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }]; },
    useRef: (initial: unknown) => { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index]; },
    useEffect: (effect: () => (() => void)) => { const index = cursor++; if (!(index in hooks)) { hooks[index] = true; cleanups.push(effect()); } },
  };
  const mocks: Record<string, unknown> = { react, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" }, "@/components/custom-select": { default: "CustomSelect" }, "@/lib/calendly-call-drafts": { parseCallPriceDollars } };
  const output = ts.transpileModule(readFileSync("components/calendly-call-draft-settings.tsx", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} as { default: () => Element | null } };
  const fetchMock = async (_url: string, init: RequestInit) => {
    const call = { method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined, signal: init.signal as AbortSignal }; fetches.push(call);
    return call.method === "GET" ? Response.json({ enabled: options.enabled !== false, ready: options.ready !== false, services: [options.existing ? saved : blank], eventTypes: [{ uri, name: "Synthetic call", durationMinutes: 30 }] })
      : options.save ? options.save(call) : Response.json({ ok: true, status: "draft_only", draft: call.body?.remove ? null : { ...saved, billing_mode: call.body?.billingMode, service_price_cents: call.body?.servicePriceCents } });
  };
  new Function("require", "module", "exports", "fetch", output)((name: string) => { if (!(name in mocks)) throw new Error(`Unexpected dependency ${name}`); return mocks[name]; }, mod, mod.exports, fetchMock);
  return { render: () => { cursor = 0; return mod.exports.default(); }, unmount: () => cleanups.forEach(cleanup => cleanup?.()), fetches };
}
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const element = tree as Element;
  return [element, ...elements(element.props.children)];
}
function text(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  return tree && typeof tree === "object" && "props" in tree ? text((tree as Element).props.children) : "";
}
function control(tree: unknown, ariaLabel: string) { return elements(tree).find(element => element.props.ariaLabel === ariaLabel)!; }
function button(tree: unknown, label: string) { return elements(tree).find(element => element.type === "button" && text(element) === label)!; }
function change(element: Element, value: unknown) { (element.props.onChange as (value: unknown) => void)(value); }
function click(element: Element) { (element.props.onClick as () => void)(); }
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function loaded(options: Parameters<typeof harness>[0] = {}) { const component = harness(options); component.render(); await flush(); component.render(); return component; }

test("draft UI starts with no pricing selection and keeps private draft language explicit", async () => {
  const component = await loaded(); let tree = component.render();
  assert.match(text(tree), /Private draft/); assert.match(text(tree), /cannot be booked/);
  change(control(tree, "Remote service for call draft"), "synthetic-service"); tree = component.render();
  assert.equal(control(tree, "Free or paid call").props.value, "");
  assert.equal(button(tree, "Save private draft").props.disabled, true);
  assert.equal((await loaded({ enabled: false })).render(), null);
});

test("draft UI saves exact paid cents, blocks repeated clicks and uses the returned revision", async () => {
  let finish: ((response: Response) => void) | undefined;
  const component = await loaded({ save: () => new Promise(resolve => { finish = resolve; }) });
  change(control(component.render(), "Remote service for call draft"), "synthetic-service");
  change(control(component.render(), "Calendly event for call draft"), uri);
  change(control(component.render(), "Free or paid call"), "paid");
  change(elements(component.render()).find(element => element.type === "input")!, { target: { value: "12.34" } });
  const saveButton = button(component.render(), "Save private draft"); click(saveButton); click(saveButton);
  assert.equal(component.fetches.filter(call => call.method === "PUT").length, 1);
  assert.equal(component.fetches.at(-1)?.body?.servicePriceCents, 1234); assert.equal(component.fetches.at(-1)?.body?.revision, null);
  assert.equal(control(component.render(), "Remote service for call draft").props.disabled, true);
  finish!(Response.json({ ok: true, status: "draft_only", draft: saved })); await flush();
  assert.match(text(component.render()), /Draft saved, not enabled/);
  change(control(component.render(), "Free or paid call"), "free"); click(button(component.render(), "Save private draft"));
  assert.equal(component.fetches.at(-1)?.body?.servicePriceCents, 0); assert.equal(component.fetches.at(-1)?.body?.revision, revision);
  component.unmount(); assert.equal(component.fetches.at(-1)?.signal.aborted, true);
});

test("draft UI rejects imprecise amounts before dispatch", async () => {
  const component = await loaded({ existing: true });
  change(control(component.render(), "Remote service for call draft"), "synthetic-service");
  change(elements(component.render()).find(element => element.type === "input")!, { target: { value: "12.345" } });
  click(button(component.render(), "Save private draft")); await flush();
  assert.equal(component.fetches.filter(call => call.method === "PUT").length, 0); assert.match(text(component.render()), /at most two decimal places/);
});

test("draft UI requires reload after stale response, malformed success, or any transport exception", async () => {
  for (const save of [async () => Response.json({ error: "Draft changed" }, { status: 409 }), async () => Response.json({ ok: true }), async () => { throw new Error("Connection interrupted"); }]) {
    const component = await loaded({ existing: true, save });
    change(control(component.render(), "Remote service for call draft"), "synthetic-service");
    click(button(component.render(), "Save private draft")); await flush();
    assert.match(text(component.render()), /Reload this page/); assert.equal(button(component.render(), "Save private draft").props.disabled, true);
    click(button(component.render(), "Save private draft")); await flush();
    assert.equal(component.fetches.filter(call => call.method === "PUT").length, 1);
  }
});

test("known validation errors allow correction, and disconnected/missing-grant drafts remain removable", async () => {
  const invalid = await loaded({ existing: true, save: async () => Response.json({ error: "Correct the price" }, { status: 400 }) });
  change(control(invalid.render(), "Remote service for call draft"), "synthetic-service"); click(button(invalid.render(), "Save private draft")); await flush();
  assert.equal(button(invalid.render(), "Save private draft").props.disabled, false);
  const component = await loaded({ existing: true, ready: false });
  change(control(component.render(), "Remote service for call draft"), "synthetic-service");
  assert.equal(button(component.render(), "Save private draft"), undefined);
  click(button(component.render(), "Remove draft")); await flush();
  assert.equal(component.fetches.at(-1)?.body?.remove, true); assert.equal(component.fetches.at(-1)?.body?.revision, revision);
  assert.match(text(component.render()), /Draft removed/);
  assert.equal(button(component.render(), "Remove draft"), undefined);
  assert.match(readFileSync("components/calendly-integration-panel.tsx", "utf8"), /!loading && <CalendlyCallDraftSettings/);
});
