import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { calculateAffiliateCommission, calculateEligibleProviderFeeRevenue } from "../lib/affiliate-rules.ts";
import { getServiceCategorySearchMatches } from "../lib/service-categories.ts";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

test("new listings omit empty photo and completed-booking metrics without hiding honest review status", () => {
  const listing = read("app/services/[slug]/page.tsx");
  assert.match(listing, /service\.imageUrls\.length > 0/);
  assert.match(listing, /service\.completedJobCount > 0/);
  assert.match(listing, /No verified reviews yet/);
  assert.doesNotMatch(listing, />Completed on BubsBookings</);
});

test("default nearby discovery keeps eligible paid-plan listings ahead while preserving distance within a plan", () => {
  const marketplace = read("lib/marketplace.ts");
  assert.match(marketplace, /p\.plan AS provider_plan/);
  assert.match(marketplace, /PRIORITY_DISTANCE_BAND_MILES = 10/);
  assert.match(marketplace, /Math\.floor\(\(left\.distanceMiles \?\? 0\) \/ PRIORITY_DISTANCE_BAND_MILES\)/);
  assert.match(marketplace, /Number\(right\.priorityPlacement\) - Number\(left\.priorityPlacement\)/);
  assert.match(marketplace, /\(left\.distanceMiles \?\? 0\) - \(right\.distanceMiles \?\? 0\)/);
  assert.match(marketplace, /LOWER\(s\.category\)/);
  assert.match(marketplace, /distance <= radiusMiles/);
});

test("substantive provider edits refresh automated verification while cosmetic settings do not", () => {
  const listingRoute = read("app/api/providers/services/[serviceId]/route.ts");
  const locationRoute = read("app/api/providers/locations/route.ts");
  const accountRoute = read("app/api/account/settings/route.ts");
  const trustRoute = read("app/api/providers/trust-settings/route.ts");
  assert.match(listingRoute, /Post-listing-update verification failed/);
  assert.match(listingRoute, /Post-listing-removal verification failed/);
  assert.match(locationRoute, /Post-location-update verification failed/);
  assert.match(accountRoute, /current\.name !== name/);
  assert.match(accountRoute, /Post-account-update verification failed/);
  assert.doesNotMatch(trustRoute, /runAutomatedProviderVerification/);
});

test("guide marketplace calls to action use the reader's location context instead of forcing Issaquah", () => {
  const guides = read("lib/guides.ts");
  assert.match(guides, /Find car detailing near you/);
  assert.match(guides, /Find a handyman near you/);
  assert.match(guides, /Find lawn care near you/);
  assert.doesNotMatch(guides, /mobile-car-detailing-vs-detail-shop[\s\S]*?ctaHref: "[^"]*location=Issaquah/);
});

test("homepage section headings follow the page heading without skipping directly to level three", () => {
  const home = read("app/page.tsx");
  assert.match(home, /<h1 id="premium-home-heading">/);
  assert.match(home, /<h2 id="featured-services-heading" tabIndex=\{-1\}>/);
  assert.match(home, /<h2 id="how-heading">/);
  assert.match(home, /<h2 id="provider-promo-heading">/);
});

test("homepage hero uses an image-free category preview with accessible contextual labeling", () => {
  const preview = read("components/home-hero-preview.tsx");
  assert.match(preview, /Explore BubsBookings/);
  assert.match(preview, /Find the right help for the job\./);
  assert.match(preview, /Home repair/);
  assert.match(preview, /Photography/);
  assert.match(preview, /Consulting/);
  assert.match(preview, /Tutoring/);
  assert.match(preview, /aria-label=/);
  assert.doesNotMatch(preview, /home-marketplace-hero\.webp/);
  assert.doesNotMatch(preview, /function MapPin|home-preview-road--one/);
});

test("the account loading placeholder cannot cover the wordmark on the narrowest phones", () => {
  const accountNav = read("components/account-nav.tsx");
  assert.match(accountNav, /w-10[^"]*min-\[380px\]:w-28/);
});

test("first-visit browser location approval reloads the marketplace with the resolved city", () => {
  const locationFilter = read("components/location-filter.tsx");
  assert.match(locationFilter, /if \(reload\) \{\s*window\.location\.replace\(href\)/);
  assert.match(locationFilter, /requestCurrentLocation\(true, true\)/);
  assert.match(locationFilter, /localStorage\.setItem\(STORAGE_KEY, JSON\.stringify\(\{ location: closest\.label, radius \}\)\)/);
});

test("search assistance finds related service categories from two typed characters", () => {
  assert.ok(getServiceCategorySearchMatches("ca").includes("Car detailing"));
  const searchAssist = read("components/service-search-assist.tsx");
  const homeSearch = read("components/home-service-search.tsx");
  assert.match(searchAssist, /role="combobox"/);
  assert.match(searchAssist, /role="listbox"/);
  assert.match(searchAssist, /requestSubmit/);
  assert.match(homeSearch, /home-search-bar relative z-40/);
  assert.match(homeSearch, /\{ value: "REMOTE", label: "Remote" \}/);
});

test("location action remains readable when enabled or disabled", () => {
  const locationFilter = read("components/location-filter.tsx");
  const styles = read("app/globals.css");
  assert.match(locationFilter, /location-apply-button/);
  assert.match(styles, /\.location-apply-button\s*\{[\s\S]*?color:\s*#ffffff\s*!important/);
  assert.match(styles, /\.location-apply-button:disabled\s*\{[\s\S]*?background:\s*#dfe5de\s*!important[\s\S]*?opacity:\s*1\s*!important/);
});

test("$250 Starter and Pro affiliate examples use the snapshotted provider fee rather than booking total", () => {
  const starterRevenue = calculateEligibleProviderFeeRevenue({ providerMarketplaceFeeCents: 2_500, bookingPriceCents: 25_000, refundedServiceAmountCents: 0 });
  const proRevenue = calculateEligibleProviderFeeRevenue({ providerMarketplaceFeeCents: 1_500, bookingPriceCents: 25_000, refundedServiceAmountCents: 0 });
  assert.equal(calculateAffiliateCommission(starterRevenue, 2_000), 500);
  assert.equal(calculateAffiliateCommission(proRevenue, 2_000), 300);
});

test("affiliate math preserves proportional partial refunds and removes revenue after a full refund", () => {
  const partialRevenue = calculateEligibleProviderFeeRevenue({ providerMarketplaceFeeCents: 2_500, bookingPriceCents: 25_000, refundedServiceAmountCents: 10_000 });
  const fullRevenue = calculateEligibleProviderFeeRevenue({ providerMarketplaceFeeCents: 2_500, bookingPriceCents: 25_000, refundedServiceAmountCents: 25_000 });
  assert.equal(partialRevenue, 1_500);
  assert.equal(calculateAffiliateCommission(partialRevenue, 2_000), 300);
  assert.equal(fullRevenue, 0);
});

test("affiliate attribution is only locked while creating a provider profile", () => {
  const onboardingRoute = read("app/api/providers/onboarding/route.ts");
  assert.match(onboardingRoute, /if \(!existing\) \{[\s\S]*?lockAffiliateAttribution/);
});

test("the narrow homepage header hides its wordmark before it can clip at 320px", () => {
  const home = read("app/page.tsx");
  const styles = read("app/globals.css");
  assert.match(home, /narrow-mobile-header site-container/);
  assert.match(styles, /@media \(max-width: 340px\)[\s\S]*?\.narrow-mobile-header \.brand-wordmark-text \{ display: none; \}/);
});

test("affiliate admin does not render an invalid audience size as NaN", () => {
  const admin = read("components/affiliate-admin.tsx");
  assert.match(admin, /Number\.isFinite\(parsed\) && parsed > 0/);
  assert.doesNotMatch(admin, /Number\(item\.audience_size\)\.toLocaleString/);
});

test("the Promise page exposes direct concern, refund, and dispute paths", () => {
  const promise = read("app/promise/page.tsx");
  assert.match(promise, />Report a concern →</);
  assert.match(promise, />Request a refund →</);
  assert.match(promise, />Open a dispute →</);
  assert.doesNotMatch(promise, /secure payment tools/i);
});

test("service business names link to their matching company before an account-level provider profile", () => {
  const home = read("components/service-listing-card.tsx");
  const detail = read("app/services/[slug]/page.tsx");
  assert.match(home, /if \(service\.companySlug\) return `\/companies\/\$\{service\.companySlug\}`/);
  assert.match(home, /service\.providerProfileVisible && service\.providerSlug/);
  assert.match(detail, /This is the business responsible for delivering the service/);
});

test("customer-facing guide surfaces consistently use Guides rather than Blog", () => {
  const index = read("app/guides/page.tsx");
  const article = read("app/guides/[slug]/page.tsx");
  const socialImage = read("app/guides/[slug]/opengraph-image.tsx");
  assert.doesNotMatch(index, /BubsBookings Blog|Filter blog articles/);
  assert.match(index, /BubsBookings Guides/);
  assert.doesNotMatch(article, /BubsBookings Blog/);
  assert.match(article, /BubsBookings Guides/);
  assert.match(socialImage, /BubsBookings Guides/);
});
