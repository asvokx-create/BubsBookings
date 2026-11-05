import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { slugifyProviderName } from "../lib/provider-profile-options.ts";

const root = process.cwd();
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("provider profile slugs are readable, stable, unique, and replace raw public IDs", () => {
  assert.equal(slugifyProviderName("  Evergreen Lawn & Garden, LLC "), "evergreen-lawn-garden-llc");
  const migration = read("database", "migrations", "062_public_provider_profiles.sql");
  const onboarding = read("app", "api", "providers", "onboarding", "route.ts");
  const sitemap = read("app", "sitemap.ts");
  assert.match(migration, /UNIQUE INDEX[\s\S]*lower\(public_profile_slug\)/);
  assert.match(onboarding, /publicProfileSlug = existing\?\.public_profile_slug/);
  assert.doesNotMatch(onboarding, /DO UPDATE SET[\s\S]*public_profile_slug = EXCLUDED/);
  assert.match(sitemap, /listing\.providerSlug/);
  assert.doesNotMatch(sitemap, /providers\/\$\{providerId\}/);
});

test("service request quotes use the canonical public provider profile columns", () => {
  const requestsRoute = read("app", "api", "job-requests", "route.ts");
  assert.match(requestsRoute, /provider\.public_profile_slug AS public_slug/);
  assert.match(requestsRoute, /provider\.public_profile_visible AS public_profile_enabled/);
  assert.doesNotMatch(requestsRoute, /provider\.public_slug/);
  assert.doesNotMatch(requestsRoute, /provider\.public_profile_enabled/);
});

test("public profiles expose only eligible providers and truthful marketplace evidence", () => {
  const marketplace = read("lib", "marketplace.ts");
  const page = read("app", "providers", "[slug]", "page.tsx");
  assert.match(marketplace, /\$2::text IS NULL[\s\S]*p\.public_profile_visible = true/);
  assert.match(marketplace, /EXISTS \(SELECT 1 FROM services active_service[\s\S]*active_service\.is_active = true[\s\S]*active_service\.provider_deleted_at IS NULL\)/);
  assert.match(marketplace, /JOIN bookings b ON b\.id = r\.booking_id AND b\.status = 'completed'/);
  assert.match(marketplace, /r\.is_hidden = false/);
  assert.match(page, /provider\.completedBookingCount > 0/);
  assert.match(page, /provider\.reviews\.length > 0/);
  assert.match(page, /Exact times and openings appear during booking/);
  assert.doesNotMatch(page, /background checked|licensed|insured/i);
});

test("fallback category artwork stays fully positioned inside provider profile headers", () => {
  const page = read("app", "providers", "[slug]", "page.tsx");
  assert.match(page, /className="!absolute bottom-5 right-7 h-24/);
});

test("business owners can preview only their own hidden or pre-launch profile", () => {
  const marketplace = read("lib", "marketplace.ts");
  const page = read("app", "providers", "[slug]", "page.tsx");
  const editor = read("components", "provider-profile-editor.tsx");
  const marketing = read("components", "provider-marketing-tools.tsx");
  assert.match(marketplace, /\$2::text IS NOT NULL AND p\.id::text = \$2/);
  assert.match(page, /query\.preview === "owner"/);
  assert.match(page, /access\?\.isOwner/);
  assert.match(page, /ownerProviderId: access\.providerId/);
  assert.match(page, /Private preview/);
  assert.match(editor, /\?preview=owner/);
  assert.match(marketing, /\?preview=owner/);
});

test("provider profile editing is owner-only, moderated, bounded, and separate from listing media", () => {
  const profileRoute = read("app", "api", "providers", "profile", "route.ts");
  const portfolioRoute = read("app", "api", "providers", "profile", "portfolio", "route.ts");
  const migration = read("database", "migrations", "062_public_provider_profiles.sql");
  assert.match(profileRoute, /access\?\.isOwner/);
  assert.match(profileRoute, /checkAndRecordContent/);
  assert.match(portfolioRoute, /detectSupportedImageFormat/);
  assert.match(portfolioRoute, /LISTING_IMAGE_MAX_BYTES/);
  assert.match(portfolioRoute, /provider_id::text = \$2/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS provider_portfolio_items/);
  assert.match(migration, /service_id uuid REFERENCES services\(id\) ON DELETE SET NULL/);
});

test("profiles connect to messages, listings, sharing, QR codes, SEO, analytics, and admin moderation", () => {
  const page = read("app", "providers", "[slug]", "page.tsx");
  const share = read("components", "listing-share-button.tsx");
  const marketing = read("components", "provider-marketing-tools.tsx");
  const analytics = read("app", "api", "analytics", "route.ts");
  const admin = read("app", "api", "admin", "route.ts");
  assert.match(page, /<ContactProviderLink/);
  assert.match(page, /"@type": "Organization"/);
  assert.match(page, /"@type": "BreadcrumbList"/);
  assert.match(page, /openGraph/);
  assert.match(share, /providerSlug/);
  assert.match(marketing, /Provider profile QR · separate from listing QR codes/);
  assert.match(analytics, /providerShareEvents/);
  assert.match(admin, /portfolio_status/);
  assert.match(admin, /provider_portfolio_hidden/);
});
