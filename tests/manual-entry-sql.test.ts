import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const source=(path:string)=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const owner="10000000-0000-0000-0000-000000000001", other="20000000-0000-0000-0000-000000000002";

test("manual contact SQL preserves provider isolation and duplicate contacts",async()=>{
 const db=new PGlite();
 try {
  await db.exec(`CREATE TABLE provider_profiles(id uuid PRIMARY KEY); CREATE TABLE "user"(id text PRIMARY KEY);
  CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END; $$;
  INSERT INTO provider_profiles VALUES('${owner}'),('${other}'); INSERT INTO "user" VALUES('user');`);
  await db.exec(source("database/migrations/092_provider_customer_imports.sql"));
  const sql=source("app/api/providers/manual-clients/route.ts").match(/database.query<\{ id: string \}>\(`([\s\S]*?)`,/)?.[1];assert.ok(sql);
  const insert=(provider:string,email:string)=>db.query(sql,[provider,"Jane",email,"4255550100","Regular client","user"]);
  assert.equal((await insert(owner,"jane@example.com")).rows.length,1);
  assert.equal((await insert(owner,"jane@example.com")).rows.length,0);
  assert.equal((await insert(owner,"other@example.com")).rows.length,0);
  assert.equal((await insert(other,"jane@example.com")).rows.length,1);
  const rows=await db.query<{marketing_consent:boolean;source_file_name:string}>("SELECT marketing_consent,source_file_name FROM provider_imported_customers");
  assert.ok(rows.rows.every(row=>row.marketing_consent===false&&row.source_file_name==="Manual entry"));
 } finally {await db.close();}
});

test("manual job SQL blocks overlapping sources, allows adjacent jobs, and isolates deletion",async()=>{
 const db=new PGlite();
 try {
  await db.exec(`CREATE TABLE provider_time_off(id uuid DEFAULT gen_random_uuid(),provider_id uuid,team_member_id uuid,starts_at timestamptz,ends_at timestamptz,reason text);
  CREATE TABLE bookings(id uuid,provider_id uuid,status text,starts_at timestamptz,ends_at timestamptz,assigned_team_member_id uuid);
  CREATE TABLE booking_assignees(booking_id uuid,is_owner boolean);
  CREATE TABLE provider_calendly_connections(id uuid,provider_id uuid,disconnected_at timestamptz,block_conflicting_bookings boolean,last_sync_succeeded_at timestamptz,last_sync_error text);
  CREATE TABLE provider_calendly_events(connection_id uuid,status text,starts_at timestamptz,ends_at timestamptz);`);
  const route=source("app/api/providers/manual-jobs/route.ts");
  const check=route.match(/const conflicts = await client.query\(`([\s\S]*?)`,/)?.[1];assert.ok(check);
  const insert=route.match(/const result = await client.query<\{ id: string \}>\(`([\s\S]*?)`,/)?.[1];assert.ok(insert);
  const remove=route.match(/const result = await database.query\(`([\s\S]*?)`,/)?.[1];assert.ok(remove);
  const from="2026-11-14T18:00:00Z",to="2026-11-14T20:00:00Z";
  assert.equal((await db.query(check,[owner,from,to])).rows.length,0);
  const job=await db.query<{id:string}>(insert,[owner,from,to,"External job: Driveway"]);
  assert.equal((await db.query(check,[owner,from,to])).rows.length,1);
  assert.equal((await db.query(check,[owner,to,"2026-11-14T21:00:00Z"])).rows.length,0);
  assert.equal((await db.query(check,[other,from,to])).rows.length,0);
  assert.equal((await db.query(remove,[job.rows[0].id,other,"External job: "])).rows.length,0);
  assert.equal((await db.query(remove,[job.rows[0].id,owner,"External job: "])).rows.length,1);
  await db.query("INSERT INTO bookings VALUES($1,$2,'confirmed',$3,$4,NULL)",[other,owner,from,to]);
  assert.equal((await db.query(check,[owner,from,to])).rows.length,1);
  await db.exec("DELETE FROM bookings");
  await db.query("INSERT INTO provider_calendly_connections VALUES($1,$2,NULL,true,now(),NULL)",[other,owner]);
  await db.query("INSERT INTO provider_calendly_events VALUES($1,'active',$2,$3)",[other,from,to]);
  assert.equal((await db.query(check,[owner,from,to])).rows.length,1);
  await db.exec("DELETE FROM provider_calendly_events; UPDATE provider_calendly_connections SET last_sync_succeeded_at=NULL");
  assert.equal((await db.query(check,[owner,from,to])).rows.length,1);
 } finally {await db.close();}
});
