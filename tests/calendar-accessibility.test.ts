import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { clampDateOnly, shiftDateOnlyMonths } from "../lib/calendar-date.ts";

test("calendar initial target clamps future minimum and past maximum", () => {
  assert.equal(clampDateOnly("2026-11-18", "2027-01-01"), "2027-01-01");
  assert.equal(clampDateOnly("2026-11-18", undefined, "2020-01-31"), "2020-01-31");
  assert.equal(clampDateOnly("2026-11-18", "2026-11-18", "2026-11-18"), "2026-11-18");
});
test("page navigation preserves days when possible and clamps month ends", () => {
  assert.equal(shiftDateOnlyMonths("2027-01-31", 1), "2027-02-28");
  assert.equal(shiftDateOnlyMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(shiftDateOnlyMonths("2028-02-29", 12), "2029-02-28");
  assert.equal(shiftDateOnlyMonths("2027-01-15", -1), "2026-12-15");
});
test("calendar roving grid and scoped popup contracts remain explicit", () => {
  const source = readFileSync(new URL("../components/date-picker.tsx", import.meta.url), "utf8");
  assert.match(source, /role="row"/);
  assert.match(source, /tabIndex=\{date === tabDate \? 0 : -1\}/);
  assert.match(source, /aria-disabled=\{unavailable \|\| undefined\}/);
  assert.match(source, /if \(isUnavailable\(next\)\) return/);
  assert.match(source, /getPortalContainer=\{\(\) => panelRef.current\}/);
  assert.match(source, /item.tabIndex >= 0/);
  assert.match(source, /lockModalBackground\(panel\)/);
});
test("only the first invalid shared control opens during one submit", () => {
  for (const file of ["date-picker", "custom-select"]) {
    const source = readFileSync(new URL(`../components/${file}.tsx`, import.meta.url), "utf8");
    assert.match(source, /function validate\(event: SubmitEvent\) \{\s*if \(event.defaultPrevented\) return;/);
  }
});
