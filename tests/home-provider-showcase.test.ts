import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("provider preview uses the real dashboard labels and no invented activity", () => {
  const preview = read("components/home-provider-showcase.tsx");
  const dashboard = read("components/provider-dashboard.tsx");
  for (const label of ["Paid out this month", "Upcoming jobs", "New requests", "Average rating", "Latest requests", "Your listings", "No requests yet", "No active listings"]) {
    assert.ok(preview.includes(label), label);
    assert.ok(dashboard.includes(label), `${label} is real dashboard copy`);
  }
  assert.doesNotMatch(preview, /premium-phone|premium-laptop|premium-qr|Good morning|Today&apos;s schedule|Christian|John Doe/);
  assert.match(preview, /Sample empty account; navigation is shortened to fit/);
});

test("preview is an explained noninteractive figure, not inaccessible fake controls", () => {
  const preview = read("components/home-provider-showcase.tsx");
  assert.match(preview, /<figure/);
  assert.match(preview, /role="img" aria-label="Provider dashboard overview:/);
  assert.match(preview, /<div aria-hidden="true">/);
  assert.match(preview, /<figcaption>/);
  assert.doesNotMatch(preview, /<(?:button|a|input|nav)\b|tabIndex|onClick/);
  const css = read("components/home-provider-showcase.module.css");
  assert.match(css, /@media \(max-width: 600px\)/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.doesNotMatch(css, /position: absolute|height: [0-9]+px|font-size: \.[0-5]/);
});
