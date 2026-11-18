import "server-only";

import { database } from "./database";
import { isEmailConfigured, sendTransactionalEmail } from "./email";

type Listing = { service_id: string; service_title: string; slug: string; user_id: string;
  business_name: string; email: string; name: string | null };
type Payload = Parameters<typeof sendTransactionalEmail>[0];
type Delivery = Listing & { attempt_count: number; payload: Payload | null };

export function listingActiveEmailPayload(row: Listing): Payload {
  const firstName = row.name?.trim().split(/\s+/)[0] || "there";
  return {
    to: row.email, userId: row.user_id, emailType: "listing_active",
    renderVersion: "stacked-actions-v1",
    idempotencyKey: `listing-active-${row.service_id}`,
    subject: "Your listing is now active on BubsBookings!",
    heading: `You're live, ${firstName}!`,
    message: `${row.service_title} from ${row.business_name} is now public on BubsBookings.\n\nHead to your dashboard to keep an eye on your bookings and earnings as your business grows.\n\nDon't forget your free marketing tools! Share your listing link and QR code on social media, business cards, or flyers so customers can find your business.\n\nThanks for being part of BubsBookings. We're excited to see what you build!\n\nChristian\nFounder, BubsBookings`,
    actions: [
      { label: "View your listing", url: `/services/${encodeURIComponent(row.slug)}` },
      { label: "Check your earnings", url: "/provider/dashboard/revenue" },
      { label: "Get your link & QR code", url: "/provider/dashboard/marketing" },
    ],
  };
}

// Discovery uses the same public gates for every publication path (provider,
// Stripe verification, admin age pass, company reactivation). Existing public
// listings are baselined by migration; reactivation never sends a second email.
export async function processListingActiveEmailQueue(batchSize = 25, serviceId?: string) {
  if (!isEmailConfigured()) return { listingActiveSent: 0, listingActiveProcessed: 0 };
  if (!serviceId) await database.query(`INSERT INTO listing_active_email_deliveries(service_id)
    SELECT service_id FROM listing_active_email_eligible ON CONFLICT DO NOTHING`);
  let sent = 0;
  let processed = 0;
  for (let index = 0; index < Math.min(Math.max(batchSize, 1), 100); index++) {
    const client = await database.connect();
    let lockKey: string | null = null;
    try {
      await client.query("BEGIN");
      // Never retry a potentially accepted request after Resend's 24h dedupe
      // window. A session lock covers delivery; the durable claim commits before
      // the network request so a crash cannot erase the retry deadline/payload.
      await client.query(`UPDATE listing_active_email_deliveries
        SET status='review_required', last_error='Retry window expired; check Resend before any manual resend.'
        WHERE status IN ('queued','sending') AND
          (attempt_count >= 5 OR first_attempt_at <= now()-interval '23 hours')`);
      const result = await client.query<Delivery>(`SELECT eligible.*, delivery.attempt_count, delivery.payload
        FROM listing_active_email_deliveries delivery
        JOIN listing_active_email_eligible eligible ON eligible.service_id=delivery.service_id
        WHERE (delivery.status='queued' OR (delivery.status='sending' AND delivery.attempted_at < now()-interval '15 minutes'))
          AND delivery.next_attempt_at <= now()
          AND delivery.attempt_count < 5
          AND ($1::uuid IS NULL OR delivery.service_id=$1::uuid)
          AND (delivery.first_attempt_at IS NULL OR delivery.first_attempt_at > now()-interval '23 hours')
        ORDER BY delivery.next_attempt_at, delivery.created_at
        FOR UPDATE OF delivery SKIP LOCKED LIMIT 1`, [serviceId ?? null]);
      const row = result.rows[0];
      if (!row) { await client.query("COMMIT"); break; }
      lockKey = `listing-active-${row.service_id}`;
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [lockKey]);
      if (!lock.rows[0]?.locked) { lockKey = null; await client.query("COMMIT"); break; }
      const payload = row.payload || listingActiveEmailPayload(row);
      if (payload.to !== row.email || payload.userId !== row.user_id
          || payload.actions?.[0]?.url !== `/services/${encodeURIComponent(row.slug)}`) {
        await client.query("UPDATE listing_active_email_deliveries SET status='review_required', last_error='Recipient or listing link changed after first attempt; review required.' WHERE service_id=$1", [row.service_id]);
        await client.query("COMMIT");
        continue;
      }
      // Freeze request body on the first attempt for Resend idempotency.
      await client.query(`UPDATE listing_active_email_deliveries SET status='sending', payload=$2::jsonb,
        first_attempt_at=COALESCE(first_attempt_at,now()), attempted_at=now(), attempt_count=attempt_count+1
        WHERE service_id=$1`, [row.service_id, JSON.stringify(payload)]);
      await client.query("COMMIT");
      const delivery = await sendTransactionalEmail(payload);
      processed++;
      if (delivery.sent) {
        sent++;
        await client.query(`UPDATE listing_active_email_deliveries SET status='sent', sent_at=now(),
          provider_message_id=$2,last_error='' WHERE service_id=$1`, [row.service_id, delivery.providerMessageId]);
      } else {
        await client.query(`UPDATE listing_active_email_deliveries SET status='queued',
          next_attempt_at=now()+($2::int * interval '1 minute'),
          last_error='Resend did not confirm acceptance; retry scheduled within the deduplication window.'
          WHERE service_id=$1`, [row.service_id, 15 * (2 ** row.attempt_count)]);
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      let discardConnection = false;
      try {
        if (lockKey) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]);
      } catch (error) {
        discardConnection = true;
        throw error;
      } finally { client.release(discardConnection); }
    }
  }
  return { listingActiveSent: sent, listingActiveProcessed: processed };
}


// Explicit admin-only entry point; the route supplies the authenticated actor.
// Never reset sent, uncertain, or in-flight deliveries, or change listing state.
export async function requestListingActiveEmail(input: { serviceId: string; userId: string; actorUserId: string }) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const eligible = await client.query(`SELECT eligible.service_id
      FROM listing_active_email_eligible eligible
      JOIN services service ON service.id=eligible.service_id
      WHERE eligible.service_id=$1::uuid AND eligible.user_id=$2
      FOR UPDATE OF service`, [input.serviceId, input.userId]);
    if (!eligible.rows.length) { await client.query("ROLLBACK"); return { status: "not_public" as const }; }
    const queued = await client.query(`INSERT INTO listing_active_email_deliveries(service_id)
      VALUES($1::uuid) ON CONFLICT (service_id) DO UPDATE SET status='queued',
        next_attempt_at=now(),last_error=''
      WHERE listing_active_email_deliveries.status='suppressed'
        AND listing_active_email_deliveries.attempt_count=0
        AND listing_active_email_deliveries.first_attempt_at IS NULL
      RETURNING service_id`, [input.serviceId]);
    if (queued.rows.length) {
      await client.query(`INSERT INTO admin_audit_log(actor_user_id,action,target_type,target_id,details)
        VALUES($1,'listing_active_email_requested','service',$2,$3::jsonb)`,
      [input.actorUserId, input.serviceId, JSON.stringify({ providerUserId: input.userId })]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  // A targeted run cannot pick any other provider/listing. Normal scheduled
  // retry retains responsibility if Resend or this request fails after queuing.
  await processListingActiveEmailQueue(1, input.serviceId);
  const result = await database.query<{ status: string }>(
    "SELECT status FROM listing_active_email_deliveries WHERE service_id=$1::uuid", [input.serviceId]);
  return { status: result.rows[0]?.status ?? "queued" };
}
