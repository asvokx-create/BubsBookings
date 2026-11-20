/** Pure contract. No provider API calls or credentials. */
export type CallState = 'requested'|'accepted'|'authorizing'|'scheduling'|'confirming'|'confirmed'|'cancelling'|'cancelled'|'review'|'failed'|'completed';
export type CallMode = 'test'|'live';
export type CallFinancialSnapshot = {
 serviceSubtotalCents:number; customerServiceFeeCents:number; customerTotalCents:number;
 providerPlan:'starter'|'pro'|'business'|'owner'; providerFeeBasisPoints:number; providerFeeCapCents:number|null; providerFeeCents:number; providerNetCents:number;
};
export type CalendlyCallRow = {
 id:string; request_key:string; customer_id:string; provider_id:string; provider_user_id:string; service_id:string;
 offer_id:string; offer_revision:string; connection_id:string; connection_generation:string; owner_uri:string;
 event_type_uri:string; event_name:string; location_kind:string; starts_at:string; ends_at:string;
 buffer_before_minutes:number; buffer_after_minutes:number; billing_mode:'free'|'paid'; stripe_mode:CallMode;
 financial_snapshot:CallFinancialSnapshot; attendee_snapshot:{name:string;email:string;timezone:string};
 state:CallState; version:number; provider_accepted_at:string|null; cancel_requested_at:string|null;
 stripe_customer_id:string|null; checkout_session_id:string|null; payment_intent_id:string|null;
 checkout_origin:string|null; external_event_uri:string|null; external_invitee_uri:string|null; meeting_url:string|null;
 calendar_check_pending?:boolean; payment_booking_id:string|null; last_error:string|null; created_at:string;
};
export type CallOperationKind = 'create_checkout'|'create_invitee'|'capture'|'cancel_invitee'|'cancel_authorization'|'refund';
export type CallOperation = {id:string; call_id:string; kind:CallOperationKind; attempted_at:string|null; completed_at:string|null; result:unknown; created_at:string};
export function validCallFinancials(call:Pick<CalendlyCallRow,'billing_mode'|'financial_snapshot'>) {
 const f=call.financial_snapshot;
 if(!f || !['starter','pro','business','owner'].includes(f.providerPlan)) return false;
 for(const key of ['serviceSubtotalCents','customerServiceFeeCents','customerTotalCents','providerFeeBasisPoints','providerFeeCents','providerNetCents'] as const) if(!Number.isSafeInteger(f[key])||f[key]<0) return false;
 if(f.providerFeeBasisPoints>10000)return false;
 if(f.providerFeeCapCents!==null&&(!Number.isSafeInteger(f.providerFeeCapCents)||f.providerFeeCapCents<0)) return false;
 if(f.customerTotalCents!==f.serviceSubtotalCents+f.customerServiceFeeCents||f.providerNetCents!==f.serviceSubtotalCents-f.providerFeeCents) return false;
 if(call.billing_mode==='free') return f.serviceSubtotalCents===0&&f.customerTotalCents===0&&f.providerFeeCents===0&&f.providerNetCents===0;
 return call.billing_mode==='paid'&&f.serviceSubtotalCents>=50&&f.serviceSubtotalCents<=100_000_000&&f.customerTotalCents<=100_000_299;
}
export function authorizationUsable(evidence:{status:string;captureBefore:string|null;totalCents:number;currency:string;mode:string;callId:string},call:CalendlyCallRow,nowMs:number) {
 return evidence.status==='authorized'&&evidence.callId===call.id&&evidence.mode===call.stripe_mode&&evidence.currency==='usd'&&evidence.totalCents===call.financial_snapshot.customerTotalCents&&evidence.captureBefore!==null&&Date.parse(evidence.captureBefore)>nowMs+120_000;
}
export function paymentMatches(evidence:{callId:string;mode:string;currency:string;totalCents:number},call:CalendlyCallRow) {
 return evidence.callId===call.id&&evidence.mode===call.stripe_mode&&evidence.currency==='usd'&&evidence.totalCents===call.financial_snapshot.customerTotalCents;
}
