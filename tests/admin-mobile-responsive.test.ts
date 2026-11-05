import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const projectRoot = process.cwd();
const read = (...parts: string[]) => readFileSync(join(projectRoot, ...parts), "utf8");

test("admin mobile navigation exposes every dashboard and route section without a wide tab strip", () => {
  const dashboard = read("components", "admin-dashboard.tsx");
  const css = read("app", "globals.css");

  assert.match(dashboard, /aria-expanded=\{mobileNavOpen\}/);
  assert.match(dashboard, /aria-controls="admin-mobile-menu"/);
  assert.match(dashboard, /All sections/);
  assert.match(dashboard, /aria-current=\{section === item\.id \? "page" : undefined\}/);
  assert.match(dashboard, /xl:grid-cols-\[240px_minmax\(0,1fr\)\]/);
  assert.match(dashboard, /admin-nav-shell min-w-0 overflow-x-hidden/);
  assert.match(dashboard, /xl:max-h-\[calc\(100dvh-2rem\)\] xl:overflow-y-auto/);
  assert.match(dashboard, /xl:hidden/);
  assert.match(dashboard, /aria-label="Admin account actions"/);
  assert.match(dashboard, /aria-label="Admin tools"/);
  assert.match(dashboard, /admin-header-shell dashboard-container flex flex-nowrap items-center justify-between/);
  assert.match(dashboard, /flex min-w-0 flex-1 flex-nowrap items-center justify-end/);
  assert.doesNotMatch(dashboard, /mobile-scroll-row/);
  assert.match(dashboard, /className="admin-header-link hidden/);
  assert.match(css, /\.admin-header-link \{[^}]*background: #eef3ec;/);
  assert.match(css, /\.admin-marketplace-link \{[^}]*background: #123d2e;[^}]*color: #fff;/);

  for (const href of ["/admin/reported-bugs", "/admin/disputes", "/admin/support", "/admin/operations", "/admin/expenses", "/account"]) {
    assert.match(dashboard, new RegExp(`href="${href.replaceAll("/", "\\/")}"`));
  }
});

test("admin actions, dialogs, and long records remain usable at phone widths", () => {
  const dashboard = read("components", "admin-dashboard.tsx");
  const issues = read("components", "admin-issue-queue.tsx");
  const support = read("components", "admin-support-queue.tsx");
  const css = read("app", "globals.css");

  assert.ok((dashboard.match(/admin-action-row/g) ?? []).length >= 4);
  assert.match(issues, /admin-action-row/);
  assert.match(support, /admin-action-row/);
  assert.match(css, /\.admin-action-row > :where\(a, button\)/);
  assert.match(css, /min-height: 2\.75rem/);
  assert.match(dashboard, /h-\[100dvh\]/);
  assert.match(dashboard, /max-h-\[calc\(100dvh-1\.5rem\)\]/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
});

test("admin support requests are separated into unresolved and resolved tabs", () => {
  const support = read("components", "admin-support-queue.tsx");

  assert.match(support, /useState<"unresolved" \| "resolved">\("unresolved"\)/);
  assert.match(support, /item\.status !== "resolved"/);
  assert.match(support, /item\.status === "resolved"/);
  assert.match(support, /role="tablist"/);
  assert.match(support, /Unresolved \(\{unresolvedSupport\.length\}\)/);
  assert.match(support, /Resolved \(\{resolvedSupport\.length\}\)/);
  assert.match(support, /visibleSupport\.map/);
  assert.match(support, />Reopen<\/button>/);
  assert.match(support, /No unresolved support requests\./);
  assert.match(support, /No resolved support requests yet\./);
});

test("account details drawer renders above the dashboard and public page layers", () => {
  const dashboard = read("components", "admin-dashboard.tsx");

  assert.match(dashboard, /import \{ createPortal \} from "react-dom"/);
  assert.match(dashboard, /fixed inset-0 z-\[600\]/);
  assert.match(dashboard, /createPortal\(dialog, document\.body\)/);
});

test("complex admin tables scroll inside their own accessible containers", () => {
  const operations = read("app", "admin", "operations", "page.tsx");

  assert.equal((operations.match(/admin-table-scroll/g) ?? []).length, 2);
  assert.equal((operations.match(/role="region"/g) ?? []).length, 2);
  assert.equal((operations.match(/tabIndex=\{0\}/g) ?? []).length, 2);
  assert.equal((operations.match(/overflow-x-auto/g) ?? []).length, 2);
  assert.match(operations, /overflow-x-clip/);
});

test("admin authorization remains enforced by the server layout", () => {
  const layout = read("app", "admin", "layout.tsx");

  assert.match(layout, /await getAdminSession\(\)/);
  assert.match(layout, /if \(!session\) redirect\("\/login\?redirect=\/admin"\)/);
});
