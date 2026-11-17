import 'server-only';
import {database} from '@/lib/database';
import {adminNotificationEmails} from '@/lib/admin';
/** Alerts contain no attendee email, video token, payment secret, or raw API body. */
export async function deliverCallReviewAlerts(){
 const result=await database.query(`INSERT INTO notifications(user_id,type,title,message,href,dedupe_key)
 SELECT u.id,'calendly_call_review','Call needs review','A call has an uncertain calendar or payment outcome. Do not recreate the booking or charge.','/admin/calendly-calls','calendly-call-review-'||c.id::text||'-'||u.id
 FROM calendly_calls c CROSS JOIN "user" u WHERE c.state='review' AND (lower(u.email)=ANY($1::text[]) OR EXISTS(SELECT 1 FROM bookme_admins a WHERE a.user_id=u.id))
 ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,[adminNotificationEmails()]);
 return result.rowCount??0;
}
export async function readCallReviewQueue(){
 return (await database.query<{id:string;event_name:string;state:string;billing_mode:string;starts_at:string;last_error:string|null;updated_at:string;operation_kinds:string[];has_booking:boolean;has_payment:boolean}>(`SELECT c.id::text,c.event_name,c.state,c.billing_mode,c.starts_at::text,c.last_error,c.updated_at::text,
 ARRAY(SELECT o.kind FROM calendly_call_operations o WHERE o.call_id=c.id AND o.attempted_at IS NOT NULL AND o.completed_at IS NULL ORDER BY o.created_at) AS operation_kinds,
 c.external_event_uri IS NOT NULL AS has_booking,c.payment_intent_id IS NOT NULL AS has_payment FROM calendly_calls c WHERE c.state='review' ORDER BY c.updated_at LIMIT 100`)).rows;
}
