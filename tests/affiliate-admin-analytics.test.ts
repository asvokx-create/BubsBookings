import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { affiliateAnalyticsWindow, aggregateAffiliateClickTrends } from "../lib/affiliate-analytics.ts";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("affiliate analytics uses stable UTC date boundaries", () => {
  const now = new Date("2026-10-19T20:00:00.000Z");
  const preset = affiliateAnalyticsWindow({ range: "7d", now });
  assert.equal(preset.start?.toISOString(), "2026-10-12T20:00:00.000Z");
  assert.equal(preset.end, null);
  const custom = affiliateAnalyticsWindow({ range: "custom", start: "2026-10-01", end: "2026-10-19", now });
  assert.equal(custom.start?.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(custom.end?.toISOString(), "2026-10-20T00:00:00.000Z");
});

test("invalid or excessive custom ranges are rejected", () => {
  const now = new Date("2026-10-19T20:00:00.000Z");
  assert.equal(affiliateAnalyticsWindow({ range: "custom", start: "2026-10-20", end: "2026-10-01", now }).valid, false);
  assert.equal(affiliateAnalyticsWindow({ range: "custom", start: "2024-01-01", end: "2026-10-01", now }).valid, false);
});

test("daily click rows aggregate into weekly and monthly trends", () => {
  const trends = aggregateAffiliateClickTrends([
    { period: "2026-10-12", clicks: 2 },
    { period: "2026-10-13", clicks: 3 },
    { period: "2026-11-01", clicks: 4 },
  ]);
  assert.deepEqual(trends.weekly, [{ period: "2026-10-12", clicks: 5 }, { period: "2026-10-26", clicks: 4 }]);
  assert.deepEqual(trends.monthly, [{ period: "2026-10", clicks: 5 }, { period: "2026-11", clicks: 4 }]);
});

test("admin affiliate analytics is server-authorized and separates raw clicks from attribution", async () => {
  const route = await source("../app/api/admin/affiliates/analytics/route.ts");
  assert.match(route, /getAdminSession\(\)/);
  assert.match(route, /Admin access required/);
  assert.match(route, /FROM affiliate_click_events/);
  assert.match(route, /first_touch_visits FROM affiliate_clicks/);
  assert.match(route, /first_touch_counts AS/);
  assert.match(route, /COALESCE\(referrals\.range_registrations, 0\)::numeric \/ first_touches\.range_first_touch_visits/);
  assert.match(route, /referrals\.signups::numeric \/ first_touches\.first_touch_visits/);
  assert.doesNotMatch(route, /referrals\.range_registrations::numeric \/ clicks\.range_clicks/);
  assert.match(route, /FROM affiliate_referrals/);
  assert.match(route, /FROM affiliate_commissions/);
  assert.match(route, /FROM services service/);
  assert.doesNotMatch(route, /provider_services/);
  assert.match(route, /LIMIT \$4 OFFSET \$5/);
  assert.doesNotMatch(route, /INSERT INTO affiliate_click|UPDATE affiliate_click|DELETE FROM affiliate_click/);
});

test("admin analytics shows fixed click windows, conversions, and unavailable rates", async () => {
  const component = await source("../components/affiliate-click-analytics.tsx");
  assert.match(component, /Total referral clicks/);
  assert.match(component, /First-touch visits/);
  assert.match(component, /7 days/);
  assert.match(component, /30 days/);
  assert.match(component, /Published providers/);
  assert.match(component, /First-touch signup conversion/);
  assert.match(component, /Not available/);
  assert.match(component, /Times shown in UTC/);
});
