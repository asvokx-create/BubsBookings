import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describeHourlyListingEstimate, parseHourlyEstimateInputs, parseHourlyListingEstimate, resolveHourlyListingEstimate } from "../lib/hourly-listing-estimate.ts";

const source = (path: string) => readFileSync(path, "utf8");

test("optional estimates require a valid ordered pair and never inherit the old two-hour minimum", () => {
  assert.deepEqual(parseHourlyEstimateInputs("", ""), { estimatedMinMinutes: null, estimatedMaxMinutes: null });
  assert.deepEqual(parseHourlyEstimateInputs("60", "120"), { estimatedMinMinutes: 60, estimatedMaxMinutes: 120 });
  assert.deepEqual(parseHourlyEstimateInputs("10", "10"), { estimatedMinMinutes: 10, estimatedMaxMinutes: 10 });
  for (const [shorter, longer] of [[null, 120],[60,null],[120,60],[0,120],[1,60001],[1.5,120],["60",120],[NaN,120],[1,Infinity]]) {
    assert.throws(() => parseHourlyListingEstimate(shorter, longer), /estimated durations/);
  }
  assert.equal(resolveHourlyListingEstimate({}, true), undefined);
  assert.deepEqual(resolveHourlyListingEstimate({estimatedMinMinutes:null,estimatedMaxMinutes:null}, true), { estimatedMinMinutes:null,estimatedMaxMinutes:null });
  assert.deepEqual(resolveHourlyListingEstimate({estimatedMinMinutes:60,estimatedMaxMinutes:120}, false), { estimatedMinMinutes:null,estimatedMaxMinutes:null });
});

test("display estimates base labor from minutes and hourly rate, with no estimate for old/invalid records", () => {
  assert.deepEqual(describeHourlyListingEstimate({ estimatedMinMinutes:60, estimatedMaxMinutes:120 }, 7500), { duration:"1h–2h", labor:"$75.00–$150.00" });
  assert.deepEqual(describeHourlyListingEstimate({ estimatedMinMinutes:90, estimatedMaxMinutes:90 }, 12345), { duration:"1h 30m", labor:"$185.18" });
  assert.equal(describeHourlyListingEstimate({ estimatedMinMinutes:null, estimatedMaxMinutes:null }, 7500),null);
  assert.equal(describeHourlyListingEstimate({ estimatedMinMinutes:120, estimatedMaxMinutes:60 }, 7500),null);
});

test("real listing SQL can create, load, edit, preserve, and clear estimates on disposable PostgreSQL", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE services (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, provider_id text, company_id text, location_id uuid,
      business_name text, slug text, category text, delivery_type text, remote_delivery_details text,
      title text, description text, price_cents integer, duration_minutes integer, city text, state text, latitude float, longitude float,
      pricing_type text NOT NULL, hourly_rate_cents integer, minimum_duration_minutes integer, maximum_duration_minutes integer,
      billing_increment_minutes integer, default_duration_minutes integer, is_active boolean, age_verification_blocked boolean,
      booking_questions jsonb, service_kind text, preparation_notes text, recurrence_options text[]
    );
    INSERT INTO services(pricing_type,minimum_duration_minutes,default_duration_minutes) VALUES ('HOURLY',120,120),('FIXED',NULL,NULL);`);
    const migration=source("database/migrations/120_hourly_listing_estimates.sql");
    await db.exec(migration);
    await db.exec(migration);
    const list=()=>db.query<{pricing_type:string; minimum_duration_minutes:number|null; estimated_min_minutes:number|null; estimated_max_minutes:number|null}>(`SELECT pricing_type,minimum_duration_minutes,estimated_min_minutes,estimated_max_minutes FROM services ORDER BY id`);
    assert.deepEqual((await list()).rows,[{pricing_type:"HOURLY",minimum_duration_minutes:120,estimated_min_minutes:null,estimated_max_minutes:null},{pricing_type:"FIXED",minimum_duration_minutes:null,estimated_min_minutes:null,estimated_max_minutes:null}]);
    const insert=source("app/api/providers/onboarding/route.ts").match(/`(INSERT INTO services \([\s\S]+?RETURNING id::text)`/)?.[1];
    const update=source("app/api/providers/services/[serviceId]/route.ts").match(/`(UPDATE services\s+SET business_name[\s\S]+?WHERE id::text = \$15)`/)?.[1];
    assert.ok(insert); assert.ok(update);
    const params=["p","co",null,"B","slug","Category","REMOTE","","Title","Description",7500,120,"City","WA",0,0,"HOURLY",7500,120,480,30,120,true,false];
    const id=(await db.query<{id:string}>(insert,[...params,60,120])).rows[0].id;
    const noEstimateId=(await db.query<{id:string}>(insert,[...params,null,null])).rows[0].id;
    const row=async(id:string)=>(await db.query<{estimated_min_minutes:number|null;estimated_max_minutes:number|null;minimum_duration_minutes:number|null}>("SELECT estimated_min_minutes,estimated_max_minutes,minimum_duration_minutes FROM services WHERE id::text=$1",[id])).rows[0];
    assert.deepEqual(await row(id),{estimated_min_minutes:60,estimated_max_minutes:120,minimum_duration_minutes:120});
    assert.deepEqual(await row(noEstimateId),{estimated_min_minutes:null,estimated_max_minutes:null,minimum_duration_minutes:120});
    const edit=["B","Title","Category","REMOTE","","Description",7500,120,"[]",null,null,null,null,null,id,"standard","",["one_time"],"HOURLY",7500,120,480,30,120];
    await db.query(update,[...edit,true,30,90]);
    assert.deepEqual(await row(id),{estimated_min_minutes:30,estimated_max_minutes:90,minimum_duration_minutes:120});
    await db.query(update,[...edit,false,null,null]);
    assert.deepEqual(await row(id),{estimated_min_minutes:30,estimated_max_minutes:90,minimum_duration_minutes:120});
    await db.query(update,[...edit,true,null,null]);
    assert.deepEqual(await row(id),{estimated_min_minutes:null,estimated_max_minutes:null,minimum_duration_minutes:120});
    await db.query(update,[...edit,true,30,90]);
    const fixedEdit=[...edit.slice(0,18),"FIXED",null,null,null,null,null];
    await db.query(update,[...fixedEdit,true,null,null]);
    assert.deepEqual(await row(id),{estimated_min_minutes:null,estimated_max_minutes:null,minimum_duration_minutes:null});
    await assert.rejects(db.query("UPDATE services SET estimated_min_minutes=30,estimated_max_minutes=90 WHERE id::text=$1",[id]),/check constraint/);
    await assert.rejects(db.query("UPDATE services SET estimated_min_minutes=30 WHERE id=1"),/check constraint/);
    await assert.rejects(db.query("UPDATE services SET estimated_min_minutes=90,estimated_max_minutes=30 WHERE id=1"),/check constraint/);
  } finally { await db.close(); }
});

test("both forms wire the optional fields; initial example rate does not trigger an invalid-rate warning", () => {
  const join=source("app/providers/join/onboarding-form.tsx");
  const edit=source("app/provider/services/[serviceId]/edit/listing-editor.tsx");
  for (const form of [join,edit]) {
    assert.match(form,/HourlyEstimateFields shorter=\{estimateShorter\}/);
    assert.match(form,/parseHourlyEstimateInputs\(estimateShorter, estimateLonger\)/);
    assert.match(form,/JSON.stringify\(\{[^\n]*\.\.\.estimate/);
  }
  assert.match(join,/placeholder="e.g. 75.00"/);
  assert.match(join,/price\.trim\(\) !== "" && hourlyPreview === null/);
  assert.match(join,/if \(hourlyPreview === null\) \{ setError\("Enter a valid hourly rate/);
  assert.match(edit,/setEstimateShorter\(result.estimatedMinMinutes == null \? ""/);
  assert.match(source("app/api/providers/services/[serviceId]/route.ts"),/estimatedMinMinutes: service\.estimated_min_minutes/);
});

test("public listing discloses fee separately and does not imply a guaranteed total; billing logic unchanged", () => {
  const page=source("app/services/[slug]/page.tsx");
  assert.match(page,/service\.pricingType === "HOURLY" \? describeHourlyListingEstimate/);
  assert.match(page,/hourlyEstimate && <section/);
  assert.match(page,/Estimated labor:/);
  assert.match(page,/Plus one \$2\.99 BubsBookings service fee at final payment/);
  assert.match(page,/not a minimum purchase, required work limit, or guaranteed total/);
  for (const path of ["components/provider-dashboard.tsx", "components/admin-dashboard.tsx", "app/admin/listings/[serviceId]/page.tsx"]) {
    const text=source(path);
    assert.doesNotMatch(text,/formatDurationMinutes\((?:service|listing)\.(?:minimumDurationMinutes|minimum_duration_minutes)/);
    assert.match(text,/tracked project|Tracked hourly project/);
  }
  assert.doesNotMatch(source("lib/hourly-projects.ts"),/estimated_min_minutes|estimated_max_minutes/);
  assert.doesNotMatch(source("lib/hourly-project-checkout.ts"),/estimated_min_minutes|estimated_max_minutes/);
});

test("maximum estimated time filter uses the stated upper bound and excludes unknown estimates only while filtering", async () => {
  const text=source("lib/marketplace.ts");
  const branch=text.match(/if \(options\.maxDuration[^\n]*\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(branch, "duration predicate is appended only for an explicit filter");
  const predicate=branch.match(/conditions\.push\(`([^\n]+)`\)/)?.[1]?.replace("$${values.length}","$1");
  assert.ok(predicate);
  assert.doesNotMatch(predicate,/default_duration_minutes/);
  const db=new PGlite();
  try {
    await db.exec(`CREATE TABLE services (id text, pricing_type text, duration_minutes integer, default_duration_minutes integer, estimated_min_minutes integer, estimated_max_minutes integer);
    INSERT INTO services VALUES ('hourly-unknown','HOURLY',120,120,NULL,NULL),('hourly-short','HOURLY',120,120,30,59),('hourly-edge','HOURLY',120,120,30,60),('hourly-long','HOURLY',120,120,30,90),('fixed','FIXED',45,NULL,NULL,NULL),('quote','QUOTE_ONLY',60,NULL,NULL,NULL),('fixed-long','FIXED',90,NULL,NULL,NULL);`);
    const ids=async(filter?:number)=>(await db.query<{id:string}>(`SELECT id FROM services s ${filter===undefined?"":`WHERE ${predicate}`} ORDER BY id`,filter===undefined?[]:[filter])).rows.map(row=>row.id);
    assert.deepEqual(await ids(),["fixed","fixed-long","hourly-edge","hourly-long","hourly-short","hourly-unknown","quote"]);
    assert.deepEqual(await ids(60),["fixed","hourly-edge","hourly-short","quote"]);
    assert.deepEqual(await ids(59),["fixed","hourly-short"]);
  } finally { await db.close(); }
});
