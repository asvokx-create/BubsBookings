import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { loadHourlyBackend } from "./helpers/hourly-test-backend.ts";
type Project={id:string;version:number;status:string;totalSeconds:number};
type Backend={createHourlyProject(user:string,body:Record<string,unknown>):Promise<Project>;mutateHourlyProject(user:string,id:string,body:Record<string,unknown>):Promise<Project>;getHourlyProject(user:string,id:string):Promise<Project>};
const enabled=process.env.BOOKME_MIGRATION_TEST_DATABASE==="1";
test("PostgreSQL real locks serialize duplicate requests, competing timers, and final submission",{skip:!enabled},async()=>{
  const connectionString=process.env.DATABASE_URL;
  assert.ok(connectionString,"DATABASE_URL is required for opt-in database tests");
  const url=new URL(connectionString);
  assert.ok(["localhost","127.0.0.1","[::1]"].includes(url.hostname),"Database concurrency tests require a localhost disposable database");
  const schema=`hourly_concurrency_${randomUUID().replaceAll("-","")}`;
  const admin=new Pool({connectionString,max:1});
  let pool:Pool|undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool=new Pool({connectionString,max:8,options:`-c search_path=${schema},public -c statement_timeout=15000 -c lock_timeout=10000`});
    await pool.query(`
      CREATE TABLE "user" (id text PRIMARY KEY,name text NOT NULL);
      CREATE TABLE provider_profiles(id uuid PRIMARY KEY,user_id text NOT NULL REFERENCES "user"(id),business_name text NOT NULL,is_active boolean NOT NULL DEFAULT true,age_verification_status text NOT NULL DEFAULT 'verified');
      CREATE TABLE services(id uuid PRIMARY KEY,provider_id uuid NOT NULL REFERENCES provider_profiles(id),title text NOT NULL,hourly_rate_cents integer NOT NULL,pricing_type text NOT NULL DEFAULT 'HOURLY',delivery_type text NOT NULL DEFAULT 'REMOTE',is_active boolean NOT NULL DEFAULT true,provider_deleted_at timestamptz);
      CREATE TABLE bookings(id uuid PRIMARY KEY,payment_status text NOT NULL,price_cents integer NOT NULL,customer_total_cents integer NOT NULL);
      CREATE TABLE notifications(user_id text,type text,title text,message text,href text,dedupe_key text UNIQUE);
      CREATE TABLE account_restrictions(user_id text,status text,expires_at timestamptz);
      CREATE TABLE booking_events(booking_id uuid REFERENCES bookings(id),event_type text,metadata jsonb,created_at timestamptz DEFAULT now());
      INSERT INTO "user" VALUES('customer','Customer'),('other','Other Customer'),('provider','Provider');
      INSERT INTO provider_profiles(id,user_id,business_name) VALUES('00000000-0000-4000-8000-000000000001','provider','Service Co');
      INSERT INTO services(id,provider_id,title,hourly_rate_cents) VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Repair',6000);
    `);
    await pool.query(readFileSync("database/migrations/111_hourly_projects.sql","utf8"));
    const backend=loadHourlyBackend<Backend>(pool);
    const input={serviceId:"00000000-0000-4000-8000-000000000002",description:"Complete the project",capMinutes:10,deliveryMethod:"REMOTE"};
    const creations=await Promise.all(Array.from({length:4},()=>backend.createHourlyProject("customer",input)));
    assert.equal(new Set(creations.map(p=>p.id)).size,1,"parallel create retries create one project");
    let first=await backend.mutateHourlyProject("provider",creations[0].id,{action:"accept",version:creations[0].version});
    let second=await backend.createHourlyProject("other",input);
    second=await backend.mutateHourlyProject("provider",second.id,{action:"accept",version:second.version});
    const starts=await Promise.allSettled([first,second].map(p=>backend.mutateHourlyProject("provider",p.id,{action:"start",version:p.version})));
    assert.equal(starts.filter(r=>r.status==="fulfilled").length,1,"provider lock permits exactly one running timer across projects");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM hourly_time_entries WHERE ended_at IS NULL")).rows[0].count,1);
    const winnerIndex=starts.findIndex(r=>r.status==="fulfilled");
    let winner=await backend.getHourlyProject("provider",[first,second][winnerIndex].id);
    // Move server-owned timestamp in isolated fixture, avoiding wall-clock sleeps.
    await pool.query("UPDATE hourly_time_entries SET started_at=clock_timestamp()-interval '90 seconds' WHERE project_id=$1 AND ended_at IS NULL",[winner.id]);
    winner=await backend.mutateHourlyProject("provider",winner.id,{action:"stop",version:winner.version});
    assert.ok(winner.totalSeconds>=90);
    const submissions=await Promise.allSettled(Array.from({length:4},()=>backend.mutateHourlyProject("provider",winner.id,{action:"submit",version:winner.version})));
    assert.equal(submissions.filter(r=>r.status==="fulfilled").length,1,"duplicate final submissions cannot create multiple versions");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM hourly_project_audit WHERE project_id=$1 AND action='submit'",[winner.id])).rows[0].count,1);
    first=await backend.getHourlyProject("provider",winner.id);
    assert.equal(first.status,"submitted");
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
