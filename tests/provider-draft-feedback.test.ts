import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateHourlyBasePriceCents, previewHourlyBasePriceCents, TRACKED_HOURLY_LEGACY_DEFAULTS, validateHourlyPricing } from "../lib/service-pricing.ts";

test("draft hourly preview safely handles negative, incomplete, and oversized inputs", () => {
  for (const [rate, duration] of [[-2000,120],[0,120],[49,120],[NaN,120],[Infinity,120],[2000,-60],[2000,0],[2000,NaN],[100000001,60],[2000,Number.MAX_SAFE_INTEGER]]) {
    assert.equal(previewHourlyBasePriceCents(rate,duration),null);
  }
  assert.equal(previewHourlyBasePriceCents(2000,120),4000);
  assert.equal(previewHourlyBasePriceCents(50,15),13);
  assert.throws(() => calculateHourlyBasePriceCents(-2000,120), /Hourly rate is invalid/);
});

test("both provider forms render guarded previews, not the throwing calculator", () => {
  for (const path of ["app/providers/join/onboarding-form.tsx", "app/provider/services/[serviceId]/edit/listing-editor.tsx"]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.ok(source.includes("previewHourlyBasePriceCents"));
    assert.ok(source.includes("hourlyPreview !== null"));
    assert.ok(source.includes('role="alert"'));
    assert.ok(!source.includes("calculateHourlyBasePriceCents"));
  }
});

test("marketing sharing and printable QR use server-provided public eligibility", () => {
  const source = readFileSync(new URL("../components/provider-marketing-tools.tsx",import.meta.url),"utf8");
  assert.ok(source.includes("?.publiclyAvailable === true"));
  assert.ok(source.includes("if (!listingPublic || !selected || !qrRef.current)"));
  assert.ok(source.includes("{listingPublic && <section"));
  assert.ok(source.includes("{listingPublic && <div"));
  assert.ok(source.includes("providerProfile && profilePublic"));
});

test("tracked hourly forms preview only the rate and cannot restore prepaid-duration controls", () => {
  for (const path of ["app/providers/join/onboarding-form.tsx", "app/provider/services/[serviceId]/edit/listing-editor.tsx"]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(source, /previewHourlyBasePriceCents\([^;]+, 60\)/);
    assert.ok(source.includes("Final payment is based on the approved timesheet."));
    assert.ok(source.includes("not prepaid hours"));
    assert.ok(!source.includes('ariaLabel="Billing increment"'));
    assert.ok(!source.includes('ariaLabel="Booking increment"'));
    assert.ok(!source.includes("minimumDurationHours} onChange"));
    assert.ok(!source.includes("defaultDurationMinutes ?? \"\"}"));
  }
});


test("fixed-to-tracked conversion does not inherit uneditable, misaligned prepaid durations", () => {
  const oldBooking = { minimumDurationMinutes: 75, defaultDurationMinutes: 75, billingIncrementMinutes: 30 as const, maximumDurationMinutes: 75 };
  const original = { ...oldBooking };
  const converted = { ...oldBooking, ...TRACKED_HOURLY_LEGACY_DEFAULTS, pricingType: "HOURLY" as const, hourlyRateCents: 6000 };
  assert.doesNotThrow(() => validateHourlyPricing(converted));
  assert.equal(converted.defaultDurationMinutes, 60);
  assert.equal(converted.maximumDurationMinutes, null);
  assert.deepEqual(oldBooking, original, "existing prepaid booking snapshots are not mutated");
  const source = readFileSync(new URL("../app/provider/services/[serviceId]/edit/listing-editor.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("...TRACKED_HOURLY_LEGACY_DEFAULTS"));
  assert.ok(!source.includes("Math.max(60, current.durationMinutes)"));
});
