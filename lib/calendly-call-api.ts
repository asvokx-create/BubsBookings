/** Calendly call protocol. Inject transport; this module never reads credentials.
 * The caller must commit an operation claim before create/cancel. No POST retries.
 */
export type CalendlyCallTransport = (method: "GET" | "POST", path: string, body?: unknown) => Promise<unknown>;
export type CalendlyCallIdentity = {
  connectionId: string; providerId: string; ownerUri: string; connectedAt: string;
  eventTypeUri: string; startTime: string; endTime: string; operationId: string;
  invitee: { name: string; email: string; timezone: string };
  expectedBuffers?: { beforeMinutes: number; afterMinutes: number };
  questionsAndAnswers?: { question: string; answer: string; position: number }[];
};
export type CalendlyCallMapping = { startTime: string; endTime: string; ownerUri: string; eventTypeUri: string; inviteeEmail: string; eventUri: string; inviteeUri: string; meetingUrl: string | null; meetingStatus: "ready" | "pending" | "failed"; status: "active" | "canceled" };
export type CalendlyCallReferences = Pick<CalendlyCallMapping, "eventUri" | "inviteeUri">;
export class CalendlyCallTransportError extends Error {
  dispatched: boolean; status?: number;
  constructor(dispatched: boolean, status?: number) { super("Calendly request did not complete successfully."); this.dispatched = dispatched; this.status = status; }
}
/** Only transport failures known to be temporary may defer an established call check. */
function temporarilyUnavailable(error: unknown): boolean {
  return error instanceof CalendlyCallTransportError && (
    (error.dispatched && error.status === undefined) || error.status === 408 || error.status === 429
    || (error.status !== undefined && error.status >= 500 && error.status <= 599));
}
function unavailableResult(error: unknown): {status: 'unavailable'; localRateLimited?: boolean} {
  return error instanceof CalendlyCallTransportError && !error.dispatched && error.status === 429
    ? {status: 'unavailable', localRateLimited: true} : {status: 'unavailable'};
}
export class CalendlyCallOutcomeError extends Error {
  outcome: "not_sent" | "rejected" | "unknown"; references?: CalendlyCallReferences;
  constructor(outcome: "not_sent" | "rejected" | "unknown", references?: CalendlyCallReferences) { super(`Calendly booking outcome: ${outcome}.`); this.outcome = outcome; this.references = references; }
}
const API = "https://api.calendly.com";
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Calendly response.");
  return value as Record<string, unknown>;
}
function resource(value: unknown) { return object(object(value).resource); }
function uri(value: unknown, path: RegExp): string {
  if (typeof value !== "string") throw new Error("Missing Calendly resource identity.");
  const url = new URL(value);
  if (url.origin !== API || url.username || url.password || url.search || url.hash || !path.test(url.pathname)) throw new Error("Invalid Calendly resource identity.");
  return value;
}
const eventPath = /^\/scheduled_events\/[A-Za-z0-9_-]+$/;
const inviteePath = /^\/scheduled_events\/[A-Za-z0-9_-]+\/invitees\/[A-Za-z0-9_-]+$/;
function utc(value: unknown) {
  if (typeof value !== "string" || !/Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid UTC time.");
  return Date.parse(value);
}
function marker(identity: CalendlyCallIdentity) { return `bubs-call-${identity.operationId}`; }
function validateIdentity(identity: CalendlyCallIdentity) {
  uri(identity.eventTypeUri, /^\/event_types\/[A-Za-z0-9_-]+$/); uri(identity.ownerUri, /^\/users\/[A-Za-z0-9_-]+$/);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.operationId)
    || !identity.connectionId || !identity.providerId || !identity.connectedAt || utc(identity.endTime) <= utc(identity.startTime)
    || !identity.invitee.timezone?.trim() || !identity.invitee.name?.trim() || identity.invitee.name.length > 240
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.invitee.email) || identity.invitee.email.length > 254) throw new Error("Invalid call identity.");
  new Intl.DateTimeFormat("en", { timeZone: identity.invitee.timezone });
}
function minutes(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1440) throw new Error("Unknown event buffer.");
  return Number(value);
}
/** Must run again immediately before dispatch; internal holds are a separate required check. */
export async function prepareCalendlyCall(read: CalendlyCallTransport, identity: CalendlyCallIdentity, nowMs = Date.now()) {
  validateIdentity(identity);
  if (utc(identity.startTime) <= nowMs) throw new Error("Call time is no longer in the future.");
  const event = resource(await read("GET", new URL(identity.eventTypeUri).pathname));
  const profile = object(event.profile);
  if (event.uri !== identity.eventTypeUri || event.active !== true || event.secret !== false || event.kind !== "solo"
    || (event.pooling_type !== null && event.pooling_type !== undefined) || profile.type !== "User" || profile.owner !== identity.ownerUri
    || event.is_paid !== false || !Number.isSafeInteger(event.duration) || Number(event.duration) < 1 || Number(event.duration) > 1440
    || utc(identity.endTime) - utc(identity.startTime) !== Number(event.duration) * 60_000) throw new Error("Event configuration no longer matches the call.");
  if (event.duration_options != null && (!Array.isArray(event.duration_options) || event.duration_options.some(value => value !== event.duration))) throw new Error("Variable-duration calls are not supported.");
  if (!Array.isArray(event.locations) || event.locations.length !== 1 || object(event.locations[0]).kind !== "zoom_conference") throw new Error("A single configured Zoom location is required.");
  if (!Array.isArray(event.custom_questions)) throw new Error("Calendly questions could not be verified.");
  const answers = identity.questionsAndAnswers ?? [];
  if (answers.length > 20 || new Set(answers.map(a => a.position)).size !== answers.length) throw new Error("Invalid call answers.");
  for (const answer of answers) {
    if (!Number.isSafeInteger(answer.position) || typeof answer.answer !== "string" || !answer.answer.trim() || answer.answer.length > 2000) throw new Error("Invalid call answer.");
    const question = event.custom_questions.map(object).find(q => q.enabled === true && q.position === answer.position && q.name === answer.question);
    if (!question || !["string", "text", "single_select"].includes(String(question.type))) throw new Error("Unsupported call question.");
    if (question.type === "single_select" && (!Array.isArray(question.answer_choices) || !question.answer_choices.includes(answer.answer))) throw new Error("Invalid call answer choice.");
  }
  for (const raw of event.custom_questions) {
    const question = object(raw);
    if (question.enabled === true && question.required !== false && !answers.some(a => a.position === question.position && a.question === question.name)) throw new Error("A required call answer is missing.");
  }
  const before = minutes(event.before_buffer), after = minutes(event.after_buffer);
  if (identity.expectedBuffers && (before !== identity.expectedBuffers.beforeMinutes || after !== identity.expectedBuffers.afterMinutes)) throw new Error("Calendly buffers changed.");
  const query = new URLSearchParams({ event_type: identity.eventTypeUri, start_time: identity.startTime, end_time: new Date(utc(identity.startTime) + 60_000).toISOString() });
  const response = object(await read("GET", `/event_type_available_times?${query}`));
  if (!Array.isArray(response.collection) || !response.collection.some(value => {
    const slot = object(value);
    return slot.status === "available" && slot.invitees_remaining === 1 && utc(slot.start_time) === utc(identity.startTime);
  })) throw new Error("The selected slot is no longer available.");
  return { bufferedStartTime: new Date(utc(identity.startTime) - before * 60_000).toISOString(), bufferedEndTime: new Date(utc(identity.endTime) + after * 60_000).toISOString() };
}
function references(value: unknown): CalendlyCallReferences {
  const invitee = resource(value);
  const eventUri = uri(invitee.event, eventPath), inviteeUri = uri(invitee.uri, inviteePath);
  if (!inviteeUri.startsWith(`${eventUri}/invitees/`)) throw new Error("Invitee belongs to a different event.");
  return { eventUri, inviteeUri };
}
function zoomUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash || !(u.hostname === "zoom.us" || u.hostname.endsWith(".zoom.us")) || !/^\/(j|w)\/[0-9]+/.test(u.pathname)) return null;
    return u.toString();
  } catch { return null; }
}
/** Full tuple + marker validation. Never authorize cancellation from email/time alone. */
export async function readMappedCalendlyCall(read: CalendlyCallTransport, identity: CalendlyCallIdentity, refs: CalendlyCallReferences): Promise<CalendlyCallMapping> {
  validateIdentity(identity); uri(refs.eventUri, eventPath); uri(refs.inviteeUri, inviteePath);
  if (!refs.inviteeUri.startsWith(`${refs.eventUri}/invitees/`)) throw new Error("Mismatched Calendly references.");
  const event = resource(await read("GET", new URL(refs.eventUri).pathname));
  const invitee = resource(await read("GET", new URL(refs.inviteeUri).pathname));
  const tracking = object(invitee.tracking);
  if (event.uri !== refs.eventUri || invitee.uri !== refs.inviteeUri || invitee.event !== refs.eventUri || event.event_type !== identity.eventTypeUri
    || utc(event.start_time) !== utc(identity.startTime) || utc(event.end_time) !== utc(identity.endTime)
    || typeof invitee.email !== "string" || invitee.email.toLowerCase() !== identity.invitee.email.toLowerCase()
    || invitee.timezone !== identity.invitee.timezone || tracking.utm_source !== "bubsbookings" || tracking.utm_content !== marker(identity)
    || !Array.isArray(event.event_memberships) || event.event_memberships.length !== 1 || object(event.event_memberships[0]).user !== identity.ownerUri
    || object(event.invitees_counter).limit !== 1 || !["active", "canceled"].includes(String(event.status)) || !["active", "canceled"].includes(String(invitee.status))) throw new Error("Calendly appointment identity is not verified.");
  const location = object(event.location);
  const url = location.type === "zoom" && location.status === "pushed" ? zoomUrl(location.join_url) : null;
  const canceled = event.status === "canceled" || invitee.status === "canceled";
  return { ...refs, startTime: identity.startTime, endTime: identity.endTime, ownerUri: identity.ownerUri, eventTypeUri: identity.eventTypeUri, inviteeEmail: identity.invitee.email, status: canceled ? "canceled" : "active", meetingUrl: canceled ? null : url,
    meetingStatus: canceled || location.type !== "zoom" || location.status === "failed" ? "failed" : url ? "ready" : "pending" };
}
export async function createCalendlyCallOnce(send: CalendlyCallTransport, identity: CalendlyCallIdentity, nowMs = Date.now()): Promise<CalendlyCallMapping> {
  try { await prepareCalendlyCall(send, identity, nowMs); } catch { throw new CalendlyCallOutcomeError("not_sent"); }
  let response: unknown;
  try {
    response = await send("POST", "/invitees", { event_type: identity.eventTypeUri, start_time: identity.startTime, invitee: identity.invitee,
      location: { kind: "zoom_conference" }, questions_and_answers: identity.questionsAndAnswers ?? [],
      tracking: { utm_source: "bubsbookings", utm_content: marker(identity) } });
  } catch (error) {
    if (error instanceof CalendlyCallTransportError && !error.dispatched) throw new CalendlyCallOutcomeError("not_sent");
    if (error instanceof CalendlyCallTransportError && [400,401,403,404,429].includes(error.status ?? 0)) throw new CalendlyCallOutcomeError("rejected");
    throw new CalendlyCallOutcomeError("unknown");
  }
  let refs: CalendlyCallReferences | undefined;
  try { refs = references(response); return await readMappedCalendlyCall(send, identity, refs); }
  catch { throw new CalendlyCallOutcomeError("unknown", refs); }
}
async function collection(read: CalendlyCallTransport, pathname: string, params: URLSearchParams): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [], seen = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const result = object(await read("GET", `${pathname}?${params}`));
    if (!Array.isArray(result.collection)) throw new Error("Incomplete Calendly collection.");
    rows.push(...result.collection.map(object));
    const pagination = object(result.pagination);
    if (!pagination.next_page_token) { if (pagination.next_page) throw new Error("Unusable pagination."); return rows; }
    if (typeof pagination.next_page_token !== "string" || seen.has(pagination.next_page_token) || pagination.next_page_token.length > 2048) throw new Error("Invalid pagination.");
    seen.add(pagination.next_page_token); params.set("page_token", pagination.next_page_token);
  }
  throw new Error("Reconciliation limit reached.");
}
export async function reconcileCalendlyCall(read: CalendlyCallTransport, identity: CalendlyCallIdentity, refs?: CalendlyCallReferences): Promise<{ status: "found"; mapping: CalendlyCallMapping } | { status: "unknown" | "ambiguous" } | {status: "unavailable"; localRateLimited?: boolean}> {
  try {
    if (refs) return { status: "found", mapping: await readMappedCalendlyCall(read, identity, refs) };
    validateIdentity(identity);
    const params = new URLSearchParams({ user: identity.ownerUri, invitee_email: identity.invitee.email,
      min_start_time: new Date(utc(identity.startTime) - 1000).toISOString(), max_start_time: new Date(utc(identity.startTime) + 1000).toISOString(), count: "100" });
    const events = await collection(read, "/scheduled_events", params), found: CalendlyCallMapping[] = [];
    for (const event of events) {
      const eventUri = uri(event.uri, eventPath);
      const invitees = await collection(read, `${new URL(eventUri).pathname}/invitees`, new URLSearchParams({ count: "100" }));
      for (const invitee of invitees) {
        if (!invitee.tracking || object(invitee.tracking).utm_content !== marker(identity)) continue;
        const candidate = { eventUri, inviteeUri: uri(invitee.uri, inviteePath) };
        try { found.push(await readMappedCalendlyCall(read, identity, candidate)); } catch (error) { return temporarilyUnavailable(error) ? unavailableResult(error) : {status: "ambiguous"}; }
      }
    }
    return found.length === 1 ? { status: "found", mapping: found[0] } : { status: found.length > 1 ? "ambiguous" : "unknown" };
  } catch (error) { return temporarilyUnavailable(error) ? unavailableResult(error) : {status: "unknown"}; }
}
export async function cancelMappedCalendlyCall(send: CalendlyCallTransport, identity: CalendlyCallIdentity, refs: CalendlyCallReferences): Promise<CalendlyCallMapping> {
  let mapped: CalendlyCallMapping;
  try { mapped = await readMappedCalendlyCall(send, identity, refs); } catch { throw new CalendlyCallOutcomeError("not_sent"); }
  if (mapped.status === "canceled") return mapped;
  try { await send("POST", `${new URL(refs.eventUri).pathname}/cancellation`, { reason: "BubsBookings call could not be confirmed. Please check your booking status." }); }
  catch (error) { throw new CalendlyCallOutcomeError(error instanceof CalendlyCallTransportError && !error.dispatched ? "not_sent" : "unknown", refs); }
  try {
    mapped = await readMappedCalendlyCall(send, identity, refs);
    if (mapped.status !== "canceled") throw new Error("Cancellation is not confirmed.");
    return mapped;
  } catch { throw new CalendlyCallOutcomeError("unknown", refs); }
}

/** Initial publishing surface deliberately supports Zoom without required extra questions. */
export async function readCalendlyCallOffer(read: CalendlyCallTransport, ownerUri: string, eventTypeUri: string) {
  uri(ownerUri, /^\/users\/[A-Za-z0-9_-]+$/); uri(eventTypeUri, /^\/event_types\/[A-Za-z0-9_-]+$/);
  const event = resource(await read("GET", new URL(eventTypeUri).pathname));
  const profile = object(event.profile);
  if (event.uri !== eventTypeUri || event.active !== true || event.secret !== false || event.kind !== "solo"
    || (event.pooling_type !== null && event.pooling_type !== undefined) || profile.type !== "User" || profile.owner !== ownerUri
    || event.is_paid !== false || !Number.isSafeInteger(event.duration) || Number(event.duration) < 1 || Number(event.duration) > 1440
    || typeof event.name !== "string" || !event.name.trim()
    || !Array.isArray(event.locations) || event.locations.length !== 1 || object(event.locations[0]).kind !== "zoom_conference"
    || !Array.isArray(event.custom_questions) || event.custom_questions.some(value => { const q = object(value); return q.enabled === true && q.required !== false; })) throw new Error("This call offer is not eligible for booking.");
  if (event.duration_options != null && (!Array.isArray(event.duration_options) || event.duration_options.some(value => value !== event.duration))) throw new Error("Variable-duration calls are not supported.");
  return { eventTypeUri, name: event.name.trim().slice(0,120), durationMinutes: Number(event.duration), beforeBufferMinutes: minutes(event.before_buffer), afterBufferMinutes: minutes(event.after_buffer) };
}
