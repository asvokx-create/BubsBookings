import { NextResponse } from "next/server";
import { getProviderAccess } from "@/lib/provider-access";
import { database } from "@/lib/database";
import { calendlyPreviewRead } from "@/lib/calendly";
import { calendlyEventTypeUri, hasCalendlyEventTypeReadScope, listCalendlyPreviewEvents, readCalendlyPreviewEvent } from "@/lib/calendly-event-availability";
import { hasVerifiedNoCalendlyPayment, parseCalendlyCallBillingDraft } from "@/lib/calendly-call-drafts";
import { DELETE_CALENDLY_CALL_DRAFT_QUERY, LIST_CALENDLY_CALL_DRAFTS_QUERY, SAVE_CALENDLY_CALL_DRAFT_QUERY } from "@/lib/calendly-call-draft-queries";
import { enforceRateLimit } from "@/lib/request-security";

const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const enabled = () => process.env.CALENDLY_CALL_DRAFTS_ENABLED === "true";
async function connectionFor(providerId: string) {
  return (await database.query<{ id: string; calendly_user_uri: string; granted_scope: string; connected_at: string }>(
    "SELECT id::text,calendly_user_uri,granted_scope,connected_at::text FROM provider_calendly_connections WHERE provider_id::text=$1 AND disconnected_at IS NULL", [providerId])).rows[0];
}

export async function GET(request: Request) {
  const access = await getProviderAccess();
  if (!access?.isOwner) return reply({ error: "Only the provider account owner can manage call drafts." }, 403);
  if (!enabled()) return reply({ enabled: false });
  if (!await enforceRateLimit({ request, userId: access.session.user.id, bucket: "calendly_call_drafts_read", limit: 10 })) return reply({ error: "Please wait a minute before reloading." }, 429);
  const services = (await database.query(LIST_CALENDLY_CALL_DRAFTS_QUERY, [access.providerId])).rows;
  const connection = await connectionFor(access.providerId);
  if (!connection || !hasCalendlyEventTypeReadScope(connection.granted_scope)) return reply({ enabled: true, ready: false, status: "draft_only", services,
    error: "Event selection needs previously granted event_types:read permission. This draft does not request new permissions. Existing drafts can still be removed." });
  try {
    const events = await listCalendlyPreviewEvents(path => calendlyPreviewRead(connection.id, connection.calendly_user_uri, path, request), connection.calendly_user_uri);
    return reply({ enabled: true, ready: true, status: "draft_only", services, eventTypes: events.filter(hasVerifiedNoCalendlyPayment) });
  } catch {
    return reply({ enabled: true, ready: false, status: "draft_only", services, error: "Calendly events could not be verified. Existing drafts are not bookable. Reload to try again." }, 503);
  }
}

export async function PUT(request: Request) {
  const access = await getProviderAccess();
  if (!access?.isOwner) return reply({ error: "Only the provider account owner can manage call drafts." }, 403);
  if (!enabled()) return reply({ error: "Call drafts are not enabled." }, 404);
  if (!await enforceRateLimit({ request, userId: access.session.user.id, bucket: "calendly_call_drafts_write", limit: 10 })) return reply({ error: "Please wait a minute before trying again." }, 429);
  let body: { serviceId?: unknown; eventTypeUri?: unknown; billingMode?: unknown; servicePriceCents?: unknown; revision?: unknown; remove?: unknown };
  try { body = await request.json(); } catch { return reply({ error: "Invalid call draft." }, 400); }
  if (!body || typeof body.serviceId !== "string" || !body.serviceId || body.serviceId.length > 100
    || (body.revision !== null && (typeof body.revision !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.revision)))) {
    return reply({ error: "Choose a service and reload its current draft before saving." }, 400);
  }
  const service = await database.query("SELECT id::text FROM services WHERE id::text=$1 AND provider_id::text=$2 AND provider_deleted_at IS NULL AND delivery_type IN ('REMOTE','BOTH')", [body.serviceId, access.providerId]);
  if (!service.rows[0]) return reply({ error: "Remote service not found." }, 404);
  if (body.remove === true) {
    if (body.revision === null) return reply({ error: "Reload the draft before removing it." }, 409);
    try {
      const removed = await database.query(DELETE_CALENDLY_CALL_DRAFT_QUERY, [body.serviceId, access.providerId, body.revision]);
      if (!removed.rowCount) return reply({ error: "The draft changed or was already removed. Reload before making another change." }, 409);
      return reply({ ok: true, status: "draft_only", draft: null });
    } catch { return reply({ error: "Removal could not be confirmed. Reload to check the draft before trying again." }, 503); }
  }
  const billing = parseCalendlyCallBillingDraft(body);
  const uri = calendlyEventTypeUri(body.eventTypeUri);
  if (!billing || !uri) return reply({ error: "Choose free with a zero price, or paid with a service price of $0.50–$1,000,000 USD, and an eligible event." }, 400);
  const connection = await connectionFor(access.providerId);
  if (!connection || !hasCalendlyEventTypeReadScope(connection.granted_scope)) return reply({ error: "Existing event-type read permission is required. No additional permission was requested." }, 409);
  let event;
  try {
    event = await readCalendlyPreviewEvent(path => calendlyPreviewRead(connection.id, connection.calendly_user_uri, path, request), connection.calendly_user_uri, uri);
    if (!hasVerifiedNoCalendlyPayment(event)) return reply({ error: "Calendly must report that this event does not collect payment. Paid calls will use BubsBookings checkout; free calls must not charge through Calendly. No Calendly setting was changed." }, 409);
  } catch { return reply({ error: "The selected event could not be verified. No draft was saved." }, 409); }
  try {
    const saved = await database.query(SAVE_CALENDLY_CALL_DRAFT_QUERY,
      [body.serviceId, access.providerId, connection.id, event.uri, event.name, connection.calendly_user_uri, connection.connected_at,
        event.durationMinutes, billing.billingMode, billing.servicePriceCents, body.revision]);
    if (!saved.rowCount) return reply({ error: "The draft, service or connection changed. Reload before saving again." }, 409);
    return reply({ ok: true, status: "draft_only", draft: saved.rows[0] });
  } catch { return reply({ error: "Saving could not be confirmed. Reload to check the draft before trying again." }, 503); }
}
