import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { liveProjectSeconds } from "../components/hourly-project-display.ts";
const source = readFileSync(new URL("../components/hourly-projects.tsx", import.meta.url), "utf8");
test("live estimates use whole seconds, without billing the next minute early", () => {
  const running = { durationSeconds: 60, timerLimitSeconds: 600 };
  assert.equal(liveProjectSeconds(60, 10, running, 999), 60);
  assert.equal(liveProjectSeconds(60, 10, running, 1000), 61);
  assert.equal(liveProjectSeconds(60, 10, running, -100), 60);
});
test("timer estimates cannot exceed original timer limit or project cap", () => {
  assert.equal(liveProjectSeconds(120, 100, {durationSeconds: 60, timerLimitSeconds: 120}, 999999), 180);
  assert.equal(liveProjectSeconds(120, 3, {durationSeconds: 60, timerLimitSeconds: 9999}, 999999), 180);
  assert.equal(liveProjectSeconds(60, 10, null, 999999), 60);
});
test("confirmation preserves reviewed version and blocks changed snapshots", () => {
  assert.match(source, /version: reviewedVersion \?\? project.version/);
  assert.match(source, /act\(confirmAction.action, \{\}, confirmAction.version\)/);
  assert.match(source, /disabled=\{busy \|\| confirmAction.version !== project.version\}/);
});
test("server action errors and refunded payment state remain visible", () => {
  assert.match(source, /data\?\.error \? `\$\{data.error\}/);
  assert.match(source, /!paid && !refunded && !provider/);
  assert.match(source, /Payment refunded/);
});
test("new hourly requests bypass the prepaid booking card", () => {
  const booking = readFileSync(new URL("../app/services/[slug]/booking-card.tsx", import.meta.url), "utf8");
  assert.match(booking, /if \(props.pricingType === "HOURLY"\) return <HourlyProjectRequest/);
  const request = readFileSync(new URL("../components/hourly-project-request.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(request, /api\/bookings|api\/stripe|BookingDatePicker/);
  assert.match(request, /maxLength=\{3000\}/);
  assert.match(request, /maxLength=\{500\}/);
});

test("project settlements link to their timesheet and suppress appointment actions", () => {
  const booking = readFileSync(new URL("../components/booking-details.tsx", import.meta.url), "utf8");
  assert.match(booking, /Hourly project payment record/);
  assert.match(booking, /View hourly project and final timesheet/);
  assert.match(booking, /!booking.hourlyProjectId && booking.status === "confirmed" && <a href=\{`\/api\/bookings/);
  assert.match(booking, /!booking.hourlyProjectId && rescheduleOpen/);
});

test("unpaid hourly settlements cannot show a new verified review form", () => {
  const booking = readFileSync(new URL("../components/booking-details.tsx", import.meta.url), "utf8");
  assert.ok(booking.includes('(booking.review || !booking.hourlyProjectId || ["paid", "refunded"].includes(booking.paymentStatus))'));
});
