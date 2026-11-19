import assert from "node:assert/strict";
import test from "node:test";
import { lockModalBackground } from "../lib/modal-environment.ts";

class ElementStub {
  inert = false;
  children: ElementStub[] = [];
  parentElement: ElementStub | null = null;
  add(child: ElementStub) { child.parentElement = this; this.children.push(child); return child; }
}

test("modal locks preserve inert baselines and overflow through non-LIFO cleanup", () => {
  const body = new ElementStub();
  let overflow = "auto"; let priority = "important";
  const style = { getPropertyValue: () => overflow, getPropertyPriority: () => priority, setProperty: (_: string, value: string, nextPriority = "") => { overflow = value; priority = nextPriority; } };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { body: Object.assign(body, { style }) } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: ElementStub });
  try {
    const page = body.add(new ElementStub());
    const retained = body.add(new ElementStub()); retained.inert = true;
    const parent = body.add(new ElementStub());
    const releaseParent = lockModalBackground(parent as unknown as HTMLElement);
    const child = body.add(new ElementStub());
    const releaseChild = lockModalBackground(child as unknown as HTMLElement);
    assert.equal(page.inert, true);
    assert.equal(parent.inert, true);
    releaseParent();
    assert.equal(page.inert, true);
    assert.equal(overflow, "hidden");
    releaseChild();
    assert.equal(page.inert, false);
    assert.equal(parent.inert, false);
    assert.equal(retained.inert, true);
    assert.equal(overflow, "auto");
    assert.equal(priority, "important");
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else Reflect.deleteProperty(globalThis, "document");
    if (originalElement) Object.defineProperty(globalThis, "HTMLElement", originalElement); else Reflect.deleteProperty(globalThis, "HTMLElement");
  }
});
