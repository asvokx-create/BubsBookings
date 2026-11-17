import Link from 'next/link';
import {redirect} from 'next/navigation';
import {getAdminSession} from '@/lib/admin';
import {readCallReviewQueue} from '@/lib/calendly-call-admin';
export const dynamic='force-dynamic';
export default async function CallReviewPage(){
 if(!await getAdminSession())redirect('/account');
 const calls=process.env.CALENDLY_CALL_BOOKINGS_ENABLED==='true'||process.env.CALENDLY_CALL_RECOVERY_ENABLED==='true'?await readCallReviewQueue():[];
 return <main className="mx-auto max-w-5xl space-y-5 px-4 py-10"><Link href="/admin">Back to administration</Link><h1 className="text-3xl font-bold">Call recovery review</h1><p>Read-only queue. An uncertain response is not proof that an appointment or payment failed. Do not create a replacement booking, retry a charge, release a reservation, or promise a refund without verifying the existing records.</p>{!calls.length&&<p>No calls currently awaiting review, or call recovery is disabled.</p>}{calls.map(call=><article key={call.id} className="rounded-xl border p-4 space-y-2"><h2 className="font-bold">{call.event_name}</h2><p>Reference: {call.id}</p><p>{call.billing_mode} · {call.starts_at} · {call.state}</p><p>{call.last_error??'Review required.'}</p><p>Calendar mapping: {call.has_booking?'recorded':'not confirmed'}; payment reference: {call.has_payment?'recorded':'not confirmed'}.</p><p>Unresolved operations: {call.operation_kinds.join(', ')||'check reconciliation evidence'}</p><p>Last update: {call.updated_at}</p></article>)}</main>;
}
