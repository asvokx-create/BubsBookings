import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { database } from "@/lib/database";
import { enforceRateLimit } from "@/lib/request-security";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.json({ error: "Log in to download your data." }, { status: 401 });
  if (!await enforceRateLimit({ request, userId: session.user.id, bucket: "account-data-export", limit: 3, windowSeconds: 3600 })) return Response.json({ error: "Too many data exports. Please try again later." }, { status: 429 });

  const client = await database.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const userId = session.user.id;
    const accountResult = await client.query(
      `SELECT id, name, email, "emailVerified", image, phone, role,
              terms_accepted_at, privacy_acknowledged_at, ai_safety_acknowledged_at,
              location_city, location_state, location_postal_code, location_country,
              location_source, location_updated_at,
              policy_version, "createdAt", "updatedAt"
       FROM "user" WHERE id = $1`,
      [userId],
    );
    const providerResult = await client.query("SELECT * FROM provider_profiles WHERE user_id = $1", [userId]);
    const providerId = providerResult.rows[0]?.id ?? null;

    async function rows(query: string, values: unknown[] = []) {
      return (await client.query(query, values)).rows;
    }

    const [settings, signInMethods, bookings, jobRequests, quotes, conversations, messages, favorites, notifications, reviewsWritten, providerReviews, teamMemberships, safetyReports, disputes, bugReports, supportRequests, demandRequests, activityEvents, analyticsEvents] = await Promise.all([
      rows("SELECT * FROM user_settings WHERE user_id = $1", [userId]),
      rows('SELECT id, "accountId", "providerId", "createdAt", "updatedAt" FROM "account" WHERE "userId" = $1', [userId]),
      rows(`SELECT * FROM bookings WHERE customer_id = $1 OR provider_id IN (SELECT id FROM provider_profiles WHERE user_id = $1) ORDER BY created_at`, [userId]),
      rows(`SELECT * FROM job_requests WHERE customer_id = $1 ORDER BY created_at`, [userId]),
      rows(`SELECT * FROM quotes WHERE customer_id = $1 OR provider_id IN (SELECT id FROM provider_profiles WHERE user_id = $1) ORDER BY created_at`, [userId]),
      rows(`SELECT * FROM conversations WHERE customer_id = $1 OR provider_id IN (SELECT id FROM provider_profiles WHERE user_id = $1) ORDER BY created_at`, [userId]),
      rows(`SELECT message.* FROM messages message JOIN conversations conversation ON conversation.id = message.conversation_id WHERE conversation.customer_id = $1 OR conversation.provider_id IN (SELECT id FROM provider_profiles WHERE user_id = $1) ORDER BY message.created_at`, [userId]),
      rows("SELECT * FROM favorites WHERE customer_id = $1 ORDER BY created_at", [userId]),
      rows("SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at", [userId]),
      rows("SELECT * FROM reviews WHERE customer_id = $1 ORDER BY created_at", [userId]),
      rows(`SELECT id, booking_id, service_id, rating, body, is_hidden, created_at, updated_at
            FROM reviews
            WHERE provider_id IN (SELECT id FROM provider_profiles WHERE user_id = $1)
            ORDER BY created_at`, [userId]),
      rows("SELECT * FROM provider_team_members WHERE user_id = $1 OR lower(email) = lower($2) ORDER BY created_at", [userId, session.user.email]),
      rows(`SELECT id, conversation_id, booking_id, category, details, status, created_at, updated_at
            FROM safety_reports WHERE reporter_id = $1 ORDER BY created_at`, [userId]),
      rows(`SELECT id, booking_id, category, details, requested_resolution, status, admin_note,
                   resolution_outcome, resolved_at, created_at, updated_at
            FROM booking_disputes WHERE opened_by = $1 ORDER BY created_at`, [userId]),
      rows("SELECT * FROM bug_reports WHERE reporter_id = $1 ORDER BY created_at", [userId]),
      rows("SELECT * FROM support_requests WHERE user_id = $1 ORDER BY created_at", [userId]),
      rows("SELECT * FROM service_demand_requests WHERE user_id = $1 OR lower(email) = lower($2) ORDER BY created_at", [userId, session.user.email]),
      rows("SELECT * FROM activity_log WHERE user_id = $1 ORDER BY created_at", [userId]),
      rows("SELECT * FROM analytics_events WHERE user_id = $1 ORDER BY created_at", [userId]),
    ]);

    const hourlyProjects = await rows(`SELECT to_jsonb(project) || jsonb_build_object(
      'service_address', CASE WHEN project.customer_id=$1 OR project.status IN ('active','submitted','approved') THEN project.service_address ELSE 'Address available after acceptance' END,
      'access_instructions', CASE WHEN project.customer_id=$1 OR project.status IN ('active','submitted','approved') THEN project.access_instructions ELSE '' END) AS project
      FROM hourly_projects project JOIN provider_profiles provider ON provider.id=project.provider_id
      WHERE project.customer_id=$1 OR provider.user_id=$1 ORDER BY project.created_at`, [userId]);
    const hourlyTimeEntries = await rows(`SELECT entry.* FROM hourly_time_entries entry JOIN hourly_projects project ON project.id=entry.project_id
      JOIN provider_profiles provider ON provider.id=project.provider_id WHERE project.customer_id=$1 OR provider.user_id=$1 ORDER BY entry.started_at`, [userId]);
    const hourlyProjectHistory = await rows(`SELECT audit.* FROM hourly_project_audit audit JOIN hourly_projects project ON project.id=audit.project_id
      JOIN provider_profiles provider ON provider.id=project.provider_id WHERE project.customer_id=$1 OR provider.user_id=$1 ORDER BY audit.created_at`, [userId]);

    const providerData = providerId ? {
      profile: providerResult.rows[0],
      companies: await rows("SELECT * FROM provider_companies WHERE provider_id = $1 ORDER BY created_at", [providerId]),
      locations: await rows("SELECT location.* FROM provider_locations location JOIN provider_companies company ON company.id = location.company_id WHERE company.provider_id = $1 ORDER BY location.created_at", [providerId]),
      serviceAreas: await rows("SELECT area.* FROM provider_location_service_areas area JOIN provider_locations location ON location.id = area.location_id JOIN provider_companies company ON company.id = location.company_id WHERE company.provider_id = $1 ORDER BY area.created_at", [providerId]),
      services: await rows("SELECT * FROM services WHERE provider_id = $1 ORDER BY created_at", [providerId]),
      serviceImages: await rows("SELECT image.* FROM service_images image JOIN services service ON service.id = image.service_id WHERE service.provider_id = $1 ORDER BY image.created_at", [providerId]),
      portfolio: await rows("SELECT * FROM provider_portfolio_items WHERE provider_id = $1 ORDER BY sort_order, created_at", [providerId]),
      availability: await rows("SELECT * FROM availability WHERE provider_id = $1 ORDER BY weekday, start_time", [providerId]),
      teamMembers: await rows("SELECT * FROM provider_team_members WHERE provider_id = $1 ORDER BY created_at", [providerId]),
      teamAvailability: await rows("SELECT availability.* FROM team_member_availability availability JOIN provider_team_members member ON member.id = availability.team_member_id WHERE member.provider_id = $1 ORDER BY availability.weekday, availability.start_time", [providerId]),
      timeOff: await rows("SELECT * FROM provider_time_off WHERE provider_id = $1 ORDER BY starts_at", [providerId]),
      scheduleRequests: await rows("SELECT * FROM team_schedule_requests WHERE provider_id = $1 ORDER BY created_at", [providerId]),
      verificationRequests: await rows("SELECT * FROM provider_verification_requests WHERE provider_id = $1 ORDER BY created_at", [providerId]),
      verificationChecks: await rows("SELECT * FROM provider_verification_checks WHERE provider_id = $1 ORDER BY created_at", [providerId]),
    } : null;

    await client.query("COMMIT");
    const exportData = {
      exportedAt: new Date().toISOString(),
      format: "BubsBookings account data export v1",
      account: accountResult.rows[0] ?? null,
      settings,
      signInMethods,
      bookings,
      hourlyProjects: hourlyProjects.map(row => row.project),
      hourlyTimeEntries,
      hourlyProjectHistory,
      jobRequests,
      quotes,
      conversations,
      messages,
      favorites,
      notifications,
      reviewsWritten,
      providerReviews,
      teamMemberships,
      safetyReports,
      disputes,
      bugReports,
      supportRequests,
      demandRequests,
      activityEvents,
      analyticsEvents,
      provider: providerData,
      note: "Passwords, authentication secrets, full payment-card data, and bank credentials are not included because BubsBookings does not expose or store them in an exportable form. Stripe maintains its own records under its privacy policy.",
    };
    const date = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(exportData, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="bubsbookings-data-${date}.json"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Account data export failed", error);
    return Response.json({ error: "We could not prepare your data download. Please try again." }, { status: 500 });
  } finally {
    client.release();
  }
}
