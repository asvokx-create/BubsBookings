import { NextResponse } from "next/server";
import { database } from "@/lib/database";
import { validateHourlyDuration, type HourlyPricingConfig, type PricingType } from "@/lib/service-pricing";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function GET(request: Request, context: RouteContext<"/api/services/[serviceId]/availability">) {
  const { serviceId } = await context.params;
  const searchParams = new URL(request.url).searchParams;
  const serviceResult = await database.query<{
    duration_minutes: number; pricing_type: PricingType; hourly_rate_cents: number | null;
    minimum_duration_minutes: number | null; maximum_duration_minutes: number | null;
    billing_increment_minutes: 15 | 30 | 60 | null; default_duration_minutes: number | null;
  }>(`SELECT s.duration_minutes,s.pricing_type,s.hourly_rate_cents,s.minimum_duration_minutes,s.maximum_duration_minutes,s.billing_increment_minutes,s.default_duration_minutes
      FROM services s JOIN provider_profiles p ON p.id=s.provider_id
      WHERE s.id::text=$1 AND s.is_active=true AND s.provider_deleted_at IS NULL AND p.is_active=true AND p.age_verification_status='verified'`, [serviceId]);
  const service = serviceResult.rows[0];
  if (!service) return NextResponse.json({ error: "Service not found." }, { status: 404 });
  const additionalMinutes = Number(searchParams.get("additionalMinutes") ?? 0);
  if (!Number.isSafeInteger(additionalMinutes) || additionalMinutes < 0 || additionalMinutes > 10_080) return NextResponse.json({ error: "Choose valid add-ons." }, { status: 400 });
  let selectedDurationMinutes = service.duration_minutes;
  if (service.pricing_type === "HOURLY") {
    const requestedDuration = Number(searchParams.get("durationMinutes") ?? service.default_duration_minutes);
    try {
      selectedDurationMinutes = validateHourlyDuration({ pricingType: "HOURLY", hourlyRateCents: service.hourly_rate_cents!, minimumDurationMinutes: service.minimum_duration_minutes!, maximumDurationMinutes: service.maximum_duration_minutes, billingIncrementMinutes: service.billing_increment_minutes!, defaultDurationMinutes: service.default_duration_minutes! } satisfies HourlyPricingConfig, requestedDuration);
    } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Choose a valid duration." }, { status: 400 }); }
  }
  selectedDurationMinutes += additionalMinutes;
  const month = searchParams.get("month") ?? "";
  if (month) {
    if (!monthPattern.test(month)) return NextResponse.json({ error: "Choose a valid month." }, { status: 400 });
    const result = await database.query<{ date: string }>(
      `WITH service_info AS (
         SELECT s.id, s.provider_id, $3::integer AS duration_minutes, s.location_id
         FROM services s
         JOIN provider_profiles p ON p.id = s.provider_id
         WHERE s.id::text = $1 AND s.is_active = true AND s.provider_deleted_at IS NULL AND p.is_active = true AND p.age_verification_status = 'verified'
       ), staff_hours AS (
         SELECT si.provider_id, NULL::uuid AS member_id, si.duration_minutes,
                a.weekday, a.start_time, a.end_time, a.timezone
         FROM service_info si JOIN availability a ON a.provider_id = si.provider_id
         WHERE a.service_id = si.id OR (a.service_id IS NULL AND NOT EXISTS (
           SELECT 1 FROM availability configured WHERE configured.provider_id = si.provider_id AND configured.service_id = si.id
         ))
         UNION ALL
         SELECT si.provider_id, member.id AS member_id, si.duration_minutes,
                hours.weekday, hours.start_time, hours.end_time, hours.timezone
         FROM service_info si JOIN provider_team_members member ON member.provider_id = si.provider_id AND member.status = 'active'
           AND (si.location_id IS NULL OR EXISTS (SELECT 1 FROM provider_team_member_locations assigned_location WHERE assigned_location.team_member_id = member.id AND assigned_location.location_id = si.location_id))
         JOIN team_member_availability hours ON hours.team_member_id = member.id
       ), days AS (
         SELECT generated::date AS date
         FROM generate_series($2::date, (($2::date + interval '1 month') - interval '1 day')::date, interval '1 day') generated
       ), generated_slots AS (
         SELECT days.date, sh.provider_id, sh.member_id, sh.duration_minutes, sh.timezone,
                generated.starts_at
         FROM staff_hours sh
         JOIN days ON sh.weekday = EXTRACT(DOW FROM days.date)
         CROSS JOIN LATERAL generate_series(
           (days.date + sh.start_time) AT TIME ZONE sh.timezone,
           ((days.date + sh.end_time) AT TIME ZONE sh.timezone) - make_interval(mins => sh.duration_minutes),
           interval '30 minutes'
         ) AS generated(starts_at)
       )
       SELECT DISTINCT to_char(gs.date, 'YYYY-MM-DD') AS date
       FROM generated_slots gs
       WHERE gs.starts_at > CURRENT_TIMESTAMP
         AND NOT EXISTS (
           SELECT 1 FROM provider_time_off blocked
           WHERE blocked.provider_id = gs.provider_id
             AND blocked.team_member_id IS NOT DISTINCT FROM gs.member_id
             AND blocked.starts_at < gs.starts_at + make_interval(mins => gs.duration_minutes)
             AND blocked.ends_at > gs.starts_at
         )
         AND NOT EXISTS (
           SELECT 1 FROM bookings b
           JOIN booking_assignees assigned ON assigned.booking_id = b.id
           WHERE b.provider_id = gs.provider_id
             AND b.status = 'confirmed'
             AND ((gs.member_id IS NULL AND assigned.is_owner = true) OR assigned.team_member_id = gs.member_id)
             AND b.starts_at < gs.starts_at + make_interval(mins => gs.duration_minutes)
             AND b.ends_at > gs.starts_at
         )
         AND NOT EXISTS (
           SELECT 1 FROM provider_calendly_connections connection
           JOIN provider_calendly_events external_event ON external_event.connection_id=connection.id
           WHERE gs.member_id IS NULL AND connection.provider_id=gs.provider_id
             AND connection.disconnected_at IS NULL AND connection.block_conflicting_bookings=true
             AND external_event.status='active'
             AND external_event.starts_at < gs.starts_at + make_interval(mins => gs.duration_minutes)
             AND external_event.ends_at > gs.starts_at
         )
       ORDER BY date`,
      [serviceId, `${month}-01`, selectedDurationMinutes],
    );
    return NextResponse.json({ dates: result.rows.map((row) => row.date) });
  }

  const date = searchParams.get("date") ?? "";
  if (!datePattern.test(date)) return NextResponse.json({ error: "Choose a valid date." }, { status: 400 });

  const result = await database.query<{ time: string }>(
    `WITH service_info AS (
       SELECT s.id, s.provider_id, $3::integer AS duration_minutes, s.location_id
       FROM services s
       JOIN provider_profiles p ON p.id = s.provider_id
       WHERE s.id::text = $1 AND s.is_active = true AND s.provider_deleted_at IS NULL AND p.is_active = true AND p.age_verification_status = 'verified'
     ), staff_hours AS (
       SELECT si.provider_id, NULL::uuid AS member_id, si.duration_minutes,
              a.weekday, a.start_time, a.end_time, a.timezone
       FROM service_info si JOIN availability a ON a.provider_id = si.provider_id
       WHERE a.service_id = si.id OR (a.service_id IS NULL AND NOT EXISTS (
         SELECT 1 FROM availability configured WHERE configured.provider_id = si.provider_id AND configured.service_id = si.id
       ))
       UNION ALL
       SELECT si.provider_id, member.id AS member_id, si.duration_minutes,
              hours.weekday, hours.start_time, hours.end_time, hours.timezone
       FROM service_info si JOIN provider_team_members member ON member.provider_id = si.provider_id AND member.status = 'active'
         AND (si.location_id IS NULL OR EXISTS (SELECT 1 FROM provider_team_member_locations assigned_location WHERE assigned_location.team_member_id = member.id AND assigned_location.location_id = si.location_id))
       JOIN team_member_availability hours ON hours.team_member_id = member.id
     ), generated_slots AS (
       SELECT sh.provider_id, sh.member_id, sh.duration_minutes, sh.timezone,
              generated.starts_at
       FROM staff_hours sh
       CROSS JOIN LATERAL generate_series(
         ($2::date + sh.start_time) AT TIME ZONE sh.timezone,
         (($2::date + sh.end_time) AT TIME ZONE sh.timezone) - make_interval(mins => sh.duration_minutes),
         interval '30 minutes'
       ) AS generated(starts_at)
       WHERE sh.weekday = EXTRACT(DOW FROM $2::date)
     )
     SELECT DISTINCT to_char(gs.starts_at AT TIME ZONE gs.timezone, 'HH24:MI') AS time
     FROM generated_slots gs
     WHERE gs.starts_at > CURRENT_TIMESTAMP
       AND NOT EXISTS (
         SELECT 1 FROM provider_time_off blocked
         WHERE blocked.provider_id = gs.provider_id
           AND blocked.team_member_id IS NOT DISTINCT FROM gs.member_id
           AND blocked.starts_at < gs.starts_at + make_interval(mins => gs.duration_minutes)
           AND blocked.ends_at > gs.starts_at
       )
       AND NOT EXISTS (
         SELECT 1 FROM bookings b
         JOIN booking_assignees assigned ON assigned.booking_id = b.id
         WHERE b.provider_id = gs.provider_id
           AND b.status = 'confirmed'
           AND ((gs.member_id IS NULL AND assigned.is_owner = true) OR assigned.team_member_id = gs.member_id)
           AND b.starts_at < gs.starts_at + make_interval(mins => gs.duration_minutes)
           AND b.ends_at > gs.starts_at
       )
       AND NOT EXISTS (
         SELECT 1 FROM provider_calendly_connections connection
         JOIN provider_calendly_events external_event ON external_event.connection_id=connection.id
         WHERE gs.member_id IS NULL AND connection.provider_id=gs.provider_id
           AND connection.disconnected_at IS NULL AND connection.block_conflicting_bookings=true
           AND external_event.status='active'
           AND external_event.starts_at < gs.starts_at + make_interval(mins => gs.duration_minutes)
           AND external_event.ends_at > gs.starts_at
       )
     ORDER BY time`,
    [serviceId, date, selectedDurationMinutes],
  );

  return NextResponse.json({ times: result.rows.map((row) => row.time.slice(0, 5)) });
}
