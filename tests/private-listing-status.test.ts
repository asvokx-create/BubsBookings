import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("private listing status query is owner-scoped and excludes deleted records", async () => {
  const source = await read("lib/private-listing-status.ts");
  const query = source.match(/OWNER_LISTING_STATUS_SQL = `([\s\S]*?)`;/)?.[1];
  assert.ok(query);
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE provider_profiles(id text, user_id text, is_active boolean, age_verification_status text);
      CREATE TABLE provider_companies(id text, is_active boolean);
      CREATE TABLE services(slug text, provider_id text, company_id text, is_active boolean, age_verification_blocked boolean, provider_deleted_at timestamptz);
      INSERT INTO provider_profiles VALUES ('p1','owner1',true,'requires_input'),('p2','owner2',true,'verified');
      INSERT INTO provider_companies VALUES ('c1',true);
      INSERT INTO services VALUES ('private','p1','c1',false,true,null),('deleted','p1','c1',false,true,now()),('inactive-company','p1','missing',false,false,null);`);
    assert.equal((await db.query(query, ['private','owner1'])).rows.length, 1);
    assert.equal((await db.query(query, ['private','owner2'])).rows.length, 0);
    assert.equal((await db.query(query, ['private',''])).rows.length, 0);
    assert.equal((await db.query(query, ['missing','owner1'])).rows.length, 0);
    assert.equal((await db.query(query, ['deleted','owner1'])).rows.length, 0);
    assert.equal((await db.query<{company_is_active:boolean}>(query, ['inactive-company','owner1'])).rows[0].company_is_active, false);
  } finally { await db.close(); }
});

test("service route explains owner-only blockers without publishing or indexing private details", async () => {
  const [page, status, unavailable, notFound] = await Promise.all([
    read("app/services/[slug]/page.tsx"), read("lib/private-listing-status.ts"),
    read("app/services/[slug]/unavailable-listing.tsx"), read("app/services/[slug]/not-found.tsx"),
  ]);
  assert.match(page, /dynamic = "force-dynamic"/);
  assert.match(page, /session\?\.user\?\.id \? await getOwnerPrivateListingStatus\(slug, session.user.id\) : null/);
  assert.match(page, /if \(ownerStatus\) return <UnavailableListing ownerStatus=\{ownerStatus\} \/>;\s+notFound\(\)/);
  assert.match(page, /title: "Listing unavailable".*index: false, follow: false/);
  assert.match(status, /if \(!userId \|\| !isDatabaseConfigured\(\)\) return null/);
  assert.doesNotMatch(status, /UPDATE|INSERT|DELETE/);
  assert.match(status, /!reasons.length && !row.is_active/);
  assert.match(notFound, /return <UnavailableListing \/>/);
  assert.match(unavailable, /Only you can see these details/);
  assert.match(unavailable, /Review age verification/);
  assert.match(unavailable, /link may be incorrect/);
});

test("rendered public explanation never includes owner verification details or actions", async () => {
  const { createRequire } = await import("node:module");
  const { default: ts } = await import("typescript");
  const { default: vm } = await import("node:vm");
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const require = createRequire(import.meta.url);
  const source = await read("app/services/[slug]/unavailable-listing.tsx");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const testModule = { exports: {} as { default: React.ComponentType<{ownerStatus?: {reasons:string[];ageDetail:string|null}}> } };
  vm.runInNewContext(compiled, { module: testModule, exports: testModule.exports, require: (name: string) => name === "next/link" ? { default: "a" } : require(name) });
  const Component = testModule.exports.default;
  const publicHtml = renderToStaticMarkup(React.createElement(Component));
  assert.match(publicHtml, /This listing isn’t available/);
  assert.doesNotMatch(publicHtml, /age verification|Stripe|provider-eligibility|Only you can see/);
  const ownerHtml = renderToStaticMarkup(React.createElement(Component, {ownerStatus: {reasons: ["Complete age verification."], ageDetail: "Your age verification is under review."}}));
  assert.match(ownerHtml, /Complete age verification/);
  assert.match(ownerHtml, /under review/);
  assert.match(ownerHtml, /provider-eligibility/);
  assert.doesNotMatch(ownerHtml, /Book now|Copy link|QR code<\/button>/);
});
