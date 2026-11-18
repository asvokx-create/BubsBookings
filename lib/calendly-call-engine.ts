import { authorizationUsable, paymentMatches, validCallFinancials, type CalendlyCallRow, type CallOperation } from './calendly-call-policy.ts';
import type { CallStore } from './calendly-call-store.ts';
export type CallMapping={eventUri:string;inviteeUri:string;meetingUrl:string|null;meetingStatus:'ready'|'pending'|'failed';status:'active'|'canceled'};
export type PaymentEvidence={id:string;mode:'test'|'live';callId:string;currency:string;totalCents:number;status:'authorized'|'captured'|'cancelled'|'failed'|'pending';captureBefore:string|null;chargeId?:string|null;amountReceivedCents:number};
export type CallPaymentInput={id:string;billingMode:'free'|'paid';stripeMode:'test'|'live';totalCents:number;serviceSubtotalCents:number;customerServiceFeeCents:number;currency:'usd';stripeCustomerId:string;checkoutSessionId?:string;paymentIntentId?:string;successUrl:string;cancelUrl:string;operationCreatedAt:string;integrationIdentifier:string};
export type CallPayments={
 createCheckout(call:CallPaymentInput,key:string):Promise<{id:string;url:string;paymentIntentId?:string|null}>;
 read(call:CallPaymentInput):Promise<PaymentEvidence|null>;
 capture(call:CallPaymentInput,key:string):Promise<PaymentEvidence>;
 cancel(call:CallPaymentInput,key:string):Promise<PaymentEvidence|null>;
 refund(call:CallPaymentInput,key:string):Promise<{id:string;status:string;amountCents:number}>;
 readRefund(call:CallPaymentInput,key:string):Promise<{id:string;status:string;amountCents:number}|null>;
};
export type CallEngineDependencies={
 store:CallStore;
 payments:CallPayments;
 calendly:{prepare(call:CalendlyCallRow):Promise<void>;create(call:CalendlyCallRow,operationId:string):Promise<CallMapping>;read(call:CalendlyCallRow,operationId:string):Promise<{status:'found';mapping:CallMapping}|{status:'unknown'|'ambiguous'}|{status:'unavailable';localRateLimited?:boolean}>;cancel(call:CalendlyCallRow,mapping:CallMapping):Promise<CallMapping>};
 /** Rechecks eligibility, immutable account generation, and holds; no external send. */
 validate(call:CalendlyCallRow):Promise<void>;
 releaseHold(call:CalendlyCallRow):Promise<void>;
 /** Only a durable authenticated cancellation request may authorize linked cancellation. */
 hasLinkedCancellation?(call:CalendlyCallRow):Promise<boolean>;
 finishLinkedCancellation?(call:CalendlyCallRow,mapping:CallMapping,cancelOperationId:string):Promise<'pending'|'completed'>;
 now?:()=>number;
};
function paymentInput(call:CalendlyCallRow,operation:CallOperation):CallPaymentInput {
 if(call.billing_mode!=='paid'||!call.stripe_customer_id||!call.checkout_origin)throw new Error('Paid call setup missing');
 const origin=new URL(call.checkout_origin);if(origin.protocol!=='https:'&&origin.hostname!=='127.0.0.1'&&origin.hostname!=='localhost')throw new Error('Invalid checkout origin');
 const suffix=operation.id.replace(/-/g,'').slice(0,8).split('').map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
 return {id:call.id,billingMode:call.billing_mode,stripeMode:call.stripe_mode,currency:'usd',totalCents:call.financial_snapshot.customerTotalCents,serviceSubtotalCents:call.financial_snapshot.serviceSubtotalCents,customerServiceFeeCents:call.financial_snapshot.customerServiceFeeCents,stripeCustomerId:call.stripe_customer_id,checkoutSessionId:call.checkout_session_id??undefined,paymentIntentId:call.payment_intent_id??undefined,successUrl:`${origin.origin}/account/calls/${call.id}`,cancelUrl:`${origin.origin}/account/calls/${call.id}`,operationCreatedAt:operation.created_at,integrationIdentifier:`calendly_calls_${suffix}`};
}
const key=(call:CalendlyCallRow,operation:CallOperation)=>`calendly-call-${call.stripe_mode}-${operation.kind}-${operation.id}`;
const errorMessage='Call confirmation needs review. No duplicate booking or charge will be attempted.';
function safeMapping(mapping:CallMapping){
 if(!/^https:\/\/api\.calendly\.com\/scheduled_events\/[A-Za-z0-9_-]+$/.test(mapping.eventUri)||!mapping.inviteeUri.startsWith(mapping.eventUri+'/invitees/'))throw new Error('Invalid event mapping');
 if(mapping.meetingUrl){const url=new URL(mapping.meetingUrl);if(url.protocol!=='https:'||url.username||url.password||!(url.hostname==='zoom.us'||url.hostname.endsWith('.zoom.us')||url.hostname==='zoom.com'||url.hostname.endsWith('.zoom.com')))throw new Error('Unverified video URL');}
}
async function persistMapping(store:CallStore,call:CalendlyCallRow,mapping:CallMapping){safeMapping(mapping);await store.patch(call.id,{external_event_uri:mapping.eventUri,external_invitee_uri:mapping.inviteeUri,meeting_url:mapping.meetingUrl});call.external_event_uri=mapping.eventUri;call.external_invitee_uri=mapping.inviteeUri;call.meeting_url=mapping.meetingUrl;}

/** Creation retries use the SAME durable Stripe key within the adapter's safe window. */
export async function startCalendlyCallCheckout(callId:string,input:{customerId:string;origin:string;expectedVersion:number},deps:CallEngineDependencies){
 return deps.store.withCallLock(callId,async store=>{
  const call=await store.get(callId);if(!call||!call.provider_accepted_at||call.billing_mode!=='paid'||call.cancel_requested_at||!['accepted','authorizing'].includes(call.state))throw new Error('Call is not awaiting authorization');
  if(!Number.isSafeInteger(input.expectedVersion)||call.version!==input.expectedVersion)throw new Error('Call changed; refresh before checkout');
  if(!validCallFinancials(call))throw new Error('Invalid price snapshot');await deps.validate(call);
  if(call.stripe_customer_id&&call.stripe_customer_id!==input.customerId)throw new Error('Customer identity changed');
  if(call.checkout_origin&&new URL(call.checkout_origin).origin!==new URL(input.origin).origin)throw new Error('Checkout origin changed');
  await store.patch(callId,{stripe_customer_id:input.customerId,checkout_origin:input.origin,state:'authorizing'});call.stripe_customer_id=input.customerId;call.checkout_origin=input.origin;
  const op=await store.operation(callId,'create_checkout');await store.claim(op.id);
  const checkout=await deps.payments.createCheckout(paymentInput(call,op),key(call,op));
  await store.patch(callId,{checkout_session_id:checkout.id,payment_intent_id:checkout.paymentIntentId??null});await store.finish(op.id,{checkoutSessionId:checkout.id});return {url:checkout.url};
 });
}

/** One durable workflow per call; external requests are outside database transactions. */
export async function reconcileCalendlyCall(callId:string,deps:CallEngineDependencies){
 return deps.store.withCallLock(callId,async store=>{
  let call=await store.get(callId);if(!call||['cancelled','failed','completed'].includes(call.state)||!call.provider_accepted_at)return;
  const now=deps.now?.()??Date.now();await store.schedule(callId,60);
  try {
   if(!validCallFinancials(call))throw new Error('Invalid financial snapshot');
   const creation=await store.operation(callId,'create_invitee');const checkout=await store.operation(callId,'create_checkout');
   const startPassed=Number.isFinite(Date.parse(call.starts_at))&&Date.parse(call.starts_at)<=now;
   const linkedCancellation=Boolean(call.payment_booking_id&&await deps.hasLinkedCancellation?.(call));
   let payment:PaymentEvidence|null=null;
   if(call.billing_mode==='paid'&&!linkedCancellation){
    if(!call.checkout_session_id&&!call.payment_intent_id){if((call.cancel_requested_at||startPassed)&&!creation.attempted_at&&!checkout.attempted_at){await deps.releaseHold(call);await store.transition(callId,'cancelled','Call cancelled before authorization.');}else if(checkout.attempted_at){await store.transition(callId,'review','Checkout outcome needs reconciliation; no new payment session will be created.');}return;}
    const refundOp=await store.operation(callId,'refund');
    if(refundOp.attempted_at&&!call.payment_booking_id){
     const refunded=await deps.payments.readRefund(paymentInput(call,checkout),key(call,refundOp));
     if(refunded?.status==='succeeded'&&refunded.amountCents===call.financial_snapshot.customerTotalCents){
      if(creation.attempted_at){const cancelled=await deps.calendly.read(call,creation.id);if(cancelled.status!=='found'||cancelled.mapping.status!=='canceled')throw new Error('Refunded calendar outcome needs review');}
      await store.finish(refundOp.id,{refundId:refunded.id});await deps.releaseHold(call);await store.transition(callId,'cancelled','Appointment cancelled and payment refunded.');return;
     }
     await store.transition(callId,'review','Refund completion requires review.');return;
    }
    payment=await deps.payments.read(paymentInput(call,checkout));
    if(payment&&!paymentMatches(payment,call))throw new Error('Payment identity mismatch');
    if(payment?.id&&payment.id!==call.payment_intent_id){await store.patch(callId,{payment_intent_id:payment.id});call.payment_intent_id=payment.id;}
   }
   let mapping:CallMapping|null=null;
   const rejected=Boolean(creation.completed_at&&creation.result&&typeof creation.result==='object'&&'rejected' in creation.result&&creation.result.rejected===true);
   if((creation.attempted_at&&!rejected)||call.external_event_uri){
    const found=await deps.calendly.read(call,creation.id);
    if(found.status==='unavailable' && call.state==='confirmed' && !call.cancel_requested_at && !linkedCancellation
      && call.external_event_uri && call.external_invitee_uri && call.meeting_url
      && (call.billing_mode==='free' || (call.payment_booking_id && payment?.status==='captured'
        && payment.amountReceivedCents===call.financial_snapshot.customerTotalCents && payment.chargeId))
      && await store.deferCalendarCheck(callId,found.localRateLimited===true)) return;
    if(found.status!=='found'){await store.transition(callId,'review',found.status==='ambiguous'?'Multiple calendar results require review. Do not retry booking.':'Calendar booking outcome is still unknown. Do not retry.');return;}
    mapping=found.mapping;await persistMapping(store,call,mapping);
   }
   // Only authenticated persisted requests can cancel a settled appointment. Native
   // refund policy owns all money movement; this engine supplies external proof.
   if(linkedCancellation){
    if(!mapping||!deps.finishLinkedCancellation)throw new Error('Linked cancellation mapping or coordinator missing');
    await store.freezeLinkedBooking(callId,'Coordinated call cancellation in progress.');
    const cancel=await store.operation(callId,'cancel_invitee');
    if(mapping.status!=='canceled'){
     if(!await store.claim(cancel.id)){await store.transition(callId,'review','Calendar cancellation is awaiting verified completion.');return;}
     mapping=await deps.calendly.cancel(call,mapping);safeMapping(mapping);
     if(mapping.status!=='canceled')throw new Error('Cancellation not verified');
    }
    if(!cancel.attempted_at)await store.claim(cancel.id);
    await store.finish(cancel.id,{eventUri:mapping.eventUri,inviteeUri:mapping.inviteeUri});
    const result=await deps.finishLinkedCancellation(call,mapping,cancel.id);
    if(result==='completed'){await deps.releaseHold(call);await store.transition(callId,'cancelled','Appointment cancelled. The applicable cancellation policy has been applied.');}
    else {const pending=await store.get(callId);await store.transition(callId,'review',pending?.last_error??'Appointment cancelled; settlement is still being reconciled.');}
    return;
   }
   // Cancellation after native settlement belongs to existing refund/payout policy.
   if(call.payment_booking_id&&(call.cancel_requested_at||mapping?.status==='canceled'||mapping?.meetingStatus==='failed'||payment?.status!=='captured')){
    await store.freezeLinkedBooking(callId,'Calendly cancellation requires coordinated refund review.');await store.transition(callId,'review','Appointment/payment changes require support review. Payment is held.');return;
   }
   const cancelNeeded=Boolean((startPassed&&!creation.attempted_at)||rejected||call.cancel_requested_at||mapping?.status==='canceled'||mapping?.meetingStatus==='failed'||payment?.status==='failed'||payment?.status==='cancelled'||(payment?.status==='captured'&&!mapping));
   if(cancelNeeded){await compensate(store,call,creation,checkout,mapping,payment,deps);return;}
   if(call.billing_mode==='free'&&call.state==='confirmed'&&mapping?.status==='active'&&mapping.meetingStatus==='ready'){await store.confirmed(callId,{});return;}
   if(!mapping){
    if(call.billing_mode==='paid'&&(!payment||payment.status==='pending'))return;
    if(call.billing_mode==='paid'&&(!payment||!authorizationUsable(payment,call,now))){await compensate(store,call,creation,checkout,null,payment,deps);return;}
    try {await deps.validate(call);await deps.calendly.prepare(call);}catch {await compensate(store,call,creation,checkout,null,payment,deps);return;}
    // Reload cancellation immediately before irreversible dispatch. A concurrent
    // cancellation after this point is reconciled after the durable mapping.
    const fresh=await store.get(callId);if(!fresh||fresh.cancel_requested_at){await compensate(store,call,creation,checkout,null,payment,deps);return;}
    if(!await store.claim(creation.id)){await store.transition(callId,'review','Calendar creation already attempted; awaiting reconciliation.');return;}
    await store.patch(callId,{state:'scheduling'});
    try {mapping=await deps.calendly.create(call,creation.id);}
    catch(error){const outcome=error&&typeof error==='object'&&'outcome' in error?error.outcome:null;
     if(outcome==='not_sent'||outcome==='rejected'){await store.finish(creation.id,{rejected:true});creation.completed_at=new Date(now).toISOString();creation.result={rejected:true};await compensate(store,call,creation,checkout,null,payment,deps);return;}
     await store.transition(callId,'review','Calendar booking outcome is unknown. Do not retry.');return;}
    await persistMapping(store,call,mapping);await store.finish(creation.id,{eventUri:mapping.eventUri,inviteeUri:mapping.inviteeUri});
   }
   call=(await store.get(callId))!;
   if(!call||['cancelled','failed','completed'].includes(call.state))return;
   if(call.cancel_requested_at||mapping.status==='canceled'||mapping.meetingStatus==='failed'){await compensate(store,call,creation,checkout,mapping,payment,deps);return;}
   if(mapping.meetingStatus!=='ready'||!mapping.meetingUrl){if(call.billing_mode==='paid'&&(!payment||!authorizationUsable(payment,call,deps.now?.()??Date.now()))){await compensate(store,call,creation,checkout,mapping,payment,deps);return;}await store.patch(callId,{state:'confirming'});return;}
   if(!call.payment_booking_id){try{await deps.validate(call);}catch{await compensate(store,call,creation,checkout,mapping,payment,deps);return;}}
   if(call.billing_mode==='free'){await store.confirmed(callId,{});return;}
   payment=await deps.payments.read(paymentInput(call,checkout));
   if(!payment||!paymentMatches(payment,call))throw new Error('Payment unavailable');
   if(payment.status==='captured'){
    if(payment.amountReceivedCents!==call.financial_snapshot.customerTotalCents||!payment.chargeId)throw new Error('Capture amount/charge mismatch');
    await store.confirmed(callId,{paymentIntentId:payment.id,chargeId:payment.chargeId});return;
   }
   if(!authorizationUsable(payment,call,deps.now?.()??Date.now())){await compensate(store,call,creation,checkout,mapping,payment,deps);return;}
   const capture=await store.operation(callId,'capture');
   if(!await store.claim(capture.id)){await compensate(store,call,creation,checkout,mapping,payment,deps);return;}
   await store.patch(callId,{state:'confirming'});
   const captured=await deps.payments.capture(paymentInput(call,checkout),key(call,capture));
   if(!paymentMatches(captured,call)||captured.status!=='captured'||captured.amountReceivedCents!==call.financial_snapshot.customerTotalCents||!captured.chargeId)throw new Error('Capture not verified');
   await store.finish(capture.id,{paymentIntentId:captured.id});
   const latest=await store.get(callId);if(!latest)throw new Error('Call missing');
   if(latest.cancel_requested_at){await compensate(store,latest,creation,checkout,mapping,captured,deps);return;}
   await store.confirmed(callId,{paymentIntentId:captured.id,chargeId:captured.chargeId});
  }catch {await store.transition(callId,'review',errorMessage);}
 });
}
async function compensate(store:CallStore,call:CalendlyCallRow,creation:CallOperation,checkout:CallOperation,mapping:CallMapping|null,payment:PaymentEvidence|null,deps:CallEngineDependencies){
 if(call.payment_booking_id){await store.freezeLinkedBooking(call.id,'Coordinated cancellation required.');await store.transition(call.id,'review','Appointment/payment changes require support review.');return;}
 await store.patch(call.id,{state:'cancelling'});
 if(mapping&&mapping.status!=='canceled'){
  const cancel=await store.operation(call.id,'cancel_invitee');
  if(!await store.claim(cancel.id)){await store.transition(call.id,'review','Calendar cancellation is awaiting verified completion.');return;}
  mapping=await deps.calendly.cancel(call,mapping);if(mapping.status!=='canceled')throw new Error('Cancellation not verified');await store.finish(cancel.id,{eventUri:mapping.eventUri});
 }
 if(!mapping&&creation.attempted_at&&!creation.completed_at)throw new Error('Uncertain calendar creation');
 if(call.billing_mode==='paid'){
  const input=paymentInput(call,checkout);
  if(payment?.status==='captured'){
   const refund=await store.operation(call.id,'refund');let result=await deps.payments.readRefund(input,key(call,refund));
   if(!result&&await store.claim(refund.id))result=await deps.payments.refund(input,key(call,refund));
   if(!result||result.status!=='succeeded'||result.amountCents!==call.financial_snapshot.customerTotalCents){await store.transition(call.id,'review','Appointment cancelled; refund completion needs review.');return;}
   await store.finish(refund.id,{refundId:result.id});
  }else if(payment?.status!=='cancelled'){
   const cancel=await store.operation(call.id,'cancel_authorization');
   if(!await store.claim(cancel.id)){await store.transition(call.id,'review','Authorization release is awaiting verified completion.');return;}
   const result=await deps.payments.cancel(input,key(call,cancel));if(result?(result.status!=='cancelled'||!paymentMatches(result,call)):Boolean(call.payment_intent_id||!call.checkout_session_id))throw new Error('Authorization cancellation not verified');await store.finish(cancel.id,{paymentIntentId:result?.id??null,checkoutExpired:result===null});
  }
 }
 await deps.releaseHold(call);await store.transition(call.id,'cancelled','Call cancelled. Any captured payment has been refunded; uncaptured authorizations were released.');
}
