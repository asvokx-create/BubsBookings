import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {requestPaidCallCancellation,recordPaidCallCancellationProof,finishPaidCallCancellation} from '../lib/calendly-call-cancellation.ts';
import {createCalendlyCallStore} from '../lib/calendly-call-store.ts';

test('production schema paid cancellation preserves native policy and retries safely',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`CREATE TABLE "user"(id text PRIMARY KEY,name text,email text,"emailVerified" boolean DEFAULT false,image text,"createdAt" timestamptz DEFAULT now(),"updatedAt" timestamptz DEFAULT now()); CREATE TABLE "session"(id text PRIMARY KEY,"userId" text); CREATE TABLE "account"(id text PRIMARY KEY,"providerId" text,"accountId" text);`);
 const files=readdirSync('database/migrations').filter(f=>f.endsWith('.sql')).sort();
 for(const file of files){try{await db.exec(readFileSync('database/migrations/'+file,'utf8').replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/g,''));}catch(e){throw new Error(file+': '+String(e));}}
 for(const prefix of ['118_','119_','120_','121_'])await db.exec(readFileSync('database/migrations/'+files.find(f=>f.startsWith(prefix))!,'utf8'));
 const provider='00000000-0000-0000-0000-000000000001',service='00000000-0000-0000-0000-000000000002',connection='00000000-0000-0000-0000-000000000003',call='00000000-0000-0000-0000-000000000004';
 await db.exec(`INSERT INTO "user"(id,name,email) VALUES('customer','Customer','customer@example.test'),('provider','Provider','provider@example.test');
 INSERT INTO provider_profiles(id,user_id,business_name,city,state,public_profile_slug) VALUES('${provider}','provider','Synthetic','City','CA','synthetic');
 INSERT INTO provider_companies(id,provider_id,name,slug,city,state) VALUES('${provider}','${provider}','Synthetic','synthetic','City','CA');
 INSERT INTO services(id,provider_id,slug,category,title,description,price_cents,duration_minutes,business_name,company_id) VALUES('${service}','${provider}','test','test','Test','Test',1000,60,'Synthetic','${provider}');`);
 await db.exec(`INSERT INTO provider_calendly_connections(id,provider_id,calendly_user_uri,calendly_organization_uri,access_token_encrypted,refresh_token_encrypted,token_expires_at) VALUES('${connection}','${provider}','owner','org','synthetic-not-credential','synthetic-not-credential',now());
 INSERT INTO calendly_call_offers(id,service_id,provider_id,connection_id,connection_generation,owner_uri,event_type_uri,event_name,duration_minutes,location_kind,buffer_before_minutes,buffer_after_minutes,billing_mode,service_price_cents) VALUES('${service}','${service}','${provider}','${connection}','generation','owner','eventtype','Test',60,'zoom_conference',0,0,'paid',1000);`);
 const f={providerPlan:'starter',serviceSubtotalCents:1000,customerServiceFeeCents:299,customerTotalCents:1299,providerFeeBasisPoints:1000,providerFeeCapCents:null,providerFeeCents:100,providerNetCents:900};
 await db.query(`INSERT INTO calendly_calls(id,request_key,customer_id,provider_id,provider_user_id,service_id,offer_id,offer_revision,connection_id,connection_generation,owner_uri,event_type_uri,event_name,starts_at,ends_at,billing_mode,stripe_mode,financial_snapshot,attendee_snapshot,provider_accepted_at,payment_intent_id,external_event_uri,external_invitee_uri,meeting_url) VALUES($1,$1,'customer',$2,'provider',$3,$3,$3,$4,'generation','owner','eventtype','Test','2027-01-01T10:00Z','2027-01-01T11:00Z','paid','test',$5::jsonb,'{}',now(),'pi_synthetic','event','invitee','https://zoom.us/j/1')`,[call,provider,service,connection,JSON.stringify(f)]);
 await db.query(`INSERT INTO calendly_call_slot_holds(call_id,provider_id,starts_at,ends_at) VALUES($1,$2,'2027-01-01T10:00Z','2027-01-01T11:00Z')`,[call,provider]);
 const query=async(sql:string,args?:unknown[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
 const client={query,release(){}};const pool={query,connect:async()=>client} as unknown as Pool;
 const store=createCalendlyCallStore(pool);
 await store.withCallLock(call,s=>s.confirmed(call,{paymentIntentId:'pi_synthetic',chargeId:'ch_synthetic'}));
 await store.withCallLock(call,s=>s.confirmed(call,{paymentIntentId:'pi_synthetic',chargeId:'ch_synthetic'}));
 const b=(await db.query<{status:string;payment_status:string;payment_release_status:string;processing_fee_status:string;customer_total_cents:number}>(`SELECT * FROM bookings WHERE id=(SELECT payment_booking_id FROM calendly_calls WHERE id=$1)`,[call])).rows[0];
 assert.equal(b.status,'confirmed');assert.equal(b.payment_status,'paid');assert.equal(b.payment_release_status,'secured');assert.equal(b.processing_fee_status,'pending');assert.equal(b.customer_total_cents,1299);
 assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM bookings')).rows[0].n,1);
 assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM calendly_call_notifications')).rows[0].n,2);

 const current=(await db.query<{version:number}>('SELECT version FROM calendly_calls WHERE id=$1',[call])).rows[0];
 const hours=(await db.query<{cancellation_window_hours:number}>('SELECT cancellation_window_hours FROM provider_profiles WHERE id=$1',[provider])).rows[0].cancellation_window_hours;
 await query('BEGIN');await assert.rejects(requestPaidCallCancellation(client as never,{callId:call,userId:'provider',version:current.version,reason:'Provider unavailable',expectedWindowHours:hours,expectedLateCancellation:true}),/cutoff changed/);await query('ROLLBACK');
 await query('BEGIN');await requestPaidCallCancellation(client as never,{callId:call,userId:'provider',version:current.version,reason:'Provider unavailable',expectedWindowHours:hours,expectedLateCancellation:false});await query('COMMIT');
 const op=await store.operation(call,'cancel_invitee');await store.claim(op.id);await store.finish(op.id,{eventUri:'event',inviteeUri:'invitee'});
 await recordPaidCallCancellationProof(client as never,{callId:call,eventUri:'event',inviteeUri:'invitee',operationId:op.id});
 let refunds=0;
 const deps={pool,refundBooking:async()=>{refunds++;if(refunds===1)return {ok:true,refunded:false};
 await query("UPDATE bookings SET refunded_amount_cents=price_cents,customer_service_fee_refunded_cents=customer_service_fee_cents,refund_status='refunded',payment_status='refunded' WHERE id=(SELECT payment_booking_id FROM calendly_calls WHERE id=$1)",[call]);return {ok:true,refunded:true};}};
 assert.equal(await finishPaidCallCancellation(deps,call),'pending');
 assert.equal(await finishPaidCallCancellation(deps,call),'completed');
 assert.equal(await finishPaidCallCancellation(deps,call),'completed');assert.equal(refunds,2);
 const canceled=(await db.query<{status:string;cancelled_by:string;late_cancellation:boolean}>('SELECT status,cancelled_by,late_cancellation FROM bookings')).rows[0];
 assert.equal(canceled.status,'cancelled');assert.equal(canceled.cancelled_by,'provider');assert.equal(canceled.late_cancellation,false);
 assert.equal((await db.query<{n:number}>("SELECT count(*)::int n FROM booking_events WHERE event_type='cancelled'")).rows[0].n,1);
 assert.equal((await db.query<{n:number}>("SELECT count(*)::int n FROM calendly_call_notifications WHERE kind='cancelled'")).rows[0].n,2);
 }finally{await db.close();}
});
