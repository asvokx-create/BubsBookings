import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/admin";
import { affiliateAnalyticsWindow, aggregateAffiliateClickTrends } from "@/lib/affiliate-analytics";
import { database } from "@/lib/database";

const PAGE_SIZE = 20;

export async function GET(request: Request) {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: "Admin access required." }, { status: 403 });

  const url = new URL(request.url);
  const window = affiliateAnalyticsWindow({
    range: url.searchParams.get("range"),
    start: url.searchParams.get("start"),
    end: url.searchParams.get("end"),
  });
  if (!window.valid) return NextResponse.json({ error: "Choose a valid custom date range of 366 days or fewer." }, { status: 400 });
  const page = Math.max(1, Math.min(10_000, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1));
  const affiliateId = url.searchParams.get("affiliateId");
  const search = (url.searchParams.get("search") ?? "").trim().slice(0, 100);

  const [countResult, listResult] = await Promise.all([
    database.query<{ count: number }>(`SELECT count(*)::int AS count FROM affiliate_profiles affiliate
      WHERE ($1::text = '' OR affiliate.display_name ILIKE '%' || $1 || '%' OR affiliate.affiliate_code ILIKE '%' || $1 || '%')`, [search]),
    database.query(`WITH click_counts AS (
        SELECT affiliate_id,
          count(*)::int AS total_clicks,
          count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS clicks_7d,
          count(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS clicks_30d,
          count(*) FILTER (WHERE ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3))::int AS range_clicks
        FROM affiliate_click_events GROUP BY affiliate_id
      ), first_touch_counts AS (
        SELECT affiliate_id,
          count(*)::int AS total_first_touch_visits,
          count(*) FILTER (WHERE ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3))::int AS range_first_touch_visits
        FROM affiliate_clicks GROUP BY affiliate_id
      ), referral_counts AS (
        SELECT referral.affiliate_id,
          count(*)::int AS referred_registrations,
          count(*) FILTER (WHERE ($2::timestamptz IS NULL OR referral.attributed_at >= $2) AND ($3::timestamptz IS NULL OR referral.attributed_at < $3))::int AS range_registrations,
          count(*) FILTER (WHERE referral.status <> 'disqualified' AND provider.is_active = true
            AND EXISTS (SELECT 1 FROM services service WHERE service.provider_id = provider.id AND service.is_active = true))::int AS published_providers
        FROM affiliate_referrals referral
        JOIN provider_profiles provider ON provider.id = referral.provider_id
        GROUP BY referral.affiliate_id
      )
      SELECT affiliate.id::text, affiliate.display_name, affiliate.affiliate_code, affiliate.status,
        COALESCE(clicks.total_clicks, 0)::int AS total_clicks,
        COALESCE(clicks.clicks_7d, 0)::int AS clicks_7d,
        COALESCE(clicks.clicks_30d, 0)::int AS clicks_30d,
        COALESCE(clicks.range_clicks, 0)::int AS range_clicks,
        COALESCE(first_touches.total_first_touch_visits, 0)::int AS total_first_touch_visits,
        COALESCE(first_touches.range_first_touch_visits, 0)::int AS range_first_touch_visits,
        COALESCE(referrals.referred_registrations, 0)::int AS referred_registrations,
        COALESCE(referrals.range_registrations, 0)::int AS range_registrations,
        COALESCE(referrals.published_providers, 0)::int AS published_providers,
        CASE WHEN COALESCE(first_touches.total_first_touch_visits, 0) = 0 THEN NULL
          ELSE round(COALESCE(referrals.referred_registrations, 0)::numeric / first_touches.total_first_touch_visits * 100, 1) END AS signup_conversion_rate,
        CASE WHEN COALESCE(first_touches.range_first_touch_visits, 0) = 0 THEN NULL
          ELSE round(COALESCE(referrals.range_registrations, 0)::numeric / first_touches.range_first_touch_visits * 100, 1) END AS range_conversion_rate
      FROM affiliate_profiles affiliate
      LEFT JOIN click_counts clicks ON clicks.affiliate_id = affiliate.id
      LEFT JOIN first_touch_counts first_touches ON first_touches.affiliate_id = affiliate.id
      LEFT JOIN referral_counts referrals ON referrals.affiliate_id = affiliate.id
      WHERE ($1::text = '' OR affiliate.display_name ILIKE '%' || $1 || '%' OR affiliate.affiliate_code ILIKE '%' || $1 || '%')
      ORDER BY COALESCE(clicks.total_clicks, 0) DESC, affiliate.applied_at DESC
      LIMIT $4 OFFSET $5`, [search, window.start, window.end, PAGE_SIZE, (page - 1) * PAGE_SIZE]),
  ]);

  let detail = null;
  if (affiliateId && /^[0-9a-f-]{36}$/i.test(affiliateId)) {
    const [summaryResult, dailyResult] = await Promise.all([
      database.query(`WITH click_stats AS (
          SELECT count(*)::int AS clicks FROM affiliate_click_events
          WHERE affiliate_id = $1::uuid
            AND ($2::timestamptz IS NULL OR created_at >= $2)
            AND ($3::timestamptz IS NULL OR created_at < $3)
        ), first_touch_stats AS (
          SELECT count(*)::int AS first_touch_visits FROM affiliate_clicks
          WHERE affiliate_id = $1::uuid
            AND ($2::timestamptz IS NULL OR created_at >= $2)
            AND ($3::timestamptz IS NULL OR created_at < $3)
        ), referral_stats AS (
          SELECT count(*) FILTER (WHERE ($2::timestamptz IS NULL OR referral.attributed_at >= $2)
              AND ($3::timestamptz IS NULL OR referral.attributed_at < $3))::int AS signups,
            count(*) FILTER (WHERE referral.status <> 'disqualified' AND provider.is_active = true)::int AS active_referred_providers,
            count(*) FILTER (WHERE referral.status <> 'disqualified' AND provider.is_active = true
              AND EXISTS (SELECT 1 FROM services service WHERE service.provider_id = provider.id AND service.is_active = true))::int AS published_providers
          FROM affiliate_referrals referral
          JOIN provider_profiles provider ON provider.id = referral.provider_id
          WHERE referral.affiliate_id = $1::uuid
        ), commission_stats AS (
          SELECT COALESCE(sum(amount_cents) FILTER (WHERE status IN ('pending','hold','approved','payable','paid')), 0)::int AS earnings_cents,
            COALESCE(sum(amount_cents) FILTER (WHERE status IN ('pending','hold','approved')), 0)::int AS pending_cents,
            COALESCE(sum(amount_cents) FILTER (WHERE status = 'payable'), 0)::int AS payable_cents,
            COALESCE(sum(amount_cents) FILTER (WHERE status = 'paid'), 0)::int AS paid_cents
          FROM affiliate_commissions
          WHERE affiliate_id = $1::uuid
            AND ($2::timestamptz IS NULL OR created_at >= $2)
            AND ($3::timestamptz IS NULL OR created_at < $3)
        )
        SELECT affiliate.id::text, affiliate.display_name, affiliate.affiliate_code,
          clicks.clicks, first_touches.first_touch_visits, referrals.signups, referrals.active_referred_providers, referrals.published_providers,
          commissions.earnings_cents, commissions.pending_cents, commissions.payable_cents, commissions.paid_cents,
          CASE WHEN first_touches.first_touch_visits = 0 THEN NULL ELSE round(referrals.signups::numeric / first_touches.first_touch_visits * 100, 1) END AS conversion_rate
        FROM affiliate_profiles affiliate CROSS JOIN click_stats clicks CROSS JOIN first_touch_stats first_touches CROSS JOIN referral_stats referrals CROSS JOIN commission_stats commissions
        WHERE affiliate.id = $1::uuid`, [affiliateId, window.start, window.end]),
      database.query<{ period: string; clicks: number }>(`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS period, count(*)::int AS clicks
        FROM affiliate_click_events
        WHERE affiliate_id = $1::uuid
          AND ($2::timestamptz IS NULL OR created_at >= $2)
          AND ($3::timestamptz IS NULL OR created_at < $3)
        GROUP BY 1 ORDER BY 1`, [affiliateId, window.start, window.end]),
    ]);
    if (summaryResult.rows[0]) {
      const daily = dailyResult.rows.map((row) => ({ period: row.period, clicks: Number(row.clicks) }));
      detail = { summary: summaryResult.rows[0], daily, ...aggregateAffiliateClickTrends(daily) };
    }
  }

  const total = countResult.rows[0]?.count ?? 0;
  return NextResponse.json({
    window: { range: window.range, start: window.start?.toISOString() ?? null, end: window.end?.toISOString() ?? null, label: window.label, timezone: "UTC" },
    affiliates: listResult.rows,
    pagination: { page, pageSize: PAGE_SIZE, total, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)) },
    detail,
  }, { headers: { "Cache-Control": "private, no-store" } });
}
