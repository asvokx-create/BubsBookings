import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("home analytics choices follow the search form without replacing or gating it", () => {
  const home = read("app/page.tsx");
  assert.ok(home.indexOf("<HomeServiceSearch ") < home.indexOf("<HomeAnalyticsChoicesSlot />"));
  assert.ok(home.indexOf("<HomeAnalyticsChoicesSlot />") < home.indexOf('<section aria-labelledby="category-heading"'));
  const manager = read("components/analytics-consent.tsx");
  assert.match(manager, /const inline = !open && compact && \(pathname === "\/" \|\| pathname === "\/pricing"\)/);
  assert.match(manager, /createPortal\(panel, placement\.slot\)/);
  assert.match(manager, /consent === undefined \|\| \(consent !== null && !open\)/);
  assert.match(manager, /href="\/cookies"/);
  assert.equal([...manager.matchAll(/inline \? "home-analytics-inline-choice"/g)].length, 2);
});

test("first-visit pricing choices flow after the pricing content, with a separate footer reopen", () => {
  const layout = read("app/pricing/layout.tsx");
  const manager = read("components/analytics-consent.tsx");
  assert.ok(layout.indexOf("{children}") < layout.indexOf("<PricingAnalyticsChoicesSlot />"));
  assert.match(manager, /!open && compact && \(pathname === "\/" \|\| pathname === "\/pricing"\)/);
  assert.match(manager, /if \(inline && !placement\?\.slot\) return null/);
  assert.match(manager, /inline && placement\?\.slot \? createPortal\(panel, placement\.slot\) : panel/);
});
