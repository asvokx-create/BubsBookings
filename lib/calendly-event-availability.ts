// Pure, read-only Calendly availability protocol. No tokens or database access.
export const CALENDLY_EVENT_TYPE_READ_SCOPE = "event_types:read";
export const CALENDLY_PREVIEW_DAYS = 7;
export type CalendlyPreviewEventType = { uri: string; name: string; durationMinutes: number; collectsPayment: boolean | null };
export type CalendlyPreviewSlot = { startsAt: string; endsAt: string };
export type CalendlyRead = <T>(path: string) => Promise<T>;

export function hasCalendlyEventTypeReadScope(scope: string) {
  const scopes = new Set(scope.split(/\s+/));
  return scopes.has(CALENDLY_EVENT_TYPE_READ_SCOPE) || scopes.has("event_types:write");
}

export function calendlyEventTypeUri(value: unknown): string | null {
  return typeof value === "string" && /^https:\/\/api\.calendly\.com\/event_types\/[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

/** Only explicitly selected, public, fixed-duration, personal one-to-one events. */
export function eligibleCalendlyPreviewEvent(value: unknown, ownerUri: string): CalendlyPreviewEventType | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  const profile = event.profile as { type?: string; owner?: string } | undefined;
  const uri = calendlyEventTypeUri(event.uri);
  if (!uri || event.active !== true || event.secret !== false || event.kind !== "solo"
    || (event.pooling_type !== null && event.pooling_type !== undefined)
    || profile?.type !== "User" || profile.owner !== ownerUri
    || !Number.isSafeInteger(event.duration) || Number(event.duration) < 1 || Number(event.duration) > 1440
    || typeof event.name !== "string" || !event.name.trim()) return null;
  if (event.duration_options !== undefined && event.duration_options !== null
    && (!Array.isArray(event.duration_options) || event.duration_options.some(duration => duration !== event.duration))) return null;
  return { uri, name: event.name.trim().slice(0, 120), durationMinutes: Number(event.duration), collectsPayment: typeof event.is_paid === "boolean" ? event.is_paid : null };
}

export function calendlyPreviewWindow(nowMs: number) {
  if (!Number.isFinite(nowMs)) throw new Error("Invalid preview time.");
  const startsAt = new Date(Math.floor(nowMs / 60_000) * 60_000 + 60_000).toISOString();
  const endsAt = new Date(Date.parse(startsAt) + CALENDLY_PREVIEW_DAYS * 86_400_000).toISOString();
  return { startsAt, endsAt };
}

export function normalizeCalendlyPreviewSlots(collection: unknown, durationMinutes: number, window: { startsAt: string; endsAt: string }): CalendlyPreviewSlot[] {
  if (!Array.isArray(collection)) throw new Error("Invalid Calendly availability response.");
  const start = Date.parse(window.startsAt), end = Date.parse(window.endsAt);
  const starts = new Set<number>();
  for (const item of collection) {
    if (!item || typeof item !== "object" || item.status !== "available" || !Number.isSafeInteger(item.invitees_remaining) || item.invitees_remaining < 1) continue;
    const time = typeof item.start_time === "string" && /Z$/.test(item.start_time) ? Date.parse(item.start_time) : NaN;
    if (Number.isFinite(time) && time >= start && time < end) starts.add(time);
  }
  return [...starts].sort((a, b) => a - b).map(time => ({ startsAt: new Date(time).toISOString(), endsAt: new Date(time + durationMinutes * 60_000).toISOString() }));
}

export function excludeCalendlyPreviewConflicts(slots: CalendlyPreviewSlot[], conflicts: { startsAt: string; endsAt: string }[]) {
  return slots.filter(slot => !conflicts.some(busy => Date.parse(busy.startsAt) < Date.parse(slot.endsAt) && Date.parse(busy.endsAt) > Date.parse(slot.startsAt)));
}

export function safeCalendlyPreviewTimezone(value: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0); return value; } catch { return "UTC"; }
}

export async function listCalendlyPreviewEvents(read: CalendlyRead, ownerUri: string) {
  const events = new Map<string, CalendlyPreviewEventType>();
  let pageToken = "";
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ user: ownerUri, active: "true", count: "100", sort: "name:asc" });
    if (pageToken) params.set("page_token", pageToken);
    const response = await read<{ collection: unknown[]; pagination?: { next_page_token?: string | null; next_page?: string | null } }>(`/event_types?${params}`);
    if (!Array.isArray(response.collection)) throw new Error("Invalid Calendly event types response.");
    for (const raw of response.collection) {
      const event = eligibleCalendlyPreviewEvent(raw, ownerUri);
      if (event) events.set(event.uri, event);
    }
    const next = response.pagination?.next_page_token;
    if (!next) {
      if (response.pagination?.next_page) throw new Error("Unsupported Calendly pagination response.");
      return [...events.values()];
    }
    if (typeof next !== "string" || next.length > 2048 || next === pageToken) throw new Error("Invalid Calendly pagination token.");
    pageToken = next;
  }
  throw new Error("Too many Calendly event types. Narrow the account before enabling a preview.");
}

export async function readCalendlyPreviewEvent(read: CalendlyRead, ownerUri: string, uri: string) {
  if (!calendlyEventTypeUri(uri)) throw new Error("Invalid Calendly event type.");
  const response = await read<{ resource: unknown }>(new URL(uri).pathname);
  const event = eligibleCalendlyPreviewEvent(response.resource, ownerUri);
  if (!event || event.uri !== uri) throw new Error("This Calendly event is no longer eligible for a public preview.");
  return event;
}

export async function readCalendlyPreview(read: CalendlyRead, ownerUri: string, uri: string, nowMs = Date.now()) {
  const event = await readCalendlyPreviewEvent(read, ownerUri, uri);
  const window = calendlyPreviewWindow(nowMs);
  const query = new URLSearchParams({ event_type: event.uri, start_time: window.startsAt, end_time: window.endsAt });
  const response = await read<{ collection: unknown[] }>(`/event_type_available_times?${query}`);
  return { event, window, slots: normalizeCalendlyPreviewSlots(response.collection, event.durationMinutes, window), checkedAt: new Date(nowMs).toISOString() };
}
