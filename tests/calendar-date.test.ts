import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addDateOnlyDays, calendarGrid, formatDateOnly, parseDateOnly, shiftCalendarMonth, todayDateOnly } from "../lib/calendar-date.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("date-only helpers validate real calendar dates", () => {
  assert.deepEqual(parseDateOnly("2028-02-29"), { year: 2028, month: 2, day: 29 });
  assert.equal(parseDateOnly("2027-02-29"), null);
  assert.equal(parseDateOnly("2026-13-01"), null);
  assert.equal(parseDateOnly("09/24/2026"), null);
});

test("date-only arithmetic crosses month, year, and daylight-saving boundaries", () => {
  assert.equal(addDateOnlyDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDateOnlyDays("2026-03-08", 1), "2026-03-09");
  assert.equal(addDateOnlyDays("2026-11-01", -1), "2026-10-31");
  assert.deepEqual(shiftCalendarMonth({ year: 2026, month: 12 }, 1), { year: 2027, month: 1 });
});

test("the calendar grid aligns dates and preserves date-only display values", () => {
  const grid = calendarGrid({ year: 2026, month: 9 });
  assert.equal(grid[0], null);
  assert.equal(grid[2], "2026-09-01");
  assert.equal(grid[31], "2026-09-30");
  assert.equal(grid.length % 7, 0);
  assert.equal(formatDateOnly("2026-09-24"), "September 24, 2026");
  assert.equal(todayDateOnly(new Date(2026, 8, 24, 23, 30)), "2026-09-24");
});

test("booking calendar retains the existing date-only booking contract", () => {
  const picker = readFileSync(join(projectRoot, "components", "booking-date-picker.tsx"), "utf8");
  const bookingCard = readFileSync(join(projectRoot, "app", "services", "[slug]", "booking-card.tsx"), "utf8");
  const availabilityRoute = readFileSync(join(projectRoot, "app", "api", "services", "[serviceId]", "availability", "route.ts"), "utf8");

  assert.doesNotMatch(picker, /toISOString\(/);
  assert.doesNotMatch(bookingCard, /type="date"/);
  assert.match(bookingCard, /<BookingDatePicker/);
  assert.match(availabilityRoute, /monthPattern = \/\^\\d\{4\}-\(0\[1-9\]\|1\[0-2\]\)\$\//);
  assert.match(availabilityRoute, /return NextResponse\.json\(\{ dates:/);
  assert.match(availabilityRoute, /return NextResponse\.json\(\{ times:/);
});

test("the shared date and time controls avoid operating-system pickers while preserving accessible form contracts", () => {
  const datePicker = readFileSync(join(projectRoot, "components", "date-picker.tsx"), "utf8");
  const timePicker = readFileSync(join(projectRoot, "components", "time-picker.tsx"), "utf8");
  const dateTimePicker = readFileSync(join(projectRoot, "components", "date-time-picker.tsx"), "utf8");
  const dateRangePicker = readFileSync(join(projectRoot, "components", "date-range-picker.tsx"), "utf8");
  const userFacingSources = [
    "components/admin-expenses.tsx", "components/affiliate-admin.tsx", "components/availability-editor.tsx",
    "components/booking-details.tsx", "components/post-job-form.tsx", "components/provider-coupon-manager.tsx",
    "components/staff-scheduler.tsx", "app/providers/join/onboarding-form.tsx",
  ].map((path) => readFileSync(join(projectRoot, path), "utf8")).join("\n");

  assert.match(datePicker, /role="grid"/);
  assert.match(datePicker, /Calendar month/);
  assert.match(datePicker, /Calendar year/);
  assert.match(datePicker, /ArrowLeft/);
  assert.match(datePicker, /sm:hidden/);
  assert.match(timePicker, /CustomSelect/);
  assert.match(dateTimePicker, /DatePicker/);
  assert.match(dateTimePicker, /TimePicker/);
  assert.match(dateRangePicker, /value\.end < start/);
  assert.doesNotMatch(userFacingSources, /type="(?:date|datetime-local|month|week|time)"/);
});

test("the desktop booking panel docks to its grid column without an internal scroll area", () => {
  const bookingCard = readFileSync(join(projectRoot, "app", "services", "[slug]", "booking-card.tsx"), "utf8");
  const stationaryPanel = readFileSync(join(projectRoot, "components", "stationary-booking-panel.tsx"), "utf8");
  const servicePage = readFileSync(join(projectRoot, "app", "services", "[slug]", "page.tsx"), "utf8");
  const globalCss = readFileSync(join(projectRoot, "app", "globals.css"), "utf8");

  assert.match(stationaryPanel, /service-booking-panel min-w-0/);
  assert.match(stationaryPanel, /<div ref=\{anchorRef\} className="min-w-0">/);
  assert.match(stationaryPanel, /const containingBlockLeft = anchor\.closest<HTMLElement>\("\.service-detail-container"\)\?\.getBoundingClientRect\(\)\.left \?\? 0/);
  assert.match(stationaryPanel, /position: "fixed", top, left: anchorRect\.left - containingBlockLeft, width: anchorRect\.width, zIndex: 40/);
  assert.match(stationaryPanel, /const top = 6 \* parseFloat\(getComputedStyle\(document\.documentElement\)\.fontSize\)/);
  assert.match(stationaryPanel, /window\.addEventListener\("scroll", syncDock, \{ passive: true \}\)/);
  assert.match(servicePage, /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(20rem,25rem\)\]/);
  assert.doesNotMatch(servicePage, /data-service-detail-header/);
  assert.match(servicePage, /<aside[^>]*className="service-booking-column min-w-0\b[^"]*"/);
  const bookingPanelCss = globalCss.slice(globalCss.indexOf(".service-booking-column"), globalCss.indexOf(".service-detail-meta"));
  assert.doesNotMatch(bookingPanelCss, /position: sticky|top: 7rem/);
  assert.doesNotMatch(globalCss, /\.service-detail-container \{ animation: none !important; \}/);
  assert.match(globalCss, /@media \(min-width: 1024px\) \{[\s\S]*?\.service-booking-column \{ align-self: stretch; \}/);
  assert.doesNotMatch(bookingPanelCss, /position: relative/);
  assert.doesNotMatch(bookingPanelCss, /max-height|overflow-y: (?:auto|scroll)/);
  assert.match(bookingCard, /<BookingDatePicker/);
  assert.ok((bookingCard.match(/lg:hidden/g) ?? []).length >= 3);
});
