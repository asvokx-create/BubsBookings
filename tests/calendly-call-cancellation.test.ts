import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {cancellationPolicy,recordPaidCallCancellationProof,finishPaidCallCancellation} from '../lib/calendly-call-cancellation.ts';
import type {PoolClient,Pool} from 'pg';
const migration=readFileSync('database/migrations/121_calendly_call_cancellations.sql','utf8');
const c='00000000-0000-0000-0000-000000000001',b='00000000-0000-0000-0000-000000000002',o='00000000-0000-0000-0000-000000000003';
test('native cancellation cutoff preserves equality, zero-hour and actor policy',()=>{
 const start='2027-01-01T12:00:00Z',cutoff=new Date('2027-01-01T10:00:00Z');
 assert.deepEqual(cancellationPolicy('customer',start,2,cutoff),{lateCancellation:false,refundRequired:true});
 assert.deepEqual(cancellationPolicy('customer',start,2,new Date(cutoff.getTime()+1)),{lateCancellation:true,refundRequired:false});
 assert.deepEqual(cancellationPolicy('provider',start,2,new Date('2027-01-02')),{lateCancellation:false,refundRequired:true});
 assert.deepEqual(cancellationPolicy('customer',start,0,new Date('2027-01-02')),{lateCancellation:false,refundRequired:true});
});
for(const scenario of ['late','pending','partial','refund'] as const)test(`native cancellation proof and crash-safe finalization: ${scenario}`,async()=>{
 const db=new PGlite();try{
 await db.exec(`CREATE TABLE "user"(id text PRIMARY KEY);INSERT INTO "user" VALUES('customer');
 CREATE TABLE bookings(id uuid PRIMARY KEY,provider_id uuid,status text,starts_at timestamptz,ends_at timestamptz,cancelled_by text,cancellation_reason text,late_cancellation boolean);
 CREATE TABLE calendly_calls(id uuid PRIMARY KEY,payment_booking_id uuid,state text,external_event_uri text,external_invitee_uri text,ends_at timestamptz,cancel_requested_at timestamptz,version integer,updated_at timestamptz);
 CREATE TABLE calendly_call_slot_holds(call_id uuid,native_booking_id uuid);
 CREATE TABLE calendly_call_operations(id uuid PRIMARY KEY,call_id uuid,kind text,attempted_at timestamptz,completed_at timestamptz,result jsonb);
 INSERT INTO bookings VALUES('${b}',NULL,'confirmed','2027-01-01T10:00Z','2027-01-01T11:00Z',NULL,NULL,false);
 INSERT INTO calendly_calls VALUES('${c}','${b}','cancelling','event','invitee','2027-01-01T11:00Z',now(),1,now());
 INSERT INTO calendly_call_operations VALUES('${o}','${c}','cancel_invitee',now(),NULL,NULL);`);
 await db.exec(migration);await db.exec(migration);
 await db.exec(`CREATE TRIGGER guard BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION protect_linked_calendly_booking();
 INSERT INTO calendly_call_cancellations(call_id,booking_id,actor_user_id,actor_role,reason,requested_at,window_hours,late_cancellation,refund_required,event_uri,invitee_uri) VALUES('${c}','${b}','customer','customer','Cannot attend',now(),2,${scenario==='late'},${scenario!=='late'},'event','invitee');`);
 const cancel=`UPDATE bookings SET status='cancelled',cancelled_by='customer',cancellation_reason='Cannot attend',late_cancellation=${scenario==='late'} WHERE id='${b}'`;
 await assert.rejects(db.exec(cancel),/verified external proof/);
 const client={query:async(sql:string,args:unknown[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows};}} as unknown as Pick<PoolClient,'query'>;
 await assert.rejects(recordPaidCallCancellationProof(client,{callId:c,eventUri:'event',inviteeUri:'invitee',operationId:o}),/does not match/);
 await db.exec(`UPDATE calendly_call_operations SET completed_at=now(),result='{"eventUri":"event","inviteeUri":"invitee"}' WHERE id='${o}'`);
 await assert.rejects(recordPaidCallCancellationProof(client,{callId:c,eventUri:'wrong',inviteeUri:'invitee',operationId:o}),/does not match/);
 await recordPaidCallCancellationProof(client,{callId:c,eventUri:'event',inviteeUri:'invitee',operationId:o});
 await assert.rejects(db.exec(`UPDATE calendly_call_cancellations SET reason='Changed reason' WHERE call_id='${c}'`),/snapshot cannot change/);
 await db.exec(cancel);
 assert.equal((await db.query<{status:string}>('SELECT status FROM bookings')).rows[0].status,'cancelled');
 await db.exec(`ALTER TABLE bookings ADD COLUMN reschedule_requested_by text,ADD COLUMN reschedule_starts_at timestamptz,ADD COLUMN reschedule_ends_at timestamptz,ADD COLUMN reschedule_reason text,ADD COLUMN reschedule_requested_at timestamptz,ADD COLUMN price_cents integer DEFAULT 1000,ADD COLUMN customer_service_fee_cents integer DEFAULT 299,ADD COLUMN refunded_amount_cents integer DEFAULT 0,ADD COLUMN customer_service_fee_refunded_cents integer DEFAULT 0,ADD COLUMN refund_status text DEFAULT 'none',ADD COLUMN payment_status text DEFAULT 'paid',ADD COLUMN payment_release_status text DEFAULT 'frozen',ADD COLUMN refund_failure_reason text;
 CREATE TABLE booking_refund_operations(booking_id uuid,settlement_issue_at timestamptz);
 ALTER TABLE calendly_calls ADD COLUMN customer_id text DEFAULT 'customer',ADD COLUMN provider_user_id text DEFAULT 'provider',ADD COLUMN last_error text;
 ALTER TABLE calendly_call_slot_holds ADD COLUMN provider_id uuid,ADD COLUMN released_at timestamptz;
 CREATE TABLE booking_reschedule_requests(booking_id uuid,status text,response_reason text,responded_by text,responded_at timestamptz);
 CREATE TABLE booking_events(booking_id uuid,actor_user_id text,event_type text,message text);
 CREATE TABLE calendly_call_notifications(call_id uuid,user_id text,kind text,message text,UNIQUE(call_id,user_id,kind));`);
 const connected={...client,release:()=>{}};
 const pool={...client,connect:async()=>connected} as unknown as Pool;
 let refundCalls=0;
 const deps={pool,refundBooking:async()=>{refundCalls++;
  if(scenario==='late')throw new Error('Late cancellation must not invoke refund');
  if(scenario==='partial'&&refundCalls===1){await db.exec(`UPDATE bookings SET refunded_amount_cents=500,refund_status='refunded'`);return {ok:true,refunded:true};}
  if(scenario==='pending'&&refundCalls===1)throw new Error('Simulated lost refund response');
  await db.exec(`UPDATE bookings SET refunded_amount_cents=price_cents,customer_service_fee_refunded_cents=customer_service_fee_cents,refund_status='refunded',payment_status='refunded'`);
  return {ok:true};
 }};
 if(scenario==='pending'||scenario==='partial'){
  assert.equal(await finishPaidCallCancellation(deps,c),'pending');
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM calendly_call_notifications')).rows[0].n,0);
 }
 if(scenario==='late'){
  assert.equal(await finishPaidCallCancellation(deps,c),'pending');
  assert.equal(await finishPaidCallCancellation(deps,c),'pending');
  const ledger=(await db.query<{state:string;last_error:string;completed_at:unknown}>(`SELECT c.state,c.last_error,x.completed_at FROM calendly_calls c JOIN calendly_call_cancellations x ON x.call_id=c.id`)).rows[0];
  assert.equal(ledger.state,'review');assert.equal(ledger.completed_at,null);
  assert.equal(ledger.last_error,'Appointment cancelled; late-cancellation funds require settlement review. No automatic refund issued.');
  const funds=(await db.query<{payment_status:string;payment_release_status:string}>('SELECT payment_status,payment_release_status FROM bookings')).rows[0];
  assert.equal(funds.payment_status,'paid');assert.equal(funds.payment_release_status,'frozen');
 }else{
  assert.equal(await finishPaidCallCancellation(deps,c),'completed');
  assert.equal(await finishPaidCallCancellation(deps,c),'completed');
 }
 assert.equal(refundCalls,scenario==='late'?0:(scenario==='pending'||scenario==='partial')?2:1);
 assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM booking_events')).rows[0].n,1);
 assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM calendly_call_notifications')).rows[0].n,scenario==='late'?0:2);
 }finally{await db.close();}
});
