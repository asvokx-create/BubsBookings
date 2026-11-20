import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const details = readFileSync(new URL("../components/booking-details.tsx", import.meta.url), "utf8");
const report = readFileSync(new URL("../components/report-user-button.tsx", import.meta.url), "utf8");

test("booking overlay contents remain in a scrollable panel with wrapping actions", () => {
  for (const [source, title] of [[details, "cancel-title"], [details, "duration-change-title"], [report, "booking-report-title"]]) {
    const line = source.split(/\r?\n/).find((candidate) => candidate.includes('aria-labelledby="' + title + '"')) ?? "";
    assert.match(line, /overflow-y-auto overscroll-contain/);
    assert.match(line, /min-w-0 max-w-lg overflow-y-auto overscroll-contain break-words/);
    assert.match(line, /flex flex-wrap justify-end gap-2/);
    assert.match(line, /sm:max-h-\[calc\(100dvh-2\.5rem\)\]/);
    assert.match(line, /aria-modal="true"/);
  }
});

test("report validation messages use a persistent alert and retain visible field focus", () => {
  assert.match(report, /<p role="alert" className=\{error \?/);
  assert.match(report, /: "sr-only"\}>\{error\}<\/p>/);
  assert.match(report, /outline-none focus:border-\[#6f7f4c\] focus:ring-2/);
});
