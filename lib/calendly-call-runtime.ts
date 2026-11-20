import 'server-only';
import { database } from '@/lib/database';
import { Pool } from 'pg';
import { getStripe, getStripeMode } from '@/lib/stripe';
import { getOrCreateConsumerStripeCustomer } from '@/lib/customer-stripe';
import { createCalendlyCallRuntimeAdapter } from '@/lib/calendly-call-runtime-adapter';
import { createCalendlyCallStore } from '@/lib/calendly-call-store';
import { createCalendlyCallPaymentAdapter } from '@/lib/calendly-call-payments';
import { reconcileCalendlyCall, startCalendlyCallCheckout, type CallEngineDependencies, type CallPayments } from '@/lib/calendly-call-engine';
import { releaseCallSlot, validateCallSlot } from '@/lib/calendly-call-conflicts';
import { ELIGIBLE_OFFER, CallRequestError, requireCallsEnabled } from '@/lib/calendly-call-offers';
import type { CalendlyCallRow } from '@/lib/calendly-call-policy';
import {deliverCallReviewAlerts} from '@/lib/calendly-call-admin';
import {hasPaidCallCancellation,recordPaidCallCancellationProof,finishPaidCallCancellation} from '@/lib/calendly-call-cancellation';
import {refundUnreleasedBooking} from '@/lib/payment-release';

export function callRecoveryEnabled(){return process.env.CALENDLY_CALL_BOOKINGS_ENABLED==='true'||process.env.CALENDLY_CALL_RECOVERY_ENABLED==='true';}
async function validate(call:CalendlyCallRow){
 requireCallsEnabled();
 if(call.stripe_mode!==getStripeMode()||Date.parse(call.starts_at)<=Date.now())throw new CallRequestError('Call time or payment environment changed.');
 const eligible=await database.query(ELIGIBLE_OFFER+` AND o.id=$1 AND o.revision=$2 AND o.provider_id=$3 AND o.service_id=$4 AND o.connection_id=$5 AND o.connection_generation=$6 AND o.owner_uri=$7 AND o.event_type_uri=$8`,[call.offer_id,call.offer_revision,call.provider_id,call.service_id,call.connection_id,call.connection_generation,call.owner_uri,call.event_type_uri]);
 if(!eligible.rowCount)throw new CallRequestError('Call offer or connected account changed.');
 if((await database.query("SELECT 1 FROM account_restrictions WHERE user_id=ANY($1::text[]) AND status IN ('suspended','banned') AND (expires_at IS NULL OR expires_at>now())",[[call.customer_id,call.provider_user_id]])).rowCount)throw new CallRequestError('An account on this call is restricted.');
 if(call.billing_mode==='paid'){
  const row=(await database.query<{stripe_account_id:string|null;stripe_connect_mode:string|null}>('SELECT stripe_account_id,stripe_connect_mode FROM provider_profiles WHERE id=$1',[call.provider_id])).rows[0];
  if(!row?.stripe_account_id||row.stripe_connect_mode!==call.stripe_mode)throw new CallRequestError('Provider payout setup is unavailable.');
  const account=await getStripe().accounts.retrieve(row.stripe_account_id);
  if(!account.charges_enabled||!account.payouts_enabled)throw new CallRequestError('Provider payout setup is unavailable.');
 }
 const client=await database.connect();try{await client.query('BEGIN');await validateCallSlot(client,{callId:call.id,providerId:call.provider_id,startsAt:new Date(Date.parse(call.starts_at)-call.buffer_before_minutes*60000),endsAt:new Date(Date.parse(call.ends_at)+call.buffer_after_minutes*60000)});await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
const globalCallRuntime=globalThis as unknown as {calendlyCallLockPool?:Pool};
function callStore(){
 // Dedicated bounded lock connections cannot starve the primary query pool while
 // the workflow performs verification through transports that use that pool.
 const locks=globalCallRuntime.calendlyCallLockPool??=new Pool({...database.options,max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:10000});
 return createCalendlyCallStore(database,locks);
}
function dependencies():CallEngineDependencies {
 const store=callStore();
 // Lazy: a free call never initializes Stripe or creates any financial object.
 const adapter=()=>createCalendlyCallPaymentAdapter({stripe:getStripe(),mode:getStripeMode()});
 const payments:CallPayments={createCheckout:(...args)=>adapter().createCheckout(...args),read:(...args)=>adapter().read(...args),capture:(...args)=>adapter().capture(...args),cancel:(...args)=>adapter().cancel(...args),refund:(...args)=>adapter().refund(...args),readRefund:(...args)=>adapter().readRefund(...args)};
 return {store,payments,calendly:createCalendlyCallRuntimeAdapter(store),validate,
  hasLinkedCancellation:call=>hasPaidCallCancellation(database,call.id),
  finishLinkedCancellation:async(call,mapping,operationId)=>{
   if(mapping.status!=='canceled')throw new Error('Appointment cancellation is not verified.');
   await recordPaidCallCancellationProof(database,{callId:call.id,eventUri:mapping.eventUri,inviteeUri:mapping.inviteeUri,operationId});
   return finishPaidCallCancellation({pool:database,refundBooking:refundUnreleasedBooking},call.id);
  },
  releaseHold:async call=>{const client=await database.connect();try{await client.query('BEGIN');await releaseCallSlot(client,call.id);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}};
}
export async function reconcileCallRuntime(id:string){if(!callRecoveryEnabled())return;return reconcileCalendlyCall(id,dependencies());}
export async function startCallCheckoutRuntime(id:string,user:{id:string;email:string;name?:string},origin:string,expectedVersion:number){
 requireCallsEnabled();
 const call=await createCalendlyCallStore(database).get(id);
 if(!call||call.version!==expectedVersion||call.customer_id!==user.id||call.billing_mode!=='paid'||!['accepted','authorizing'].includes(call.state)||call.cancel_requested_at)throw new CallRequestError('Call is not awaiting your authorization.');
 await validate(call);
 const customerId=await getOrCreateConsumerStripeCustomer({userId:user.id,email:user.email,name:user.name});
 return startCalendlyCallCheckout(id,{customerId,origin,expectedVersion},dependencies());
}
/** Signed webhooks only expedite reads. Their payload never authorizes capture/refund. */
export async function wakeCallForStripeObject(object:{id?:string;metadata?:Record<string,string>|null}){
 if(!callRecoveryEnabled())return;
 const id=object.metadata?.calendly_call_id;
 await database.query(`UPDATE calendly_calls SET next_check_at=now() WHERE stripe_mode=$3 AND (id::text=$1 OR payment_intent_id=$2 OR checkout_session_id=$2) AND state NOT IN ('cancelled','failed','completed')`,[id??'',object.id??'',getStripeMode()]);
}
export async function wakeCallsForCalendlyEvent(raw:string){
 if(!callRecoveryEnabled())return;
 const parsed=JSON.parse(raw) as {payload?:{event?:unknown;scheduled_event?:{uri?:unknown}}};
 const uri=parsed.payload?.scheduled_event?.uri??parsed.payload?.event;
 if(typeof uri==='string'&&/^https:\/\/api\.calendly\.com\/scheduled_events\/[A-Za-z0-9_-]+$/.test(uri))await database.query("UPDATE calendly_calls SET next_check_at=now() WHERE external_event_uri=$1 AND state NOT IN ('cancelled','failed','completed')",[uri]);
 // Unknown-create attempts also have fair periodic reconciliation; no email/time guessed matching.
}
/** Atomic durable in-app delivery to BOTH participants; no unreliable external email claim. */
export async function deliverCallNotifications(){
 const result=await database.query(`WITH pending AS (SELECT n.*,c.payment_booking_id FROM calendly_call_notifications n JOIN calendly_calls c ON c.id=n.call_id WHERE n.delivered_at IS NULL ORDER BY n.id LIMIT 100 FOR UPDATE OF n SKIP LOCKED),
 inserted AS (INSERT INTO notifications(user_id,booking_id,type,title,message,href,dedupe_key) SELECT user_id,payment_booking_id,'calendly_call','Call update',message,'/account/calls/'||call_id::text,'calendly-call-'||id::text FROM pending ON CONFLICT(dedupe_key) DO NOTHING RETURNING id)
 UPDATE calendly_call_notifications SET delivered_at=now() WHERE id IN (SELECT id FROM pending) RETURNING id`);
 return result.rowCount??0;
}
export async function processDueCalendlyCalls(){
 if(!callRecoveryEnabled())return {enabled:false,checked:0,failed:0,notifications:0};
 // Claim oldest-attempted due work first, so repeated transient checks cannot
 // starve other appointments. Advance due time atomically across cron instances.
 const due=await database.query<{id:string}>(`WITH due AS (SELECT id FROM calendly_calls WHERE next_check_at<=now() AND provider_accepted_at IS NOT NULL AND state NOT IN ('cancelled','failed','completed') ORDER BY last_checked_at NULLS FIRST,next_check_at,created_at LIMIT 20 FOR UPDATE SKIP LOCKED) UPDATE calendly_calls c SET next_check_at=now()+interval '2 minutes' FROM due WHERE c.id=due.id RETURNING c.id::text`);
 let failed=0;for(const row of due.rows){try{await reconcileCallRuntime(row.id);}catch{failed++;}}
 return {enabled:true,checked:due.rows.length,failed,notifications:await deliverCallNotifications(),reviewAlerts:await deliverCallReviewAlerts()};
}
