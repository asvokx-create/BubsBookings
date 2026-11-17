import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CalendlyCallRow, CallOperation, CallOperationKind, CallState } from './calendly-call-policy.ts';

export type CallPatch = Partial<Pick<CalendlyCallRow,'state'|'checkout_session_id'|'payment_intent_id'|'stripe_customer_id'|'checkout_origin'|'external_event_uri'|'external_invitee_uri'|'meeting_url'|'last_error'>>;
export interface CallStore {
 withCallLock<T>(id:string,work:(store:CallStore)=>Promise<T>):Promise<T|null>;
 get(id:string):Promise<CalendlyCallRow|null>;
 patch(id:string,patch:CallPatch):Promise<void>;
 operation(id:string,kind:CallOperationKind):Promise<CallOperation>;
 claim(operationId:string):Promise<boolean>;
 finish(operationId:string,result:unknown):Promise<void>;
 transition(id:string,state:CallState,message?:string):Promise<void>;
 confirmed(id:string,evidence:{paymentIntentId?:string;chargeId?:string}):Promise<void>;
 schedule(id:string,delaySeconds:number):Promise<void>;
 freezeLinkedBooking(id:string,reason:string):Promise<void>;
}
const patchKeys=new Set(['state','checkout_session_id','payment_intent_id','stripe_customer_id','checkout_origin','external_event_uri','external_invitee_uri','meeting_url','last_error']);
export function createCalendlyCallStore(pool:Pool,lockPool:Pool=pool):CallStore {
 function using(executor:Pool|PoolClient):CallStore {
  const store:CallStore={
   async withCallLock(id,work){
    const client=await lockPool.connect();let locked=false;
    try {locked=Boolean((await client.query("SELECT pg_try_advisory_lock(hashtext('calendly-call:' || $1)) AS locked",[id])).rows[0].locked);return locked?await work(using(client)):null;}
    finally {try {if(locked)await client.query("SELECT pg_advisory_unlock(hashtext('calendly-call:' || $1))",[id]);}finally {client.release();}}
   },
   async get(id){return (await executor.query<{call:CalendlyCallRow}>("SELECT row_to_json(c) AS call FROM calendly_calls c WHERE id::text=$1",[id])).rows[0]?.call??null;},
   async patch(id,patch){const pairs=Object.entries(patch);if(!pairs.length)return;if(pairs.some(([k])=>!patchKeys.has(k)))throw new Error('Invalid call patch');await executor.query(`UPDATE calendly_calls SET ${pairs.map(([k],i)=>`${k}=$${i+2}`).join(',')},version=version+1,updated_at=now() WHERE id::text=$1`,[id,...pairs.map(([,v])=>v)]);},
   async operation(id,kind){await executor.query('INSERT INTO calendly_call_operations(call_id,kind) VALUES($1,$2) ON CONFLICT(call_id,kind) DO NOTHING',[id,kind]);return (await executor.query<{operation:CallOperation}>('SELECT row_to_json(o) AS operation FROM calendly_call_operations o WHERE call_id=$1 AND kind=$2',[id,kind])).rows[0].operation;},
   async claim(id){return Boolean((await executor.query('UPDATE calendly_call_operations SET attempted_at=now() WHERE id=$1 AND attempted_at IS NULL RETURNING id',[id])).rowCount);},
   async finish(id,result){await executor.query('UPDATE calendly_call_operations SET completed_at=now(),result=$2::jsonb,last_error=NULL WHERE id=$1',[id,JSON.stringify(result)]);},
   async transition(id,state,message){
    if(state==='review')await store.freezeLinkedBooking(id,message??'Call reconciliation requires review.');
    // State and in-app notification outbox commit together. Never sends email in this transaction.
    await executor.query(`WITH changed AS (UPDATE calendly_calls SET state=$2,last_error=$3,version=version+1,updated_at=now() WHERE id::text=$1 RETURNING *)
     INSERT INTO calendly_call_notifications(call_id,user_id,kind,message)
     SELECT id,recipient,$2,$4 FROM changed CROSS JOIN LATERAL unnest(ARRAY[customer_id,provider_user_id]) recipient
     WHERE $2 IN ('confirmed','cancelled','review','failed') ON CONFLICT(call_id,user_id,kind) DO NOTHING`,[id,state,message??null,message??`Call ${state}.`]);
   },
   async confirmed(id,evidence){
    if(executor===pool)throw new Error('Confirmation requires call lock');
    const client=executor as PoolClient;await client.query('BEGIN');
    try {
     const call=(await client.query<{call:CalendlyCallRow}>('SELECT row_to_json(c) AS call FROM calendly_calls c WHERE id::text=$1 FOR UPDATE',[id])).rows[0]?.call;
     if(!call||call.cancel_requested_at||!call.external_event_uri||!call.external_invitee_uri||!call.meeting_url)throw new Error('Call no longer confirmable');
     const hold=await client.query('UPDATE calendly_call_slot_holds SET starts_at=starts_at WHERE call_id=$1 AND released_at IS NULL RETURNING call_id',[id]);
     if(!hold.rowCount)throw new Error('Active slot reservation required');
     if(call.payment_booking_id){const linked=(await client.query('SELECT payment_status,payment_release_status FROM bookings WHERE id=$1 FOR UPDATE',[call.payment_booking_id])).rows[0];if(!linked||linked.payment_status!=='paid'||['frozen','reversed','failed','partially_released'].includes(linked.payment_release_status))throw new Error('Linked payment requires review');}
     if(call.billing_mode==='paid'&&!call.payment_booking_id){
      if(!evidence.paymentIntentId||!evidence.chargeId||evidence.paymentIntentId!==call.payment_intent_id)throw new Error('Verified payment identity required');
      const f=call.financial_snapshot;const bookingId=randomUUID();
      // The reservation trigger exempts only this explicitly linked native booking.
      await client.query('UPDATE calendly_call_slot_holds SET native_booking_id=$2 WHERE call_id=$1 AND released_at IS NULL',[id,bookingId]);
      await client.query(`INSERT INTO bookings(id,customer_id,provider_id,service_id,starts_at,ends_at,status,service_address,notes,price_cents,delivery_method,pricing_type_snapshot,billable_duration_minutes,base_price_cents,
       provider_plan_snapshot,provider_fee_basis_points,provider_fee_cap_cents,platform_fee_cents,provider_payout_cents,customer_service_fee_cents,customer_total_cents,
       payment_status,payment_flow,payment_release_status,stripe_mode,stripe_payment_intent_id,stripe_charge_id,stripe_checkout_session_id,paid_at,processing_fee_status)
       VALUES($1,$2,$3,$4,$5,$6,'confirmed','Remote Calendly call',$7,$8,'REMOTE','FIXED',$9,$8,$10,$11,$12,$13,$14,$15,$16,'paid','held_transfer_v1','secured',$17,$18,$19,$20,now(),'pending')`,
       [bookingId,call.customer_id,call.provider_id,call.service_id,call.starts_at,call.ends_at,`Calendly call: ${call.event_name}`,f.serviceSubtotalCents,Math.ceil((Date.parse(call.ends_at)-Date.parse(call.starts_at))/60000),f.providerPlan,f.providerFeeBasisPoints,f.providerFeeCapCents,f.providerFeeCents,f.providerNetCents,f.customerServiceFeeCents,f.customerTotalCents,call.stripe_mode,evidence.paymentIntentId,evidence.chargeId,call.checkout_session_id]);
      await client.query('UPDATE calendly_calls SET payment_booking_id=$2 WHERE id=$1',[id,bookingId]);
      await client.query(`INSERT INTO booking_events(booking_id,actor_user_id,event_type,message,metadata) VALUES($1,$2,'payment_received','Call payment captured after appointment confirmation.',$3::jsonb)`,[bookingId,call.customer_id,JSON.stringify({calendlyCallId:call.id})]);
     }
     await store.transition(id,'confirmed','Your Calendly call is confirmed.');await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}
   },
   async schedule(id,delaySeconds){await executor.query("UPDATE calendly_calls SET last_checked_at=now(),next_check_at=now()+($2::integer * interval '1 second') WHERE id::text=$1",[id,Math.max(15,Math.min(3600,delaySeconds))]);},
   async freezeLinkedBooking(id,reason){await executor.query(`UPDATE bookings b SET payment_release_status='frozen',payout_frozen_at=COALESCE(payout_frozen_at,now()),payout_freeze_reason=$2 WHERE b.id=(SELECT payment_booking_id FROM calendly_calls WHERE id::text=$1) AND b.payment_status='paid'`,[id,reason]);},
  };return store;
 }
 return using(pool);
}
