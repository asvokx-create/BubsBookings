import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import BrandLockup from "@/components/brand-lockup";
import AffiliateLinkBuilder from "@/components/affiliate-link-builder";
import AffiliateStripeSetup from "@/components/affiliate-stripe-setup";
import ProviderGrowthMilestones from "@/components/provider-growth-milestones";
import PartnerCompensationSummary from "@/components/partner-compensation-summary";
import { auth } from "@/lib/auth";
import { database } from "@/lib/database";
import { getStripeMode } from "@/lib/stripe";
import { getAffiliateMilestoneProgress } from "@/lib/affiliate-milestones";
import AffiliateAgreementReacceptance from "@/components/affiliate-agreement-reacceptance";
import { affiliateRequiresAgreementReacceptance } from "@/lib/affiliate-agreement-reacceptance";

export const metadata: Metadata = { title: "Partner dashboard", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
const ranges: Record<string, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", ytd: "year", all: "all" };
function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }

export default async function AffiliateDashboardPage({ searchParams }: { searchParams: Promise<{ range?: string; stripe?: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login?redirect=/affiliate");
  const params = await searchParams;
  const requested = params.range ?? "30d";
  const range = requested in ranges ? requested : "30d";
  const since = range === "all" ? null : range === "ytd" ? "year" : `${Number(range.slice(0, -1))} days`;
  const profileResult = await database.query<{
    id: string; display_name: string; affiliate_code: string | null; status: string; program_name: string;
    compensation_type:"standard"|"custom";activation_bonus_enabled:boolean;milestone_bonuses_enabled:boolean;
    revenue_share_enabled:boolean;custom_campaign_enabled:boolean;activation_bonus_cents:number;
    revenue_share_basis_points:number;revenue_share_duration_months:number;custom_campaign_amount_cents:number|null;
    custom_campaign_starts_on:Date|null;custom_campaign_ends_on:Date|null;
    stripe_account_id: string | null; stripe_connect_mode: "test" | "live" | null;
    stripe_payouts_enabled: boolean; payment_status: string; tax_onboarding_status: string;
    partner_agreement_version: string | null; terms_version: string | null; privacy_version: string | null;
    agreement_reacceptance_required_at: Date | null; agreement_reacceptance_reason: string | null;
  }>(`SELECT affiliate.id::text, affiliate.display_name, affiliate.affiliate_code, affiliate.status, program.name AS program_name,
      affiliate.compensation_type,
      COALESCE(affiliate.activation_bonus_enabled_override,program.activation_bonus_enabled,false) AS activation_bonus_enabled,
      COALESCE(affiliate.milestone_bonuses_override,program.milestone_bonuses_enabled,false) AS milestone_bonuses_enabled,
      COALESCE(affiliate.revenue_share_enabled_override,program.revenue_share_enabled,false) AS revenue_share_enabled,
      COALESCE(affiliate.custom_campaign_enabled_override,program.custom_campaign_enabled,false) AS custom_campaign_enabled,
      COALESCE(affiliate.activation_bonus_override_cents,program.activation_bonus_cents) AS activation_bonus_cents,
      COALESCE(affiliate.revenue_share_override_basis_points,program.revenue_share_basis_points) AS revenue_share_basis_points,
      COALESCE(affiliate.revenue_share_duration_override_months,program.revenue_share_duration_months) AS revenue_share_duration_months,
      affiliate.custom_campaign_amount_cents,affiliate.custom_campaign_starts_on,affiliate.custom_campaign_ends_on
      ,affiliate.stripe_account_id,affiliate.stripe_connect_mode,affiliate.stripe_payouts_enabled,
      affiliate.payment_status,affiliate.tax_onboarding_status,
      affiliate.partner_agreement_version,affiliate.terms_version,affiliate.privacy_version,
      affiliate.agreement_reacceptance_required_at,affiliate.agreement_reacceptance_reason
      FROM affiliate_profiles affiliate JOIN affiliate_programs program ON program.id = affiliate.program_id
      WHERE affiliate.user_id = $1
      ORDER BY affiliate.created_at DESC LIMIT 1`, [session.user.id]);
  const profile = profileResult.rows[0];
  if (!profile) return <main className="min-h-screen bg-[#f8f7f3] text-[#183126]"><div className="reading-container px-5 py-16"><Link href="/"><BrandLockup /></Link><div className="mt-10 rounded-[2rem] border border-[#183126]/10 bg-white p-8"><h1 className="text-3xl font-bold">No partner account yet</h1><p className="mt-3 leading-7 text-[#687970]">Apply to the BubsBookings partner program. Applications are reviewed before referral links and commissions are activated.</p><Link href="/partners#apply" className="mt-6 inline-flex rounded-full bg-[#eee25a] px-6 py-3 font-bold">Apply now</Link></div></div></main>;
  if (!profile.affiliate_code || !["active", "paused"].includes(profile.status)) return <main className="min-h-screen bg-[#f8f7f3] text-[#183126]"><div className="reading-container px-5 py-16"><Link href="/"><BrandLockup /></Link><div className="mt-10 rounded-[2rem] bg-white p-8"><p className="text-xs font-bold uppercase tracking-wider text-[#687970]">Application status</p><h1 className="mt-2 text-3xl font-bold capitalize">{profile.status.replace("_", " ")}</h1><p className="mt-3 leading-7 text-[#687970]">{profile.status === "approved" ? "Your application is approved and awaiting activation. You can set up Stripe payouts now; referral attribution begins only after BubsBookings activates your partner account." : "Your application is not active yet. BubsBookings will review it before issuing a referral code."}</p></div>{profile.status==="approved"?<AffiliateStripeSetup initialConnected={Boolean(profile.stripe_account_id&&profile.stripe_connect_mode===getStripeMode())} initialReady={profile.stripe_connect_mode===getStripeMode()&&profile.stripe_payouts_enabled&&profile.payment_status==="ready"} initialTaxState={profile.tax_onboarding_status} returning={params.stripe==="connect-return"||params.stripe==="connect-refresh"}/>:null}</div></main>;

  const [statsResult, referralsResult, commissionsResult, payoutsResult, milestoneProgress] = await Promise.all([
    database.query<{ clicks: number; first_touch_visits: number; signup_starts: number; account_creations: number; published_listings: number; signups: number; active_referrals: number; qualified: number; bookings: number; eligible_revenue: number; pending: number; payable: number; paid: number; lifetime_earnings: number }>(`SELECT
      (SELECT count(*)::int FROM affiliate_click_events WHERE affiliate_id = $1 AND ($2::text IS NULL OR created_at >= CASE WHEN $2='year' THEN date_trunc('year',now()) ELSE now()-$2::interval END)) AS clicks,
      (SELECT count(*)::int FROM affiliate_clicks WHERE affiliate_id = $1 AND ($2::text IS NULL OR created_at >= CASE WHEN $2='year' THEN date_trunc('year',now()) ELSE now()-$2::interval END)) AS first_touch_visits,
      (SELECT count(*)::int FROM affiliate_clicks WHERE affiliate_id = $1 AND signup_started_at IS NOT NULL AND ($2::text IS NULL OR signup_started_at >= CASE WHEN $2='year' THEN date_trunc('year',now()) ELSE now()-$2::interval END)) AS signup_starts,
      (SELECT count(*)::int FROM affiliate_clicks WHERE affiliate_id = $1 AND account_created_at IS NOT NULL AND ($2::text IS NULL OR account_created_at >= CASE WHEN $2='year' THEN date_trunc('year',now()) ELSE now()-$2::interval END)) AS account_creations,
      (SELECT count(*)::int FROM affiliate_clicks WHERE affiliate_id = $1 AND first_listing_published_at IS NOT NULL AND ($2::text IS NULL OR first_listing_published_at >= CASE WHEN $2='year' THEN date_trunc('year',now()) ELSE now()-$2::interval END)) AS published_listings,
      (SELECT count(*)::int FROM affiliate_referrals WHERE affiliate_id = $1 AND ($2::text IS NULL OR attributed_at >= CASE WHEN $2='year' THEN date_trunc('year',now()) ELSE now()-$2::interval END)) AS signups,
      (SELECT count(*)::int FROM affiliate_referrals WHERE affiliate_id = $1 AND status <> 'disqualified'
        AND (revenue_share_ends_at IS NULL OR revenue_share_ends_at >= now())) AS active_referrals,
      (SELECT count(*)::int FROM affiliate_referrals WHERE affiliate_id = $1 AND qualified_at IS NOT NULL AND ($2::text IS NULL OR qualified_at >= CASE WHEN $2='year' THEN date_trunc('year',now()) ELSE now()-$2::interval END)) AS qualified,
      (SELECT count(DISTINCT booking_id)::int FROM affiliate_commissions WHERE affiliate_id = $1 AND booking_id IS NOT NULL AND ($2::text IS NULL OR created_at >= CASE WHEN $2='year' THEN date_trunc('year',now()) ELSE now()-$2::interval END)) AS bookings,
      (SELECT COALESCE(sum(eligible_revenue_cents),0)::int FROM affiliate_commissions WHERE affiliate_id = $1 AND commission_type = 'revenue_share' AND status <> 'reversed' AND ($2::text IS NULL OR created_at >= CASE WHEN $2='year' THEN date_trunc('year',now()) ELSE now()-$2::interval END)) AS eligible_revenue,
      (SELECT COALESCE(sum(amount_cents),0)::int FROM affiliate_commissions WHERE affiliate_id = $1 AND status IN ('pending','hold','approved') AND ($2::text IS NULL OR created_at >= CASE WHEN $2='year' THEN date_trunc('year',now()) ELSE now()-$2::interval END)) AS pending,
      (SELECT COALESCE(sum(amount_cents),0)::int FROM affiliate_commissions WHERE affiliate_id = $1 AND status = 'payable' AND ($2::text IS NULL OR created_at >= CASE WHEN $2='year' THEN date_trunc('year',now()) ELSE now()-$2::interval END)) AS payable,
      (SELECT COALESCE(sum(amount_cents),0)::int FROM affiliate_commissions WHERE affiliate_id = $1 AND status = 'paid' AND ($2::text IS NULL OR created_at >= CASE WHEN $2='year' THEN date_trunc('year',now()) ELSE now()-$2::interval END)) AS paid,
      (SELECT COALESCE(sum(amount_cents),0)::int FROM affiliate_commissions WHERE affiliate_id = $1 AND status IN ('pending','hold','approved','payable','paid')) AS lifetime_earnings`, [profile.id, since]),
    database.query<{ business_name: string; attributed_at: Date; status: string; revenue_share_ends_at: Date | null; commission_cents: number }>(`SELECT provider.business_name, referral.attributed_at, referral.status, referral.revenue_share_ends_at,
      COALESCE(sum(commission.amount_cents) FILTER (WHERE commission.status <> 'reversed'),0)::int AS commission_cents
      FROM affiliate_referrals referral JOIN provider_profiles provider ON provider.id = referral.provider_id
      LEFT JOIN affiliate_commissions commission ON commission.referral_id = referral.id
      WHERE referral.affiliate_id = $1 GROUP BY referral.id, provider.business_name ORDER BY referral.attributed_at DESC LIMIT 25`, [profile.id]),
    database.query<{ id: string; commission_type: string; amount_cents: number; status: string; created_at: Date; business_name: string }>(`SELECT commission.id::text, commission.commission_type, commission.amount_cents, commission.status, commission.created_at, provider.business_name
      FROM affiliate_commissions commission JOIN provider_profiles provider ON provider.id = commission.provider_id
      WHERE commission.affiliate_id = $1 ORDER BY commission.created_at DESC LIMIT 25`, [profile.id]),
    database.query<{ id: string; amount_cents: number; status: string; paid_at: Date | null; created_at: Date; payout_reference: string | null }>(`SELECT id::text, amount_cents, status, paid_at, created_at, payout_reference FROM affiliate_payouts WHERE affiliate_id = $1 ORDER BY created_at DESC LIMIT 20`, [profile.id]),
    profile.milestone_bonuses_enabled ? getAffiliateMilestoneProgress(profile.id) : Promise.resolve(null),
  ]);
  const stats = statsResult.rows[0];
  const requiresAgreementReacceptance = affiliateRequiresAgreementReacceptance(profile);
  const conversion = stats.clicks ? Math.round(stats.signups / stats.clicks * 1000) / 10 : 0;
  const metrics:Array<[string,string|number]>=[["Referral-link clicks",stats.clicks],["First-touch visits",stats.first_touch_visits],["Signup starts",stats.signup_starts],["Accounts created",stats.account_creations],["Provider profiles",stats.signups],["Published listings",stats.published_listings],["Qualified providers",stats.qualified],["Profile conversion",`${conversion}%`],["Bookings generated",stats.bookings]];
  if(profile.revenue_share_enabled)metrics.push(["Eligible platform revenue",money(stats.eligible_revenue)]);
  metrics.push(["Pending commissions",money(stats.pending)],["Payable balance",money(stats.payable)],["Paid commissions",money(stats.paid)],["Lifetime earnings",money(stats.lifetime_earnings)]);
  return <main className="affiliate-page min-h-screen bg-[#f8f7f3] text-[#183126]"><header className="border-b border-[#183126]/10 bg-white"><div className="dashboard-container flex items-center justify-between px-5 py-4"><Link href="/"><BrandLockup /></Link><Link href="/account" className="rounded-full border border-[#183126]/15 px-5 py-2.5 text-sm font-bold">Account</Link></div></header>
    <div className="dashboard-container px-5 py-10"><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-[#687970]">{profile.compensation_type==="standard"?"Standard Partner Program":profile.program_name}</p><h1 className="mt-2 text-4xl font-bold tracking-tight">Welcome, {profile.display_name}</h1><p className="mt-2 text-sm text-[#687970]">Code <strong className="text-[#183126]">{profile.affiliate_code}</strong> · <span className="capitalize">{profile.status}</span></p></div><nav className="flex flex-wrap gap-2" aria-label="Analytics date range">{Object.entries(ranges).map(([key, label]) => <Link key={key} href={`/affiliate?range=${key}`} className={`rounded-full px-4 py-2 text-xs font-bold ${range === key ? "bg-[#183126] text-white" : "border border-[#183126]/15 bg-white"}`}>{label === "year" ? "Year to date" : label === "all" ? "All time" : `Last ${label}`}</Link>)}</nav></div>
    <PartnerCompensationSummary compensationType={profile.compensation_type} activationBonusEnabled={profile.activation_bonus_enabled} activationBonusCents={profile.activation_bonus_cents} revenueShareEnabled={profile.revenue_share_enabled} revenueShareBasisPoints={profile.revenue_share_basis_points} revenueShareDurationMonths={profile.revenue_share_duration_months} milestoneBonusesEnabled={profile.milestone_bonuses_enabled} customCampaignEnabled={profile.custom_campaign_enabled} customCampaignAmountCents={profile.custom_campaign_amount_cents} customCampaignStartsOn={profile.custom_campaign_starts_on} customCampaignEndsOn={profile.custom_campaign_ends_on} />
    {profile.milestone_bonuses_enabled&&milestoneProgress ? <ProviderGrowthMilestones activeProviderCount={milestoneProgress.activeProviderCount} milestones={milestoneProgress.milestones} completedThresholds={milestoneProgress.achievements.filter((item) => !item.reversedAt && !["reversed","rejected"].includes(item.status)).map((item) => item.threshold)} enabled={milestoneProgress.enabled} historicalReviewPending={milestoneProgress.enabled && !milestoneProgress.backfillApproved} /> : null}
    {profile.status === "paused" ? <div role="status" className="mt-6 rounded-2xl border border-[#b05a3c]/20 bg-[#fff1e8] p-4 text-sm leading-6"><strong>Your partner account is paused.</strong> Historical reporting remains available, but your referral link will not attribute new providers until the account is reactivated.</div> : null}
    {requiresAgreementReacceptance ? <AffiliateAgreementReacceptance reason={profile.agreement_reacceptance_reason} /> : null}
    <AffiliateStripeSetup initialConnected={Boolean(profile.stripe_account_id&&profile.stripe_connect_mode===getStripeMode())} initialReady={profile.stripe_connect_mode===getStripeMode()&&profile.stripe_payouts_enabled&&profile.payment_status==="ready"} initialTaxState={profile.tax_onboarding_status} returning={params.stripe==="connect-return"||params.stripe==="connect-refresh"}/>
    <section className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{metrics.map(([label,value]) => <article key={label} className="rounded-2xl border border-[#183126]/10 bg-white p-5"><p className="text-xs font-bold uppercase tracking-wider text-[#718078]">{label}</p><p className="mt-2 text-2xl font-bold">{value}</p></article>)}</section>
    {profile.status === "active" ? <div className="mt-7"><AffiliateLinkBuilder code={profile.affiliate_code} /></div> : null}
    <div className="mt-7 grid gap-6 xl:grid-cols-2"><section className="rounded-[1.75rem] border border-[#183126]/10 bg-white p-5"><h2 className="text-xl font-bold">Referred providers</h2><div className="mt-4 grid gap-3">{referralsResult.rows.length ? referralsResult.rows.map((item) => <article key={`${item.business_name}-${item.attributed_at.toISOString()}`} className="rounded-2xl bg-[#f6f7f2] p-4"><div className="flex flex-wrap justify-between gap-2"><strong>{item.business_name}</strong><span className="text-sm font-bold capitalize">{item.status.replaceAll("_", " ")}</span></div><p className="mt-1 text-xs text-[#687970]">Joined {item.attributed_at.toLocaleDateString()} · Commission {money(item.commission_cents)}{item.revenue_share_ends_at ? ` · Share ends ${item.revenue_share_ends_at.toLocaleDateString()}` : ""}</p></article>) : <p className="text-sm text-[#687970]">No attributed providers in this view yet.</p>}</div></section>
    <section className="rounded-[1.75rem] border border-[#183126]/10 bg-white p-5"><h2 className="text-xl font-bold">Recent commissions</h2><div className="mt-4 grid gap-3">{commissionsResult.rows.length ? commissionsResult.rows.map((item) => <article key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[#f6f7f2] p-4"><div><strong className="capitalize">{item.commission_type.replaceAll("_", " ")}</strong><p className="text-xs text-[#687970]">{item.business_name} · {item.created_at.toLocaleDateString()}</p></div><div className="text-right"><p className="font-bold">{money(item.amount_cents)}</p><p className="text-xs font-bold capitalize text-[#687970]">{item.status}</p></div></article>) : <p className="text-sm text-[#687970]">No commissions yet.</p>}</div></section></div>
    <section className="mt-7 rounded-[1.75rem] border border-[#183126]/10 bg-white p-5"><h2 className="text-xl font-bold">Payout history</h2><p className="mt-1 text-sm text-[#687970]">Approved affiliate payouts are transferred to your connected Stripe balance separately from provider payouts.</p><div className="mt-4 grid gap-3">{payoutsResult.rows.length ? payoutsResult.rows.map((item) => <article key={item.id} className="flex flex-wrap justify-between gap-3 rounded-2xl bg-[#f6f7f2] p-4"><div><strong>{money(item.amount_cents)}</strong><p className="text-xs text-[#687970]">{(item.paid_at ?? item.created_at).toLocaleDateString()} {item.payout_reference ? `· Stripe reference ${item.payout_reference}` : ""}</p></div><span className="text-sm font-bold capitalize">{item.status}</span></article>) : <p className="text-sm text-[#687970]">No payouts issued yet.</p>}</div></section>
    </div></main>;
}
