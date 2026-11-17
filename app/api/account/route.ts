import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { database } from "@/lib/database";
import { deleteImage } from "@/lib/spaces";
import { getStripe, getStripeMode } from "@/lib/stripe";
import { enforceRateLimit } from "@/lib/request-security";

export const runtime = "nodejs";

function isMissingStripeResource(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "resource_missing";
}

export async function DELETE(request: Request) {
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin) {
    try {
      if (new URL(requestOrigin).origin !== new URL(request.url).origin) return NextResponse.json({ error: "Account deletion must be started from BubsBookings." }, { status: 403 });
    } catch {
      return NextResponse.json({ error: "Account deletion must be started from BubsBookings." }, { status: 403 });
    }
  }
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Log in to delete your account." }, { status: 401 });
  if (!await enforceRateLimit({ request, userId: session.user.id, bucket: "account-delete", limit: 3, windowSeconds: 3600 })) return NextResponse.json({ error: "Too many deletion attempts. Please try again later." }, { status: 429 });

  const body = await request.json().catch(() => null) as { confirmation?: unknown } | null;
  const confirmation = typeof body?.confirmation === "string" ? body.confirmation.trim().toLowerCase() : "";
  if (confirmation !== session.user.email.toLowerCase()) return NextResponse.json({ error: "Type your account email exactly to confirm deletion." }, { status: 400 });

  const providerResult = await database.query<{
    id: string;
    stripe_customer_id: string | null;
    stripe_account_id: string | null;
    stripe_subscription_id: string | null;
    stripe_billing_mode: "test" | "live" | null;
    stripe_connect_mode: "test" | "live" | null;
  }>(`SELECT id::text, stripe_customer_id, stripe_account_id, stripe_subscription_id, stripe_billing_mode, stripe_connect_mode FROM provider_profiles WHERE user_id = $1`, [session.user.id]);
  const provider = providerResult.rows[0] ?? null;
  const blockers = await database.query<{ active_bookings: number; open_disputes: number; unsettled_payments: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE booking.status IN ('requested', 'confirmed'))::int AS active_bookings,
       COUNT(*) FILTER (WHERE booking.payment_status = 'pending' OR booking.payment_release_status IN ('secured', 'awaiting_customer', 'processing', 'frozen', 'failed'))::int AS unsettled_payments,
       (SELECT COUNT(*)::int FROM booking_disputes dispute WHERE dispute.status IN ('open', 'reviewing') AND (dispute.opened_by = $1 OR dispute.against_user_id = $1)) AS open_disputes
     FROM bookings booking
     WHERE booking.customer_id = $1 OR ($2::uuid IS NOT NULL AND booking.provider_id = $2::uuid)`,
    [session.user.id, provider?.id ?? null],
  );
  const blocked = blockers.rows[0];
  if ((blocked?.active_bookings ?? 0) > 0 || (blocked?.open_disputes ?? 0) > 0 || (blocked?.unsettled_payments ?? 0) > 0) {
    return NextResponse.json({ error: "Resolve active bookings, open disputes, and unsettled payments before deleting this account." }, { status: 409 });
  }

  // Project time/payment evidence belongs to both parties. Do not delete Stripe
  // resources and then fail on its retained foreign keys; reconcile via support.
  const projectRecords = await database.query(`SELECT 1 FROM hourly_projects project JOIN provider_profiles provider ON provider.id=project.provider_id
    WHERE project.customer_id=$1 OR provider.user_id=$1 LIMIT 1`, [session.user.id]);
  if (projectRecords.rowCount) return NextResponse.json({ error: "This account has hourly-project records shared with another participant. Contact support to reconcile any remaining work or payments and complete account deletion safely." }, { status: 409 });

  const settingsResult = await database.query<{ consumer_stripe_customer_id: string | null; consumer_stripe_mode: "test" | "live" | null; profile_image_key: string | null }>(
    "SELECT consumer_stripe_customer_id, consumer_stripe_mode, profile_image_key FROM user_settings WHERE user_id = $1",
    [session.user.id],
  );
  const settings = settingsResult.rows[0] ?? null;
  const imageResult = await database.query<{ object_key: string }>(
    `SELECT object_key FROM service_images WHERE service_id IN (SELECT service.id FROM services service JOIN provider_profiles provider ON provider.id = service.provider_id WHERE provider.user_id = $1)
     UNION ALL
     SELECT item.object_key FROM provider_portfolio_items item JOIN provider_profiles provider ON provider.id = item.provider_id WHERE provider.user_id = $1`,
    [session.user.id],
  );

  try {
    const mode = getStripeMode();
    const hasStripeRecords = Boolean(provider?.stripe_customer_id || provider?.stripe_account_id || provider?.stripe_subscription_id || settings?.consumer_stripe_customer_id);
    if (hasStripeRecords) {
      const stripe = getStripe();
      const inaccessibleStripeRecord = (provider?.stripe_billing_mode && provider.stripe_billing_mode !== mode && (provider.stripe_customer_id || provider.stripe_subscription_id))
        || (provider?.stripe_connect_mode && provider.stripe_connect_mode !== mode && provider.stripe_account_id)
        || (settings?.consumer_stripe_mode && settings.consumer_stripe_mode !== mode && settings.consumer_stripe_customer_id);
      if (inaccessibleStripeRecord) throw new Error("Stripe records belong to a different environment.");
      if (provider?.stripe_subscription_id && provider.stripe_billing_mode === mode) await stripe.subscriptions.cancel(provider.stripe_subscription_id).catch((error) => { if (!isMissingStripeResource(error)) throw error; });
      const customerIds = new Set<string>();
      if (provider?.stripe_customer_id && provider.stripe_billing_mode === mode) customerIds.add(provider.stripe_customer_id);
      if (settings?.consumer_stripe_customer_id && settings.consumer_stripe_mode === mode) customerIds.add(settings.consumer_stripe_customer_id);
      for (const customerId of customerIds) await stripe.customers.del(customerId).catch((error) => { if (!isMissingStripeResource(error)) throw error; });
      if (provider?.stripe_account_id && provider.stripe_connect_mode === mode) await stripe.accounts.del(provider.stripe_account_id).catch((error) => { if (!isMissingStripeResource(error)) throw error; });
    }

    const imageKeys = [settings?.profile_image_key, ...imageResult.rows.map((row) => row.object_key)].filter((key): key is string => Boolean(key));
    await Promise.all(imageKeys.map((key) => deleteImage(key)));
  } catch (error) {
    console.error("External account deletion failed", error);
    return NextResponse.json({ error: "We could not remove all connected payment or image-storage data. Please contact support so deletion can be completed safely." }, { status: 502 });
  }

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const userId = session.user.id;
    await client.query("DELETE FROM booking_disputes WHERE opened_by = $1 OR against_user_id = $1", [userId]);
    await client.query("DELETE FROM safety_reports WHERE reporter_id = $1 OR reported_user_id = $1", [userId]);
    await client.query("DELETE FROM bookings WHERE customer_id = $1 OR provider_id IN (SELECT id FROM provider_profiles WHERE user_id = $1)", [userId]);
    await client.query("DELETE FROM messages WHERE sender_id = $1", [userId]);
    await client.query("DELETE FROM provider_team_members WHERE user_id = $1 OR lower(email) = lower($2)", [userId, session.user.email]);
    await client.query("DELETE FROM email_delivery_log WHERE user_id = $1 OR lower(recipient) = lower($2)", [userId, session.user.email]);
    await client.query("DELETE FROM service_demand_requests WHERE user_id = $1 OR lower(email) = lower($2)", [userId, session.user.email]);
    await client.query("DELETE FROM analytics_events WHERE user_id = $1 OR target_id = $1", [userId]);
    await client.query("DELETE FROM activity_log WHERE user_id = $1 OR target_id = $1", [userId]);
    await client.query("DELETE FROM admin_audit_log WHERE actor_user_id = $1 OR target_id = $1", [userId]);
    await client.query('DELETE FROM "verification" WHERE lower(identifier) = lower($1)', [session.user.email]);
    await client.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Account deletion failed", error);
    return NextResponse.json({ error: "We could not finish deleting your BubsBookings account. Please contact support so the remaining deletion can be completed." }, { status: 500 });
  } finally {
    client.release();
  }
}
