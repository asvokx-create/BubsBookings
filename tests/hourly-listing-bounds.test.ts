import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_HOURLY_RATE_CENTS, validateListingHourlyPricing, validateHourlyPricing, previewHourlyBasePriceCents, calculateHourlyBasePriceCents, TRACKED_HOURLY_LEGACY_DEFAULTS } from "../lib/service-pricing.ts";
import { calculateHourlyProjectPrice } from "../lib/hourly-project-pricing.ts";
const config = (hourlyRateCents: number) => ({ pricingType: "HOURLY" as const, hourlyRateCents, ...TRACKED_HOURLY_LEGACY_DEFAULTS });
test("listing hourly bounds accept exact supported endpoints and reject invalid and extreme values", () => {
  for (const rate of [50, 12500, MAX_HOURLY_RATE_CENTS]) {
    assert.equal(validateListingHourlyPricing(config(rate)).hourlyRateCents, rate);
    assert.equal(previewHourlyBasePriceCents(rate, 60), rate);
    assert.equal(calculateHourlyProjectPrice(3600, rate).subtotalCents, rate);
  }
  for (const rate of [0, 49, -50, NaN, Infinity, 50.5, MAX_HOURLY_RATE_CENTS + 1, 15_000_000, 99_999_999_900]) {
    assert.throws(() => validateListingHourlyPricing(config(rate)), /hourly rate/);
    assert.equal(previewHourlyBasePriceCents(rate, 60), null);
  }
});
test("historical hourly calculations are not clamped or revalidated as listing writes", () => {
  assert.equal(validateHourlyPricing(config(15_000_000)).hourlyRateCents, 15_000_000);
  assert.equal(calculateHourlyBasePriceCents(15_000_000, 60), 15_000_000);
  assert.equal(calculateHourlyProjectPrice(3600, 1).subtotalCents, 1);
});
test("both listing write routes and forms use the shared bounds", () => {
  for (const path of ["app/api/providers/onboarding/route.ts", "app/api/providers/services/[serviceId]/route.ts"]) {
    assert.match(readFileSync(path, "utf8"), /validateListingHourlyPricing\(\{/);
  }
  for (const path of ["app/providers/join/onboarding-form.tsx", "app/provider/services/[serviceId]/edit/listing-editor.tsx"]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /MAX_HOURLY_RATE_CENTS \/ 100/);
    assert.match(source, /hourlyPreview === null/);
    assert.doesNotMatch(source, /1,000,000|1000000/);
  }
});
