import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { shouldRecordAffiliateLanding } from "../lib/affiliate-request.ts";

function request(input: { method?: string; url?: string; headers?: Record<string, string> } = {}) {
  return {
    method: input.method ?? "GET",
    url: input.url ?? "https://bubsbookings.com/providers/join?ref=PRESTONLEE&utm_source=affiliate",
    headers: new Headers(input.headers),
  };
}

test("direct and mobile referral documents are eligible for server-side recording", () => {
  assert.equal(shouldRecordAffiliateLanding(request({ headers: { "sec-fetch-dest": "document", "user-agent": "Mozilla/5.0 Safari/605.1.15 iPhone" } })), true);
  assert.equal(shouldRecordAffiliateLanding(request({ headers: { "sec-fetch-dest": "document", "user-agent": "Mozilla/5.0 Chrome/140.0 Mobile Safari/537.36" } })), true);
});

test("five separate visits from the same browser remain five qualifying clicks", () => {
  const repeatedVisits = Array.from({ length: 5 }, () => request({
    headers: { "sec-fetch-dest": "document", "user-agent": "Mozilla/5.0 Safari/605.1.15 iPhone" },
  }));
  assert.equal(repeatedVisits.filter(shouldRecordAffiliateLanding).length, 5);
});

test("ten different browsers remain ten qualifying clicks", () => {
  const separateBrowsers = Array.from({ length: 10 }, (_, index) => request({
    headers: { "sec-fetch-dest": "document", "user-agent": `Mozilla/5.0 Browser-${index}` },
  }));
  assert.equal(separateBrowsers.filter(shouldRecordAffiliateLanding).length, 10);
});

test("prefetches, bots, non-documents, invalid paths, and non-GET requests are excluded", () => {
  assert.equal(shouldRecordAffiliateLanding(request({ headers: { purpose: "prefetch" } })), false);
  assert.equal(shouldRecordAffiliateLanding(request({ headers: { "user-agent": "Googlebot/2.1" } })), false);
  assert.equal(shouldRecordAffiliateLanding(request({ headers: { "sec-fetch-dest": "script" } })), false);
  assert.equal(shouldRecordAffiliateLanding(request({ url: "https://bubsbookings.com/providers/join" })), false);
  assert.equal(shouldRecordAffiliateLanding(request({ url: "https://bubsbookings.com/pricing?ref=PRESTONLEE" })), false);
  assert.equal(shouldRecordAffiliateLanding(request({ method: "POST" })), false);
});

test("every referral landing is counted while attribution retains first touch", async () => {
  const proxy = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");
  const store = await readFile(new URL("../lib/affiliate-attribution-store.ts", import.meta.url), "utf8");
  const clientTracker = await readFile(new URL("../components/affiliate-attribution-tracker.tsx", import.meta.url), "utf8");
  assert.match(proxy, /shouldRecordAffiliateLanding\(request\)/);
  assert.match(proxy, /recordAffiliateRawClick/);
  assert.match(proxy, /storeAffiliateAttribution/);
  assert.ok(proxy.indexOf("recordAffiliateRawClick") < proxy.indexOf("storeAffiliateAttribution({"), "raw click storage must run before first-touch retention");
  assert.match(proxy, /matcher: \["\/404", "\/api\/:path\*", "\/providers\/:path\*", "\/services\/:path\*", "\/companies\/:path\*"\]/);
  assert.match(proxy, /Cache-Control", "private, no-store/);
  assert.ok(store.indexOf('status: "retained"') < store.indexOf("INSERT INTO affiliate_clicks"));
  assert.match(store, /affiliate\.status = 'active'/);
  assert.match(store, /program\.status = 'enabled'/);
  assert.match(store, /INSERT INTO affiliate_click_events/);
  assert.match(clientTracker, /fetch\("\/api\/affiliates\/attribution"/);
  assert.doesNotMatch(clientTracker, /useAnalyticsConsent/);
});

test("raw click storage is separate and backfills known historical visits", async () => {
  const migration = await readFile(new URL("../database/migrations/099_affiliate_raw_click_events.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS affiliate_click_events/);
  assert.match(migration, /INSERT INTO affiliate_click_events[\s\S]*FROM affiliate_clicks/);
  assert.doesNotMatch(migration, /ip_address|user_agent|fingerprint/);
});

test("admin and affiliate dashboards use the same raw-click source without changing commissions", async () => {
  const adminAnalytics = await readFile(new URL("../app/api/admin/affiliates/analytics/route.ts", import.meta.url), "utf8");
  const adminRoute = await readFile(new URL("../app/api/admin/affiliates/route.ts", import.meta.url), "utf8");
  const affiliateDashboard = await readFile(new URL("../app/affiliate/page.tsx", import.meta.url), "utf8");
  const commissionEngine = await readFile(new URL("../lib/affiliates.ts", import.meta.url), "utf8");

  assert.match(adminAnalytics, /FROM affiliate_click_events/);
  assert.match(adminRoute, /FROM affiliate_click_events/);
  assert.match(affiliateDashboard, /FROM affiliate_click_events/);
  assert.match(adminAnalytics, /Cache-Control": "private, no-store/);
  assert.doesNotMatch(commissionEngine, /affiliate_click_events/);
});
