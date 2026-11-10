import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const form = readFileSync(join(process.cwd(), "app", "providers", "join", "onboarding-form.tsx"), "utf8");

test("hourly onboarding offers tracked projects rather than prepaid duration controls", () => {
  assert.match(form, /maximum approved work limit, not prepaid hours/);
  assert.match(form, /No minimum duration, old billing increments, or automatic charges/);
  assert.doesNotMatch(form, /Minimum hours<input|Default booking duration|Booking increment<CustomSelect/);
  assert.match(form, /pricingType !== "HOURLY" && <label/);
});

test("fixed scheduling and legacy hourly persistence fields remain compatible", () => {
  assert.match(form, /onChange=\{\(event\) => setDurationAmount\(event\.target\.value\)\}/);
  assert.match(form, /min=\{durationUnit === "hours" \? "0.25" : "0.01"\}/);
  assert.match(form, /hourlyRate: pricingType === "HOURLY" \? Number\(price\) : null/);
  assert.match(form, /minimumDurationMinutes: pricingType === "HOURLY" \? minimumMinutes : null/);
  assert.match(form, /billingIncrementMinutes: pricingType === "HOURLY" \? billingIncrementMinutes : null/);
});
