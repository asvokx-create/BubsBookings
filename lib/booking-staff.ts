import "server-only";

import type { PoolClient } from "pg";

export async function unavailableBookingProfessionals(client: PoolClient, input: {
  bookingId: string;
  providerId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
}) {
  const result = await client.query<{ name: string }>(
    `WITH assigned AS (
       SELECT assignment.team_member_id, assignment.is_owner
       FROM booking_assignees assignment
       WHERE assignment.booking_id::text = $1
     ), staff_hours AS (
       SELECT NULL::uuid AS team_member_id, true AS is_owner, hours.weekday, hours.start_time, hours.end_time, hours.timezone
       FROM availability hours
       WHERE hours.provider_id::text = $2
         AND (hours.service_id::text = $3 OR (hours.service_id IS NULL AND NOT EXISTS (
           SELECT 1 FROM availability configured WHERE configured.provider_id = hours.provider_id AND configured.service_id::text = $3
         )))
       UNION ALL
       SELECT member.id, false, hours.weekday, hours.start_time, hours.end_time, hours.timezone
       FROM provider_team_members member
       JOIN provider_team_member_locations assigned_location ON assigned_location.team_member_id = member.id
       JOIN team_member_availability hours ON hours.team_member_id = member.id
       WHERE member.provider_id::text = $2 AND member.status = 'active'
         AND assigned_location.location_id = (SELECT location_id FROM services WHERE id::text = $3)
     )
     SELECT CASE WHEN assigned.is_owner THEN owner.name ELSE member.name END AS name
     FROM assigned
     JOIN provider_profiles provider ON provider.id::text = $2
     JOIN "user" owner ON owner.id = provider.user_id
     LEFT JOIN provider_team_members member ON member.id = assigned.team_member_id
     WHERE NOT EXISTS (
       SELECT 1 FROM staff_hours hours
       WHERE hours.team_member_id IS NOT DISTINCT FROM assigned.team_member_id
         AND hours.is_owner = assigned.is_owner
         AND hours.weekday = EXTRACT(DOW FROM $4::timestamptz AT TIME ZONE hours.timezone)
         AND ($4::timestamptz AT TIME ZONE hours.timezone)::time >= hours.start_time
         AND ($5::timestamptz AT TIME ZONE hours.timezone)::time <= hours.end_time
     ) OR EXISTS (
       SELECT 1 FROM provider_time_off blocked
       WHERE blocked.provider_id::text = $2
         AND blocked.team_member_id IS NOT DISTINCT FROM assigned.team_member_id
         AND blocked.starts_at < $5 AND blocked.ends_at > $4
     ) OR EXISTS (
       SELECT 1 FROM bookings other
       JOIN booking_assignees other_assignment ON other_assignment.booking_id = other.id
       WHERE other.provider_id::text = $2 AND other.id::text <> $1 AND other.status = 'confirmed'
         AND other.starts_at < $5 AND other.ends_at > $4
         AND ((assigned.is_owner = true AND other_assignment.is_owner = true)
           OR (assigned.team_member_id IS NOT NULL AND other_assignment.team_member_id = assigned.team_member_id))
     ) OR (assigned.is_owner = true AND EXISTS (
       SELECT 1 FROM provider_calendly_connections connection
       JOIN provider_calendly_events external_event ON external_event.connection_id = connection.id
       WHERE connection.provider_id::text = $2 AND connection.disconnected_at IS NULL
         AND connection.block_conflicting_bookings = true AND external_event.status = 'active'
         AND external_event.starts_at < $5 AND external_event.ends_at > $4
     )) OR (assigned.is_owner = true AND EXISTS (
       SELECT 1 FROM provider_calendly_connections connection
       WHERE connection.provider_id::text = $2 AND connection.disconnected_at IS NULL
         AND connection.block_conflicting_bookings = true
         AND (connection.last_sync_succeeded_at IS NULL
           OR connection.last_sync_succeeded_at < now()-interval '20 minutes'
           OR connection.last_sync_error IS NOT NULL)
     ))`,
    [input.bookingId, input.providerId, input.serviceId, input.startsAt, input.endsAt],
  );
  return result.rows.map((row) => row.name);
}
