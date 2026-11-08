import { NextResponse } from "next/server";
import { calendlyConfiguration, disconnectCalendly } from "@/lib/calendly";
import { database } from "@/lib/database";
import { getProviderAccess } from "@/lib/provider-access";
import { recordActivity } from "@/lib/request-security";

export async function GET() {
  const access = await getProviderAccess();
  if (!access?.isOwner) return NextResponse.json({ error: "Only the provider account owner can manage Calendly." }, { status: 403 });
  const result = await database.query<{
    id: string; account_name: string; account_email: string; account_timezone: string; scheduling_url: string | null;
    webhook_status: string; webhook_error: string | null; block_conflicting_bookings: boolean; last_sync_started_at: Date | null;
    last_sync_succeeded_at: Date | null; last_sync_error: string | null; connected_at: Date; conflict_protection_status: "disabled" | "current" | "stale";
  }>(`SELECT id::text,account_name,account_email,account_timezone,scheduling_url,webhook_status,webhook_error,block_conflicting_bookings,
      last_sync_started_at,last_sync_succeeded_at,last_sync_error,connected_at,
      CASE WHEN block_conflicting_bookings=false THEN 'disabled'
        WHEN last_sync_succeeded_at IS NOT NULL AND last_sync_succeeded_at>=now()-interval '20 minutes' AND last_sync_error IS NULL THEN 'current'
        ELSE 'stale' END AS conflict_protection_status
      FROM provider_calendly_connections WHERE provider_id::text=$1 AND disconnected_at IS NULL`, [access.providerId]);
  const connection = result.rows[0];
  return NextResponse.json({
    configured: calendlyConfiguration().configured,
    connection: connection ? {
      id: connection.id, accountName: connection.account_name, accountEmail: connection.account_email,
      accountTimezone: connection.account_timezone, schedulingUrl: connection.scheduling_url,
      webhookStatus: connection.webhook_status, webhookError: connection.webhook_error,
      blockConflictingBookings: connection.block_conflicting_bookings,
      conflictProtectionStatus: connection.conflict_protection_status,
      lastSyncStartedAt: connection.last_sync_started_at, lastSyncSucceededAt: connection.last_sync_succeeded_at,
      lastSyncError: connection.last_sync_error, connectedAt: connection.connected_at,
    } : null,
  });
}

export async function PATCH(request: Request) {
  const access = await getProviderAccess();
  if (!access?.isOwner) return NextResponse.json({ error: "Only the provider account owner can manage Calendly." }, { status: 403 });
  const body = await request.json() as { blockConflictingBookings?: unknown };
  if (typeof body.blockConflictingBookings !== "boolean") return NextResponse.json({ error: "Choose a valid calendar setting." }, { status: 400 });
  const updated = await database.query(
    `UPDATE provider_calendly_connections SET block_conflicting_bookings=$2,updated_at=now()
     WHERE provider_id::text=$1 AND disconnected_at IS NULL RETURNING id`, [access.providerId, body.blockConflictingBookings],
  );
  if (!updated.rowCount) return NextResponse.json({ error: "Calendly is not connected." }, { status: 404 });
  await recordActivity({ userId: access.session.user.id, action: "calendly_conflict_setting_updated", targetType: "provider", targetId: access.providerId, metadata: { enabled: body.blockConflictingBookings } });
  return NextResponse.json({ ok: true, blockConflictingBookings: body.blockConflictingBookings });
}

export async function DELETE() {
  const access = await getProviderAccess();
  if (!access?.isOwner) return NextResponse.json({ error: "Only the provider account owner can disconnect Calendly." }, { status: 403 });
  const result = await database.query<{ id: string }>("SELECT id::text FROM provider_calendly_connections WHERE provider_id::text=$1 AND disconnected_at IS NULL", [access.providerId]);
  if (!result.rows[0]) return NextResponse.json({ ok: true });
  await disconnectCalendly(result.rows[0].id);
  await recordActivity({ userId: access.session.user.id, action: "calendly_disconnected", targetType: "provider", targetId: access.providerId });
  return NextResponse.json({ ok: true });
}
