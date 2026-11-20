import { calendlyCallRequest } from '@/lib/calendly';
import { prepareCalendlyCall, createCalendlyCallOnce, reconcileCalendlyCall, cancelMappedCalendlyCall, type CalendlyCallIdentity, type CalendlyCallTransport } from './calendly-call-api';
import type { CallEngineDependencies } from './calendly-call-engine';
import type { CalendlyCallRow } from './calendly-call-policy';
import type { CallStore } from './calendly-call-store';

export function calendlyCallIdentity(call:CalendlyCallRow, operationId:string):CalendlyCallIdentity {
 return {connectionId:call.connection_id,providerId:call.provider_id,ownerUri:call.owner_uri,connectedAt:call.connection_generation,
  eventTypeUri:call.event_type_uri,startTime:new Date(call.starts_at).toISOString(),endTime:new Date(call.ends_at).toISOString(),operationId,
  expectedBuffers:{beforeMinutes:call.buffer_before_minutes,afterMinutes:call.buffer_after_minutes},invitee:{...call.attendee_snapshot}};
}
/** No eager IO. Store must use the same durable operations as the engine. */
export function createCalendlyCallRuntimeAdapter(store:Pick<CallStore,'operation'>,request?:Request):CallEngineDependencies['calendly'] {
 const transport=(call:CalendlyCallRow):CalendlyCallTransport=>(method,path,body)=>calendlyCallRequest(
  {connectionId:call.connection_id,providerId:call.provider_id,ownerUri:call.owner_uri,connectedAt:call.connection_generation},method,path,body,request);
 return {
  async prepare(call){
   const prepared=await prepareCalendlyCall(transport(call),calendlyCallIdentity(call,call.id));
   if(Date.parse(prepared.bufferedStartTime)!==Date.parse(call.starts_at)-call.buffer_before_minutes*60000
    ||Date.parse(prepared.bufferedEndTime)!==Date.parse(call.ends_at)+call.buffer_after_minutes*60000)throw new Error('Calendly buffers changed; select the call again.');
  },
  create(call,operationId){return createCalendlyCallOnce(transport(call),calendlyCallIdentity(call,operationId));},
  read(call,operationId){
   if(Boolean(call.external_event_uri)!==Boolean(call.external_invitee_uri))return Promise.resolve({status:'unknown' as const});
   const refs=call.external_event_uri&&call.external_invitee_uri?{eventUri:call.external_event_uri,inviteeUri:call.external_invitee_uri}:undefined;
   return reconcileCalendlyCall(transport(call),calendlyCallIdentity(call,operationId),refs);
  },
  async cancel(call,mapping){
   const creation=await store.operation(call.id,'create_invitee');
   if(!creation.attempted_at)throw new Error('Cannot cancel an appointment without its original creation operation.');
   return cancelMappedCalendlyCall(transport(call),calendlyCallIdentity(call,creation.id),mapping);
  },
 };
}
