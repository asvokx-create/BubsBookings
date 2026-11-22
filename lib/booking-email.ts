import "server-only";

import { database } from "./database";
import { sendTransactionalEmail } from "./email";
import { formatDurationMinutes } from "./service-pricing";

type BookingEmailRow = {
  id: string;
  service_title: string;
  starts_at: Date;
  customer_id: string;
  customer_name: string;
  customer_email: string;
  customer_notifications: boolean;
  provider_user_id: string;
  provider_name: string;
  provider_email: string;
  provider_notifications: boolean;
  payment_status: string;
  ends_at: Date;
  pricing_type_snapshot: "FIXED" | "HOURLY" | "QUOTE_ONLY";
  hourly_rate_cents_snapshot: number | null;
  billable_duration_minutes: number;
  price_cents: number;
};

async function bookingForEmail(bookingId: string) {
  const result = await database.query<BookingEmailRow>(
    `SELECT b.id::text, s.title AS service_title, b.starts_at, b.ends_at, b.payment_status, b.price_cents,
            b.pricing_type_snapshot,b.hourly_rate_cents_snapshot,b.billable_duration_minutes,
            b.customer_id, customer.name AS customer_name, customer.email AS customer_email,
            COALESCE(customer_settings.booking_notifications, true) AS customer_notifications,
            p.user_id AS provider_user_id, s.business_name AS provider_name,
            provider_user.email AS provider_email,
            COALESCE(provider_settings.booking_notifications, true) AS provider_notifications
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     JOIN provider_profiles p ON p.id = b.provider_id
     JOIN "user" customer ON customer.id = b.customer_id
     JOIN "user" provider_user ON provider_user.id = p.user_id
     LEFT JOIN user_settings customer_settings ON customer_settings.user_id = customer.id
     LEFT JOIN user_settings provider_settings ON provider_settings.user_id = provider_user.id
     WHERE b.id::text = $1`,
    [bookingId],
  );
  return result.rows[0] ?? null;
}

function appointmentLabel(date: Date) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Los_Angeles" }).format(date);
}

export async function sendBookingUpdateEmails(bookingId: string, event: "requested" | "accepted" | "declined" | "cancelled" | "completed") {
  const booking = await bookingForEmail(bookingId);
  if (!booking) return;
  const when = appointmentLabel(booking.starts_at);
  const until = appointmentLabel(booking.ends_at);
  const pricing = booking.pricing_type_snapshot === "QUOTE_ONLY"
    ? " This is a custom quote request. No price has been approved or charged."
    : booking.pricing_type_snapshot === "HOURLY" && booking.hourly_rate_cents_snapshot !== null
    ? ` ${formatDurationMinutes(booking.billable_duration_minutes)} at $${(booking.hourly_rate_cents_snapshot / 100).toFixed(2)}/hr; service subtotal $${(booking.price_cents / 100).toFixed(2)}.`
    : ` Service price $${(booking.price_cents / 100).toFixed(2)}.`;

  if (event === "requested") {
    if (booking.provider_notifications) await sendTransactionalEmail({ to: booking.provider_email, userId: booking.provider_user_id, bookingId, emailType: "booking_requested_provider", subject: `New request for ${booking.service_title}`, heading: "You have a new booking request", message: `${booking.customer_name} requested ${booking.service_title} for ${when}.${pricing}`, actionLabel: "Review request", actionUrl: "/provider/dashboard/bookings" });
    if (booking.customer_notifications) await sendTransactionalEmail({ to: booking.customer_email, userId: booking.customer_id, bookingId, emailType: "booking_requested_customer", subject: "Your BubsBookings request was sent", heading: "Your request is with the provider", message: `${booking.provider_name} received your request for ${booking.service_title} on ${when}.${pricing}`, actionLabel: "View booking", actionUrl: `/account/bookings/${bookingId}` });
    return;
  }

  const content = {
    accepted: { subject: "Your BubsBookings booking is confirmed", heading: "Booking confirmed", message: `${booking.provider_name} accepted ${booking.service_title} from ${when} to ${until}.${pricing} Open your booking to pay through Stripe before the appointment.` },
    declined: { subject: "Your BubsBookings request was declined", heading: "Booking request declined", message: `${booking.provider_name} could not accept ${booking.service_title} for ${when}.` },
    cancelled: { subject: "A BubsBookings booking was cancelled", heading: "Booking cancelled", message: `${booking.service_title}, scheduled for ${when}, was cancelled.` },
    completed: booking.payment_status === "paid"
      ? { subject: "Please confirm your completed BubsBookings service", heading: "Was the job completed?", message: `${booking.service_title} was marked complete. Confirm the work or open a dispute within 48 hours. If you do not respond, the provider payout releases automatically.` }
      : { subject: `Payment due for ${booking.service_title}`, heading: "Your service was marked complete", message: `${booking.service_title} was marked complete. Open your booking to pay through Stripe.` },
  }[event];
  if (booking.customer_notifications) await sendTransactionalEmail({ to: booking.customer_email, userId: booking.customer_id, bookingId, emailType: `booking_${event}_customer`, ...content, actionLabel: "View booking", actionUrl: `/account/bookings/${bookingId}` });
  if (event === "cancelled" && booking.provider_notifications) await sendTransactionalEmail({ to: booking.provider_email, userId: booking.provider_user_id, bookingId, emailType: "booking_cancelled_provider", subject: content.subject, heading: content.heading, message: `${booking.customer_name}'s ${booking.service_title} booking for ${when} was cancelled.`, actionLabel: "View bookings", actionUrl: "/provider/dashboard/bookings" });
}

export async function sendBookingReminder(booking: BookingEmailRow, hours: 24 | 1, occurrence = "0") {
  // Keep the original implicit key untouched for all legacy occurrences.
  const key = (recipient: "customer" | "provider") => occurrence === "0" ? {}
    : { idempotencyKey: `booking-reminder-${booking.id}-${hours}h-${recipient}-r${occurrence}` };
  const when = appointmentLabel(booking.starts_at);
  const until = appointmentLabel(booking.ends_at);
  const pricing = booking.pricing_type_snapshot === "QUOTE_ONLY"
    ? " Custom quote pending. No price has been approved or charged."
    : booking.pricing_type_snapshot === "HOURLY" && booking.hourly_rate_cents_snapshot !== null
    ? ` ${formatDurationMinutes(booking.billable_duration_minutes)} at $${(booking.hourly_rate_cents_snapshot / 100).toFixed(2)}/hr; service subtotal $${(booking.price_cents / 100).toFixed(2)}.`
    : ` Service price $${(booking.price_cents / 100).toFixed(2)}.`;
  const providerMessage = `${booking.service_title} is scheduled from ${when} to ${until}.${pricing} Open BubsBookings for the latest details or to message the other person.`;
  const customerMessage = booking.payment_status === "paid"
    ? providerMessage
    : `${booking.service_title} is scheduled for ${when}, and payment is still due. Open your booking to pay through Stripe before the provider arrives.`;
  const results = await Promise.all([
    booking.customer_notifications ? sendTransactionalEmail({ to: booking.customer_email, userId: booking.customer_id, bookingId: booking.id, emailType: `reminder_${hours}h_customer`, ...key("customer"), subject: `Reminder: ${booking.service_title} is coming up`, heading: hours === 24 ? "Your booking is tomorrow" : "Your booking starts soon", message: customerMessage, actionLabel: booking.payment_status === "paid" ? "View booking" : "Pay through Stripe", actionUrl: `/account/bookings/${booking.id}` }) : null,
    booking.provider_notifications ? sendTransactionalEmail({ to: booking.provider_email, userId: booking.provider_user_id, bookingId: booking.id, emailType: `reminder_${hours}h_provider`, ...key("provider"), subject: `Reminder: ${booking.service_title} is coming up`, heading: hours === 24 ? "You have a booking tomorrow" : "Your booking starts soon", message: providerMessage, actionLabel: "View bookings", actionUrl: "/provider/dashboard/bookings" }) : null,
  ]);
  return results.every((result) => result === null || result.sent);
}

export type { BookingEmailRow };
