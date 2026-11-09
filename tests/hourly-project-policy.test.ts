import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { requiresHourlyProject } from "../lib/hourly-project-policy.ts";
test("only new hourly requests require tracked projects", () => {
  assert.equal(requiresHourlyProject("HOURLY"), true);
  for (const value of ["FIXED", "QUOTE_ONLY", undefined, null]) assert.equal(requiresHourlyProject(value), false);
});
test("new booking and quote APIs reject the prepaid hourly bypass", () => {
  for (const path of ["app/api/bookings/route.ts", "app/api/job-requests/[requestId]/quotes/route.ts", "app/api/quotes/[quoteId]/route.ts"]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /requiresHourlyProject/);
    assert.match(source, /HOURLY_PROJECT_REQUIRED/);
  }
});
test("already booked quotes are returned before new hourly acceptance is blocked", () => {
  const source = readFileSync("app/api/quotes/[quoteId]/route.ts", "utf8");
  assert.ok(source.indexOf("if (quote.booking_id)") < source.indexOf("if (requiresHourlyProject(quote.pricing_type))"));
});

test("project payment records do not create fictional calendar appointments", () => {
  for (const path of ["app/api/calendar/route.ts", "app/api/bookings/[bookingId]/calendar/route.ts"]) {
    assert.match(readFileSync(path, "utf8"), /NOT EXISTS \(SELECT 1 FROM hourly_projects project WHERE project\.payment_booking_id=b\.id\)/);
  }
  assert.match(readFileSync("app/api/bookings/[bookingId]/route.ts", "utf8"), /hourlyProjectId: row\.hourly_project_id/);
});

test("unpaid hourly settlements cannot generate public reviews", () => {
  const source = readFileSync("app/api/bookings/[bookingId]/review/route.ts", "utf8");
  assert.match(source, /b\.payment_status IN \('paid','refunded'\) OR NOT EXISTS \(SELECT 1 FROM hourly_projects project WHERE project\.payment_booking_id=b\.id\)/);
});

test("project data exports retain address privacy and deletion fails before external payment deletion", () => {
  const exported = readFileSync("app/api/account/data-export/route.ts", "utf8");
  assert.match(exported, /hourlyTimeEntries/);
  assert.match(exported, /hourlyProjectHistory/);
  assert.match(exported, /Address available after acceptance/);
  const deletion = readFileSync("app/api/account/route.ts", "utf8");
  assert.ok(deletion.indexOf("const projectRecords") < deletion.indexOf("stripe.customers.del"));
});

test("approved tracked-hourly terms preserve legacy terms and disclose all billing rules", () => {
  for (const path of ["app/terms/page.tsx", "app/provider-agreement/page.tsx"]) {
    const source = readFileSync(path, "utf8");
    for (const disclosure of ["one final timesheet", "rounded up once", "one $2.99 customer service fee", "Existing prepaid bookings retain", "48-hour payout review period starts after payment"]) assert.ok(source.includes(disclosure), disclosure);
  }
  const exported = readFileSync("app/api/account/data-export/route.ts", "utf8");
  assert.match(exported, /hourlyProjects: hourlyProjects\.map/);
});
