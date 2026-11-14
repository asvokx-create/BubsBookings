import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("homepage provider signup is a direct link in the hero before customer search", () => {
  const home = read("app/page.tsx");
  const hero = home.slice(home.indexOf('<div className="premium-hero-content'), home.indexOf('<div className="premium-search-dock'));
  assert.match(hero, /<Link href="\/providers\/join" className="premium-hero-provider-cta">\s*List your business free/);
  assert.doesNotMatch(hero, /\bhidden\b/);
  assert.match(hero, /className="premium-hero-description"/);
});

test("hero provider link has a touch-sized target, visible focus and wrapping-safe width", () => {
  const css = read("app/globals.css");
  assert.match(css, /\.premium-hero-provider-cta \{[^}]*min-height: 48px;[^}]*max-width: 100%;/);
  assert.match(css, /\.premium-hero-provider-cta:focus-visible \{[^}]*outline: 3px solid white;/);
  assert.match(css, /\.premium-hero-description \{[^}]*margin-top: 1\.5rem;/);
  assert.doesNotMatch(css, /\.premium-hero-copy > p:last-child/);
});
