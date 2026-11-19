/* eslint-disable @typescript-eslint/no-explicit-any -- This isolated transpiled JSX harness models heterogeneous React props and refs. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function harness(options: { clipboard?: "ok" | "denied" | "absent"; legacy?: boolean; nativeCancel?: boolean } = {}) {
  const states: unknown[] = [], refs: { current: unknown }[] = [], effects: (() => unknown)[] = [];
  let si = 0, ri = 0;
  let timers = 0, removed = 0, selected = false, focused = false;
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const doc = { body: { style: { overflow: "" }, appendChild() {} }, createElement() { return { value: "", style: {}, setAttribute() {}, select() {}, remove() { removed++; } }; }, execCommand() { return options.legacy ?? false; }, addEventListener() {}, removeEventListener() {} };
  const exports = {};
  const context = vm.createContext({ exports, DOMException, navigator: {
    ...(options.clipboard === "absent" ? {} : { clipboard: { async writeText() { if (options.clipboard !== "ok") throw new Error("denied"); } } }),
    ...(options.nativeCancel ? { async share() { throw new DOMException("Canceled", "AbortError"); } } : {}),
  }, document: doc, window: { clearTimeout() {}, setTimeout() { timers++; return 1; }, matchMedia() { return { matches: !!options.nativeCancel }; }, innerWidth: 1000 },
    require(name: string) {
      if (name === "react") return { useState(init: unknown) { const i = si++; if (!(i in states)) states[i] = init; return [states[i], (v: unknown) => { states[i] = v; }]; }, useRef(init: unknown) { const i = ri++; return refs[i] ??= { current: init }; }, useEffect(f: () => unknown) { effects.push(f); } };
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "react-dom") return { createPortal: (v: unknown) => v };
      if (name.includes("analytics-consent")) return { analyticsAllowed: () => false };
      if (name.includes("listing-share")) return { canonicalListingUrl: (slug: string) => "https://bubsbookings.com/services/" + encodeURIComponent(slug), listingShareText: () => "Share", listingShareDestinations: () => ({}) };
      return { default: () => null };
    }
  });
  const source = readFileSync("components/listing-share-button.tsx", "utf8");
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, context);
  type Element = { type: string; props: Record<string, any> };
  function nodes(node: any): Element[] { if (!node || typeof node !== "object") return []; return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]; }
  function render(action = "copy") {
    si = ri = 0; effects.length = 0;
    const tree = (exports as any).default({ providerSlug: "safe?query", title: "Provider", action });
    const all = nodes(tree);
    for (const node of all) if (node.props?.ref) node.props.ref.current = node.type === "input" ? { focus() { focused = true; node.props.onFocus({ currentTarget: { select() { selected = true; } } }); } } : node.props.role === "dialog" ? { querySelectorAll: () => [] } : { focus() {} };
    for (const f of effects) f();
    return all;
  }
  return { render, states, get timers() { return timers; }, get removed() { return removed; }, get focused() { return focused; }, get selected() { return selected; } };
}

test("denied copy opens persistent selectable provider link and focuses it", async () => {
  const h = harness({ clipboard: "denied" });
  await h.render().find(n => n.type === "button")!.props.onClick();
  const nodes = h.render();
  assert.equal(h.states[0], true);
  assert.equal(h.states[1], "manual");
  assert.equal(h.timers, 0);
  assert.equal(nodes.find(n => n.type === "input")!.props.value, "https://bubsbookings.com/providers/safe%3Fquery");
  assert.ok(nodes.find(n => n.props.role === "status" && n.props["aria-live"] === "polite"));
  assert.ok(h.focused && h.selected);
  nodes.find(n => n.props["aria-label"] === "Close share menu")!.props.onClick();
  assert.equal(h.states[0], false);
});

test("unavailable clipboard with failed legacy copy exposes manual link and cleans up", async () => {
  const h = harness({ clipboard: "absent" });
  await h.render()[1].props.onClick();
  assert.ok(h.render().find(n => n.type === "input"));
  assert.equal(h.removed, 1);
});

test("copy success stays closed and keeps success reset", async () => {
  for (const options of [{ clipboard: "ok" as const }, { clipboard: "absent" as const, legacy: true }]) {
    const h = harness(options);
    await h.render().find(n => n.type === "button")!.props.onClick();
    assert.equal(h.states[0], false);
    assert.equal(h.states[1], "copied");
    assert.equal(h.timers, 1);
  }
});

test("native cancellation does not open share dialog", async () => {
  const h = harness({ nativeCancel: true });
  await h.render("share").find(n => n.type === "button")!.props.onClick();
  assert.equal(h.states[0], false);
});

