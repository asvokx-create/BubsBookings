import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateHourlyBasePriceCents, previewHourlyBasePriceCents } from "../lib/service-pricing.ts";

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
