import { MANUAL_JOB_PREFIX } from "@/lib/manual-job";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { database } from "@/lib/database";

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const role = new URL(request.url).searchParams.get("role") === "provider" ? "provider" : "customer";
  const result = await database.query<{
    id: string; title: string; person: string; starts_at: Date; ends_at: Date; location: string; status: string;
    assigned_team_member_id: string | null; assigned_team_member_ids: string[]; assignee_name: string;
  }>(role === "provider" ?
    `SELECT b.id::text, s.title, u.name AS person, b.starts_at, b.ends_at,
            CASE WHEN b.delivery_method = 'REMOTE' THEN 'Remote service' WHEN b.status = 'requested' THEN
              COALESCE(NULLIF(trim(concat_ws(' ', concat_ws(', ', b.service_city, b.service_state), b.service_postal_code)), ''), 'Address available after acceptance')
              ELSE b.service_address END AS location,
            b.status,
            b.assigned_team_member_id::text,
            ARRAY(SELECT COALESCE(assigned.team_member_id::text, 'owner') FROM booking_assignees assigned WHERE assigned.booking_id = b.id) AS assigned_team_member_ids,
            COALESCE((SELECT string_agg(CASE WHEN assigned.is_owner THEN owner_user.name ELSE assigned_member.name END, ', ' ORDER BY assigned.is_owner DESC, assigned_member.name)
              FROM booking_assignees assigned LEFT JOIN provider_team_members assigned_member ON assigned_member.id = assigned.team_member_id
              WHERE assigned.booking_id = b.id), COALESCE(member.name, owner_user.name)) AS assignee_name
     FROM bookings b JOIN services s ON s.id = b.service_id JOIN "user" u ON u.id = b.customer_id
     JOIN provider_profiles p ON p.id = b.provider_id
     JOIN "user" owner_user ON owner_user.id = p.user_id
     LEFT JOIN provider_team_members member ON member.id = b.assigned_team_member_id
     WHERE p.user_id = $1 AND b.provider_deleted_at IS NULL AND b.status <> 'cancelled'
       AND b.starts_at >= now() - interval '6 months' AND b.starts_at < now() + interval '18 months'
     ORDER BY b.starts_at` :
    `SELECT b.id::text, s.title, s.business_name AS person, b.starts_at, b.ends_at, b.service_address AS location, b.status,
            b.assigned_team_member_id::text,
            ARRAY(SELECT COALESCE(assigned.team_member_id::text, 'owner') FROM booking_assignees assigned WHERE assigned.booking_id = b.id) AS assigned_team_member_ids,
            COALESCE((SELECT string_agg(CASE WHEN assigned.is_owner THEN owner_user.name ELSE assigned_member.name END, ', ' ORDER BY assigned.is_owner DESC, assigned_member.name)
              FROM booking_assignees assigned LEFT JOIN provider_team_members assigned_member ON assigned_member.id = assigned.team_member_id
              WHERE assigned.booking_id = b.id), COALESCE(member.name, owner_user.name)) AS assignee_name
     FROM bookings b JOIN services s ON s.id = b.service_id JOIN provider_profiles p ON p.id = b.provider_id
     JOIN "user" owner_user ON owner_user.id = p.user_id
     LEFT JOIN provider_team_members member ON member.id = b.assigned_team_member_id
     WHERE b.customer_id = $1 AND b.status <> 'cancelled'
       AND b.starts_at >= now() - interval '6 months' AND b.starts_at < now() + interval '18 months'
     ORDER BY b.starts_at`, [session.user.id]);
  const staff = role === "provider" ? (await database.query<{ id: string; name: string }>(
    `SELECT member.id::text, member.name FROM provider_team_members member JOIN provider_profiles p ON p.id = member.provider_id
     WHERE p.user_id = $1 AND member.status = 'active' ORDER BY member.name`, [session.user.id])).rows : [];
  const timeOff = role === "provider" ? (await database.query<{ id: string; member_id: string | null; assignee_name: string; starts_at: Date; ends_at: Date; reason: string }>(
    `SELECT blocked.id::text, blocked.team_member_id::text AS member_id, COALESCE(member.name, 'Company owner') AS assignee_name,
            blocked.starts_at, blocked.ends_at, blocked.reason
     FROM provider_time_off blocked JOIN provider_profiles p ON p.id = blocked.provider_id
     LEFT JOIN provider_team_members member ON member.id = blocked.team_member_id
     WHERE p.user_id = $1 AND blocked.ends_at >= now() - interval '6 months' AND blocked.starts_at < now() + interval '18 months'`, [session.user.id])).rows : [];
  const calendly = role === "provider" ? (await database.query<{ id: string; title: string; starts_at: Date; ends_at: Date; location: string; status: string }>(
    `SELECT event.id::text,event.title,event.starts_at,event.ends_at,event.location,event.status
     FROM provider_calendly_events event
     JOIN provider_calendly_connections connection ON connection.id=event.connection_id AND connection.disconnected_at IS NULL
     JOIN provider_profiles provider ON provider.id=event.provider_id
     WHERE provider.user_id=$1 AND event.starts_at>=now()-interval '6 months' AND event.starts_at<now()+interval '18 months'
     ORDER BY event.starts_at`, [session.user.id])).rows : [];
  return NextResponse.json({ staff, events: [...result.rows.map((row) => ({ id: row.id, kind: "booking", title: row.title, person: row.person,
    startsAt: row.starts_at, endsAt: row.ends_at, location: row.location, status: row.status,
    assignedTeamMemberId: row.assigned_team_member_id, assignedTeamMemberIds: row.assigned_team_member_ids.length ? row.assigned_team_member_ids : [row.assigned_team_member_id ?? "owner"], assigneeName: row.assignee_name })), ...timeOff.map((block) => ({ id: block.id, kind: block.reason.startsWith(MANUAL_JOB_PREFIX) ? "manual_job" : "time_off", title: block.reason.startsWith(MANUAL_JOB_PREFIX) ? block.reason.slice(MANUAL_JOB_PREFIX.length) : block.reason,
      person: block.assignee_name, startsAt: block.starts_at, endsAt: block.ends_at, location: "Unavailable", status: "blocked",
      assignedTeamMemberId: block.member_id, assignedTeamMemberIds: [block.member_id ?? "owner"], assigneeName: block.assignee_name })),
    ...calendly.map((event) => ({ id: event.id, kind: "calendly", title: event.title, person: "Calendly",
      startsAt: event.starts_at, endsAt: event.ends_at, location: event.location, status: event.status,
      assignedTeamMemberId: null, assignedTeamMemberIds: ["owner"], assigneeName: "Company owner" }))] });
}
