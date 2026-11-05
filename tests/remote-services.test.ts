import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { serviceMatchesRequest, serviceSupportsMethod } from "../lib/service-delivery.ts";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("delivery compatibility is explicit and never treats remote-only work as local", () => {
  assert.equal(serviceSupportsMethod("REMOTE", "REMOTE"), true);
  assert.equal(serviceSupportsMethod("REMOTE", "IN_PERSON"), false);
  assert.equal(serviceSupportsMethod("BOTH", "REMOTE"), true);
  assert.equal(serviceSupportsMethod("BOTH", "IN_PERSON"), true);
  assert.equal(serviceMatchesRequest("IN_PERSON", "REMOTE"), false);
  assert.equal(serviceMatchesRequest("REMOTE", "EITHER"), true);
});

test("the migration safely defaults existing records and snapshots booking delivery", () => {
  const migration = source("database/migrations/066_service_delivery_types.sql");
  assert.match(migration, /delivery_type text NOT NULL DEFAULT 'IN_PERSON'/);
  assert.match(migration, /location_id DROP NOT NULL/);
  assert.match(migration, /bookings[\s\S]*delivery_method text NOT NULL DEFAULT 'IN_PERSON'/);
  assert.match(migration, /job_requests[\s\S]*delivery_type IN \('IN_PERSON', 'REMOTE', 'EITHER'\)/);
  assert.match(migration, /service_address_line1 DROP NOT NULL/);
});

test("remote discovery bypasses distance without leaking location into URLs", () => {
  const marketplace = source("lib/marketplace.ts");
  const services = source("app/page.tsx");
  const card = source("components/service-listing-card.tsx");
  assert.match(marketplace, /service\.deliveryType === "REMOTE"/);
  assert.match(marketplace, /service\.deliveryType === "BOTH"/);
  assert.match(marketplace, /delivery === "REMOTE"/);
  assert.match(services, /input\.delivery !== "REMOTE" && input\.location/);
  assert.match(card, /Available online/);
  assert.match(source("components/home-service-search.tsx"), /Search without a distance limit/);
});

test("remote bookings and requests do not require a physical address", () => {
  const booking = source("app/api/bookings/route.ts");
  const bookingCard = source("app/services/[slug]/booking-card.tsx");
  const jobs = source("app/api/job-requests/route.ts");
  const jobForm = source("components/post-job-form.tsx");
  assert.match(booking, /isRemote \? "Remote service"/);
  assert.match(booking, /delivery_method/);
  assert.match(bookingCard, /deliveryMethod !== "REMOTE"/);
  assert.match(jobs, /requiresLocation = deliveryType !== "REMOTE"/);
  assert.match(jobForm, /deliveryType !== "REMOTE"/);
  assert.match(jobForm, /do not collect or expose your street address/);
});

test("remote and local workflows continue through quotes, payments, and affiliate-neutral bookings", () => {
  const quoteCreate = source("app/api/job-requests/[requestId]/quotes/route.ts");
  const quoteAccept = source("app/api/quotes/[quoteId]/route.ts");
  const quoteForm = source("components/job-request-center.tsx");
  const affiliateRules = source("lib/affiliate-rules.ts");
  assert.match(quoteCreate, /delivery_method/);
  assert.match(quoteCreate, /serviceSupportsMethod/);
  assert.match(quoteCreate, /Choose a delivery method supported by both the request and service/);
  assert.match(quoteForm, /How will you deliver this quote/);
  assert.match(quoteAccept, /quote\.delivery_method === "REMOTE" \? "Remote service"/);
  assert.match(quoteAccept, /calculateBookingFinancialSnapshot/);
  assert.doesNotMatch(affiliateRules, /delivery_type|delivery_method/);
});

test("local SEO pages exclude remote-only listings while the sitemap keeps every public listing", () => {
  assert.match(source("app/locations/page.tsx"), /delivery: "IN_PERSON"/);
  assert.match(source("app/locations/[city]/page.tsx"), /delivery: "IN_PERSON"/);
  assert.match(source("app/locations/[city]/[category]/page.tsx"), /delivery: "IN_PERSON"/);
  assert.match(source("app/sitemap.ts"), /getPublicSeoInventory\(\)/);
  assert.match(source("app/sitemap.ts"), /listing\.deliveryType === "REMOTE"/);
  assert.doesNotMatch(source("app/sitemap.ts"), /limit: 1000/);
});

test("provider acquisition and guidance welcome local and remote professionals", () => {
  const join = source("app/providers/join/page.tsx");
  const guides = source("lib/guides.ts");
  const footer = source("components/site-footer.tsx");
  const partners = source("app/partners/page.tsx");
  const messages = source("app/account/messages/page.tsx");
  assert.match(join, /For service providers/);
  assert.match(join, /offer services locally or remotely/);
  assert.match(join, /Offer services in person, remotely, or both/);
  assert.doesNotMatch(join, /For local professionals|connect with nearby customers/);
  assert.match(partners, /local or remote service providers/);
  assert.doesNotMatch(partners, /Help local providers grow/);
  assert.match(messages, /local or remote providers/);
  assert.match(guides, /Remote listings do not use customer distance or a travel radius/);
  assert.match(footer, /Your service marketplace/);
  assert.match(footer, /local and remote service providers across the United States/);
  assert.match(source("app/guides/page.tsx"), /hiring local or remote help/);
  assert.match(footer, /\["Find services", "\/#nearby-listings"\]/);
});

test("homepage search asks for delivery type before using local controls", () => {
  const search = source("components/home-service-search.tsx");
  const home = source("app/page.tsx");
  assert.match(search, /name="delivery"/);
  assert.match(search, /delivery !== "REMOTE"/);
  assert.match(search, /Search without a distance limit/);
  assert.match(home, /HomeServiceSearch/);
  assert.doesNotMatch(home, /join the local availability list/);
});

test("remote provider profiles avoid blank local areas and label every service", () => {
  const profile = source("app/providers/[slug]/page.tsx");
  const company = source("app/companies/[slug]/page.tsx");
  const card = source("components/service-listing-card.tsx");
  assert.match(profile, /Remote services available across the supported U\.S\. marketplace/);
  assert.match(profile, /provider\.hasInPersonServices/);
  assert.match(profile, /ServiceListingCard/);
  assert.match(card, /service\.deliveryType === "REMOTE" \? "Online"/);
  assert.match(profile, /"@type": "Organization"/);
  assert.match(profile, /"@type": "BreadcrumbList"/);
  assert.match(company, /hasRemoteServices && <span/);
  assert.match(company, /hasInPersonServices && company\.locations\.map/);
  assert.match(company, /ServiceListingCard/);
});

test("screening badges use the current automated result and material edits refresh it", () => {
  const marketplace = source("lib/marketplace.ts");
  const listing = source("app/services/[slug]/page.tsx");
  const listingRoute = source("app/api/providers/services/[serviceId]/route.ts");
  const locationRoute = source("app/api/providers/locations/route.ts");
  const accountRoute = source("app/api/account/settings/route.ts");
  assert.match(marketplace, /screeningCurrent && row\.is_verified && row\.screening_status === "passed"/);
  assert.match(marketplace, /screeningCurrent && provider\.is_verified && provider\.screening_status === "passed"/);
  assert.doesNotMatch(listing, /Automated profile checks last ran/);
  assert.match(listingRoute, /runAutomatedProviderVerification/);
  assert.match(locationRoute, /runAutomatedProviderVerification/);
  assert.match(accountRoute, /verificationRelevantChanged/);
});

test("remote-only provider settings do not present a working-radius control", () => {
  const settings = source("components/provider-trust-settings.tsx");
  const providerApi = source("app/api/providers/me/route.ts");
  assert.match(settings, /initial\.hasInPersonServices \?/);
  assert.match(settings, /Your active services are remote/);
  assert.match(providerApi, /hasInPersonServices: services\.some/);
});

test("remote-only provider and admin views do not present a travel radius as active", () => {
  const locations = source("components/location-manager.tsx");
  const locationsApi = source("app/api/providers/locations/route.ts");
  const admin = source("components/admin-dashboard.tsx");
  const adminAccount = source("app/api/admin/accounts/[userId]/route.ts");
  assert.match(locationsApi, /in_person_listing_count/);
  assert.match(locations, /No travel radius used for remote-only services/);
  assert.match(adminAccount, /has_in_person_services/);
  assert.match(admin, /Not used for remote-only services/);
});
