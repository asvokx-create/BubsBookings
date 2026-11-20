import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";

const migration = readFileSync("database/migrations/119_calendly_call_slot_holds.sql", "utf8");
const provider="00000000-0000-0000-0000-000000000001", call="00000000-0000-0000-0000-000000000002", other="00000000-0000-0000-0000-000000000003", booking="00000000-0000-0000-0000-000000000004", member="00000000-0000-0000-0000-000000000005";
const schemaSql=`CREATE TABLE provider_profiles(id uuid PRIMARY KEY);
 CREATE TABLE calendly_calls(id uuid PRIMARY KEY,provider_id uuid,external_event_uri text,payment_booking_id uuid,ends_at timestamptz DEFAULT '2027-01-01T11:00Z',state text DEFAULT 'confirmed',version integer DEFAULT 1,updated_at timestamptz);
 CREATE TABLE bookings(id uuid PRIMARY KEY,provider_id uuid,starts_at timestamptz,ends_at timestamptz,status text);
 CREATE TABLE booking_assignees(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),booking_id uuid REFERENCES bookings(id),team_member_id uuid,is_owner boolean);
 CREATE TABLE provider_time_off(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),provider_id uuid,team_member_id uuid,starts_at timestamptz,ends_at timestamptz);
 CREATE TABLE provider_calendly_connections(id uuid PRIMARY KEY,provider_id uuid,disconnected_at timestamptz,block_conflicting_bookings boolean);
 CREATE TABLE provider_calendly_events(connection_id uuid,external_event_uri text,status text,starts_at timestamptz,ends_at timestamptz);
 INSERT INTO provider_profiles VALUES('${provider}'); INSERT INTO calendly_calls(id,provider_id,external_event_uri) VALUES('${call}','${provider}',NULL),('${other}','${provider}',NULL);`;
const hold=`INSERT INTO calendly_call_slot_holds(call_id,provider_id,starts_at,ends_at) VALUES('${call}','${provider}','2027-01-01T10:00Z','2027-01-01T11:00Z')`;
const native=`INSERT INTO bookings VALUES('${booking}','${provider}','2027-01-01T10:30Z','2027-01-01T11:30Z','confirmed')`;
const block=`INSERT INTO provider_time_off(provider_id,starts_at,ends_at) VALUES('${provider}','2027-01-01T10:30Z','2027-01-01T11:30Z')`;

test("call holds serialize native booking/timeoff writers, preserve repeat migration, allow adjacent slots", async()=>{
 const db=new PGlite();try{
 await db.exec(schemaSql);await db.exec(migration);await db.exec(hold);await db.exec(migration);
 await assert.rejects(db.exec(native), /conflicts with a reserved call/);
 await assert.rejects(db.exec(block), /conflicts with a reserved call/);
 await assert.rejects(db.exec(`INSERT INTO calendly_call_slot_holds(call_id,provider_id,starts_at,ends_at) VALUES('${other}','${provider}','2027-01-01T10:59Z','2027-01-01T12:00Z')`),/conflicts/);
 await db.exec(`INSERT INTO calendly_call_slot_holds(call_id,provider_id,starts_at,ends_at) VALUES('${other}','${provider}','2027-01-01T11:00Z','2027-01-01T12:00Z')`);
 assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM calendly_call_slot_holds")).rows[0].n,2);
 await db.exec(`UPDATE calendly_call_slot_holds SET released_at=now()`);await db.exec(native);
 await assert.rejects(db.exec(`UPDATE calendly_call_slot_holds SET released_at=NULL WHERE call_id='${call}'`),/cannot reactivate/);
 }finally{await db.close();}
});

test("confirmed native booking and owner block deny hold; known team-only booking does not",async()=>{
 const db=new PGlite();try{
 await db.exec(schemaSql);await db.exec(migration);await db.exec(native);
 await assert.rejects(db.exec(hold),/conflicts/);
 await db.exec(`INSERT INTO booking_assignees(booking_id,team_member_id,is_owner) VALUES('${booking}','${member}',false)`);await db.exec(hold);
 await assert.rejects(db.exec(`UPDATE booking_assignees SET is_owner=true,team_member_id=NULL WHERE booking_id='${booking}'`),/assignment conflicts/);
 await assert.rejects(db.exec(`DELETE FROM booking_assignees WHERE booking_id='${booking}'`),/assignment conflicts/);
 await db.exec(`INSERT INTO bookings VALUES('${other}','${provider}','2027-01-02T10:30Z','2027-01-02T11:30Z','confirmed')`);
 await assert.rejects(db.exec(`UPDATE booking_assignees SET booking_id='${other}' WHERE booking_id='${booking}'`),/assignment conflicts/);
 await db.exec(`UPDATE calendly_call_slot_holds SET released_at=now();`);await db.exec(block);
 await assert.rejects(db.exec(`INSERT INTO calendly_call_slot_holds(call_id,provider_id,starts_at,ends_at) VALUES('${other}','${provider}','2027-01-01T10:30Z','2027-01-01T11:30Z')`),/conflicts/);
 }finally{await db.close();}
});

test("only exact same-call native and verified external mapping may bypass own hold",async()=>{
 const db=new PGlite();try{
 await db.exec(schemaSql);await db.exec(migration);await db.exec(hold);
 await db.exec(`BEGIN; UPDATE calendly_call_slot_holds SET native_booking_id='${booking}' WHERE call_id='${call}'; ${native}; INSERT INTO booking_assignees(booking_id,is_owner) VALUES('${booking}',true); COMMIT;`);
 await assert.rejects(db.exec(`UPDATE bookings SET status='cancelled' WHERE id='${booking}'`),/coordinated cancellation/);
 await assert.rejects(db.exec(`UPDATE bookings SET starts_at=starts_at+interval '1 hour' WHERE id='${booking}'`),/coordinated cancellation/);
 await assert.rejects(db.exec(`UPDATE bookings SET status='completed' WHERE id='${booking}'`),/scheduled end/);
 await db.exec(`UPDATE calendly_calls SET ends_at=now()-interval '1 minute' WHERE id='${call}'; UPDATE bookings SET status='completed' WHERE id='${booking}'`);
 assert.equal((await db.query<{ state: string }>(`SELECT state FROM calendly_calls WHERE id='${call}'`)).rows[0].state,'completed');
 await assert.rejects(db.exec(`UPDATE calendly_call_slot_holds SET native_booking_id=NULL WHERE call_id='${call}'`),/mapping cannot change/);
 await assert.rejects(db.exec(`INSERT INTO bookings VALUES(gen_random_uuid(),'${provider}','2027-01-01T10:30Z','2027-01-01T10:45Z','confirmed')`),/conflicts/);
 await db.exec(`INSERT INTO provider_calendly_connections VALUES('${provider}','${provider}',NULL,true);
 INSERT INTO provider_calendly_events VALUES('${provider}','https://api.calendly.com/scheduled_events/mapped','active','2027-01-01T10:00Z','2027-01-01T11:00Z');`);
 await assert.rejects(db.exec(`UPDATE calendly_call_slot_holds SET starts_at=starts_at WHERE call_id='${call}'`),/conflicts/);
 await db.exec(`UPDATE calendly_calls SET external_event_uri='https://api.calendly.com/scheduled_events/mapped' WHERE id='${call}'; UPDATE calendly_call_slot_holds SET starts_at=starts_at WHERE call_id='${call}';`);
 }finally{await db.close();}
});

test("PostgreSQL concurrent native and call reservations cannot both commit",{skip:process.env.BOOKME_MIGRATION_TEST_DATABASE!=="1"},async()=>{
 const connectionString=process.env.DATABASE_URL;assert.ok(connectionString);
 assert.ok(["localhost","127.0.0.1","[::1]"].includes(new URL(connectionString).hostname),"Only isolated loopback databases are allowed");
 const schema=`call_conflicts_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString,max:1});let pool:Pool|undefined;
 try{await admin.query(`CREATE SCHEMA "${schema}"`);pool=new Pool({connectionString,max:4,options:`-c search_path=${schema},public -c statement_timeout=10000 -c lock_timeout=8000`});await pool.query(schemaSql);await pool.query(migration);
 for(const conflicting of [native,block]){
  await pool.query("DELETE FROM calendly_call_slot_holds; DELETE FROM booking_assignees; DELETE FROM bookings; DELETE FROM provider_time_off");
  const a:PoolClient=await pool.connect(),b:PoolClient=await pool.connect();try{
   await a.query("BEGIN");await a.query(hold);await b.query("BEGIN");
   const waiting:Promise<boolean>=b.query(conflicting).then(()=>true,()=>false);
   await new Promise(resolve=>setTimeout(resolve,40));await a.query("COMMIT");
   assert.equal(await waiting,false,"native write must observe the committed hold after waiting for shared lock");await b.query("ROLLBACK");
  }finally{a.release();b.release();}
 }
 }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}
});

test("slot acquisition is disabled by default and validates bounds before querying",async()=>{
 const {acquireCallSlot}=await import("../lib/calendly-call-conflicts.ts");
 const previous=process.env.CALENDLY_CALL_BOOKINGS_ENABLED;
 const calls:string[]=[];
 const client={query:async(sql:string)=>{calls.push(sql);return {rows:[],rowCount:1};}} as unknown as Parameters<typeof acquireCallSlot>[0];
 const slot={callId:call,providerId:provider,startsAt:"2027-01-01T10:00Z",endsAt:"2027-01-01T11:00Z"};
 try{
 delete process.env.CALENDLY_CALL_BOOKINGS_ENABLED;
 await assert.rejects(acquireCallSlot(client,slot),/not enabled/);assert.equal(calls.length,0);
 process.env.CALENDLY_CALL_BOOKINGS_ENABLED="true";
 await assert.rejects(acquireCallSlot(client,{...slot,endsAt:slot.startsAt}),/Invalid call interval/);assert.equal(calls.length,0);
 await acquireCallSlot(client,slot);assert.match(calls[0],/pg_advisory_xact_lock/);assert.match(calls[1],/released_at IS NULL/);
 }finally{if(previous===undefined)delete process.env.CALENDLY_CALL_BOOKINGS_ENABLED;else process.env.CALENDLY_CALL_BOOKINGS_ENABLED=previous;}
});
