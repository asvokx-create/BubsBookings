'use client';
import {useState} from 'react';
export type CallCancellationView={appointmentCancelled:boolean;settlementReview:boolean;canRequest:boolean;windowHours:number;policy:string;cutoffAt:string;late:boolean;status:string;refundStatus:string|null};
export default function CalendlyPaidCallCancellation({policy,isProvider,busy,onRequest}:{policy:CallCancellationView;isProvider:boolean;busy:boolean;onRequest:(reason:string,windowHours:number,expectedLateCancellation:boolean)=>Promise<void>}){
 const[open,setOpen]=useState(false),[reason,setReason]=useState('');
 return <section className="space-y-2">
  {policy.status==='none'&&<p>{policy.policy}</p>}
  <p>{policy.status==='none'?'Current cancellation notice:':'Applied cancellation notice:'} {policy.windowHours} hours. {policy.windowHours>0&&<>Notice deadline: {new Date(policy.cutoffAt).toLocaleString()}.</>}</p>
  {policy.settlementReview?<p>The appointment is cancelled. This was a late cancellation under the applied policy, so there is no automatic refund. Settlement of the held funds is under review. No payout or refund is promised. Updates appear in BubsBookings.</p>:policy.status!=='none'&&<p>{policy.appointmentCancelled?'The appointment is cancelled. ':''}Cancellation: {policy.status}. Refund: {policy.refundStatus??'not yet verified'}. A cancellation request is not confirmation of a refund. Updates appear in BubsBookings.</p>}
  {policy.canRequest&&<>
   <p>{isProvider?'Provider cancellation requests a refund through the existing policy before payout release.':policy.late?'This is a late cancellation under the current policy. No automatic refund is promised.':'Cancellation before the notice deadline requests a refund through the existing policy before payout release.'} Refunds remain subject to payment verification and review; released payouts or payment issues may need support. The current policy and deadline are checked when you submit. Do not cancel independently in Calendly.</p>
   {!open?<button disabled={busy} onClick={()=>setOpen(true)}>Review paid call cancellation</button>:<form onSubmit={e=>{e.preventDefault();void onRequest(reason,policy.windowHours,policy.late);}} className="space-y-2">
    <label className="block">Cancellation reason<textarea required minLength={3} maxLength={500} value={reason} onChange={e=>setReason(e.target.value)} className="block w-full rounded border p-2"/></label>
    <p>Submitting requests cancellation of this Calendly meeting and applies the current booking refund policy. Completion is verified in the background, not immediate.</p>
    <button type="button" disabled={busy} onClick={()=>setOpen(false)}>Keep call</button>
    <button disabled={busy||reason.trim().length<3} type="submit">Confirm cancellation request</button>
   </form>}
  </>}
 </section>;
}
