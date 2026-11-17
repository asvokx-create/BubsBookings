import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("provider dashboard navigation uses matching, consistent icons for every section", () => {
  const dashboard = read("components", "provider-dashboard.tsx");
  const icons = read("components", "provider-dashboard-icon.tsx");
  const sharedIcons = read("components", "ui-icon.tsx");
  const sectionNames = ["projects", "overview", "bookings", "opportunities", "calendar", "messages", "revenue", "services", "profile", "marketing", "locations", "availability", "reviews", "team", "billing", "settings"];

  for (const section of sectionNames) {
    assert.match(dashboard, new RegExp(`section: "${section}"`));
    assert.match(sharedIcons, new RegExp(`case "${section}"`));
  }

  assert.match(dashboard, /<ProviderDashboardIcon name=\{item\.section\}/);
  assert.match(dashboard, /aria-label="Provider dashboard sections"[\s\S]*ProviderDashboardIcon/);
  assert.doesNotMatch(dashboard.slice(dashboard.indexOf("const dashboardNav"), dashboard.indexOf("const sectionsNeedingPageHeading")), /icon:\s*"[▦◷⌁▣✉$◇◉⌖□☆♙▤⚙]"/);
  assert.match(icons, /<UiIcon name=\{name\}/);
  assert.match(sharedIcons, /aria-hidden="true"/);
  assert.match(sharedIcons, /stroke="currentColor"/);
});
