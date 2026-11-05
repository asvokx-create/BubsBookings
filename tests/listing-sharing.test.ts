import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonicalListingUrl, listingShareDestinations, listingShareText } from "../lib/listing-share.ts";

const root = process.cwd();
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("listing shares always use a clean canonical public URL", () => {
  assert.equal(canonicalListingUrl("full-car-detailing-service-b5116345"), "https://bubsbookings.com/services/full-car-detailing-service-b5116345");
  assert.equal(canonicalListingUrl("safe?ref=OTHER"), "https://bubsbookings.com/services/safe%3Fref%3DOTHER");
  assert.doesNotMatch(canonicalListingUrl("safe?ref=OTHER"), /\?ref=/);
});

test("supported share destinations encode the canonical listing URL and title", () => {
  const title = "Detailing & Care";
  const links = listingShareDestinations(title, "detailing-care");
  const canonical = encodeURIComponent("https://bubsbookings.com/services/detailing-care");
  assert.match(links.facebook, new RegExp(canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(links.x, /twitter\.com\/intent\/tweet/);
  assert.match(links.whatsapp, /wa\.me\/\?text=/);
  assert.match(links.linkedin, /linkedin\.com\/sharing\/share-offsite/);
  assert.match(links.email, /^mailto:\?subject=/);
  assert.match(decodeURIComponent(links.x), /Check out Detailing & Care on BubsBookings\./);
  assert.equal(listingShareText(title), "Check out Detailing & Care on BubsBookings.");
});

test("public listings and provider marketing use the same accessible sharing component", () => {
  const component = read("components", "listing-share-button.tsx");
  const listing = read("app", "services", "[slug]", "page.tsx");
  const marketing = read("components", "provider-marketing-tools.tsx");
  assert.match(listing, /<ListingShareButton serviceId=/);
  assert.match(marketing, /<ListingShareButton action="copy"/);
  assert.match(marketing, /<ListingShareButton serviceId=/);
  assert.match(component, /navigator\.share/);
  assert.match(component, /error\.name === "AbortError"/);
  assert.match(component, /navigator\.clipboard\?\.writeText/);
  assert.match(component, /document\.execCommand\("copy"\)/);
  assert.match(component, /aria-label=\{action === "share" \? `Share \$\{title\}`/);
  assert.match(component, /role="dialog" aria-modal="true"/);
  assert.match(component, /event\.key === "Escape"/);
  assert.match(component, /event\.key !== "Tab"/);
  assert.doesNotMatch(component, /instagram/i);
});

test("marketing share actions preserve readable contrast inside the dark card", () => {
  const marketing = read("components", "provider-marketing-tools.tsx");
  assert.match(marketing, /!bg-\[#eee25a\] !text-\[#183126\]/);
  assert.match(marketing, /!bg-transparent !text-white/);
});

test("listing previews use a primary photo or a branded 1200 by 630 fallback", () => {
  const listing = read("app", "services", "[slug]", "page.tsx");
  const fallback = read("app", "services", "[slug]", "opengraph-image.tsx");
  assert.match(listing, /service\.imageUrls\[0\]/);
  assert.match(listing, /twitter: \{ card: "summary_large_image"/);
  assert.match(listing, /siteName: "BubsBookings"/);
  assert.match(listing, /const canonical = absolutePublicUrl\(`\/services\/\$\{service\.slug\}`\)/);
  assert.match(listing, /alternates: \{ canonical \}/);
  assert.match(fallback, /width: 1200, height: 630/);
  assert.match(fallback, /Bubs/);
  assert.match(fallback, /Bookings/);
});

test("share analytics accept only active public listings and server-derived provider context", () => {
  const route = read("app", "api", "analytics", "route.ts");
  for (const event of ["listing_share_opened", "listing_share_native", "listing_share_copy_link", "listing_share_facebook", "listing_share_x", "listing_share_whatsapp", "listing_share_linkedin", "listing_share_email"]) assert.match(route, new RegExp(event));
  assert.match(route, /s\.is_active = true AND p\.is_active = true/);
  assert.match(route, /metadata = \{ method: shareEvents\.get\(eventName\), providerId: service\.rows\[0\]\.provider_id \}/);
});

test("share UI includes explicit neutral dark mode styles without a social SDK", () => {
  const styles = read("app", "globals.css");
  const packageJson = read("package.json");
  assert.match(styles, /html\[data-theme="dark"\] \.listing-share-dialog/);
  assert.match(styles, /background: #1a1a1d/);
  assert.match(styles, /\.listing-share-option:focus-visible/);
  assert.doesNotMatch(packageJson, /facebook-sdk|linkedin-sdk|twitter-sdk|whatsapp-sdk/);
});
