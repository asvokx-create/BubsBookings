import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const booking = readFileSync(new URL("../app/services/[slug]/booking-card.tsx", import.meta.url), "utf8");

test("booking availability moves focus into results, but not from outside the form", () => {
  assert.match(booking, /focusResults.current = activeElement === document.body \|\| \(activeElement === focusBeforeRequest && form.contains\(activeElement\)\)/);
  assert.match(booking, /if \(step !== "times" \|\| !focusResults.current\) return/);
  assert.match(booking, /<legend ref=\{resultsTitle\} tabIndex=\{-1\} aria-describedby=\{resultsCountId\}/);
  assert.match(booking, /id=\{resultsCountId\} className="sr-only"/);
  assert.match(booking, /confirmationTitle\.current\?\.focus\(\)/);
  assert.match(booking, /<h2 ref=\{confirmationTitle\} tabIndex=\{-1\}/);
});

test("booking availability exposes selected times and a status without changing the request gate", () => {
  assert.match(booking, /key=\{slot\} type="button" aria-pressed=\{time === slot\}/);
  assert.match(booking, /role="status" className="sr-only">\{loading \? \(step === "details" \? "Checking availability\."/);
  assert.match(booking, /missingBookingRequestDetails\(\{[^\n]+/);
  assert.match(booking, /<form noValidate/);
});

test("the existing booking report dropdown remains inside the shared modal focus trap", () => {
  const report = readFileSync(new URL("../components/report-user-button.tsx", import.meta.url), "utf8");
  assert.match(report, /ariaLabel="Report reason" getPortalContainer=\{\(\) => dialogRef.current\}/);
});
