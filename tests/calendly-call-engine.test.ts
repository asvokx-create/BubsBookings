import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileCalendlyCall,type CallEngineDependencies,type PaymentEvidence} from '../lib/calendly-call-engine.ts';
import type {CalendlyCallRow,CallOperation} from '../lib/calendly-call-policy.ts';
import type {CallStore} from '../lib/calendly-call-store.ts';
function fixture(paid=false){
 const row={id:'call',billing_mode:paid?'paid':'free',stripe_mode:'test',state:'accepted',provider_accepted_at:'now',cancel_requested_at:null,payment_booking_id:null,stripe_customer_id:'cus_1',checkout_origin:'https://example.com',checkout_session_id:paid?'cs_1':null,payment_intent_id:paid?'pi_1':null,financial_snapshot:{providerPlan:'starter',serviceSubtotalCents:paid?1000:0,customerServiceFeeCents:paid?299:0,customerTotalCents:paid?1299:0,providerFeeBasisPoints:1000,providerFeeCapCents:null,providerFeeCents:paid?100:0,providerNetCents:paid?900:0}} as CalendlyCallRow;
 const ops=new Map<string,CallOperation>();const counts={create:0,capture:0,cancel:0,release:0,confirmed:0,calendarCancel:0,freeze:0};
 const mapping={eventUri:'https://api.calendly.com/scheduled_events/e1',inviteeUri:'https://api.calendly.com/scheduled_events/e1/invitees/i1',meetingUrl:'https://zoom.us/j/1',meetingStatus:'ready' as const,status:'active' as const};
 let payment:PaymentEvidence|null=paid?{id:'pi_1',mode:'test',callId:'call',currency:'usd',totalCents:1299,status:'authorized',captureBefore:new Date(Date.now()+3600000).toISOString(),amountReceivedCents:0,chargeId:null}:null;
 const store={withCallLock:async(_id,work)=>work(store),get:async()=>({...row}),patch:async(_id,p)=>{Object.assign(row,p);},operation:async(_id,kind)=>{if(!ops.has(kind))ops.set(kind,{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'+kind,call_id:'call',kind,created_at:new Date().toISOString(),attempted_at:null,completed_at:null,result:null});return {...ops.get(kind)!};},claim:async(id)=>{const op=[...ops.values()].find(o=>o.id===id)!;if(op.attempted_at)return false;op.attempted_at='now';return true;},finish:async(id,result)=>{const op=[...ops.values()].find(o=>o.id===id)!;op.completed_at='now';op.result=result;},transition:async(_id,state)=>{row.state=state;},confirmed:async()=>{counts.confirmed++;row.state='confirmed';row.calendar_check_pending=false;if(paid)row.payment_booking_id='booking';},deferCalendarCheck:async()=>{if(row.state!=='confirmed'||row.cancel_requested_at)return false;row.calendar_check_pending=true;return true;},schedule:async()=>{},freezeLinkedBooking:async()=>{counts.freeze++;}} as CallStore;
 const deps:CallEngineDependencies={store,now:Date.now,validate:async()=>{},releaseHold:async()=>{counts.release++;},calendly:{prepare:async()=>{},create:async()=>{counts.create++;return mapping;},read:async()=>({status:'found',mapping}),cancel:async()=>{counts.calendarCancel++;return {...mapping,status:'canceled'};}},payments:{createCheckout:async()=>{throw new Error('unused');},read:async()=>payment,capture:async()=>{counts.capture++;payment={...payment!,status:'captured',amountReceivedCents:1299,chargeId:'ch_1'};return payment;},cancel:async()=>{counts.cancel++;return payment?{...payment,status:'cancelled'}:null;},refund:async()=>({id:'re_1',status:'succeeded',amountCents:1299}),readRefund:async()=>null}};
 return {row,ops,counts,deps,mapping,setPayment:(p:PaymentEvidence|null)=>{payment=p;}};
}
test('free confirms without touching Stripe',async()=>{const f=fixture();f.deps.payments=new Proxy({}, {get:()=>()=>{throw Error('Stripe touched');}}) as never;await reconcileCalendlyCall('call',f.deps);assert.equal(f.row.state,'confirmed');assert.equal(f.counts.create,1);assert.equal(f.counts.capture,0);});
test('paid books before capture and bridges only verified capture',async()=>{const f=fixture(true);await reconcileCalendlyCall('call',f.deps);assert.equal(f.row.state,'confirmed');assert.equal(f.counts.create,1);assert.equal(f.counts.capture,1);await reconcileCalendlyCall('call',f.deps);assert.equal(f.counts.create,1);assert.equal(f.counts.capture,1);});
test('ambiguous calendar write is never retried',async()=>{const f=fixture(true);f.deps.calendly.create=async()=>{f.counts.create++;throw {outcome:'unknown'};};f.deps.calendly.read=async()=>({status:'unknown'});await reconcileCalendlyCall('call',f.deps);await reconcileCalendlyCall('call',f.deps);assert.equal(f.counts.create,1);assert.equal(f.counts.capture,0);assert.equal(f.row.state,'review');});
test('known rejection releases hold and never retries calendar',async()=>{const f=fixture(true);f.deps.calendly.create=async()=>{f.counts.create++;throw {outcome:'rejected'};};await reconcileCalendlyCall('call',f.deps);assert.equal(f.row.state,'cancelled');assert.equal(f.counts.cancel,1);assert.equal(f.counts.release,1);});
test('preflight failure voids authorization without booking',async()=>{const f=fixture(true);f.deps.calendly.prepare=async()=>{throw Error('slot gone');};await reconcileCalendlyCall('call',f.deps);assert.equal(f.row.state,'cancelled');assert.equal(f.counts.create,0);assert.equal(f.counts.cancel,1);});
test('pending Zoom and expiring hold cancels appointment rather than capture',async()=>{const f=fixture(true);f.deps.calendly.create=async()=>({...f.mapping,meetingStatus:'pending',meetingUrl:null});f.deps.now=()=>Date.now()+3590000;await reconcileCalendlyCall('call',f.deps);assert.equal(f.counts.capture,0);assert.equal(f.row.state,'cancelled');});
test('checkout without PI must be expired before cancellation completes',async()=>{const f=fixture(true);f.row.cancel_requested_at='now';f.row.payment_intent_id=null;f.setPayment(null);await reconcileCalendlyCall('call',f.deps);assert.equal(f.counts.cancel,1);assert.equal(f.row.state,'cancelled');});
test('ambiguous checkout create cannot be declared safely cancelled',async()=>{const f=fixture(true);f.row.checkout_session_id=null;f.row.payment_intent_id=null;f.row.cancel_requested_at='now';const op=await f.deps.store.operation('call','create_checkout');await f.deps.store.claim(op.id);await reconcileCalendlyCall('call',f.deps);assert.notEqual(f.row.state,'cancelled');assert.equal(f.counts.release,0);});
test('linked cancellation freezes rather than bypassing native refund policy',async()=>{const f=fixture(true);f.row.payment_booking_id='booking';f.row.cancel_requested_at='now';await reconcileCalendlyCall('call',f.deps);assert.equal(f.row.state,'review');assert.equal(f.counts.freeze,1);assert.equal(f.counts.cancel,0);});

test('confirmed free call survives started time and disabled new scheduling',async()=>{const f=fixture();await reconcileCalendlyCall('call',f.deps);f.row.starts_at='2020-01-01T00:00:00Z';f.deps.validate=async()=>{throw Error('closed');};await reconcileCalendlyCall('call',f.deps);assert.equal(f.row.state,'confirmed');assert.equal(f.counts.calendarCancel,0);});
test('successful own refund recovers before normal payment read rejects refunded charge',async()=>{const f=fixture(true);const create=await f.deps.store.operation('call','create_invitee');await f.deps.store.claim(create.id);const refund=await f.deps.store.operation('call','refund');await f.deps.store.claim(refund.id);f.deps.payments.read=async()=>{throw Error('refunded charge');};f.deps.payments.readRefund=async()=>({id:'re_1',status:'succeeded',amountCents:1299});f.deps.calendly.read=async()=>({status:'found',mapping:{...f.mapping,status:'canceled'}});await reconcileCalendlyCall('call',f.deps);assert.equal(f.row.state,'cancelled');assert.equal(f.counts.release,1);});
test('post-calendar local conflict cancels appointment and authorization without charge',async()=>{const f=fixture(true);let checks=0;f.deps.validate=async()=>{if(++checks===2)throw Error('conflict');};await reconcileCalendlyCall('call',f.deps);assert.equal(f.counts.create,1);assert.equal(f.counts.capture,0);assert.equal(f.counts.calendarCancel,1);assert.equal(f.row.state,'cancelled');});
test('authenticated linked cancellation delegates native policy only after calendar proof',async()=>{const f=fixture(true);f.row.payment_booking_id='booking';f.row.cancel_requested_at='now';const create=await f.deps.store.operation('call','create_invitee');await f.deps.store.claim(create.id);f.deps.hasLinkedCancellation=async()=>true;f.deps.payments.read=async()=>{throw Error('normal read must not block native refund recovery');};let finished=0;f.deps.finishLinkedCancellation=async(_call,mapping,op)=>{assert.equal(mapping.status,'canceled');assert.equal(f.ops.get('cancel_invitee')?.id,op);assert.ok(f.ops.get('cancel_invitee')?.attempted_at);assert.ok(f.ops.get('cancel_invitee')?.completed_at);finished++;return 'completed';};await reconcileCalendlyCall('call',f.deps);assert.equal(f.row.state,'cancelled');assert.equal(finished,1);assert.equal(f.counts.calendarCancel,1);assert.equal(f.counts.cancel,0);});
test('ambiguous linked cancellation is read-reconciled without duplicate send',async()=>{const f=fixture(true);f.row.payment_booking_id='booking';f.row.cancel_requested_at='now';const create=await f.deps.store.operation('call','create_invitee');await f.deps.store.claim(create.id);f.deps.hasLinkedCancellation=async()=>true;f.deps.finishLinkedCancellation=async()=>{throw Error('not yet verified');};f.deps.calendly.cancel=async()=>{f.counts.calendarCancel++;throw Error('network uncertain');};await reconcileCalendlyCall('call',f.deps);await reconcileCalendlyCall('call',f.deps);assert.equal(f.counts.calendarCancel,1);assert.equal(f.row.state,'review');});
for(const paid of [false,true])test(`${paid?'paid':'free'} confirmed call retries temporary GET and clears pending after recovery without duplicate effects`,async()=>{
 const f=fixture(paid);await reconcileCalendlyCall('call',f.deps);
 const before={...f.counts};f.deps.calendly.read=async()=>({status:'unavailable'});
 for(let i=0;i<3;i++)await reconcileCalendlyCall('call',f.deps);
 assert.equal(f.row.state,'confirmed');assert.equal(f.row.calendar_check_pending,true);
 assert.equal(f.counts.freeze,0);assert.equal(f.counts.create,before.create);assert.equal(f.counts.capture,before.capture);
 assert.equal(f.counts.calendarCancel,0);assert.equal(f.counts.cancel,0);
 f.deps.calendly.read=async()=>({status:'found',mapping:f.mapping});await reconcileCalendlyCall('call',f.deps);
 assert.equal(f.row.state,'confirmed');assert.equal(f.row.calendar_check_pending,false);
 assert.equal(f.counts.create,before.create);assert.equal(f.counts.capture,before.capture);
});
test('temporary GET is not safe retry for unconfirmed, cancellation, financial mismatch or failed lock-time guard',async()=>{
 for(const scenario of ['unconfirmed','cancel','payment','guard'] as const){
  const f=fixture(true);await reconcileCalendlyCall('call',f.deps);
  if(scenario==='unconfirmed')f.row.state='review';
  if(scenario==='cancel')f.row.cancel_requested_at='now';
  if(scenario==='payment')f.setPayment({id:'pi_1',mode:'test',callId:'call',currency:'usd',totalCents:1299,status:'captured',captureBefore:null,amountReceivedCents:1,chargeId:'ch_1'});
  if(scenario==='guard')f.deps.store.deferCalendarCheck=async()=>false;
  f.deps.calendly.read=async()=>({status:'unavailable'});await reconcileCalendlyCall('call',f.deps);
  assert.equal(f.row.state,'review',scenario);assert.notEqual(f.row.calendar_check_pending,true,scenario);
  assert.equal(f.counts.create,1);assert.equal(f.counts.capture,1);
 }
});
test('unknown or ambiguous GET stays review rather than automatic retry',async()=>{
 for(const status of ['unknown','ambiguous'] as const){const f=fixture();await reconcileCalendlyCall('call',f.deps);f.deps.calendly.read=async()=>({status});await reconcileCalendlyCall('call',f.deps);assert.equal(f.row.state,'review');assert.notEqual(f.row.calendar_check_pending,true);}
});
test('engine passes only explicit local limiter evidence to deferred queue scheduling',async()=>{
 for(const localRateLimited of [true,false,undefined]){
  const f=fixture();await reconcileCalendlyCall('call',f.deps);let received:unknown='not called';
  f.deps.calendly.read=async()=>({status:'unavailable',...(localRateLimited===undefined?{}:{localRateLimited})});
  f.deps.store.deferCalendarCheck=async(_id,local)=>{received=local;return true;};
  await reconcileCalendlyCall('call',f.deps);assert.equal(received,localRateLimited===true);
 }
});
