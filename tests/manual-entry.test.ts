import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseManualClient } from "../lib/manual-client.ts";
import { parseManualJob, MANUAL_JOB_PREFIX } from "../lib/manual-job.ts";

test("manual clients normalize contact fields without granting marketing consent", () => {
  assert.deepEqual(parseManualClient({name:" Jane Doe ",email:"JANE@EXAMPLE.COM",phone:"(425) 555-0100",notes:"Regular client",lawfulBasis:true}),{name:"Jane Doe",email:"jane@example.com",phone:"4255550100",notes:"Regular client"});
});
test("name-only clients work; invalid input and missing permission fail", () => {
  assert.equal(parseManualClient({name:"Jane",lawfulBasis:true}).name,"Jane");
  for (const body of [null,{}, {name:"Jane"},{name:"Jane",lawfulBasis:true,email:"bad"},{name:"Jane",lawfulBasis:true,phone:"123"},{name:"x".repeat(201),lawfulBasis:true}]) assert.throws(()=>parseManualClient(body));
});
test("manual jobs keep an explicit external prefix and offset-aware times", () => {
  const job=parseManualJob({title:" Driveway job ",startsAt:"2026-11-14T10:00:00-08:00",endsAt:"2026-11-14T12:00:00-08:00"},new Date("2026-11-13T12:00Z"));
  assert.equal(job.reason,MANUAL_JOB_PREFIX+"Driveway job");assert.equal(job.startsAt.toISOString(),"2026-11-14T18:00:00.000Z");
});
test("invalid, reversed, timezone-less and overly long jobs fail", () => {
  for (const body of [null,{}, {title:"Job",startsAt:"2026-11-14T10:00",endsAt:"2026-11-14T12:00"},{title:"Job",startsAt:"2026-11-14T10:00Z",endsAt:"2026-11-14T09:00Z"},{title:"Job",startsAt:"2026-11-14T10:00Z",endsAt:"2027-11-14T09:00Z"},{title:"<Job>",startsAt:"2026-11-14T10:00Z",endsAt:"2026-11-14T12:00Z"}]) assert.throws(()=>parseManualJob(body));
});
const source=(path:string)=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
test("client writes stay provider-scoped, duplicate-safe and communication-free",()=>{
  const route=source("app/api/providers/manual-clients/route.ts");
  assert.match(route,/getMarketingAccess\("clients"\)/);assert.match(route,/access.providerId/);assert.match(route,/ON CONFLICT DO NOTHING/);assert.match(route,/false,\$6,'Manual entry'/);assert.doesNotMatch(route,/send.*Email|INSERT INTO "user"/);
});
test("external jobs serialize with booking writes and check all availability sources",()=>{
  const route=source("app/api/providers/manual-jobs/route.ts");
  assert.match(route,/access\?\.isOwner/);assert.match(route,/pg_advisory_xact_lock\(hashtext\(\$1\)\)/);assert.match(route,/b.status='confirmed'/);assert.match(route,/provider_time_off/);assert.match(route,/provider_calendly_events/);assert.match(route,/last_sync_succeeded_at/);assert.match(route,/provider_id::text=\$2/);assert.match(route,/starts_with\(reason,\$3\)/);assert.doesNotMatch(route,/INSERT INTO bookings|stripe|send.*Email/);
});
test("calendar retains overnight jobs and manual date/time inputs are independent",()=>{
  const calendar=source("components/booking-calendar.tsx");
  assert.match(calendar,/startsAt < range.end && endsAt > range.start/);
  const form=source("components/manual-job-form.tsx");
  assert.match(form,/value=\{startDate\} onChange=\{setStartDate\}/);
  assert.match(form,/value=\{startTime\} onChange=\{setStartTime\}/);
});

test("manual jobs reject dates outside the visible calendar window",()=>{
  for(const startsAt of ["2025-01-01T10:00:00Z","2029-01-01T10:00:00Z"]) assert.throws(()=>parseManualJob({title:"Job",startsAt,endsAt:new Date(+new Date(startsAt)+3600000).toISOString()},new Date("2026-11-13T12:00Z")),/stays visible/);
});
