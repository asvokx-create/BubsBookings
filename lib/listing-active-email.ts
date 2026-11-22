import "server-only";

import { database } from "./database";
import { isEmailConfigured, sendTransactionalEmail } from "./email";

type Listing = { service_id: string; service_title: string; slug: string; user_id: string;
  business_name: string; email: string; name: string | null };
type Payload = Parameters<typeof sendTransactionalEmail>[0];
type PortfolioListing = { service_id: string; company_name: string; service_title: string };
type StoredPayload = Payload & { portfolioServiceIds?: string[] };
type Delivery = Listing & { attempt_count: number; payload: StoredPayload | null };

// Bound the DB read even for unlimited plans. The extra row is an overflow
// sentinel, never a silent truncation. Budget the actual escaped/plain text
// contribution separately from the unchanged outer email layout and actions.
const maxPortfolioRows = 250;
const maxPortfolioBytes = 32 * 1024;
function renderedPortfolioBytes(value: string) {
  const htmlEntities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" };
  const html = value.replace(/[&<>'"]/g, (character) => htmlEntities[character]);
  return Buffer.byteLength(html, "utf8") + Buffer.byteLength(value, "utf8");
}
// Keep character shaping (e.g. ZWJ/ZWNJ and emoji sequences), but neutralize
// structural controls, Unicode line separators, and directional overrides.
const cleanLine = (value: string) => value.replace(/[\s\p{Cc}\p{Bidi_Control}]+/gu, " ").trim();

export function approvedPortfolioMessage(listings: PortfolioListing[]) {
  const groups = new Map<string, string[]>();
  for (const listing of listings) {
    const company = cleanLine(listing.company_name);
    const title = cleanLine(listing.service_title);
    if (!company || !title) return "";
    const titles = groups.get(company) ?? [];
    titles.push(title);
    groups.set(company, titles);
  }
  return ["Your public listings (including your newly published listing):",
    ...Array.from(groups, ([company, titles]) => [company, ...titles.map(title => `• ${title}`)].join("\n")),
  ].join("\n\n");
}

const eligiblePortfolioSql = `SELECT eligible.service_id::text AS service_id,
    company.name AS company_name, eligible.service_title
  FROM listing_active_email_eligible eligible
  JOIN services service ON service.id=eligible.service_id
  JOIN provider_companies company ON company.id=service.company_id AND company.provider_id=service.provider_id
  WHERE eligible.user_id=$1
    AND ($2::uuid[] IS NULL OR eligible.service_id=ANY($2::uuid[]))
  ORDER BY lower(company.name), company.name, lower(eligible.service_title), eligible.service_title, eligible.service_id
  LIMIT $3`;

export function listingActiveEmailPayload(row: Listing, rows: PortfolioListing[] = []): StoredPayload {
  const showPortfolio = rows.length > 1 &&
    (rows.length > maxPortfolioRows || rows.some((listing) => listing.service_id === row.service_id));
  const fullPortfolio = showPortfolio && rows.length <= maxPortfolioRows ? approvedPortfolioMessage(rows) : "";
  const overflow = showPortfolio && (!fullPortfolio || renderedPortfolioBytes(fullPortfolio) > maxPortfolioBytes);
  const portfolio = overflow
    ? "You have more public listings than fit in this email. Open your listings to see the full list."
    : fullPortfolio;
  const publication = portfolio
    ? `${row.service_title} is now public on BubsBookings.\n\n${portfolio}`
    : `${row.service_title} from ${row.business_name} is now public on BubsBookings.`;
  const firstName = row.name?.trim().split(/\s+/)[0] || "there";
  return {
    to: row.email, userId: row.user_id, emailType: "listing_active",
    renderVersion: "stacked-actions-v1",
    idempotencyKey: `listing-active-${row.service_id}`,
    subject: "Your listing is now active on BubsBookings!",
    heading: `You're live, ${firstName}!`,
    ...(portfolio && !overflow ? { portfolioServiceIds: rows.map((listing) => listing.service_id) } : {}),
    message: `${publication}\n\nHead to your dashboard to keep an eye on your bookings and earnings as your business grows.\n\nDon't forget your free marketing tools! Share your listing link and QR code on social media, business cards, or flyers so customers can find your business.\n\nThanks for being part of BubsBookings. We're excited to see what you build!\n\nChristian\nFounder, BubsBookings`,
    actions: [
      { label: "View your listing", url: `/services/${encodeURIComponent(row.slug)}` },
      overflow
        ? { label: "View all your listings", url: "/provider/dashboard/services" }
        : { label: "Check your earnings", url: "/provider/dashboard/revenue" },
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
      // Never rewrite previously attempted payloads: Resend deduplicates the
      // exact request. A withdrawn/renamed grouped listing instead needs review.
      const portfolioRows = !row.payload || row.payload.portfolioServiceIds
        ? (await client.query<PortfolioListing>(eligiblePortfolioSql,
          [row.user_id, row.payload?.portfolioServiceIds ?? null, maxPortfolioRows + 1])).rows
        : [];
      const payload = row.payload || listingActiveEmailPayload(row, portfolioRows);
      const frozenPortfolioChanged = row.payload?.portfolioServiceIds &&
        (portfolioRows.length !== row.payload.portfolioServiceIds.length ||
          listingActiveEmailPayload(row, portfolioRows).message !== row.payload.message);
      if (frozenPortfolioChanged || payload.to !== row.email || payload.userId !== row.user_id
          || payload.actions?.[0]?.url !== `/services/${encodeURIComponent(row.slug)}`) {
        await client.query("UPDATE listing_active_email_deliveries SET status='review_required', last_error='Recipient, listing link, or grouped portfolio changed after first attempt; review required.' WHERE service_id=$1", [row.service_id]);
        await client.query("COMMIT");
        continue;
      }
      // Freeze request body on the first attempt for Resend idempotency.
      await client.query(`UPDATE listing_active_email_deliveries SET status='sending', payload=$2::jsonb,
        first_attempt_at=COALESCE(first_attempt_at,now()), attempted_at=now(), attempt_count=attempt_count+1
        WHERE service_id=$1`, [row.service_id, JSON.stringify(payload)]);
      await client.query("COMMIT");
      // Strip queue bookkeeping before calling the existing renderer.
      const { portfolioServiceIds: _portfolioServiceIds, ...emailPayload } = payload;
      void _portfolioServiceIds;
      const delivery = await sendTransactionalEmail(emailPayload);
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
