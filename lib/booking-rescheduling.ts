import "server-only";

import { database } from "./database";
import { sendTransactionalEmail } from "./email";

export type RescheduleOutcome = "requested" | "approved" | "declined" | "withdrawn" | "expired" | "time_unavailable";

type RescheduleEmailRow = {
  id: string; booking_id: string; customer_id: string; customer_email: string; customer_notifications: boolean;
  provider_user_id: string; provider_email: string; provider_notifications: boolean; requested_by: string;
  service_title: string; original_starts_at: Date; original_ends_at: Date; proposed_starts_at: Date; proposed_ends_at: Date;
  timezone: string;
};

function appointmentLabel(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
}

export async function sendRescheduleEmails(requestId: string, outcome: RescheduleOutcome) {
  const result = await database.query<RescheduleEmailRow>(
    `SELECT request.id::text,request.booking_id::text,request.requested_by,request.original_starts_at,request.original_ends_at,
            request.proposed_starts_at,request.proposed_ends_at,booking.customer_id,customer.email AS customer_email,
            COALESCE(customer_settings.booking_notifications,true) AS customer_notifications,
            provider.user_id AS provider_user_id,provider_user.email AS provider_email,
            COALESCE(provider_settings.booking_notifications,true) AS provider_notifications,service.title AS service_title,
            COALESCE((SELECT hours.timezone FROM availability hours WHERE hours.provider_id=booking.provider_id
              AND (hours.service_id=booking.service_id OR hours.service_id IS NULL)
              ORDER BY (hours.service_id=booking.service_id) DESC LIMIT 1),'America/Los_Angeles') AS timezone
     FROM booking_reschedule_requests request JOIN bookings booking ON booking.id=request.booking_id
     JOIN services service ON service.id=booking.service_id JOIN provider_profiles provider ON provider.id=booking.provider_id
     JOIN "user" customer ON customer.id=booking.customer_id JOIN "user" provider_user ON provider_user.id=provider.user_id
     LEFT JOIN user_settings customer_settings ON customer_settings.user_id=customer.id
     LEFT JOIN user_settings provider_settings ON provider_settings.user_id=provider_user.id
     WHERE request.id::text=$1`, [requestId],
  );
  const row = result.rows[0];
  if (!row) return;
  const original = `${appointmentLabel(row.original_starts_at, row.timezone)}–${appointmentLabel(row.original_ends_at, row.timezone)}`;
  const proposed = `${appointmentLabel(row.proposed_starts_at, row.timezone)}–${appointmentLabel(row.proposed_ends_at, row.timezone)}`;
  const reference = row.booking_id.slice(0, 8).toUpperCase();
  const copy: Record<RescheduleOutcome, { subject: string; heading: string; status: string }> = {
    requested: { subject: `Review a new time for ${row.service_title}`, heading: "Reschedule approval requested", status: "Pending Approval" },
    approved: { subject: `New time approved for ${row.service_title}`, heading: "Booking rescheduled", status: "Approved" },
    declined: { subject: `Reschedule declined for ${row.service_title}`, heading: "Original booking preserved", status: "Declined" },
    withdrawn: { subject: `Reschedule request withdrawn for ${row.service_title}`, heading: "Reschedule request withdrawn", status: "Withdrawn" },
    expired: { subject: `Reschedule request expired for ${row.service_title}`, heading: "Reschedule request expired", status: "Expired" },
    time_unavailable: { subject: `Proposed time unavailable for ${row.service_title}`, heading: "Choose another time", status: "Time No Longer Available" },
  };
  const recipients = [
    { id: row.customer_id, email: row.customer_email, enabled: row.customer_notifications, href: `/account/bookings/${row.booking_id}` },
    { id: row.provider_user_id, email: row.provider_email, enabled: row.provider_notifications, href: `/provider/dashboard/bookings/${row.booking_id}` },
  ].filter((recipient) => outcome !== "requested" || recipient.id !== row.requested_by);
  await Promise.all(recipients.map((recipient) => recipient.enabled ? sendTransactionalEmail({
    to: recipient.email, userId: recipient.id, bookingId: row.booking_id,
    emailType: `booking_reschedule_${outcome}`,
    idempotencyKey: `booking-reschedule-${requestId}-${outcome}-${recipient.id}`,
    subject: copy[outcome].subject, heading: copy[outcome].heading,
    message: `Booking #${reference}\nOriginal: ${original}\nProposed: ${proposed}\nTimezone: ${row.timezone}\nStatus: ${copy[outcome].status}`,
    actionLabel: outcome === "requested" ? "Review request" : "View booking", actionUrl: recipient.href,
  }) : null));
}

export async function expireRescheduleRequests(bookingId?: string) {
  const client = await database.connect();
  const expiredIds: string[] = [];
  try {
    await client.query("BEGIN");
    const expired = await client.query<{ id: string; booking_id: string; customer_id: string; provider_user_id: string }>(
      `UPDATE booking_reschedule_requests request SET status='expired',responded_at=now()
       FROM bookings booking JOIN provider_profiles provider ON provider.id=booking.provider_id
       WHERE request.booking_id=booking.id AND request.status='pending' AND request.expires_at<=now()
         AND ($1::text IS NULL OR booking.id::text=$1)
       RETURNING request.id::text,booking.id::text AS booking_id,booking.customer_id,provider.user_id AS provider_user_id`,
      [bookingId ?? null],
    );
    for (const request of expired.rows) {
      expiredIds.push(request.id);
      await client.query(`INSERT INTO booking_events(booking_id,event_type,message,metadata)
        VALUES($1::uuid,'reschedule_expired','The reschedule request expired. The original booking time remains confirmed.',jsonb_build_object('requestId',$2::text))`, [request.booking_id, request.id]);
      for (const userId of [request.customer_id, request.provider_user_id]) await client.query(
        `INSERT INTO notifications(user_id,booking_id,type,title,message,href,dedupe_key)
         VALUES($1,$2::uuid,'booking_reschedule','Reschedule request expired','The proposed time was not approved before it expired. The original booking remains confirmed.',
           CASE WHEN $1=$3 THEN '/account/bookings/'||$2::uuid::text ELSE '/provider/dashboard/bookings/'||$2::uuid::text END,$4)
         ON CONFLICT(dedupe_key) DO NOTHING`,
        [userId, request.booking_id, request.customer_id, `booking-reschedule-${request.id}-expired-${userId}`],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
  await Promise.all(expiredIds.map((id) => sendRescheduleEmails(id, "expired").catch((error) => {
    console.error("Expired reschedule email failed", { requestId: id, error });
  })));
  return { expired: expiredIds.length };
}
