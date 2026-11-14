import { NextResponse } from "next/server";
import { database } from "@/lib/database";
import { getProviderAccess } from "@/lib/provider-access";
import { enforceRateLimit, recordActivity } from "@/lib/request-security";
import { MANUAL_JOB_PREFIX, parseManualJob } from "@/lib/manual-job";

export async function POST(request: Request) {
  const access = await getProviderAccess();
  if (!access?.isOwner) return NextResponse.json({ error: "Only the business owner can add external jobs." }, { status: 403 });
  if (!await enforceRateLimit({ request, userId: access.session.user.id, bucket: "provider-manual-jobs", limit: 20 }))
    return NextResponse.json({ error: "Too many changes. Please wait a minute." }, { status: 429 });
  let input: ReturnType<typeof parseManualJob>;
  try { input = parseManualJob(await request.json()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Check the job details." }, { status: 400 }); }
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [access.providerId]);
    const conflicts = await client.query(`SELECT 1 WHERE EXISTS (
      SELECT 1 FROM provider_time_off WHERE provider_id::text=$1 AND team_member_id IS NULL AND starts_at<$3 AND ends_at>$2
    ) OR EXISTS (
      SELECT 1 FROM bookings b WHERE b.provider_id::text=$1 AND b.status='confirmed' AND b.starts_at<$3 AND b.ends_at>$2
      AND (EXISTS (SELECT 1 FROM booking_assignees a WHERE a.booking_id=b.id AND a.is_owner=true)
        OR (b.assigned_team_member_id IS NULL AND NOT EXISTS (SELECT 1 FROM booking_assignees a WHERE a.booking_id=b.id)))
    ) OR EXISTS (
      SELECT 1 FROM provider_calendly_connections c JOIN provider_calendly_events e ON e.connection_id=c.id
      WHERE c.provider_id::text=$1 AND c.disconnected_at IS NULL AND c.block_conflicting_bookings=true
      AND e.status='active' AND e.starts_at<$3 AND e.ends_at>$2
    ) OR EXISTS (
      SELECT 1 FROM provider_calendly_connections c WHERE c.provider_id::text=$1 AND c.disconnected_at IS NULL
      AND c.block_conflicting_bookings=true AND (c.last_sync_succeeded_at IS NULL OR c.last_sync_succeeded_at<now()-interval '20 minutes' OR c.last_sync_error IS NOT NULL)
    )`, [access.providerId, input.startsAt, input.endsAt]);
    if (conflicts.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "This time overlaps an existing booking or block, or Calendly needs to sync. Check your calendar and try again." }, { status: 409 });
    }
    const result = await client.query<{ id: string }>(`INSERT INTO provider_time_off(provider_id,team_member_id,starts_at,ends_at,reason)
      VALUES($1,NULL,$2,$3,$4) RETURNING id::text`, [access.providerId,input.startsAt,input.endsAt,input.reason]);
    await client.query("COMMIT");
    await recordActivity({ userId: access.session.user.id, action: "manual_job_added", targetType: "time_off", targetId: result.rows[0].id }).catch(() => {});
    return NextResponse.json({ id: result.rows[0].id }, { status: 201 });
  } catch {
    await client.query("ROLLBACK");
    return NextResponse.json({ error: "The job could not be saved. Please try again." }, { status: 500 });
  } finally { client.release(); }
}

export async function DELETE(request: Request) {
  const access = await getProviderAccess();
  if (!access?.isOwner) return NextResponse.json({ error: "Only the business owner can remove external jobs." }, { status: 403 });
  if (!await enforceRateLimit({ request, userId: access.session.user.id, bucket: "provider-manual-jobs", limit: 20 })) return NextResponse.json({ error: "Too many changes. Please wait a minute." }, { status: 429 });
  const body = await request.json().catch(() => null);
  if (typeof body?.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id)) return NextResponse.json({ error: "Choose a valid job." }, { status: 400 });
  const result = await database.query(`DELETE FROM provider_time_off WHERE id::text=$1 AND provider_id::text=$2
    AND team_member_id IS NULL AND starts_with(reason,$3) RETURNING id`, [body.id, access.providerId, MANUAL_JOB_PREFIX]);
  if (!result.rowCount) return NextResponse.json({ error: "External job not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
