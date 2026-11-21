import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { appendInternalPath, isSafeInternalPath, normalizeInternalHistory, rewindInternalHistory } from "../lib/internal-navigation.ts";

const projectRoot = process.cwd();
const read = (...parts: string[]) => readFileSync(join(projectRoot, ...parts), "utf8");

test("internal navigation history accepts only local paths and preserves search context", () => {
  assert.equal(isSafeInternalPath("/services?category=cleaning&sort=price"), true);
  assert.equal(isSafeInternalPath("https://example.com/services"), false);
  assert.equal(isSafeInternalPath("//example.com/services"), false);

  const history = appendInternalPath(
    ["https://example.com", "/", "//example.com"],
    "/services?category=cleaning&sort=price",
  );
  assert.deepEqual(history, ["/", "/services?category=cleaning&sort=price"]);
  assert.deepEqual(normalizeInternalHistory({}), []);
});

test("rewinding removes the current page and exposes the prior internal destination", () => {
  const current = "/services/window-cleaning";
  const result = rewindInternalHistory(["/", "/services?q=windows", current], current);

  assert.equal(result.previous, "/services?q=windows");
  assert.deepEqual(result.history, ["/", "/services?q=windows"]);
  assert.equal(rewindInternalHistory([current], current).previous, null);
});

test("the reusable back control is accessible, mobile friendly, and has a safe fallback", () => {
  const button = read("components", "back-button.tsx");
  const css = read("app", "globals.css");

  assert.match(button, /type="button"/);
  assert.match(button, /aria-label=\{label\}/);
  assert.match(button, /min-h-11/);
  assert.match(button, /min-w-11/);
  assert.match(button, /shrink-0/);
  assert.match(button, /focus-visible:outline/);
  assert.match(button, /transition-colors/);
  assert.doesNotMatch(button, /hover:(?:scale|translate|rotate)/);
  assert.match(button, /router\.back\(\)/);
  assert.match(button, /isSafeInternalPath\(fallbackHref\)/);
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*?\.back-button[\s\S]*?width: 2\.75rem/);
  assert.match(css, /\.back-button-label[\s\S]*?display: none/);
});

test("service detail navigation retains marketplace filters and names the destination", () => {
  const services = read("components", "service-listing-card.tsx");
  const detail = read("app", "services", "[slug]", "page.tsx");

  assert.match(services, /encodeURIComponent\(returnPath\)/);
  assert.match(detail, /contextualReturn \? "Back to results" : "Back to services"/);
  assert.match(detail, /fallbackHref=\{servicesReturnPath\}/);
  assert.match(detail, /marketplaceReturnPath\(returnPathValue, slug\)/);
  assert.match(detail, /contextualListingReturn=\{Boolean\(contextualReturn\)\}/);
});

test("navigation history is tracked globally and BackButton is limited to nested experiences", () => {
  const layout = read("app", "layout.tsx");
  assert.match(layout, /<InternalNavigationHistory \/>/);
  assert.match(layout, /<Suspense fallback=\{null\}>/);

  for (const path of [
    ["app", "account", "bookings", "[bookingId]", "page.tsx"],
    ["app", "provider", "dashboard", "bookings", "[bookingId]", "page.tsx"],
    ["app", "providers", "[slug]", "page.tsx"],
    ["app", "account", "calendar", "page.tsx"],
    ["app", "account", "requests", "page.tsx"],
    ["app", "companies", "[slug]", "page.tsx"],
    ["app", "guides", "[slug]", "page.tsx"],
    ["app", "admin", "listings", "[serviceId]", "page.tsx"],
    ["components", "admin-issue-queue.tsx"],
  ]) {
    assert.match(read(...path), /BackButton/);
  }

  for (const path of [
    ["app", "page.tsx"],
    ["app", "services", "page.tsx"],
    ["app", "account", "page.tsx"],
    ["app", "admin", "page.tsx"],
  ]) {
    assert.doesNotMatch(read(...path), /BackButton/);
  }
});

test("mobile conversation view exposes a full-size contextual return control", () => {
  const messaging = read("components", "messaging-center.tsx");

  assert.match(messaging, /aria-label="Back to messages"/);
  assert.match(messaging, /<span className="back-button-label">Messages<\/span>/);
  assert.match(messaging, /min-h-11/);
  assert.match(messaging, /lg:hidden/);
});
