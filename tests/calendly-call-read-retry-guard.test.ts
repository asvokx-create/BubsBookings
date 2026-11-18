import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {createCalendlyCallStore} from '../lib/calendly-call-store.ts';

test('transient read guard blocks completion and new payout until recovered; stale writes cannot reopen',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`CREATE TABLE "user"(id text PRIMARY KEY,name text,email text,"emailVerified" boolean DEFAULT false,image text,"createdAt" timestamptz DEFAULT now(),"updatedAt" timestamptz DEFAULT now()); CREATE TABLE "session"(id text PRIMARY KEY,"userId" text); CREATE TABLE "account"(id text PRIMARY KEY,"providerId" text,"accountId" text);`);
 const files=readdirSync('database/migrations').filter(f=>f.endsWith('.sql')).sort();
 for(const file of files){try{await db.exec(readFileSync('database/migrations/'+file,'utf8').replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/g,''));}catch(e){throw new Error(file+': '+String(e));}}
 for(const prefix of ['122_'])await db.exec(readFileSync('database/migrations/'+files.find(f=>f.startsWith(prefix))!,'utf8'));
 const provider='00000000-0000-0000-0000-000000000001',service='00000000-0000-0000-0000-000000000002',connection='00000000-0000-0000-0000-000000000003',call='00000000-0000-0000-0000-000000000004';
 await db.exec(`INSERT INTO "user"(id,name,email) VALUES('customer','Customer','customer@example.test'),('provider','Provider','provider@example.test');
 INSERT INTO provider_profiles(id,user_id,business_name,city,state,public_profile_slug) VALUES('${provider}','provider','Synthetic','City','CA','synthetic');
 INSERT INTO provider_companies(id,provider_id,name,slug,city,state) VALUES('${provider}','${provider}','Synthetic','synthetic','City','CA');
 INSERT INTO services(id,provider_id,slug,category,title,description,price_cents,duration_minutes,business_name,company_id) VALUES('${service}','${provider}','test','test','Test','Test',1000,60,'Synthetic','${provider}');`);
 await db.exec(`INSERT INTO provider_calendly_connections(id,provider_id,calendly_user_uri,calendly_organization_uri,access_token_encrypted,refresh_token_encrypted,token_expires_at) VALUES('${connection}','${provider}','owner','org','synthetic-not-credential','synthetic-not-credential',now());
 INSERT INTO calendly_call_offers(id,service_id,provider_id,connection_id,connection_generation,owner_uri,event_type_uri,event_name,duration_minutes,location_kind,buffer_before_minutes,buffer_after_minutes,billing_mode,service_price_cents) VALUES('${service}','${service}','${provider}','${connection}','generation','owner','eventtype','Test',60,'zoom_conference',0,0,'paid',1000);`);
 const f={providerPlan:'starter',serviceSubtotalCents:1000,customerServiceFeeCents:299,customerTotalCents:1299,providerFeeBasisPoints:1000,providerFeeCapCents:null,providerFeeCents:100,providerNetCents:900};
 await db.query(`INSERT INTO calendly_calls(id,request_key,customer_id,provider_id,provider_user_id,service_id,offer_id,offer_revision,connection_id,connection_generation,owner_uri,event_type_uri,event_name,starts_at,ends_at,billing_mode,stripe_mode,financial_snapshot,attendee_snapshot,provider_accepted_at,payment_intent_id,external_event_uri,external_invitee_uri,meeting_url) VALUES($1,$1,'customer',$2,'provider',$3,$3,$3,$4,'generation','owner','eventtype','Test','2020-01-01T10:00Z','2020-01-01T11:00Z','paid','test',$5::jsonb,'{}',now(),'pi_synthetic','event','invitee','https://zoom.us/j/1')`,[call,provider,service,connection,JSON.stringify(f)]);
 await db.query(`INSERT INTO calendly_call_slot_holds(call_id,provider_id,starts_at,ends_at) VALUES($1,$2,'2020-01-01T10:00Z','2020-01-01T11:00Z')`,[call,provider]);
 const queries:string[]=[];
 const query=async(sql:string,args?:unknown[])=>{queries.push(sql);const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
 const client={query,release(){}};const pool={query,connect:async()=>client} as unknown as Pool;
 const store=createCalendlyCallStore(pool);
 await store.withCallLock(call,s=>s.confirmed(call,{paymentIntentId:'pi_synthetic',chargeId:'ch_synthetic'}));
 await store.withCallLock(call,s=>s.confirmed(call,{paymentIntentId:'pi_synthetic',chargeId:'ch_synthetic'}));
 const b=(await db.query<{status:string;payment_status:string;payment_release_status:string;processing_fee_status:string;customer_total_cents:number}>(`SELECT * FROM bookings WHERE id=(SELECT payment_booking_id FROM calendly_calls WHERE id=$1)`,[call])).rows[0];
 assert.equal(b.status,'confirmed');assert.equal(b.payment_status,'paid');assert.equal(b.payment_release_status,'secured');assert.equal(b.processing_fee_status,'pending');assert.equal(b.customer_total_cents,1299);
 assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM bookings')).rows[0].n,1);
 assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM calendly_call_notifications')).rows[0].n,2);

 const snapshot=async()=> (await db.query<{state:string;calendar_check_pending:boolean;last_error:string|null}>('SELECT state,calendar_check_pending,last_error FROM calendly_calls WHERE id=$1',[call])).rows[0];
 assert.equal((await snapshot()).last_error,null,'confirmation prose is not an error');
 queries.length=0;
 assert.equal(await store.withCallLock(call,s=>s.deferCalendarCheck(call)),true);
 assert.ok(queries.findIndex(sql=>sql.includes('FROM bookings')&&sql.includes('FOR UPDATE'))<queries.findIndex(sql=>sql.includes('row_to_json(c)')&&sql.includes('FOR UPDATE')),'retry uses booking then call lock order');
 assert.equal((await snapshot()).calendar_check_pending,true);
 await assert.rejects(db.query("UPDATE bookings SET status='completed' WHERE id=(SELECT payment_booking_id FROM calendly_calls WHERE id=$1)",[call]),/confirmed Calendly call/);
 await assert.rejects(db.query("UPDATE bookings SET payment_release_status='processing' WHERE id=(SELECT payment_booking_id FROM calendly_calls WHERE id=$1)",[call]),/verification is pending/);
 await store.withCallLock(call,s=>s.confirmed(call,{paymentIntentId:'pi_synthetic',chargeId:'ch_synthetic'}));
 assert.equal((await snapshot()).calendar_check_pending,false);
 await db.query("UPDATE bookings SET payment_release_status='frozen' WHERE id=(SELECT payment_booking_id FROM calendly_calls WHERE id=$1)",[call]);
 assert.equal(await store.withCallLock(call,s=>s.deferCalendarCheck(call)),false);
 await assert.rejects(store.withCallLock(call,s=>s.confirmed(call,{paymentIntentId:'pi_synthetic',chargeId:'ch_synthetic'})),/Linked payment requires review/);
 assert.equal((await db.query<{payment_release_status:string}>('SELECT payment_release_status FROM bookings')).rows[0].payment_release_status,'frozen','successful polling never unfreezes financial review');
 await db.query("UPDATE bookings SET payment_release_status='secured' WHERE id=(SELECT payment_booking_id FROM calendly_calls WHERE id=$1)",[call]);
 await db.query("UPDATE bookings SET payment_release_status='processing' WHERE id=(SELECT payment_booking_id FROM calendly_calls WHERE id=$1)",[call]);
 await db.query("UPDATE bookings SET payment_release_status='secured' WHERE id=(SELECT payment_booking_id FROM calendly_calls WHERE id=$1)",[call]);
 await db.query("UPDATE bookings SET status='completed' WHERE id=(SELECT payment_booking_id FROM calendly_calls WHERE id=$1)",[call]);
 assert.equal((await snapshot()).state,'completed');
 await assert.rejects(store.withCallLock(call,s=>s.confirmed(call,{paymentIntentId:'pi_synthetic',chargeId:'ch_synthetic'})),/no longer confirmable/);
 assert.equal(await store.withCallLock(call,s=>s.deferCalendarCheck(call)),false);
 await store.transition(call,'review','Stale failed read');
 await store.freezeLinkedBooking(call,'Stale failure');
 await store.patch(call,{state:'confirming',last_error:'stale'});
 assert.equal((await snapshot()).state,'completed');
 assert.equal((await snapshot()).last_error,null);
 assert.equal((await db.query<{payment_release_status:string}>('SELECT payment_release_status FROM bookings')).rows[0].payment_release_status,'secured');
 // Financial freezes must never be implicitly cleared by read retry.
 await db.query("UPDATE calendly_calls SET state='confirmed' WHERE id=$1",[call]);
 assert.equal(await store.withCallLock(call,s=>s.deferCalendarCheck(call)),false,'native terminal state is rechecked');
 await db.query("UPDATE calendly_calls SET state='cancelled' WHERE id=$1",[call]);
 await store.transition(call,'confirmed','stale');
 assert.equal((await snapshot()).state,'cancelled');
 await db.query("UPDATE calendly_calls SET state='failed' WHERE id=$1",[call]);
 await store.transition(call,'review','stale');
 assert.equal((await snapshot()).state,'failed');
 }finally{await db.close();}
});
