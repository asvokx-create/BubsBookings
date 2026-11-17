import 'server-only';
import { database } from '@/lib/database';
import { calendlyCallRequest } from '@/lib/calendly';
import {readCalendlyCallOffer} from '@/lib/calendly-call-api';
export class CallRequestError extends Error { constructor(message:string,public status=409){super(message);} }
export function requireCallsEnabled(){if(process.env.CALENDLY_CALL_BOOKINGS_ENABLED!=='true')throw new CallRequestError('Call bookings are not enabled.',404);}
export function requireExistingCallsEnabled(){if(process.env.CALENDLY_CALL_BOOKINGS_ENABLED!=='true'&&process.env.CALENDLY_CALL_RECOVERY_ENABLED!=='true')throw new CallRequestError('Call bookings are unavailable.',404);}
export type CallOffer={id:string;service_id:string;provider_id:string;provider_user_id:string;connection_id:string;connection_generation:string;owner_uri:string;event_type_uri:string;event_name:string;duration_minutes:number;location_kind:string;buffer_before_minutes:number;buffer_after_minutes:number;billing_mode:'free'|'paid';service_price_cents:number;revision:string;active:boolean};
export const ELIGIBLE_OFFER=`SELECT o.*,p.user_id AS provider_user_id FROM calendly_call_offers o
 JOIN services s ON s.id=o.service_id JOIN provider_profiles p ON p.id=o.provider_id AND s.provider_id=p.id
 JOIN provider_companies company ON company.id=s.company_id AND company.is_active=true
 JOIN provider_calendly_connections c ON c.id=o.connection_id AND c.provider_id=p.id
 WHERE o.active=true AND s.is_active=true AND s.provider_deleted_at IS NULL AND s.delivery_type IN ('REMOTE','BOTH')
 AND p.is_active=true AND p.age_verification_status='verified' AND c.disconnected_at IS NULL
 AND c.connected_at::text=o.connection_generation AND c.calendly_user_uri=o.owner_uri`;
export function offerTransport(o:CallOffer,request?:Request){return (method:'GET'|'POST',path:string,body?:unknown)=>calendlyCallRequest({connectionId:o.connection_id,providerId:o.provider_id,ownerUri:o.owner_uri,connectedAt:o.connection_generation},method,path,body,request);}
export async function publishCallOffer(userId:string,serviceId:string,draftRevision:string,request:Request){
 requireCallsEnabled();
 const draft=(await database.query<CallOffer & {draft_revision:string}>(`SELECT d.service_id::text,s.provider_id::text,p.user_id AS provider_user_id,d.connection_id::text,d.connection_connected_at::text AS connection_generation,d.calendly_user_uri AS owner_uri,d.event_type_uri,d.duration_minutes,d.billing_mode,d.service_price_cents,d.revision::text AS draft_revision
 FROM service_calendly_call_drafts d JOIN services s ON s.id=d.service_id JOIN provider_profiles p ON p.id=s.provider_id
 JOIN provider_calendly_connections c ON c.id=d.connection_id AND c.provider_id=p.id AND c.disconnected_at IS NULL AND c.connected_at=d.connection_connected_at AND c.calendly_user_uri=d.calendly_user_uri
 WHERE s.id::text=$1 AND p.user_id=$2 AND d.revision::text=$3 AND p.is_active=true AND p.age_verification_status='verified' AND s.provider_deleted_at IS NULL AND s.delivery_type IN ('REMOTE','BOTH')`,[serviceId,userId,draftRevision])).rows[0];
 if(!draft)throw new CallRequestError('Draft changed or connection is unavailable.');
 const verified=await readCalendlyCallOffer(offerTransport(draft,request),draft.owner_uri,draft.event_type_uri);
 if(verified.durationMinutes!==draft.duration_minutes)throw new CallRequestError('Event duration changed. Update your private draft.');
 const result=await database.query(`INSERT INTO calendly_call_offers(service_id,provider_id,connection_id,connection_generation,owner_uri,event_type_uri,event_name,duration_minutes,location_kind,buffer_before_minutes,buffer_after_minutes,billing_mode,service_price_cents,active,published_at)
 SELECT d.service_id,s.provider_id,d.connection_id,d.connection_connected_at::text,d.calendly_user_uri,d.event_type_uri,$4,d.duration_minutes,'zoom_conference',$5,$6,d.billing_mode,d.service_price_cents,true,now()
 FROM service_calendly_call_drafts d JOIN services s ON s.id=d.service_id JOIN provider_profiles p ON p.id=s.provider_id JOIN provider_calendly_connections c ON c.id=d.connection_id
 WHERE s.id::text=$1 AND p.user_id=$2 AND d.revision::text=$3 AND c.disconnected_at IS NULL AND c.provider_id=p.id AND c.connected_at=d.connection_connected_at AND c.calendly_user_uri=d.calendly_user_uri
 ON CONFLICT(service_id) DO UPDATE SET connection_id=excluded.connection_id,connection_generation=excluded.connection_generation,owner_uri=excluded.owner_uri,event_type_uri=excluded.event_type_uri,event_name=excluded.event_name,duration_minutes=excluded.duration_minutes,buffer_before_minutes=excluded.buffer_before_minutes,buffer_after_minutes=excluded.buffer_after_minutes,billing_mode=excluded.billing_mode,service_price_cents=excluded.service_price_cents,revision=gen_random_uuid(),active=true,published_at=now(),updated_at=now() RETURNING id`,[serviceId,userId,draftRevision,verified.name,verified.beforeBufferMinutes,verified.afterBufferMinutes]);
 if(!result.rowCount)throw new CallRequestError('Draft or connection changed. Refresh before publishing.');
}
export async function publicCallOffer(serviceId:string,request:Request){requireCallsEnabled();const o=(await database.query<CallOffer>(ELIGIBLE_OFFER+' AND o.service_id::text=$1',[serviceId])).rows[0];if(!o)return null;
 const transport=offerTransport(o,request);const verified=await readCalendlyCallOffer(transport,o.owner_uri,o.event_type_uri);if(verified.durationMinutes!==o.duration_minutes||verified.beforeBufferMinutes!==o.buffer_before_minutes||verified.afterBufferMinutes!==o.buffer_after_minutes)throw new CallRequestError('Offer settings changed.');
 const start=new Date(Date.now()+60_000),end=new Date(start.getTime()+6*86400000);
 const response=await transport('GET','/event_type_available_times?'+new URLSearchParams({event_type:o.event_type_uri,start_time:start.toISOString(),end_time:end.toISOString()})) as {collection?:{status?:string;invitees_remaining?:number;start_time?:string}[]};
 if(!(await database.query(ELIGIBLE_OFFER+' AND o.id=$1 AND o.revision=$2',[o.id,o.revision])).rowCount)throw new CallRequestError('Offer changed.');
 return {id:o.id,revision:o.revision,name:o.event_name,durationMinutes:o.duration_minutes,billingMode:o.billing_mode,subtotalCents:o.service_price_cents,totalCents:o.service_price_cents+(o.billing_mode==='paid'?299:0),slots:(response.collection??[]).filter(s=>s.status==='available'&&s.invitees_remaining===1&&typeof s.start_time==='string'&&Number.isFinite(Date.parse(s.start_time))).map(s=>s.start_time!)};
}
