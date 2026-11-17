import "server-only";
import { database } from "@/lib/database";
import { calendlyPreviewRead } from "@/lib/calendly";
import { excludeCalendlyPreviewConflicts, hasCalendlyEventTypeReadScope, readCalendlyPreview, safeCalendlyPreviewTimezone } from "@/lib/calendly-event-availability";
import { CALENDLY_PREVIEW_CONFLICTS_QUERY, PUBLIC_CALENDLY_PREVIEW_QUERY } from "@/lib/calendly-preview-queries";

export function calendlyAvailabilityPreviewEnabled() {
  return process.env.CALENDLY_AVAILABILITY_PREVIEW_ENABLED === "true";
}

type PreviewMapping = { service_id: string; connection_id: string; event_type_uri: string; calendly_user_uri: string; account_timezone: string; granted_scope: string; connected_at: string; updated_at: string };
async function publicMapping(serviceId: string) {
  if (!calendlyAvailabilityPreviewEnabled()) return null;
  const result = await database.query<PreviewMapping>(PUBLIC_CALENDLY_PREVIEW_QUERY, [serviceId]);
  const mapping = result.rows[0];
  return mapping && hasCalendlyEventTypeReadScope(mapping.granted_scope) ? mapping : null;
}

export async function hasPublicCalendlyPreview(serviceId: string) {
  try { return Boolean(await publicMapping(serviceId)); } catch { return false; }
}

// Small, bounded, process-local request coalescing. The shared database rate limiter
// still applies across workers. Never use expired data on upstream errors.
type Snapshot = Awaited<ReturnType<typeof readCalendlyPreview>>;
const cache = new Map<string, { expiresAt: number; pending: Promise<Snapshot> }>();
function snapshotKey(mapping: PreviewMapping) {
  return `${mapping.connection_id}:${mapping.connected_at}:${mapping.event_type_uri}:${mapping.updated_at}`;
}

export async function getPublicCalendlyPreview(serviceId: string, request: Request) {
  const mapping = await publicMapping(serviceId);
  if (!mapping) return null;
  const key = snapshotKey(mapping);
  for (const [existingKey, entry] of cache) if (entry.expiresAt <= Date.now()) cache.delete(existingKey);
  let entry = cache.get(key);
  if (!entry) {
    if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    const pending = readCalendlyPreview(path => calendlyPreviewRead(mapping.connection_id, mapping.calendly_user_uri, path, request), mapping.calendly_user_uri, mapping.event_type_uri);
    entry = { expiresAt: Date.now() + 30_000, pending };
    cache.set(key, entry);
    void pending.catch(() => { if (cache.get(key)?.pending === pending) cache.delete(key); });
  }
  const snapshot = await entry.pending;
  // Disconnect, unpublish, revoke access or change selection while an API call is
  // pending must not release the old event's availability to the public.
  const stillPublic = await publicMapping(serviceId);
  if (!stillPublic || snapshotKey(stillPublic) !== key) return null;
  const conflicts = await database.query<{ starts_at: Date; ends_at: Date }>(CALENDLY_PREVIEW_CONFLICTS_QUERY,
    [serviceId, snapshot.window.startsAt, new Date(Date.parse(snapshot.window.endsAt) + snapshot.event.durationMinutes * 60_000)]);
  const slots = excludeCalendlyPreviewConflicts(snapshot.slots, conflicts.rows.map(row => ({ startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString() })))
    .filter(slot => Date.parse(slot.startsAt) > Date.now());
  return {
    mode: "preview_only" as const,
    eventName: snapshot.event.name,
    durationMinutes: snapshot.event.durationMinutes,
    timeZone: safeCalendlyPreviewTimezone(mapping.account_timezone),
    checkedAt: snapshot.checkedAt,
    through: snapshot.window.endsAt,
    slots: slots.slice(0, 60),
    moreAvailable: slots.length > 60,
  };
}
