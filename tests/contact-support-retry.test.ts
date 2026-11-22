import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type FormEvent = { preventDefault(): void };
type TargetEvent = { target: { value: string } };
type ElementNode = { type: string; props: {
  children?: unknown;
  tabIndex?: number;
  ref?: { current: { focus(): void } };
  onClick(event?: FormEvent): void;
  onChange(event: TargetEvent): void;
  onSubmit(event: FormEvent): Promise<void>;
  value?: string;
  disabled?: boolean;
  readOnly?: boolean;
} };
const subject = "  A support subject  ";
const message = "  An unchanged draft with\na second line.  ";
const article = ts.transpileModule(readFileSync(new URL("../components/contact-support-button.tsx", import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function createFixture(fetchMock: (url: string, options: RequestInit) => Promise<Response>) {
  const slots: unknown[] = [];
  const effects: (() => void)[] = [];
  const jsx = (type: string, props: ElementNode["props"]): ElementNode => ({ type, props });
  let cursor = 0;
  let lastFocus = "";
  const react = {
    useState(initial: unknown) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], (value: unknown) => { slots[i] = value; }];
    },
    useRef(initial: unknown) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useEffect(effect: () => void) { effects.push(effect); },
  };
  const exports: { default: (props: object) => ElementNode | null } = { default: () => null };
  const calls: { url: string; method?: string; payload: unknown }[] = [];
  runInNewContext(article, {
    exports,
    fetch: async (url: string, options: RequestInit) => {
      calls.push({ url, method: options.method, payload: JSON.parse(String(options.body)) as unknown });
      return fetchMock(url, options);
    },
    require(name: string) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "next/link") return { default: "a" };
      if (name === "@/components/use-modal-accessibility") return { useModalAccessibility: () => ({ current: null }) };
      throw new Error("Unexpected dependency: " + name);
    },
  });
  const textOf = (x: unknown): string => {
    if (Array.isArray(x)) return x.map(textOf).join("");
    if (typeof x === "string") return x;
    return x && typeof x === "object" && "props" in x ? textOf((x as ElementNode).props.children) : "";
  };
  let nodes: ElementNode[] = [];
  function render() {
    cursor = 0;
    nodes = [];
    function walk(x: unknown) {
      if (Array.isArray(x)) return x.forEach(walk);
      if (!x || typeof x !== "object" || !("props" in x)) return;
      const node = x as ElementNode;
      nodes.push(node);
      if (node.props.tabIndex === -1 && node.props.ref && (node.type === "p" || node.type === "h2")) {
        node.props.ref.current = { focus() { lastFocus = textOf(node); } };
      }
      walk(node.props.children);
    }
    walk(exports.default({}));
    effects.splice(0).forEach(effect => effect());
  }
  function get(type: string, text?: string) {
    const result = nodes.find(n => n.type === type && (text === undefined || textOf(n) === text));
    assert.ok(result, `Missing ${type} ${text ?? ""}`);
    return result.props;
  }
  const event = { preventDefault() {} };
  render();
  get("a", "Contact support").onClick(event);
  render();
  get("input").onChange({ target: { value: subject } });
  get("textarea").onChange({ target: { value: message } });
  render();
  return { get, calls, render, focus: () => lastFocus, submit: () => get("form").onSubmit(event) as Promise<void> };
}

test("non-JSON and unexpected success restore retry, keep exact draft, and never show false success", async () => {
  for (const response of [new Response("<html>upstream</html>", { status: 502 }), new Response("<html>unexpected</html>"), Response.json({ ok: true }), Response.json({ ok: false, id: "test" }), Response.json(null)]) {
    const ui = createFixture(async () => response);
    await ui.submit();
    ui.render();
    assert.deepEqual(ui.calls, [{ url: "/api/support", method: "POST", payload: { subject, message } }]);
    assert.equal(ui.get("button", "Try again").disabled, false);
    assert.equal(ui.get("input").value, subject);
    assert.equal(ui.get("textarea").value, message);
    assert.match(ui.focus(), /couldn’t confirm.*draft is still here/);
  }
});

test("in-flight protection, structured error and deliberate retry to confirmed success", async () => {
  let finish!: (value: Response) => void;
  let attempts = 0;
  const ui = createFixture(() => ++attempts === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(Response.json({ ok: true, id: "synthetic-42" })));
  const first = ui.submit();
  ui.render();
  assert.equal(ui.get("button", "Sending…").disabled, true);
  assert.equal(ui.get("button", "Cancel").disabled, true);
  assert.equal(ui.get("input").readOnly, true);
  assert.equal(ui.get("textarea").readOnly, true);
  await ui.submit();
  assert.equal(ui.calls.length, 1);
  finish(Response.json({ error: "Please wait and try again." }, { status: 429 }));
  await first;
  ui.render();
  assert.match(ui.focus(), /Please wait and try again.*draft is still here/);
  assert.equal(ui.calls.length, 1);
  await ui.submit();
  ui.render();
  assert.deepEqual(ui.calls[0], ui.calls[1]);
  assert.equal(ui.focus(), "Message sent to support");
  ui.get("button", "Done").onClick();
  ui.render();
  ui.get("a", "Contact support").onClick({ preventDefault() {} });
  ui.render();
  assert.equal(ui.get("input").value, "");
  assert.equal(ui.get("textarea").value, "");
});

test("network rejection re-enables deliberate retry without clearing the draft", async () => {
  const ui = createFixture(async () => { throw new Error("synthetic network error"); });
  await ui.submit();
  ui.render();
  assert.equal(ui.get("button", "Try again").disabled, false);
  assert.equal(ui.get("input").value, subject);
  assert.equal(ui.get("textarea").value, message);
  assert.equal(ui.calls.length, 1);
});
