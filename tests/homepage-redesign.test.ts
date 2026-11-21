import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

test("premium homepage retains live marketplace search and eligible listing data", () => {
  const home = read("app", "page.tsx");
  const card = read("components", "service-listing-card.tsx");
  assert.match(home, /<HomeServiceSearch/);
  assert.match(home, /await getServices\(/);
  assert.match(home, /Homepage service loading failed/);
  assert.match(home, /servicesWithinRange\.map/);
  assert.match(home, /maxPrice: input\.maxPrice/);
  assert.match(home, /maxDuration: input\.maxDuration/);
  assert.match(card, /<FavoriteButton serviceId=\{service\.id\}/);
  assert.match(card, /service\.companySlug/);
  assert.doesNotMatch(home, /1,500\+|10,000\+|50\+|testimonial|guaranteed customers|guaranteed bookings/i);
});

test("premium hero uses decorative CSS artwork and one discoverable search surface", () => {
  const home = read("app", "page.tsx");
  const search = read("components", "home-service-search.tsx");
  const css = read("app", "globals.css");
  const preview = read("app", "home-marketplace-preview.css");
  assert.doesNotMatch(home, /home-premium-hero\.webp/);
  assert.match(home, /className="marketplace-hero-art" aria-hidden="true"/);
  assert.match(preview, /\.marketplace-hero-art \{ display: none; \}/);
  assert.match(preview, /\.marketplace-hero \.premium-search-dock \{\s*position: relative;/);
  assert.equal((home.match(/<HomeServiceSearch/g) ?? []).length, 1);
  assert.match(home, /Find local and <span>online services\.<\/span>/);
  assert.doesNotMatch(home, /Local and remote service marketplace/i);
  assert.match(search, /xl:min-w-\[360px\]/);
  assert.match(search, /px-4 sm:px-5[^"]*xl:px-6/);
  assert.match(search, /home-search-icon mr-2[^"]*xl:mr-3/);
  assert.match(search, /home-search-submit[^"]*px-5/);
  assert.match(css, /\.premium-search-dock \.home-search-input input \{ font-size: \.9rem; \}/);
  assert.match(css, /\.premium-search-dock \.home-search-submit \{[\s\S]*?min-width: 8\.25rem;/);
});

test("homepage categories use supported searchable values and preserve location", () => {
  const home = read("app", "page.tsx");
  for (const category of ["Home repair", "Car detailing", "Tech help", "Photography", "Personal training", "Pet care", "Tutoring"]) {
    assert.match(home, new RegExp(`category: "${category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.match(home, new RegExp(`label: "${category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  }
  assert.match(home, /categoryParams\.set\("location", location\)/);
  assert.match(home, /#nearby-listings/);
});

test("homepage has the focused seven-section structure and truthful provider promo", () => {
  const home = read("app", "page.tsx");
  const showcase = read("components", "home-provider-showcase.tsx");
  for (const className of ["premium-hero", "premium-categories", "premium-featured", "premium-how", "premium-provider"]) {
    assert.match(home, new RegExp(`className="${className}(?: |")`));
  }
  assert.match(home, /without paying for leads/);
  assert.match(showcase, /Provider dashboard preview\. Sample empty account/);
  assert.doesNotMatch(home, /home-benefit-band|home-why|home-final-links|What people are saying/);
});

test("desktop navigation matches the premium public information architecture", () => {
  const home = read("app", "page.tsx");
  assert.match(home, />Find a Service<\/Link>/);
  assert.match(home, />For Providers<\/Link>/);
  assert.match(home, />How It Works<\/Link>/);
  assert.match(home, />Resources<\/Link>/);
  assert.doesNotMatch(home, /premium-header-search|aria-label="Search services"/);
});

test("homepage header keeps its first server and client render stable", () => {
  const accountNav = read("components", "account-nav.tsx");
  const brandMark = read("components", "brand-mark.tsx");
  assert.match(accountNav, /const mounted = useSyncExternalStore/);
  assert.match(accountNav, /if \(!mounted \|\| isPending\)/);
  assert.match(brandMark, /loading=\{priority \? "eager" : "lazy"\}/);
});

test("signed-in homepage notification control has explicit hero contrast", () => {
  const bell = read("components", "notification-bell.tsx");
  const css = read("app", "globals.css");
  assert.match(bell, /notification-bell-trigger/);
  assert.match(css, /\.premium-home-header \.home-header-account \.notification-bell-trigger \{[\s\S]*?background: rgba\(8, 29, 22, \.66\) !important;[\s\S]*?color: white !important;/);
  assert.match(css, /\.premium-home-header \.home-header-account a\[href="\/account"\] \[role="img"\] \{[\s\S]*?background-color: rgba\(20, 58, 44, \.92\);[\s\S]*?color: white;/);
  assert.match(css, /\.notification-bell-trigger:hover \{[\s\S]*?background: var\(--premium-accent\) !important;[\s\S]*?color: #102d22 !important;/);
});

test("responsive homepage has deliberate tablet and phone layouts", () => {
  const css = read("app", "globals.css");
  assert.match(css, /@media \(max-width: 899px\)[\s\S]*?\.premium-provider-inner \{ grid-template-columns: 1fr/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*?\.premium-category-row \{ display: flex/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*?\.premium-listing-grid \{ grid-template-columns: 1fr/);
  assert.match(css, /@media \(max-width: 359px\)[\s\S]*?\.premium-service-card \{ grid-template-columns: 1fr/);
});
