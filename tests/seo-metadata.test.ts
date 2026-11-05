import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { absolutePublicUrl, metadataDescription, publicPageMetadata, SITE_ORIGIN } from "../lib/seo.ts";

const projectRoot = process.cwd();
const read = (...parts: string[]) => readFileSync(join(projectRoot, ...parts), "utf8");

test("public metadata uses one absolute canonical URL for canonical and Open Graph", () => {
  const metadata = publicPageMetadata({
    title: "Browse services",
    description: "Explore bookable local and remote services.",
    pathname: "/services/",
  });

  assert.equal(SITE_ORIGIN, "https://bubsbookings.com");
  assert.equal(absolutePublicUrl("/"), SITE_ORIGIN);
  assert.equal(absolutePublicUrl("services/"), "https://bubsbookings.com/services");
  assert.equal(metadata.alternates?.canonical, "https://bubsbookings.com/services");
  assert.equal(metadata.openGraph?.url, metadata.alternates?.canonical);
  assert.equal(metadata.openGraph?.siteName, "BubsBookings");
  assert.match(read("lib", "seo.ts"), /DEFAULT_SOCIAL_IMAGE = "\/brand-logo\.jpg"/);
});

test("dynamic metadata descriptions stay readable and within the search snippet budget", () => {
  const description = metadataDescription([
    "Explore workflow automation from Streamlining Your Business.",
    "Available online across the United States.",
    "Automate Airtable and Insightly CRM workflows without repetitive manual entry.",
  ]);
  assert.ok(description.length <= 160);
  assert.match(description, /…$/);
  assert.doesNotMatch(description, /\s…$/);
});

test("shared SEO configuration serves complete head metadata and one public host", () => {
  const config = read("next.config.ts");

  assert.match(config, /htmlLimitedBots:\s*\/\.\*\//);
  assert.match(config, /value:\s*"www\.bubsbookings\.com"/);
  assert.match(config, /destination:\s*"https:\/\/bubsbookings\.com\/:path\*"/);
});

test("public static routes use the shared canonical and social metadata helper", () => {
  const publicPages = [
    ["app", "page.tsx"],
    ["app", "requests", "page.tsx"],
    ["app", "locations", "page.tsx"],
    ["app", "pricing", "page.tsx"],
    ["app", "providers", "join", "page.tsx"],
    ["app", "terms", "page.tsx"],
    ["app", "privacy", "page.tsx"],
    ["app", "cancellations-refunds", "page.tsx"],
    ["app", "payment-billing", "page.tsx"],
    ["app", "provider-agreement", "page.tsx"],
    ["app", "provider-safety", "page.tsx"],
    ["app", "partner-agreement", "page.tsx"],
    ["app", "marketing-communications", "page.tsx"],
    ["app", "dmca", "page.tsx"],
  ];

  for (const page of publicPages) {
    assert.match(read(...page), /publicPageMetadata\(/, `${page.join("/")} must use shared SEO metadata`);
  }
});

test("private and tokenized routes remain intentionally excluded from search", () => {
  const protectedLayouts = [
    ["app", "account", "layout.tsx"],
    ["app", "admin", "layout.tsx"],
    ["app", "provider", "layout.tsx"],
    ["app", "unsubscribe", "page.tsx"],
  ];

  for (const page of protectedLayouts) {
    assert.match(read(...page), /robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/, `${page.join("/")} must stay noindex,nofollow`);
  }
});

test("sitemap and robots rules cover public discovery while protecting private areas", () => {
  const sitemap = read("app", "sitemap.ts");
  const robots = read("app", "robots.ts");

  assert.match(sitemap, /"", "\/requests", "\/pricing", "\/providers\/join", "\/partners", "\/about", "\/locations", "\/guides"/);
  assert.doesNotMatch(sitemap, /const staticPages = \[[^\]]*"\/services"/);
  assert.match(sitemap, /"\/cancellations-refunds", "\/payment-billing"/);
  assert.match(sitemap, /"\/provider-safety", "\/partner-agreement", "\/marketing-communications"/);
  assert.match(sitemap, /"\/content-removal", "\/dmca", "\/accessibility"/);
  assert.match(sitemap, /GUIDES\.map/);
  assert.match(sitemap, /getPublicSeoInventory/);
  assert.match(sitemap, /listings\.map/);
  assert.match(sitemap, /providerPages/);
  assert.match(sitemap, /lastModified/);
  assert.match(sitemap, /images: listing\.imageUrls/);
  assert.doesNotMatch(sitemap, /limit:\s*1000/);
  assert.match(robots, /sitemap: "https:\/\/bubsbookings\.com\/sitemap\.xml"/);
  assert.match(robots, /disallow: \["\/account\/", "\/provider\/dashboard\/", "\/admin\/", "\/api\/"\]/);
});

test("public dynamic pages use canonical metadata, safe structured data, and real 404 handling", () => {
  const servicePage = read("app", "services", "[slug]", "page.tsx");
  const providerPage = read("app", "providers", "[slug]", "page.tsx");
  const companyPage = read("app", "companies", "[slug]", "page.tsx");

  for (const page of [servicePage, providerPage, companyPage]) {
    assert.match(page, /absolutePublicUrl/);
    assert.match(page, /notFound\(\)/);
    assert.match(page, /"@type": "BreadcrumbList"/);
  }
  for (const page of [servicePage, providerPage]) assert.match(page, /robots: \{ index: true, follow: true \}/);
  assert.match(companyPage, /robots: company\.services\.length \? \{ index: true, follow: true \} : \{ index: false, follow: true \}/);
  assert.match(servicePage, /metadataDescription/);
  assert.doesNotMatch(servicePage, /providers\/\$\{service\.providerId\}/);
  assert.doesNotMatch(servicePage, /"@type": "LocalBusiness"/);
  assert.match(servicePage, /service\.imageUrls\.length \? \{ image: service\.imageUrls \} : \{\}/);
  assert.match(companyPage, /View full provider profile/);
});

test("linked service-card artwork has an accessible text alternative", () => {
  const card = read("components", "service-listing-card.tsx");
  assert.match(card, /role=\{imageUrl \? undefined : "img"\}/);
  assert.match(card, /aria-label=\{imageUrl \? undefined : `\$\{service\.title\} cover`\}/);
  assert.match(card, /<Image src=\{imageUrl\} alt=\{`\$\{service\.title\} cover`\}/);
  for (const page of [["app", "companies", "[slug]", "page.tsx"], ["app", "locations", "[city]", "page.tsx"]]) assert.match(read(...page), /ServiceListingCard/);
});
