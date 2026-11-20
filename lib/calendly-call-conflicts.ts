import type { PoolClient } from "pg";

type Client = Pick<PoolClient, "query">;
export type CallSlot = { callId: string; providerId: string; startsAt: Date | string; endsAt: Date | string };
export class CalendlyCallSlotConflict extends Error {
  status = 409;
  constructor(message = "That time conflicts with another booking or unavailable period. Choose another time.") { super(message); }
}

/** Caller must own an open transaction. Never use a pool query across this operation.
 * Bounds include provider/event buffers. No automatic expiry: an unknown external
 * booking outcome must retain its reservation until authoritatively reconciled. */
export async function acquireCallSlot(client: Client, slot: CallSlot) {
  if (process.env.CALENDLY_CALL_BOOKINGS_ENABLED !== "true") throw new CalendlyCallSlotConflict("Call bookings are not enabled.");
  const start = new Date(slot.startsAt), end = new Date(slot.endsAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new CalendlyCallSlotConflict("Invalid call interval.");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [slot.providerId]);
  try {
    const result = await client.query(`INSERT INTO calendly_call_slot_holds(call_id,provider_id,starts_at,ends_at)
      VALUES($1,$2,$3,$4) ON CONFLICT(call_id) DO UPDATE SET starts_at=excluded.starts_at,ends_at=excluded.ends_at
      WHERE calendly_call_slot_holds.provider_id=excluded.provider_id AND calendly_call_slot_holds.released_at IS NULL
      RETURNING call_id`, [slot.callId,slot.providerId,start,end]);
    if (!result.rowCount) throw new CalendlyCallSlotConflict("This reservation has already been released or changed. Start a new request.");
  } catch (error) {
    if ((error as { code?: string }).code === "23P01") throw new CalendlyCallSlotConflict();
    throw error;
  }
}
export const validateCallSlot = acquireCallSlot;

/** Only after definitive cancellation/no external appointment, or completed call.
 * May run while feature is disabled so existing recovery work remains possible. */
export async function releaseCallSlot(client: Client, callId: string) {
  const found = await client.query<{ provider_id: string }>("SELECT provider_id::text FROM calendly_call_slot_holds WHERE call_id=$1", [callId]);
  if (!found.rows[0]) return;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [found.rows[0].provider_id]);
  await client.query("UPDATE calendly_call_slot_holds SET released_at=COALESCE(released_at,now()) WHERE call_id=$1", [callId]);
}

/** Map before inserting the same call's native payment booking, in one transaction.
 * Deferred FK permits insert ordering. Never exempts any unrelated native booking. */
export async function linkCallSlotBooking(client: Client, callId: string, bookingId: string) {
  const found = await client.query<{ provider_id: string }>("SELECT provider_id::text FROM calendly_call_slot_holds WHERE call_id=$1", [callId]);
  if (!found.rows[0]) throw new CalendlyCallSlotConflict("Call reservation is missing.");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [found.rows[0].provider_id]);
  const linked = await client.query(`UPDATE calendly_call_slot_holds SET native_booking_id=$2
    WHERE call_id=$1 AND released_at IS NULL AND (native_booking_id IS NULL OR native_booking_id=$2) RETURNING call_id`, [callId,bookingId]);
  if (!linked.rowCount) throw new CalendlyCallSlotConflict("Call reservation cannot be linked to this payment.");
}
