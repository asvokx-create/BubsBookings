import assert from "node:assert/strict";
import test from "node:test";
import { endOfZonedCalendarDate, isValidTimeZone, nextCalendarDate, zonedDateTimeToUtc } from "../lib/zoned-date-time.ts";

test("converts Pacific noon to the correct UTC instant during daylight time", () => {
  assert.equal(zonedDateTimeToUtc("2026-09-23", "12:00", "America/Los_Angeles")?.toISOString(), "2026-09-23T19:00:00.000Z");
});

test("converts Pacific noon to the correct UTC instant during standard time", () => {
  assert.equal(zonedDateTimeToUtc("2026-12-23", "12:00", "America/Los_Angeles")?.toISOString(), "2026-12-23T20:00:00.000Z");
});

test("rejects an invalid time zone and a skipped daylight-saving time", () => {
  assert.equal(isValidTimeZone("Not/A_Time_Zone"), false);
  assert.equal(zonedDateTimeToUtc("2026-03-08", "02:30", "America/Los_Angeles"), null);
});

test("rejects a repeated daylight-saving wall-clock time instead of choosing an offset", () => {
  assert.equal(zonedDateTimeToUtc("2026-11-01", "01:30", "America/Los_Angeles"), null);
  assert.equal(zonedDateTimeToUtc("2026-11-01", "02:30", "America/Los_Angeles")?.toISOString(), "2026-11-01T10:30:00.000Z");
});

test("coupon expiration lasts through the provider's full local calendar day",()=>{
  assert.equal(nextCalendarDate("2026-10-04"),"2026-10-05");
  assert.equal(endOfZonedCalendarDate("2026-10-04","America/Los_Angeles")?.toISOString(),"2026-10-05T07:00:00.000Z");
  assert.equal(endOfZonedCalendarDate("2027-01-15","America/Los_Angeles")?.toISOString(),"2027-01-16T08:00:00.000Z");
});

test("coupon expiration rejects impossible dates",()=>{
  assert.equal(endOfZonedCalendarDate("2026-02-30","America/Los_Angeles"),null);
  assert.equal(endOfZonedCalendarDate("not-a-date","America/Los_Angeles"),null);
});
