import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { database } from "@/lib/database";
import { zonedDateTimeToUtc } from "@/lib/zoned-date-time";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

const availabilityCtes = `
  WITH booking_info AS (
    SELECT booking.id, booking.provider_id, booking.service_id,
           round(EXTRACT(EPOCH FROM (booking.ends_at-booking.starts_at))/60)::integer AS duration_minutes,
           COALESCE((SELECT hours.timezone FROM availability hours
             WHERE hours.provider_id=booking.provider_id
               AND (hours.service_id=booking.service_id OR hours.service_id IS NULL)
             ORDER BY (hours.service_id=booking.service_id) DESC LIMIT 1), 'America/Los_Angeles') AS timezone
    FROM bookings booking JOIN provider_profiles provider ON provider.id=booking.provider_id
    WHERE booking.id::text=$1 AND booking.status='confirmed'
      AND (booking.customer_id=$2 OR provider.user_id=$2)
  ), assigned AS (
    SELECT assignment.team_member_id, assignment.is_owner
    FROM booking_assignees assignment JOIN booking_info info ON info.id=assignment.booking_id
  ), staff_hours AS (
    SELECT NULL::uuid AS team_member_id, true AS is_owner, hours.weekday, hours.start_time, hours.end_time, hours.timezone
    FROM availability hours JOIN booking_info info ON info.provider_id=hours.provider_id
    WHERE hours.service_id=info.service_id OR (hours.service_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM availability configured WHERE configured.provider_id=info.provider_id AND configured.service_id=info.service_id
    ))
    UNION ALL
    SELECT member.id, false, hours.weekday, hours.start_time, hours.end_time, hours.timezone
    FROM provider_team_members member JOIN team_member_availability hours ON hours.team_member_id=member.id
    JOIN booking_info info ON info.provider_id=member.provider_id
    WHERE member.status='active'
  ), candidates AS (
    SELECT generated.starts_at, generated.starts_at + make_interval(mins=>info.duration_minutes) AS ends_at,
           (generated.starts_at AT TIME ZONE info.timezone)::date AS local_date, info.timezone
    FROM booking_info info
    CROSS JOIN LATERAL generate_series($3::timestamptz, $4::timestamptz, interval '30 minutes') generated(starts_at)
    WHERE generated.starts_at > CURRENT_TIMESTAMP
  ), available AS (
    SELECT candidate.* FROM candidates candidate CROSS JOIN booking_info info
    WHERE NOT EXISTS (
      SELECT 1 FROM assigned professional
      WHERE NOT EXISTS (
        SELECT 1 FROM staff_hours hours
        WHERE hours.team_member_id IS NOT DISTINCT FROM professional.team_member_id
          AND hours.is_owner=professional.is_owner
          AND hours.weekday=EXTRACT(DOW FROM candidate.starts_at AT TIME ZONE hours.timezone)
          AND (candidate.starts_at AT TIME ZONE hours.timezone)::time>=hours.start_time
          AND (candidate.ends_at AT TIME ZONE hours.timezone)::time<=hours.end_time
      )
      OR EXISTS (
        SELECT 1 FROM provider_time_off blocked
        WHERE blocked.provider_id=info.provider_id
          AND blocked.team_member_id IS NOT DISTINCT FROM professional.team_member_id
          AND blocked.starts_at<candidate.ends_at AND blocked.ends_at>candidate.starts_at
      )
      OR EXISTS (
        SELECT 1 FROM bookings other JOIN booking_assignees other_assignment ON other_assignment.booking_id=other.id
        WHERE other.provider_id=info.provider_id AND other.id<>info.id AND other.status='confirmed'
          AND other.starts_at<candidate.ends_at AND other.ends_at>candidate.starts_at
          AND ((professional.is_owner=true AND other_assignment.is_owner=true)
            OR (professional.team_member_id IS NOT NULL AND other_assignment.team_member_id=professional.team_member_id))
      )
      OR (professional.is_owner=true AND EXISTS (
        SELECT 1 FROM provider_calendly_connections connection
        JOIN provider_calendly_events external_event ON external_event.connection_id=connection.id
        WHERE connection.provider_id=info.provider_id AND connection.disconnected_at IS NULL
          AND connection.block_conflicting_bookings=true AND external_event.status='active'
          AND external_event.starts_at<candidate.ends_at AND external_event.ends_at>candidate.starts_at
      ))
      OR (professional.is_owner=true AND EXISTS (
        SELECT 1 FROM provider_calendly_connections connection
        WHERE connection.provider_id=info.provider_id AND connection.disconnected_at IS NULL
          AND connection.block_conflicting_bookings=true
          AND (connection.last_sync_succeeded_at IS NULL
            OR connection.last_sync_succeeded_at<now()-interval '20 minutes'
            OR connection.last_sync_error IS NOT NULL)
      ))
    )
  )`;

export async function GET(request: Request, context: { params: Promise<{ bookingId: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { bookingId } = await context.params;
  const search = new URL(request.url).searchParams;
  const month = search.get("month") ?? "";
  const date = search.get("date") ?? "";
  if (!month && !date) return NextResponse.json({ error: "Choose a month or date." }, { status: 400 });
  if (month && !monthPattern.test(month)) return NextResponse.json({ error: "Choose a valid month." }, { status: 400 });
  if (date && !datePattern.test(date)) return NextResponse.json({ error: "Choose a valid date." }, { status: 400 });

  const period = month ? `${month}-01` : date;
  const rangeStart = new Date(`${period}T00:00:00Z`);
  rangeStart.setUTCDate(rangeStart.getUTCDate() - 1);
  const rangeEnd = new Date(`${period}T00:00:00Z`);
  rangeEnd.setUTCDate(rangeEnd.getUTCDate() + (month ? 33 : 2));
  const result = await database.query<{ value: string; timezone: string }>(
    `${availabilityCtes}
     SELECT DISTINCT ${month
       ? "to_char(available.local_date, 'YYYY-MM-DD')"
       : "to_char(available.starts_at AT TIME ZONE available.timezone, 'HH24:MI')"} AS value,
       available.timezone
     FROM available
     WHERE available.local_date ${month ? ">= $5::date AND available.local_date < $5::date + interval '1 month'" : "= $5::date"}
     ORDER BY value`,
    [bookingId, session.user.id, rangeStart, rangeEnd, period],
  );
  if (!result.rows.length) {
    const access = await database.query(`SELECT 1 FROM bookings booking JOIN provider_profiles provider ON provider.id=booking.provider_id
      WHERE booking.id::text=$1 AND booking.status='confirmed' AND (booking.customer_id=$2 OR provider.user_id=$2)`, [bookingId, session.user.id]);
    if (!access.rowCount) return NextResponse.json({ error: "This booking is not eligible for rescheduling." }, { status: 404 });
  }
  if (month) return NextResponse.json({ dates: result.rows.map((row) => row.value), timeZone: result.rows[0]?.timezone ?? "America/Los_Angeles" });
  const safeRows = result.rows.filter((row) => zonedDateTimeToUtc(date, row.value, row.timezone) !== null);
  return NextResponse.json({ times: safeRows.map((row) => row.value), timeZone: safeRows[0]?.timezone ?? result.rows[0]?.timezone ?? "America/Los_Angeles" });
}
