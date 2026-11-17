import { NextResponse } from "next/server";
import { getProviderAccess } from "@/lib/provider-access";
import { database } from "@/lib/database";
import { calendlyPreviewRead } from "@/lib/calendly";
import { calendlyAvailabilityPreviewEnabled } from "@/lib/calendly-service-preview";
import { calendlyEventTypeUri, hasCalendlyEventTypeReadScope, listCalendlyPreviewEvents, readCalendlyPreviewEvent } from "@/lib/calendly-event-availability";
import { SAVE_CALENDLY_PREVIEW_QUERY } from "@/lib/calendly-preview-queries";
import { enforceRateLimit, recordActivity } from "@/lib/request-security";

const headers = { "Cache-Control": "private, no-store" };
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
async function connectionFor(providerId: string) {
  return (await database.query<{ id: string; calendly_user_uri: string; granted_scope: string; connected_at: string }>(
    "SELECT id::text,calendly_user_uri,granted_scope,connected_at::text FROM provider_calendly_connections WHERE provider_id::text=$1 AND disconnected_at IS NULL", [providerId])).rows[0];
}

export async function GET(request: Request) {
  const access = await getProviderAccess();
  if (!access?.isOwner) return reply({ error: "Only the provider account owner can manage Calendly previews." }, 403);
  if (!calendlyAvailabilityPreviewEnabled()) return reply({ enabled: false });
  const connection = await connectionFor(access.providerId);
  const services = (await database.query<{ id: string; title: string; event_type_uri: string | null; event_type_name: string | null }>(
    `SELECT service.id::text,service.title,preview.event_type_uri,preview.event_type_name FROM services service
     LEFT JOIN service_calendly_availability_previews preview ON preview.service_id=service.id
     WHERE service.provider_id::text=$1 AND service.provider_deleted_at IS NULL AND service.delivery_type IN ('REMOTE','BOTH') ORDER BY service.title`, [access.providerId])).rows;
  if (!connection || !hasCalendlyEventTypeReadScope(connection.granted_scope)) return reply({ enabled: true, ready: false, services,
    error: "This preview needs previously granted event_types:read access. No new permission is requested here. The administrator must approve and validate a separate OAuth rollout before this can be enabled." });
  try {
    const eventTypes = await listCalendlyPreviewEvents(path => calendlyPreviewRead(connection.id, connection.calendly_user_uri, path, request), connection.calendly_user_uri);
    return reply({ enabled: true, ready: true, services, eventTypes });
  } catch { return reply({ enabled: true, ready: false, services, error: "Calendly event types could not be verified. Try again later or ask the administrator to check this connection." }, 503); }
}

export async function PUT(request: Request) {
  const access = await getProviderAccess();
  if (!access?.isOwner) return reply({ error: "Only the provider account owner can manage Calendly previews." }, 403);
  if (!calendlyAvailabilityPreviewEnabled()) return reply({ error: "Calendly previews are not enabled." }, 404);
  if (!await enforceRateLimit({ request, userId: access.session.user.id, bucket: "calendly_preview_settings", limit: 10 })) return reply({ error: "Please wait a minute before trying again." }, 429);
  let body: { serviceId?: unknown; eventTypeUri?: unknown };
  try { body = await request.json(); } catch { return reply({ error: "Invalid preview selection." }, 400); }
  if (typeof body?.serviceId !== "string" || body.serviceId.length > 100) return reply({ error: "Choose a service." }, 400);
  const service = await database.query<{ id: string }>("SELECT id::text FROM services WHERE id::text=$1 AND provider_id::text=$2 AND provider_deleted_at IS NULL AND delivery_type IN ('REMOTE','BOTH')", [body.serviceId, access.providerId]);
  if (!service.rows[0]) return reply({ error: "Remote service not found." }, 404);
  if (body.eventTypeUri === null) {
    await database.query(`DELETE FROM service_calendly_availability_previews preview USING services service
      WHERE preview.service_id=service.id AND service.id::text=$1 AND service.provider_id::text=$2`, [body.serviceId, access.providerId]);
    await recordActivity({ userId: access.session.user.id, action: "calendly_preview_removed", targetType: "service", targetId: body.serviceId });
    return reply({ ok: true });
  }
  const uri = calendlyEventTypeUri(body.eventTypeUri);
  if (!uri) return reply({ error: "Choose an eligible Calendly event." }, 400);
  const connection = await connectionFor(access.providerId);
  if (!connection || !hasCalendlyEventTypeReadScope(connection.granted_scope)) return reply({ error: "Existing Calendly event-type read permission is required. No additional permission was requested." }, 409);
  try {
    const event = await readCalendlyPreviewEvent(path => calendlyPreviewRead(connection.id, connection.calendly_user_uri, path, request), connection.calendly_user_uri, uri);
    const saved = await database.query(
      SAVE_CALENDLY_PREVIEW_QUERY, [body.serviceId, access.providerId, connection.id, event.uri, event.name, connection.calendly_user_uri, connection.connected_at]);
    if (!saved.rowCount) return reply({ error: "The connection or service changed. Reload before selecting an event." }, 409);
    await recordActivity({ userId: access.session.user.id, action: "calendly_preview_selected", targetType: "service", targetId: body.serviceId });
    return reply({ ok: true });
  } catch { return reply({ error: "This event could not be verified as an active, public, fixed-duration personal event for your connected account. Nothing was changed." }, 409); }
}
