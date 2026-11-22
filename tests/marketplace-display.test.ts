import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hasMarketplaceSearchFilters, marketplaceResultsHeading, providerCardReviewDisplay } from "../lib/marketplace-display.ts";

test("neither established nor new unrated providers acquire a made-up status", () => {
  const established = { joinedAt: "2024-01-01", providerAverageRating: null, providerReviewCount: 0 };
  const newProvider = { ...established, joinedAt: "2026-11-21" };
  assert.equal(providerCardReviewDisplay(established), null);
  assert.equal(providerCardReviewDisplay(newProvider), null);
  assert.equal(providerCardReviewDisplay({ providerAverageRating: 4.8, providerReviewCount: 0 }), null);
  assert.equal(providerCardReviewDisplay({ providerAverageRating: 4.8, providerReviewCount: 2, providerStatus: "Profile screened" })?.kind, "rating");
});

test("explicit statuses and displayable rating/count remain useful", () => {
  assert.deepEqual(providerCardReviewDisplay({ providerStatus: "Profile screened" }), {kind: "status", status: "Profile screened"});
  assert.deepEqual(providerCardReviewDisplay({ providerStatus: "Verified", providerAverageRating: Number.NaN, providerReviewCount: 3 }), {kind: "status", status: "Verified"});
  assert.equal(providerCardReviewDisplay({ providerStatus: "  " }), null);
  assert.deepEqual(providerCardReviewDisplay({ providerAverageRating: 4.76, providerReviewCount: 3 }), {kind: "rating", rating: "4.8", count: 3});
});

test("homepage labels display narrowing filters, not canonical browsing context", () => {
  const defaults = {query: "  ", category: "All services", delivery: "ALL"};
  const browse = { ...defaults, location: "Issaquah, WA", radius: 25, sort: "price-low", showFilters: true };
  assert.equal(hasMarketplaceSearchFilters(browse), false);
  assert.equal(hasMarketplaceSearchFilters({ ...defaults, maxPrice: Infinity, maxDuration: 0 }), false);
  for (const applied of [{query:"bike"}, {category:"Pet care"}, {delivery:"REMOTE"}, {delivery:"IN_PERSON"}, {maxPrice:100}, {maxDuration:120}]) {
    assert.equal(hasMarketplaceSearchFilters({...defaults,...applied}), true);
  }
  assert.equal(marketplaceResultsHeading(false,"Issaquah"),"Explore services near Issaquah.");
  assert.equal(marketplaceResultsHeading(true,"Issaquah"),"Search results near Issaquah.");
  assert.equal(marketplaceResultsHeading(true,""),"Search results on BubsBookings.");
});

test("homepage retains section naming and the Back-to-results focus target", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const home = read("app/page.tsx");
  assert.match(home, /id="nearby-listings".*aria-labelledby="featured-services-heading"/);
  assert.match(home, /<h2 id="featured-services-heading" tabIndex=\{-1\}>\{resultsHeading\}<\/h2>/);
  assert.match(home, /<ListingResultsReturn resultsPath=\{currentResultsPath\}/);
  assert.match(home, /returnPath=\{currentResultsPath\}/);
  assert.match(read("components/listing-results-return.tsx"), /getElementById\("featured-services-heading"\)/);
  assert.doesNotMatch(home, /Featured services/);
});
