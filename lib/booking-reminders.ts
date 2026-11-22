import "server-only";

import { database } from "./database";
import { sendBookingReminder, type BookingEmailRow } from "./booking-email";
import { isEmailConfigured } from "./email";
import type { ProviderPlan } from "./plans";

type ReminderRow = BookingEmailRow & {
  reminder_hours: 24 | 1;
  plan: ProviderPlan;
  reminder_occurrence: string;
  reminder_start_epoch: string;
};

// Keep the database's exact microseconds outside the JavaScript Date parser.
const dueReminderQuery = `SELECT b.id::text, s.title AS service_title, b.starts_at, b.ends_at, b.payment_status, b.price_cents,
            b.pricing_type_snapshot, b.hourly_rate_cents_snapshot, b.billable_duration_minutes,
            b.reminder_occurrence::text, extract(epoch FROM b.starts_at)::text AS reminder_start_epoch,
            b.customer_id, customer.name AS customer_name, customer.email AS customer_email,
            COALESCE(customer_settings.booking_notifications, true) AS customer_notifications,
            p.user_id AS provider_user_id, s.business_name AS provider_name,
            provider_user.email AS provider_email,
            COALESCE(provider_settings.booking_notifications, true) AS provider_notifications, p.plan,
            CASE WHEN b.starts_at <= now() + interval '70 minutes' THEN 1 ELSE 24 END AS reminder_hours
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     JOIN provider_profiles p ON p.id = b.provider_id
     JOIN "user" customer ON customer.id = b.customer_id
     JOIN "user" provider_user ON provider_user.id = p.user_id
     LEFT JOIN user_settings customer_settings ON customer_settings.user_id = customer.id
     LEFT JOIN user_settings provider_settings ON provider_settings.user_id = provider_user.id
     WHERE b.status = 'confirmed' AND b.starts_at > now()
       AND ((b.starts_at BETWEEN now() + interval '23 hours' AND now() + interval '25 hours' AND b.reminder_24h_sent_at IS NULL)
         OR (p.plan IN ('pro', 'business', 'owner') AND b.starts_at BETWEEN now() + interval '50 minutes' AND now() + interval '70 minutes' AND b.reminder_1h_sent_at IS NULL))
`;

const exactOccurrence = `b.id = $1::uuid AND b.reminder_occurrence = $2::bigint
  AND extract(epoch FROM b.starts_at) = $3::numeric`;

export async function runBookingReminders() {
  if (!isEmailConfigured()) return { configured: false, processed: 0 };

  const result = await database.query<ReminderRow>(`${dueReminderQuery} ORDER BY b.starts_at LIMIT 100`);

  let sent = 0;
  for (const booking of result.rows) {
    const identity = [booking.id, booking.reminder_occurrence, booking.reminder_start_epoch];
    const { rows: [fresh] } = await database.query<ReminderRow>(
      `${dueReminderQuery} AND (${exactOccurrence})`, identity,
    );
    if (!fresh || fresh.reminder_hours !== booking.reminder_hours) continue;
    const delivered = await sendBookingReminder(fresh, fresh.reminder_hours, fresh.reminder_occurrence);
    if (!delivered) continue;
    const marker = fresh.reminder_hours === 24 ? "reminder_24h_sent_at" : "reminder_1h_sent_at";
    const completed = await database.query(
      `UPDATE bookings b SET ${marker} = now()
       WHERE ${exactOccurrence} AND b.status = 'confirmed' AND b.${marker} IS NULL`,
      identity,
    );
    sent += completed.rowCount ?? 0;
  }
  await database.query("INSERT INTO operations_checks (check_type, status, details) VALUES ('booking_reminders', 'ok', $1::jsonb)", [JSON.stringify({ processed: sent })]);
  return { configured: true, processed: sent };
}
