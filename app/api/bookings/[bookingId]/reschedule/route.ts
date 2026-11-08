import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { database } from "@/lib/database";
import { checkAndRecordContent } from "@/lib/content-safety";
import { unavailableBookingProfessionals } from "@/lib/booking-staff";
import { expireRescheduleRequests, sendRescheduleEmails, type RescheduleOutcome } from "@/lib/booking-rescheduling";
import { enforceRateLimit, recordActivity } from "@/lib/request-security";

type BookingRow = {
  id: string; customer_id: string; provider_user_id: string; provider_id: string; service_id: string; service_title: string;
  starts_at: Date; ends_at: Date; status: string;
};

function bookingHref(role: "customer" | "provider", bookingId: string) {
  return role === "customer" ? `/account/bookings/${bookingId}` : `/provider/dashboard/bookings/${bookingId}`;
}

async function addNotification(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, input: {
  userId: string; bookingId: string; customerId: string; requestId: string; outcome: RescheduleOutcome; title: string; message: string;
}) {
  await client.query(`INSERT INTO notifications(user_id,booking_id,type,title,message,href,dedupe_key)
    VALUES($1,$2::uuid,'booking_reschedule',$3,$4,$5,$6) ON CONFLICT(dedupe_key) DO NOTHING`,
  [input.userId, input.bookingId, input.title, input.message,
    bookingHref(input.userId === input.customerId ? "customer" : "provider", input.bookingId),
    `booking-reschedule-${input.requestId}-${input.outcome}-${input.userId}`]);
}

export async function POST(request: Request, context: { params: Promise<{ bookingId: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!await enforceRateLimit({ request, userId: session.user.id, bucket: "booking-reschedule", limit: 10 })) {
    return NextResponse.json({ error: "Too many reschedule requests. Please wait and try again." }, { status: 429 });
  }
  const { bookingId } = await context.params;
  const body = await request.json() as { startsAt?: unknown; reason?: unknown };
  const proposedStart = typeof body.startsAt === "string" ? new Date(body.startsAt) : new Date(Number.NaN);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (Number.isNaN(proposedStart.getTime()) || proposedStart <= new Date()) return NextResponse.json({ error: "Choose a future available time." }, { status: 400 });
  if (reason.length > 500) return NextResponse.json({ error: "Keep the explanation under 500 characters." }, { status: 400 });
  if (reason) {
    const safety = await checkAndRecordContent({ userId: session.user.id, surface: "booking_reschedule", fields: [reason] });
    if (!safety.allowed) return NextResponse.json({ error: safety.message }, { status: 422 });
  }
  await expireRescheduleRequests(bookingId);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<BookingRow>(
      `SELECT booking.id::text,booking.customer_id,provider.user_id AS provider_user_id,booking.provider_id::text,
              booking.service_id::text,service.title AS service_title,booking.starts_at,booking.ends_at,booking.status
       FROM bookings booking JOIN provider_profiles provider ON provider.id=booking.provider_id
       JOIN services service ON service.id=booking.service_id
       WHERE booking.id::text=$1 AND (booking.customer_id=$2 OR provider.user_id=$2) FOR UPDATE OF booking`,
      [bookingId, session.user.id],
    );
    const booking = result.rows[0];
    if (!booking) { await client.query("ROLLBACK"); return NextResponse.json({ error: "Booking not found." }, { status: 404 }); }
    if (booking.status !== "confirmed" || booking.starts_at <= new Date()) { await client.query("ROLLBACK"); return NextResponse.json({ error: "Only upcoming confirmed bookings can be rescheduled." }, { status: 409 }); }
    const duration = booking.ends_at.getTime() - booking.starts_at.getTime();
    const proposedEnd = new Date(proposedStart.getTime() + duration);
    if (proposedStart.getTime() === booking.starts_at.getTime()) { await client.query("ROLLBACK"); return NextResponse.json({ error: "Choose a different appointment time." }, { status: 400 }); }
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [booking.provider_id]);
    const unavailable = await unavailableBookingProfessionals(client, { bookingId, providerId: booking.provider_id, serviceId: booking.service_id, startsAt: proposedStart, endsAt: proposedEnd });
    if (unavailable.length) { await client.query("ROLLBACK"); return NextResponse.json({ error: "That time is no longer available. Choose another time." }, { status: 409 }); }
    const requesterRole = session.user.id === booking.customer_id ? "customer" : "provider";
    const recipientId = requesterRole === "customer" ? booking.provider_user_id : booking.customer_id;
    const created = await client.query<{ id: string }>(
      `INSERT INTO booking_reschedule_requests(booking_id,requested_by,requester_role,original_starts_at,original_ends_at,
        proposed_starts_at,proposed_ends_at,reason) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8) RETURNING id::text`,
      [bookingId, session.user.id, requesterRole, booking.starts_at, booking.ends_at, proposedStart, proposedEnd, reason],
    );
    const requestId = created.rows[0].id;
    await client.query(`INSERT INTO booking_events(booking_id,actor_user_id,event_type,message,metadata)
      VALUES($1::uuid,$2,'reschedule_requested',$3,jsonb_build_object('requestId',$4::text,'originalStartsAt',$5::timestamptz,
        'originalEndsAt',$6::timestamptz,'proposedStartsAt',$7::timestamptz,'proposedEndsAt',$8::timestamptz,'requesterRole',$9::text))`,
      [bookingId, session.user.id, `${requesterRole === "customer" ? "Customer" : "Provider"} requested a new appointment time${reason ? `: ${reason}` : "."}`, requestId,
        booking.starts_at, booking.ends_at, proposedStart, proposedEnd, requesterRole]);
    await addNotification(client, { userId: recipientId, bookingId, customerId: booking.customer_id, requestId, outcome: "requested",
      title: "Reschedule approval requested", message: `${booking.service_title}: review the proposed appointment time. The original time remains confirmed until you approve.` });
    await client.query("COMMIT");
    await recordActivity({ userId: session.user.id, action: "reschedule_requested", targetType: "booking", targetId: bookingId, metadata: { requestId, requesterRole } });
    await sendRescheduleEmails(requestId, "requested").catch((error) => console.error("Reschedule request email failed", { requestId, error }));
    return NextResponse.json({ id: requestId }, { status: 201 });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code === "23505") return NextResponse.json({ error: "This booking already has a pending reschedule request." }, { status: 409 });
    console.error("Booking reschedule request failed", error);
    return NextResponse.json({ error: "We could not create the reschedule request." }, { status: 500 });
  } finally { client.release(); }
}

export async function PATCH(request: Request, context: { params: Promise<{ bookingId: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!await enforceRateLimit({ request, userId: session.user.id, bucket: "booking-reschedule-response", limit: 20 })) {
    return NextResponse.json({ error: "Too many reschedule actions. Please wait and try again." }, { status: 429 });
  }
  const { bookingId } = await context.params;
  const body = await request.json() as { requestId?: unknown; action?: unknown; reason?: unknown };
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  const action = body.action === "approve" || body.action === "decline" || body.action === "withdraw" ? body.action : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!requestId || !action) return NextResponse.json({ error: "Choose a valid reschedule action." }, { status: 400 });
  if (reason.length > 500) return NextResponse.json({ error: "Keep the explanation under 500 characters." }, { status: 400 });
  if (reason) {
    const safety = await checkAndRecordContent({ userId: session.user.id, surface: "booking_reschedule", fields: [reason] });
    if (!safety.allowed) return NextResponse.json({ error: safety.message }, { status: 422 });
  }
  await expireRescheduleRequests(bookingId);
  const client = await database.connect();
  let emailOutcome: RescheduleOutcome | null = null;
  let conflictResponse = false;
  try {
    await client.query("BEGIN");
    const result = await client.query<BookingRow & {
      request_id: string; requested_by: string; requester_role: "customer" | "provider"; proposed_starts_at: Date; proposed_ends_at: Date;
      original_starts_at: Date; original_ends_at: Date;
    }>(
      `SELECT booking.id::text,booking.customer_id,provider.user_id AS provider_user_id,booking.provider_id::text,
              booking.service_id::text,service.title AS service_title,booking.starts_at,booking.ends_at,booking.status,
              proposal.id::text AS request_id,proposal.requested_by,proposal.requester_role,proposal.original_starts_at,
              proposal.original_ends_at,proposal.proposed_starts_at,proposal.proposed_ends_at
       FROM booking_reschedule_requests proposal JOIN bookings booking ON booking.id=proposal.booking_id
       JOIN provider_profiles provider ON provider.id=booking.provider_id JOIN services service ON service.id=booking.service_id
       WHERE proposal.id::text=$1 AND booking.id::text=$2 AND proposal.status='pending'
         AND (booking.customer_id=$3 OR provider.user_id=$3) FOR UPDATE OF proposal,booking`,
      [requestId, bookingId, session.user.id],
    );
    const proposal = result.rows[0];
    if (!proposal) { await client.query("ROLLBACK"); return NextResponse.json({ error: "Pending reschedule request not found." }, { status: 404 }); }
    const recipientId = proposal.requester_role === "customer" ? proposal.provider_user_id : proposal.customer_id;
    if (action === "withdraw" ? proposal.requested_by !== session.user.id : recipientId !== session.user.id) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: action === "withdraw" ? "Only the requester can withdraw this request." : "Only the other party can approve or decline this request." }, { status: 403 });
    }
    if (proposal.status !== "confirmed" || proposal.starts_at <= new Date()) { await client.query("ROLLBACK"); return NextResponse.json({ error: "This booking can no longer be rescheduled." }, { status: 409 }); }

    let status: Exclude<RescheduleOutcome, "requested" | "expired">;
    if (action === "approve") {
      if (proposal.proposed_starts_at <= new Date()) status = "time_unavailable";
      else {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [proposal.provider_id]);
        const unavailable = await unavailableBookingProfessionals(client, { bookingId, providerId: proposal.provider_id, serviceId: proposal.service_id, startsAt: proposal.proposed_starts_at, endsAt: proposal.proposed_ends_at });
        status = unavailable.length ? "time_unavailable" : "approved";
      }
    } else status = action === "decline" ? "declined" : "withdrawn";
    await client.query(`UPDATE booking_reschedule_requests SET status=$2,response_reason=$3,responded_by=$4,responded_at=now() WHERE id::text=$1`,
      [requestId, status, reason, session.user.id]);
    if (status === "approved") await client.query(`UPDATE bookings SET starts_at=$2,ends_at=$3,
      reschedule_requested_by=NULL,reschedule_starts_at=NULL,reschedule_ends_at=NULL,reschedule_reason=NULL,reschedule_requested_at=NULL
      WHERE id::text=$1`, [bookingId, proposal.proposed_starts_at, proposal.proposed_ends_at]);
    const messages = {
      approved: "The proposed appointment time was approved. The booking calendar was updated.",
      declined: "The reschedule request was declined. The original booking time remains confirmed.",
      withdrawn: "The requester withdrew the proposed time. The original booking remains confirmed.",
      time_unavailable: "The proposed time was no longer available. The original booking remains confirmed.",
    } as const;
    await client.query(`INSERT INTO booking_events(booking_id,actor_user_id,event_type,message,metadata)
      VALUES($1::uuid,$2,$3,$4,jsonb_build_object('requestId',$5::text,'originalStartsAt',$6::timestamptz,
        'originalEndsAt',$7::timestamptz,'proposedStartsAt',$8::timestamptz,'proposedEndsAt',$9::timestamptz,'reason',$10::text))`,
      [bookingId, session.user.id, `reschedule_${status}`, messages[status], requestId, proposal.original_starts_at, proposal.original_ends_at,
        proposal.proposed_starts_at, proposal.proposed_ends_at, reason]);
    for (const userId of [proposal.customer_id, proposal.provider_user_id]) await addNotification(client, {
      userId, bookingId, customerId: proposal.customer_id, requestId, outcome: status,
      title: status === "approved" ? "New booking time approved" : status === "declined" ? "Reschedule request declined" : status === "withdrawn" ? "Reschedule request withdrawn" : "Proposed time unavailable",
      message: messages[status],
    });
    await client.query("COMMIT");
    emailOutcome = status;
    conflictResponse = status === "time_unavailable";
    await recordActivity({ userId: session.user.id, action: `reschedule_${status}`, targetType: "booking", targetId: bookingId, metadata: { requestId } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Booking reschedule response failed", error);
    return NextResponse.json({ error: "We could not update the reschedule request." }, { status: 500 });
  } finally { client.release(); }
  if (emailOutcome) await sendRescheduleEmails(requestId, emailOutcome).catch((error) => console.error("Reschedule outcome email failed", { requestId, emailOutcome, error }));
  if (conflictResponse) return NextResponse.json({ error: "The proposed time is no longer available. The original booking remains confirmed.", status: "time_unavailable" }, { status: 409 });
  return NextResponse.json({ ok: true, status: emailOutcome });
}
