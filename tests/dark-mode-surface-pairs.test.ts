import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const css = read("app/globals.css");
function declarations(selector: string) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, selector);
  return css.slice(start, css.indexOf("}", start));
}
test("premium listing hearts retain contrasting ink against their white backing in dark mode", () => {
  assert.match(declarations(".premium-service-favorite {"), /background: rgba\(255, 255, 255, \.95\) !important/);
  assert.match(declarations('html[data-theme="dark"] .compact-service-card > .premium-service-favorite[aria-pressed="false"]'), /color: #153c2e !important/);
  assert.match(declarations('html[data-theme="dark"] .compact-service-card > .premium-service-favorite[aria-pressed="true"]'), /color: #ac3835 !important/);
});
test("premium white wordmarks do not inherit the dark gradient", () => {
  assert.match(css, /html\[data-theme="dark"\] \.brand-wordmark-bookings:not\(:where\(\.premium-header-logo \*, \.premium-footer-brand \*\)\)/);
  for (const family of ["premium-header-logo", "premium-footer-brand"]) {
    assert.match(declarations(`.${family} .brand-wordmark-bookings {`), /background: none;[\s\S]*-webkit-text-fill-color: white/);
  }
});
test("shared public header dark background overrides main header light fill", () => {
  const block = declarations('html[data-theme="dark"] .public-site-header {');
  assert.match(block, /background: rgba\(15, 19, 17, \.94\) !important/);
  assert.match(block, /color: var\(--text-primary\)/);
  for (const path of ["about", "pricing", "partners", "support", "providers/join"]) assert.match(read(`app/${path}/page.tsx`), /<PublicSiteHeader/);
});
test("admin overview, user hover, and inactive support actions pair dark surface and readable text", () => {
  const dashboard = read("components/admin-dashboard.tsx"); const support = read("components/admin-support-queue.tsx");
  for (const marker of ["admin-metric-card", "admin-refresh-action", "admin-metric-arrow", "admin-account-summary"]) assert.match(dashboard, new RegExp(marker));
  assert.match(support, /admin-support-filter/);
  assert.match(declarations('html[data-theme="dark"] .admin-page .admin-account-summary:hover'), /background-color: #2c3c32 !important;[\s\S]*color: var\(--text-primary\) !important/);
  assert.match(declarations('html[data-theme="dark"] .admin-header-link,'), /background: var\(--bb-surface\) !important;[\s\S]*color: var\(--text-primary\) !important/);
});
test("location summary and radius keep readable dark hover and focus surfaces", () => {
  const block = declarations('html[data-theme="dark"] .home-search-location summary:hover,');
  assert.match(block, /summary:focus-visible/);
  assert.match(block, /div:last-child:focus-within/);
  assert.match(block, /background-color: #2c3c32 !important;[\s\S]*color: var\(--text-primary\) !important/);
  assert.match(read("components/location-filter.tsx"), /location-filter-city/);
});
test("shared secondary buttons take theme surface and hover tokens without changing the light palette", () => {
  assert.match(declarations(':where(main) :where(a, button)[class*="border"][class~="bg-white"] {'), /background: var\(--bb-surface\) !important/);
  assert.match(declarations(':where(main) :where(a, button)[class*="border"][class~="bg-white"]:not(:disabled):hover {'), /background: var\(--bb-secondary-hover, #f4f8f2\) !important/);
  assert.match(css, /--bb-surface: #ffffff;/);
  assert.match(css, /--bb-surface: #1b231e;[\s\S]*?--bb-secondary-hover: #2c3c32;/);
});
test("neutral light hover utilities receive a theme-appropriate dark hover", () => {
  const block = declarations('html[data-theme="dark"] :where(a, button, summary):where(');
  assert.match(block, /\[class~="hover:bg-\[#edf3e7\]"\]/);
  assert.match(block, /\[class~="hover:bg-\[#e3ecde\]"\]/);
  assert.match(block, /:not\(:disabled\):hover \{/);
  assert.match(block, /background-color: var\(--card-hover\) !important/);
  // Bright brand actions, deliberate white heart backing, and warning palettes are distinct.
  assert.doesNotMatch(block, /#eee25a|#fff0e7|#f7f5ed/);
});

test("dark marketplace metadata and title hover maintain legible contrast", () => {
  const block = declarations('html[data-theme="dark"] .premium-service-category,');
  for (const selector of [".premium-provider-row a", ".premium-provider-row > div > p:first-child", ".premium-service-rating", ".premium-service-rating small", ".premium-service-location", ".premium-service-price span"]) assert.ok(block.includes(selector), selector);
  assert.match(block, /color: #b7c5bd/);
  assert.match(declarations('html[data-theme="dark"] .premium-service-content > a:hover h3 {'), /color: #78d698/);
  function luminance(hex: string) {
    const rgb = hex.match(/../g)!.map(s => parseInt(s, 16) / 255).map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  }
  for (const fg of ["b7c5bd", "78d698"]) assert.ok((luminance(fg) + 0.05) / (luminance("191d1b") + 0.05) >= 4.5);
});
