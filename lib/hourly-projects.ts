import "server-only";
import type { PoolClient } from "pg";
import { database } from "@/lib/database";
import { calculateHourlyProjectPrice, cappedTimerSeconds } from "@/lib/hourly-project-pricing";
import { serviceSupportsMethod, isServiceDeliveryType } from "@/lib/service-delivery";
import { checkAndRecordContent } from "@/lib/content-safety";

export class HourlyProjectError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
type Body = Record<string, unknown>;
type ProjectRow = { id:string; customer_id:string; provider_id:string; service_id:string; status:string; title:string; description:string; hourly_rate_cents:number; cap_minutes:number; version:number; delivery_method:string; service_address:string; access_instructions:string; payment_booking_id:string|null; submitted_seconds:number|null; submitted_minutes:number|null; submitted_subtotal_cents:number|null; provider_user_id:string; provider_name:string; customer_name:string; payment_status:string|null; created_at:Date; updated_at:Date; submitted_at:Date|null; approved_at:Date|null };
type Entry = { id:string; project_id:string; provider_id:string; started_at:Date; ended_at:Date|null; duration_seconds:number; description:string; source:string; timer_limit_seconds:number|null };
const selectProject = `SELECT h.*, p.user_id AS provider_user_id,p.business_name AS provider_name,u.name AS customer_name,b.payment_status FROM hourly_projects h JOIN provider_profiles p ON p.id=h.provider_id JOIN "user" u ON u.id=h.customer_id LEFT JOIN bookings b ON b.id=h.payment_booking_id`;
const text = (value:unknown, max:number) => { const result = typeof value === "string" ? value.trim() : ""; if(result.length > max) throw new HourlyProjectError("Text is too long."); return result; };
const integer = (value:unknown, max=525600) => { if(typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw new HourlyProjectError("Enter a valid whole number of minutes."); return value; };
function permitted(p:ProjectRow,userId:string) { if(p.customer_id!==userId && p.provider_user_id!==userId) throw new HourlyProjectError("Project not found.",404); }
async function assertAccountEligible(client:PoolClient,userId:string) {
  const blocked=await client.query("SELECT 1 FROM account_restrictions WHERE user_id=$1 AND status IN ('suspended','banned') AND (expires_at IS NULL OR expires_at>now()) LIMIT 1",[userId]);
  if(blocked.rowCount) throw new HourlyProjectError("Your account is restricted.",403);
}
async function dbNow(client:PoolClient) { return (await client.query<{now:Date}>("SELECT clock_timestamp() AS now")).rows[0].now; }
async function entries(client:PoolClient,id:string) { return (await client.query<Entry>("SELECT * FROM hourly_time_entries WHERE project_id=$1 ORDER BY started_at,id",[id])).rows; }
function seconds(entry:Entry,now:Date) { return entry.ended_at ? entry.duration_seconds : cappedTimerSeconds(entry.started_at,now,entry.timer_limit_seconds!); }
async function view(client:PoolClient,p:ProjectRow,userId:string) {
  const now=await dbNow(client); const rows=await entries(client,p.id);
  const total=rows.reduce((sum,e)=>sum+seconds(e,now),0);
  const history=await client.query<{action:string;version:number;details:unknown;created_at:Date}>("SELECT action,version,details,created_at FROM hourly_project_audit WHERE project_id=$1 ORDER BY version",[p.id]);
  if(p.payment_booking_id) {
    const approvals=await client.query<{metadata:{version?:number};created_at:Date}>("SELECT metadata,created_at FROM booking_events WHERE booking_id=$1 AND event_type='timesheet_approved' ORDER BY created_at",[p.payment_booking_id]);
    for(const approval of approvals.rows) history.rows.push({action:"approve",version:approval.metadata.version ?? p.version,details:approval.metadata,created_at:approval.created_at});
  }
  return {id:p.id,serviceId:p.service_id,providerId:p.provider_id,title:p.title,description:p.description,providerName:p.provider_name,customerName:p.customer_name,role:p.customer_id===userId?"customer":"provider",status:p.status,hourlyRateCents:p.hourly_rate_cents,capMinutes:p.cap_minutes,version:p.version,deliveryMethod:p.delivery_method,serviceAddress:p.customer_id===userId||["active","submitted","approved"].includes(p.status)?p.service_address:"Address available after acceptance",accessInstructions:p.customer_id===userId||["active","submitted","approved"].includes(p.status)?p.access_instructions:"",paymentBookingId:p.payment_booking_id,paymentStatus:p.payment_status,createdAt:p.created_at,updatedAt:p.updated_at,submittedAt:p.submitted_at,approvedAt:p.approved_at,serverNow:now,...calculateHourlyProjectPrice(total,p.hourly_rate_cents),entries:rows.map(e=>({id:e.id,description:e.description,startedAt:e.started_at,endedAt:e.ended_at,durationSeconds:seconds(e,now),source:e.source,timerLimitSeconds:e.timer_limit_seconds})),history:history.rows.map(h=>({action:h.action,version:h.version,details:h.details,createdAt:h.created_at}))};
}
export async function getHourlyProject(userId:string,id:string) {
  const client=await database.connect(); try { const p=(await client.query<ProjectRow>(`${selectProject} WHERE h.id::text=$1`,[id])).rows[0]; if(!p) throw new HourlyProjectError("Project not found.",404); permitted(p,userId); return await view(client,p,userId); } finally {client.release();}
}
export async function listHourlyProjects(userId:string) {
  const client=await database.connect(); try { const rows=await client.query<ProjectRow>(`${selectProject} WHERE h.customer_id=$1 OR p.user_id=$1 ORDER BY h.created_at DESC LIMIT 200`,[userId]); return await Promise.all(rows.rows.map(p=>view(client,p,userId))); } finally {client.release();}
}
async function audit(client:PoolClient,id:string,userId:string,action:string,version:number,details:unknown) { await client.query("INSERT INTO hourly_project_audit(project_id,actor_id,action,version,details) VALUES($1,$2,$3,$4,$5::jsonb)",[id,userId,action,version,JSON.stringify(details)]); }
async function notifyProject(client:PoolClient,id:string,userId:string,action:string,version:number,provider:boolean) {
  const titles:Record<string,string>={create:"New hourly project request",accept:"Hourly project accepted",submit:"Review your final timesheet",cancel:"Hourly project cancelled",request_changes:"Timesheet correction requested",increase_cap:"Project hours cap increased"};
  if(!titles[action]) return;
  await client.query("INSERT INTO notifications(user_id,type,title,message,href,dedupe_key) VALUES($1,'hourly_project',$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING",[userId,titles[action],"Open the project to review the latest update.",`${provider?"/provider/dashboard/projects":"/account/projects"}/${id}`,`hourly-project-${id}-${version}-${userId}`]);
}
export async function createHourlyProject(userId:string,body:Body) {
  const serviceId=text(body.serviceId,80),title=text(body.title,160),description=text(body.description,3000),cap=integer(body.capMinutes);
  if(description.length<3) throw new HourlyProjectError("Describe the work you need.");
  const method=body.deliveryMethod; if(method!=="REMOTE" && method!=="IN_PERSON") throw new HourlyProjectError("Choose a delivery method.");
  const line1=text(body.addressLine1,120),line2=text(body.addressLine2,80),city=text(body.city,80),state=text(body.state,2).toUpperCase(),postal=text(body.postalCode,10),access=text(body.accessInstructions,500);
  const states="AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" ");
  if(method==="IN_PERSON" && (!line1 || !city || !states.includes(state) || !/^\d{5}(?:-\d{4})?$/.test(postal))) throw new HourlyProjectError("Complete the US service address.");
  const address=method==="REMOTE"?"Remote service":[line1,line2,`${city}, ${state} ${postal}`].filter(Boolean).join(", ");
  if(address.length>320) throw new HourlyProjectError("The service address is too long.");
  const safety=await checkAndRecordContent({userId,surface:"booking",fields:[title,description,address,access]}); if(!safety.allowed) throw new HourlyProjectError(safety.message ?? "Please revise the project text.",422);
  const client=await database.connect(); let id:string;
  try { await client.query("BEGIN"); await assertAccountEligible(client,userId); await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`hourly-create:${userId}:${serviceId}`]);
    const service=(await client.query<{id:string;provider_id:string;user_id:string;title:string;hourly_rate_cents:number;delivery_type:string}>(`SELECT s.id,s.provider_id,p.user_id,s.title,s.hourly_rate_cents,s.delivery_type FROM services s JOIN provider_profiles p ON p.id=s.provider_id WHERE s.id::text=$1 AND s.is_active=true AND s.provider_deleted_at IS NULL AND s.pricing_type='HOURLY' AND p.is_active=true AND p.age_verification_status='verified' FOR SHARE OF s,p`,[serviceId])).rows[0];
    if(!service) throw new HourlyProjectError("This hourly service is not available.",409);
    await assertAccountEligible(client,service.user_id);
    if(service.user_id===userId) throw new HourlyProjectError("You cannot request your own service.");
    if(!isServiceDeliveryType(service.delivery_type)||!serviceSupportsMethod(service.delivery_type,method)) throw new HourlyProjectError("That delivery method is not available.");
    calculateHourlyProjectPrice(cap*60,service.hourly_rate_cents);
    const existing=(await client.query<{id:string}>("SELECT id FROM hourly_projects WHERE customer_id=$1 AND service_id=$2 AND status IN ('requested','active','submitted') LIMIT 1",[userId,service.id])).rows[0];
    if(existing) { id=existing.id; } else {
      id=(await client.query<{id:string}>("INSERT INTO hourly_projects(customer_id,provider_id,service_id,title,description,hourly_rate_cents,cap_minutes,delivery_method,service_address,access_instructions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",[userId,service.provider_id,service.id,title||service.title,description,service.hourly_rate_cents,cap,method,address,access])).rows[0].id;
      await audit(client,id,userId,"create",1,{description,capMinutes:cap});
      await notifyProject(client,id,service.user_id,"create",1,true);
    }
    await client.query("COMMIT");
  } catch(e) {await client.query("ROLLBACK");throw e;} finally {client.release();}
  return getHourlyProject(userId,id!);
}

export async function mutateHourlyProject(userId:string,id:string,body:Body) {
  const action=text(body.action,40),description=text(body.description,3000);
  if(description) { const safety=await checkAndRecordContent({userId,surface:"booking",fields:[description]}); if(!safety.allowed) throw new HourlyProjectError(safety.message ?? "Please revise the project text.",422); }
  const client=await database.connect();
  try {
    await client.query("BEGIN");
    const initial=(await client.query<ProjectRow>(`${selectProject} WHERE h.id::text=$1`,[id])).rows[0]; if(!initial) throw new HourlyProjectError("Project not found.",404); permitted(initial,userId);
    // All provider timer operations use this lock before any project row lock.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`hourly-provider:${initial.provider_id}`]);
    const p=(await client.query<ProjectRow>(`${selectProject} WHERE h.id=$1 FOR UPDATE OF h`,[id])).rows[0];
    if(body.version!==p.version) throw new HourlyProjectError("The project changed. Refresh before trying again.",409);
    const provider=p.provider_user_id===userId,customer=p.customer_id===userId;
    if(p.status==="approved"||p.status==="cancelled"||p.payment_booking_id) throw new HourlyProjectError("This project is locked.",409);
    const providerActions=["accept","start","stop","add_entry","edit_entry","delete_entry","submit"];
    if(providerActions.includes(action)&&!provider) throw new HourlyProjectError("Only the provider can do that.",403);
    if(["request_changes","increase_cap"].includes(action)&&!customer) throw new HourlyProjectError("Only the customer can do that.",403);
    if(![...providerActions,"request_changes","increase_cap","cancel"].includes(action)) throw new HourlyProjectError("Unknown project action.");
    await assertAccountEligible(client,userId);
    if(provider && providerActions.includes(action)) {
      const eligible=await client.query("SELECT 1 FROM provider_profiles WHERE id=$1 AND is_active=true AND age_verification_status='verified' FOR SHARE",[p.provider_id]);
      if(!eligible.rowCount) throw new HourlyProjectError("An active, verified provider account is required.",403);
    }
    const now=await dbNow(client);
    // Settle exhausted unattended timers without billing beyond their original allowance.
    await client.query(`UPDATE hourly_time_entries SET ended_at=started_at+timer_limit_seconds*interval '1 second',duration_seconds=timer_limit_seconds WHERE provider_id=$1 AND ended_at IS NULL AND started_at+timer_limit_seconds*interval '1 second'<=$2`,[p.provider_id,now]);
    const rows=await entries(client,id); const running=rows.find(e=>!e.ended_at); const total=rows.reduce((sum,e)=>sum+seconds(e,now),0);
    let status=p.status; let cap=p.cap_minutes; let snapshot:{totalSeconds:number;billableMinutes:number;subtotalCents:number}|null=null;
    if(action==="accept") { if(p.status!=="requested") throw new HourlyProjectError("Only requested projects can be accepted.",409); const eligible=await client.query("SELECT 1 FROM provider_profiles WHERE id=$1 AND is_active=true AND age_verification_status='verified'",[p.provider_id]);if(!eligible.rowCount) throw new HourlyProjectError("Provider verification is required.",403); status="active"; }
    else if(action==="request_changes") {if(p.status!=="submitted"||description.length<3) throw new HourlyProjectError("Explain the correction needed on this submitted timesheet.");status="active";}
    else if(action==="cancel") {if(!["requested","active"].includes(p.status)||running||total>0) throw new HourlyProjectError("Projects with tracked or running time cannot be cancelled. Correct or submit the time first.",409);status="cancelled";}
    else {
      if(p.status!=="active") throw new HourlyProjectError("The project must be active.",409);
      if(action==="increase_cap") {cap=integer(body.capMinutes);if(cap<=p.cap_minutes) throw new HourlyProjectError("The new hours cap must be higher.");calculateHourlyProjectPrice(cap*60,p.hourly_rate_cents);}
      if(action==="start") {
        if(total>=cap*60) throw new HourlyProjectError("The customer hours cap has been reached.",409);
        if((await client.query("SELECT 1 FROM hourly_time_entries WHERE provider_id=$1 AND ended_at IS NULL",[p.provider_id])).rowCount) throw new HourlyProjectError("Stop your running timer before starting another.",409);
        await client.query("INSERT INTO hourly_time_entries(project_id,provider_id,started_at,source,timer_limit_seconds,description) VALUES($1,$2,$3,'timer',$4,$5)",[id,p.provider_id,now,cap*60-total,description]);
      }
      if(action==="stop") {if(!running) { if(!rows.some(e=>e.source==="timer")) throw new HourlyProjectError("There is no running timer.",409); } else { const duration=seconds(running,now);await client.query("UPDATE hourly_time_entries SET ended_at=started_at+$2::integer*interval '1 second',duration_seconds=$2::integer WHERE id=$1",[running.id,duration]);} }
      if(["add_entry","edit_entry","delete_entry"].includes(action)) {
        if(running) throw new HourlyProjectError("Stop the timer before correcting time.",409);
        const entry=rows.find(e=>e.id===body.entryId); if(action!=="add_entry"&&!entry) throw new HourlyProjectError("Time entry not found.",404);
        const duration=action==="delete_entry"?0:integer(body.durationMinutes)*60;
        const nextTotal=total-(action==="add_entry"?0:entry!.duration_seconds)+duration;
        if(nextTotal>cap*60) throw new HourlyProjectError("This time would exceed the customer hours cap.",409);
        calculateHourlyProjectPrice(nextTotal,p.hourly_rate_cents);
        if(action==="delete_entry") await client.query("DELETE FROM hourly_time_entries WHERE id=$1",[entry!.id]);
        else if(action==="edit_entry") await client.query("UPDATE hourly_time_entries SET duration_seconds=$2::integer,ended_at=started_at+$2::integer*interval '1 second',description=$3,source='manual',timer_limit_seconds=NULL WHERE id=$1",[entry!.id,duration,description]);
        else await client.query("INSERT INTO hourly_time_entries(project_id,provider_id,started_at,ended_at,duration_seconds,description,source) VALUES($1,$2,$3::timestamptz-$4::integer*interval '1 second',$3::timestamptz,$4::integer,$5,'manual')",[id,p.provider_id,now,duration,description]);
      }
      if(action==="submit") {if(running||total<1) throw new HourlyProjectError("Stop the timer and record time before submitting.",409);snapshot=calculateHourlyProjectPrice(total,p.hourly_rate_cents);status="submitted";}
    }
    await client.query(`UPDATE hourly_projects SET status=$2::text,cap_minutes=$3,version=version+1,updated_at=$4::timestamptz,submitted_seconds=$5,submitted_minutes=$6,submitted_subtotal_cents=$7,submitted_at=CASE WHEN $2::text='submitted' THEN $4::timestamptz ELSE NULL END WHERE id=$1`,[id,status,cap,now,snapshot?.totalSeconds??null,snapshot?.billableMinutes??null,snapshot?.subtotalCents??null]);
    await audit(client,id,userId,action,p.version+1,{description,entryId:body.entryId??null,durationMinutes:body.durationMinutes??null,capMinutes:cap,beforeEntries:rows});
    const recipient=action==="cancel"?(customer?p.provider_user_id:p.customer_id):["request_changes","increase_cap"].includes(action)?p.provider_user_id:p.customer_id;
    await notifyProject(client,id,recipient,action,p.version+1,recipient===p.provider_user_id);
    await client.query("COMMIT");
  } catch(e) {await client.query("ROLLBACK");throw e;} finally {client.release();}
  return getHourlyProject(userId,id);
}
