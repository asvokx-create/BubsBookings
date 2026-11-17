import type { Pool, PoolClient } from 'pg';
import { releaseCallSlot } from './calendly-call-conflicts.ts';
type Queryable=Pick<PoolClient,'query'>;
export class CallCancellationError extends Error {status=409;}
export function cancellationPolicy(role:'provider'|'customer',startsAt:Date|string,windowHours:number,requestedAt:Date){
 const late=role==='customer'&&windowHours>0&&requestedAt.getTime()>new Date(startsAt).getTime()-windowHours*3600000;
 return {lateCancellation:late,refundRequired:role==='provider'||!late};
}
/** Caller owns transaction + request moderation. No external IO. */
export async function requestPaidCallCancellation(client:Queryable,input:{callId:string;userId:string;version:number;reason:string;expectedWindowHours:number;expectedLateCancellation:boolean}){
 const reason=input.reason.trim();if(reason.length<3||reason.length>500)throw new CallCancellationError('Add a brief cancellation reason.');
 const c=(await client.query(`SELECT * FROM calendly_calls WHERE id=$1 AND (customer_id=$2 OR provider_user_id=$2) FOR UPDATE`,[input.callId,input.userId])).rows[0];
 if(!c)throw new CallCancellationError('Call not found.');
 const prior=(await client.query('SELECT * FROM calendly_call_cancellations WHERE call_id=$1',[input.callId])).rows[0];
 if(prior){if(prior.actor_user_id!==input.userId)throw new CallCancellationError('The other participant has already requested cancellation; review its status.');return prior;}
 if(c.billing_mode!=='paid'||!c.payment_booking_id||c.state!=='confirmed'||c.version!==input.version||!c.external_event_uri||!c.external_invitee_uri)throw new CallCancellationError('Call changed or cannot be cancelled. Refresh first.');
 const b=(await client.query(`SELECT b.status,b.starts_at,p.cancellation_window_hours FROM bookings b JOIN provider_profiles p ON p.id=b.provider_id WHERE b.id=$1 FOR UPDATE OF b`,[c.payment_booking_id])).rows[0];
 if(!b||b.status!=='confirmed'||b.cancellation_window_hours!==input.expectedWindowHours)throw new CallCancellationError('Only confirmed appointments can be cancelled.');
 const requestedAt=new Date(),role=input.userId===c.provider_user_id?'provider':'customer';
 const policy=cancellationPolicy(role,b.starts_at,b.cancellation_window_hours,requestedAt);
 if(input.expectedLateCancellation!==policy.lateCancellation)throw new CallCancellationError('The cancellation cutoff changed. Review the updated policy before confirming.');
 const row=(await client.query(`INSERT INTO calendly_call_cancellations(call_id,booking_id,actor_user_id,actor_role,reason,requested_at,window_hours,late_cancellation,refund_required,event_uri,invitee_uri)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[c.id,c.payment_booking_id,input.userId,role,reason,requestedAt,b.cancellation_window_hours,policy.lateCancellation,policy.refundRequired,c.external_event_uri,c.external_invitee_uri])).rows[0];
 await client.query("UPDATE calendly_calls SET state='cancelling',cancel_requested_at=$2,version=version+1,updated_at=now(),next_check_at=now() WHERE id=$1",[c.id,requestedAt]);return row;
}
export async function hasPaidCallCancellation(db:Queryable,callId:string){return Boolean((await db.query('SELECT 1 FROM calendly_call_cancellations WHERE call_id=$1',[callId])).rowCount);}
/** Engine supplies authoritative canceled mapping, after finishing durable cancel operation. */
export async function recordPaidCallCancellationProof(client:Queryable,input:{callId:string;eventUri:string;inviteeUri:string;operationId:string}){
 const updated=await client.query(`UPDATE calendly_call_cancellations x SET external_cancelled_at=COALESCE(external_cancelled_at,now()),cancel_operation_id=$4
 FROM calendly_calls c,calendly_call_operations o WHERE x.call_id=$1 AND c.id=x.call_id AND x.booking_id=c.payment_booking_id
 AND x.event_uri=$2 AND x.invitee_uri=$3 AND c.external_event_uri=$2 AND c.external_invitee_uri=$3
 AND o.id=$4 AND o.call_id=c.id AND o.kind='cancel_invitee' AND o.attempted_at IS NOT NULL AND o.completed_at IS NOT NULL AND o.result->>'eventUri'=$2 AND o.result->>'inviteeUri'=$3
 AND (x.cancel_operation_id IS NULL OR x.cancel_operation_id=$4) RETURNING x.call_id`,[input.callId,input.eventUri,input.inviteeUri,input.operationId]);
 if(!updated.rowCount)throw new CallCancellationError('Cancellation proof does not match the authenticated request.');
}
type CancellationDependencies={pool:Pool;refundBooking:(id:string,reason:string)=>Promise<unknown>};
export async function finishPaidCallCancellation({pool,refundBooking}:CancellationDependencies,callId:string):Promise<'pending'|'completed'>{
 const client=await pool.connect();let row;
 try{await client.query('BEGIN');await client.query('SELECT id FROM calendly_calls WHERE id=$1 FOR UPDATE',[callId]);
 row=(await client.query('SELECT * FROM calendly_call_cancellations WHERE call_id=$1 FOR UPDATE',[callId])).rows[0];
 if(!row?.external_cancelled_at){await client.query('ROLLBACK');return 'pending';}
 if(row.completed_at){await client.query('COMMIT');return 'completed';}
 if(!row.native_cancelled_at){
  await client.query(`UPDATE bookings SET status='cancelled',cancelled_by=$2,cancellation_reason=$3,late_cancellation=$4,
   reschedule_requested_by=NULL,reschedule_starts_at=NULL,reschedule_ends_at=NULL,reschedule_reason=NULL,reschedule_requested_at=NULL WHERE id=$1`,[row.booking_id,row.actor_role,row.reason,row.late_cancellation]);
  await client.query(`UPDATE booking_reschedule_requests SET status='withdrawn',response_reason='Booking cancelled',responded_by=$2,responded_at=now() WHERE booking_id=$1 AND status='pending'`,[row.booking_id,row.actor_user_id]);
  await client.query(`INSERT INTO booking_events(booking_id,actor_user_id,event_type,message) VALUES($1,$2,'cancelled',$3)`,[row.booking_id,row.actor_user_id,`${row.late_cancellation?'Late cancellation':row.actor_role+' cancelled the booking'}: ${row.reason}`]);
  await client.query('UPDATE calendly_call_cancellations SET native_cancelled_at=now() WHERE call_id=$1',[callId]);
 }
 await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 if(!row.refund_required){
  // No automatic refund is not a payout authorization. Existing native payout
  // requires completed work; canceled paid funds therefore need manual settlement.
  const reason='Appointment cancelled; late-cancellation funds require settlement review. No automatic refund issued.';
  await pool.query(`WITH pending AS (UPDATE calendly_call_cancellations SET last_error=$2 WHERE call_id=$1 AND completed_at IS NULL RETURNING call_id)
   UPDATE calendly_calls SET state='review',last_error=$2,version=version+1,updated_at=now() WHERE id IN (SELECT call_id FROM pending)`,[callId,reason]);
  return 'pending';
 }
 if(row.refund_required){
  // Existing native durable refund operations own all Stripe work and policy.
  try{await refundBooking(row.booking_id,row.actor_role==='provider'?'Provider cancelled before payout release.':'Customer cancelled within the provider notice window before payout release.');}catch{/* Persist pending below; never infer success from a transport result. */}
  const b=(await pool.query(`SELECT b.*,EXISTS(SELECT 1 FROM booking_refund_operations o WHERE o.booking_id=b.id AND o.settlement_issue_at IS NOT NULL) AS settlement_issue FROM bookings b WHERE b.id=$1`,[row.booking_id])).rows[0];
  if(!b||b.refunded_amount_cents!==b.price_cents||b.customer_service_fee_refunded_cents!==b.customer_service_fee_cents||b.settlement_issue||b.refund_status!=='refunded'||b.payment_status!=='refunded'||b.refund_failure_reason){
   await pool.query("UPDATE calendly_call_cancellations SET last_error='Appointment cancelled; refund completion needs review.' WHERE call_id=$1",[callId]);return 'pending';
  }
 }
 const finish=await pool.connect();try{await finish.query('BEGIN');await finish.query('SELECT id FROM calendly_calls WHERE id=$1 FOR UPDATE',[callId]);
 const won=await finish.query('UPDATE calendly_call_cancellations SET completed_at=now(),last_error=NULL WHERE call_id=$1 AND completed_at IS NULL RETURNING call_id',[callId]);
 if(won.rowCount){await releaseCallSlot(finish,callId);await finish.query("UPDATE calendly_calls SET state='cancelled',version=version+1,updated_at=now(),last_error=NULL WHERE id=$1",[callId]);
 await finish.query(`INSERT INTO calendly_call_notifications(call_id,user_id,kind,message) SELECT id,recipient,'cancelled',$2 FROM calendly_calls CROSS JOIN LATERAL unnest(ARRAY[customer_id,provider_user_id]) recipient WHERE id=$1 ON CONFLICT(call_id,user_id,kind) DO NOTHING`,[callId,row.refund_required?'Appointment cancelled. The refund has been verified.':'Appointment cancelled. The late-cancellation policy applies; no automatic refund was issued.']);}
 await finish.query('COMMIT');return 'completed';
 }catch(error){await finish.query('ROLLBACK');throw error;}finally{finish.release();}
}
