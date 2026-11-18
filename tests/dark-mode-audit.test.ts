import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("dark accent text only changes when an accent background is active", () => {
  const css = read("app/globals.css");
  assert.match(css, /\[class~="bg-\[#eee25a\]"\]/);
  assert.doesNotMatch(css, /html\[data-theme="dark"\] :where\(\s*\[class\*="bg-\[#eee25a\]"\]/);
  assert.match(css, /\[class~="hover:bg-\[#eee25a\]"\][\s\S]*?\):hover/);
  assert.match(css, /\[class\^="bg-\[#faf"\]/);
  assert.match(css, /\[class\*=" bg-\[#faf"\]/);
  assert.doesNotMatch(css, /\[class\*="bg-\[#faf"\]/);
});

test("dark mode has explicit surfaces for the audited visual exceptions", () => {
  const css = read("app/globals.css");
  const home = read("app/page.tsx");
  const serviceCard = read("components/service-listing-card.tsx");
  const settings = read("app/account/settings/settings-form.tsx");
  for (const selector of [
    ".partners-hero",
    ".message-thread-surface",
    ".premium-service-card",
    ".premium-home",
    ".settings-theme-option",
    ".settings-secondary-action",
    ".settings-logout-action",
    ".trust-badge--verified",
    ".trust-badge--warning",
    ".partners-program-card",
    ".auth-page",
  ]) assert.match(css, new RegExp(selector.replace(".", "\\.")));

  assert.match(css, /:-webkit-autofill/);
  assert.match(css, /radial-gradient\(circle_at_85%_15%/);
  assert.match(read("app/partners/page.tsx"), /className="partners-hero /);
  assert.match(read("app/partners/page.tsx"), /className="partners-program-card /);
  assert.match(read("app/signup/page.tsx"), /className="auth-page /);
  assert.match(read("components/messaging-center.tsx"), /className="message-thread-surface /);
  assert.match(read("components/messaging-center.tsx"), /className="grid gap-3 border-b/);
  for (const className of ["premium-hero", "premium-provider"]) {
    assert.match(home, new RegExp(`className="${className}(?: |")`));
  }
  assert.match(serviceCard, /className="premium-service-card /);
  for (const className of ["settings-theme-option", "settings-secondary-action", "settings-logout-action"]) {
    assert.match(settings, new RegExp(className));
  }
  assert.match(read("app/services/[slug]/page.tsx"), /trust-badge--verified/);
  assert.match(read("components/brand-wordmark.tsx"), /text-\[\.9rem\] min-\[360px\]:text-\[1\.05rem\]/);
});

test("dark mode uses one neutral token system while preserving branded accents", () => {
  const css = read("app/globals.css");
  const dark = css.slice(css.indexOf('html[data-theme="dark"]'));
  const tokens = {
    background: "#0d0d0f",
    surface: "#171719",
    "surface-elevated": "#1b1b1e",
    card: "#1d1d20",
    "card-hover": "#242428",
    input: "#222226",
    "input-hover": "#29292e",
    "input-focus": "#26262b",
    border: "#38383e",
    "border-strong": "#505058",
    divider: "#2c2c31",
    "text-primary": "#f5f5f6",
    "text-secondary": "#d4d4d8",
    "text-muted": "#a6a6ad",
    link: "#8edaa7",
    "link-hover": "#b5e9c5",
    tooltip: "#28282d",
    modal: "#1b1b1e",
    success: "#78d698",
    warning: "#f0d66d",
    error: "#f09a8c",
    info: "#8fc7ff",
    "focus-ring": "#eee25a",
    skeleton: "#2b2b30",
  };
  for (const [name, value] of Object.entries(tokens)) {
    assert.match(dark, new RegExp(`--${name}: ${value}`));
  }
  assert.doesNotMatch(dark, /(?:background(?:-color)?|--(?:background|surface|card|input|modal|tooltip))\s*:[^;\n]*(?:#0d1813|#15251e|#101f18|#17372a|#172a21|#122219|#10241b|#162b21)/);
  assert.match(dark, /background-color: #246b42 !important/);
  assert.match(dark, /background-color: var\(--focus-ring\)|outline: 3px solid var\(--focus-ring\)/);
  assert.match(dark, /\.home-business-card a[\s\S]*?background-color: #fffef5 !important[\s\S]*?color: #183126 !important/);
  assert.match(dark, /\.pricing-hero aside[\s\S]*?background-color: var\(--card\) !important/);
  assert.match(dark, /\.partners-program-card[\s\S]*?background: linear-gradient\(145deg, #202024, #18181b\) !important/);
});

test("calendars, messages, charts, tables, dialogs, and footer use shared dark primitives", () => {
  const css = read("app/globals.css");
  for (const selector of [
    ".booking-calendar-day--available",
    ".booking-calendar-day--today",
    ".booking-calendar-day--selected",
    ".booking-calendar-day--disabled",
    ".calendar-event--blocked",
    ".message-bubble--sent",
    ".message-bubble--received",
    ".revenue-chart-grid",
    ".revenue-chart-line",
    ".admin-table-scroll",
    ".site-footer",
    '[role="tooltip"]',
  ]) assert.match(css, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.match(read("components/booking-date-picker.tsx"), /booking-calendar-day--selected/);
  assert.match(read("components/booking-calendar.tsx"), /calendar-view-toggle/);
  assert.match(read("components/messaging-center.tsx"), /message-bubble--sent/);
  assert.match(read("components/provider-dashboard.tsx"), /revenue-chart-line/);
  assert.match(read("components/service-category-icon.tsx"), /service-category-icon-decoration/);
  assert.match(css, /\.service-category-icon-decoration[\s\S]*?background-color: rgba\(255, 255, 255, \.2\) !important/);
  assert.match(css, /\.account-page > header[\s\S]*?border-color: transparent !important/);
  assert.match(css, /\.brand-wordmark-text[\s\S]*?padding: \.08em \.04em \.22em/);
});

test("search controls do not expose native or duplicate bright borders in dark mode", () => {
  const css = read("app/globals.css");
  assert.match(css, /input\[type="search"\][\s\S]*?appearance: none/);
  assert.match(css, /\.home-search-input input[\s\S]*?border-color: transparent !important[\s\S]*?box-shadow: none !important[\s\S]*?outline: none !important/);
  assert.match(css, /html\[data-theme="dark"\] \.home-search-input:focus-within[\s\S]*?var\(--brand\)/);
  assert.match(css, /html\[data-theme="dark"\] \.home-search-input input:focus-visible[\s\S]*?outline: none !important/);
  assert.match(css, /\.services-search-query-input,[\s\S]*?\.services-search-query-input:focus[\s\S]*?border-color: transparent !important[\s\S]*?box-shadow: none !important/);
  assert.match(css, /\.compact-radius-select,[\s\S]*?\.sort-control-select[\s\S]*?border-color: transparent !important[\s\S]*?box-shadow: none !important/);
});

test("dashboard secondary controls and client rows remain readable in dark mode", () => {
  const css = read("app/globals.css");
  const dashboard = read("components/provider-dashboard.tsx");
  const profile = read("components/provider-profile-editor.tsx");
  const billing = read("components/billing-panel.tsx");
  const clients = read("components/provider-customer-tools.tsx");
  const account = read("app/account/page.tsx");

  assert.match(css, /:where\(\.account-page, \.dashboard-page\)[\s\S]*?:where\(a, button\)\[class~="bg-white"\][\s\S]*?background-color: var\(--card-hover\) !important/);
  assert.match(css, /:where\(\.listing-share-trigger, \.date-picker-trigger\)[\s\S]*?color: var\(--text-primary\) !important/);
  assert.match(css, /\.dashboard-page table tbody tr[\s\S]*?background-color: var\(--card\) !important/);
  assert.match(css, /\.dashboard-page table tbody tr:hover[\s\S]*?background-color: var\(--card-hover\) !important/);

  for (const source of [dashboard, profile, billing, clients, account]) {
    assert.match(source, /bg-white/);
  }
});

test("provider settings and premium homepage media use restrained dark surfaces", () => {
  const css = read("app/globals.css");
  const dashboard = read("components/provider-dashboard.tsx");
  const home = read("app/page.tsx");
  const serviceCard = read("components/service-listing-card.tsx");
  const showcase = read("components/home-provider-showcase.tsx");

  assert.match(dashboard, /data-provider-settings-hub/);
  assert.match(css, /section\[data-provider-settings-hub\] \.grid > a[\s\S]*?background: var\(--bb-surface-muted\) !important/);
  assert.match(showcase, /home-provider-showcase\.module\.css/);
  assert.match(css, /html\[data-theme="dark"\] \.premium-home[\s\S]*?background: #0c110e/);
  assert.match(home, /ServiceListingCard/);
  assert.match(serviceCard, /className="premium-service-image"/);
  assert.match(css, /html\[data-theme="dark"\] \.premium-service-image img[\s\S]*?filter: brightness\(\.78\) saturate\(\.88\)/);
  assert.match(css, /html\[data-theme="dark"\] \.premium-service-card,[\s\S]*?background: #191d1b/);
});

test("dark palette pairs retain accessible text contrast", () => {
  const rgb = (hex: string) => hex.match(/[a-f\d]{2}/gi)!.map((part) => Number.parseInt(part, 16));
  const luminance = (hex: string) => {
    const [red, green, blue] = rgb(hex).map((value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const contrast = (foreground: string, background: string) => {
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };

  assert.ok(contrast("#eef5f0", "#0d1813") >= 7);
  assert.ok(contrast("#adbbb3", "#15251e") >= 4.5);
  assert.ok(contrast("#183126", "#eee25a") >= 4.5);
  assert.ok(contrast("#a9e3ba", "#19392a") >= 4.5);
  assert.ok(contrast("#f4df83", "#3a3217") >= 4.5);
  assert.ok(contrast("#f5f5f6", "#0d0d0f") >= 12);
  assert.ok(contrast("#d4d4d8", "#1d1d20") >= 7);
  assert.ok(contrast("#a6a6ad", "#1d1d20") >= 4.5);
  assert.ok(contrast("#ffffff", "#246b42") >= 4.5);
  assert.ok(contrast("#183126", "#eee25a") >= 4.5);
});
