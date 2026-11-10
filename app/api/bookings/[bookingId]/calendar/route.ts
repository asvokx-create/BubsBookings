import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { database } from "@/lib/database";

const escapeIcs = (value: string) => value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
const icsDate = (value: Date) => value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export async function GET(_request: Request, context: { params: Promise<{ bookingId: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { bookingId } = await context.params;
  const result = await database.query<{ title: string; provider: string; starts_at: Date; ends_at: Date; location: string; notes: string }>(
    `SELECT s.title, s.business_name AS provider, b.starts_at, b.ends_at, b.service_address AS location, b.notes
     FROM bookings b JOIN services s ON s.id = b.service_id JOIN provider_profiles p ON p.id = b.provider_id
     WHERE b.id::text = $1 AND b.status IN ('confirmed', 'completed')
       AND NOT EXISTS (SELECT 1 FROM hourly_projects project WHERE project.payment_booking_id=b.id)
       AND (b.customer_id = $2 OR p.user_id = $2) LIMIT 1`, [bookingId, session.user.id]);
  const booking = result.rows[0];
  if (!booking) return NextResponse.json({ error: "Calendar event not found." }, { status: 404 });
  const content = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//BubsBookings//Bookings//EN", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT", `UID:${bookingId}@bubsbookings.com`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(booking.starts_at)}`,
    `DTEND:${icsDate(booking.ends_at)}`, `SUMMARY:${escapeIcs(booking.title)} with ${escapeIcs(booking.provider)}`,
    `LOCATION:${escapeIcs(booking.location)}`, `DESCRIPTION:${escapeIcs(booking.notes || "Booked through BubsBookings")}`,
    "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
  return new NextResponse(content, { headers: { "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": `attachment; filename=bubsbookings-${bookingId.slice(0, 8)}.ics` } });
}
