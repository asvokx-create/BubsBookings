"use client";

import BrandLockup from "@/components/brand-lockup";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { authClient } from "@/lib/auth-client";
import ProfileAvatar from "@/components/profile-avatar";
import CustomSelect from "@/components/custom-select";
import { PLAN_ENTITLEMENTS, type ProviderPlan } from "@/lib/plans";
import { accountLocationSourceLabel } from "@/lib/account-location";
import UiIcon from "@/components/ui-icon";
import { formatDurationMinutes, formatHourlyRate } from "@/lib/service-pricing";
import AdminComplimentaryPro from "@/components/admin-complimentary-pro";

type AdminSection = "overview" | "reports" | "moderation" | "accounts" | "listings" | "reviews" | "payouts" | "audit";
type Stats = {
  users: number; active_providers: number; active_services: number; bookings_30d: number;
  open_reports: number; blocked_30d: number; unique_site_views: number; affiliate_clicks: number;
};
type AdminStatCard = {
  id: string; label: string; value: number; detail: string; description: string; timeRange: string; basis: string;
  destinationLabel: string; destinationSection?: AdminSection; destinationHref?: string;
};
type SafetyReport = {
  id: string; category: string; details: string; status: string; created_at: string;
  reporter_name: string; reporter_email: string; reported_name: string; reported_email: string;
  service_title: string;
};
type ModerationEvent = {
  id: string; surface: string; category: string; severity: string; action: string;
  created_at: string; user_name: string; user_email: string;
};
type MessageModerationEvent = {
  id: string; message_id: string; conversation_id: string | null; booking_id: string | null;
  sender_id: string | null; recipient_id: string | null; sender_name: string; sender_email: string;
  recipient_name: string; message_content: string; risk_level: "low" | "medium" | "high";
  detection_reason: string; triggered_rules: string[]; detected_signals: string[];
  booking_context: { state?: string; quoteStatus?: string | null; bookingStatus?: string | null; paymentStatus?: string | null };
  action_taken: string; status: string; account_status_snapshot: string; current_account_status: string;
  admin_notes: string; previous_violations: number; service_title: string; created_at: string; reviewed_at: string | null;
};
type Account = {
  id: string; name: string; email: string; image: string | null; role: string; created_at: string;
  restriction_status: string | null; restriction_reason: string | null;
  provider_id: string | null; business_name: string | null; provider_plan: ProviderPlan | null; provider_active: boolean | null; is_partner: boolean;
  provider_effective_plan: ProviderPlan | null; provider_current_listing_count: number | null;
  provider_listing_limit: number | null; provider_over_listing_limit: boolean | null;
  phone_verified: boolean | null; identity_verified: boolean | null; business_verified: boolean | null;
};
type Listing = {
  id: string; slug: string; title: string; category: string; description: string; is_active: boolean; price_cents: number;
  pricing_type: "FIXED" | "HOURLY" | "QUOTE_ONLY"; hourly_rate_cents: number | null; minimum_duration_minutes: number | null;
  created_at: string; business_name: string; city: string; state: string; provider_id: string; delivery_type: "IN_PERSON" | "REMOTE" | "BOTH";
  provider_is_active: boolean; age_verification_status: string; age_verification_source: string | null;
  company_is_active: boolean; publicly_available: boolean; age_verification_blocked: boolean;
  stripe_connected: boolean; stripe_charges_enabled: boolean; stripe_payouts_enabled: boolean;
  screening_status: string; screening_checked_at: string | null;
  safety_review_status: "not_reviewed" | "passed" | "action_required"; safety_reviewed_at: string | null;
  last_status_update: string;
};
type Review = {
  id: string; rating: number; body: string; is_hidden: boolean; created_at: string;
  customer_name: string; customer_email: string; service_title: string; business_name: string;
};
type AuditEntry = {
  id: string; action: string; target_type: string; target_id: string;
  details: Record<string, unknown>; created_at: string; actor_name: string;
};
type Payout = {
  id: string; payment_release_status: string; payment_status: string; price_cents: number;
  customer_service_fee_cents: number; customer_total_cents: number; platform_fee_cents: number;
  provider_payout_cents: number; provider_plan_snapshot: string; provider_fee_basis_points: number;
  stripe_payment_intent_id: string | null; stripe_charge_id: string | null; stripe_transfer_id: string | null;
  refunded_amount_cents: number; stripe_refund_id: string | null; completed_at: string | null; customer_confirmed_at: string | null;
  completion_confirmation_due_at: string | null; payout_released_at: string | null;
  payout_freeze_reason: string | null; payout_failure_reason: string | null; booking_status: string;
  created_at: string; customer_name: string; provider_name: string; service_title: string;
};
type BookingTip = {
  id: string; booking_id: string; amount_cents: number; tip_type: "percentage" | "custom"; percentage: number | null;
  payment_status: string; transfer_status: string; refunded_amount_cents: number; risk_status: "clear" | "review";
  stripe_payment_intent_id: string | null; stripe_charge_id: string | null; stripe_transfer_id: string | null;
  stripe_refund_id: string | null; stripe_dispute_id: string | null; stripe_dispute_status: string | null;
  failure_reason: string | null; transfer_failure_reason: string | null; created_at: string; paid_at: string | null;
  transferred_at: string | null; refunded_at: string | null; customer_name: string; provider_name: string; service_title: string;
};
type DashboardData = {
  stats: Stats; reports: SafetyReport[]; events: ModerationEvent[];
  messageModeration: MessageModerationEvent[];
  accounts: Account[]; listings: Listing[]; reviews: Review[]; payouts: Payout[]; tips: BookingTip[]; audit: AuditEntry[];
};
type AdminActionOptions = {
  action: string; targetId: string; status?: string; needsReason?: boolean; needsAmount?: boolean; maximumAmountCents?: number;
  confirmText?: string; successText: string;
};
type AccountDetails = {
  account: Account & {
    phone: string | null; email_verified: boolean; two_factor_enabled: boolean;
    terms_accepted_at: string | null; privacy_acknowledged_at: string | null;
    ai_safety_acknowledged_at: string | null; policy_version: string | null; updated_at: string;
    location_city: string | null; location_state: string | null; location_postal_code: string | null; location_country: string | null;
    location_source: string | null; location_updated_at: string | null;
    restriction_expires_at: string | null; restriction_created_at: string | null;
  };
  settings: null | { city: string; state: string; search_radius_miles: number; booking_notifications: boolean; message_notifications: boolean; theme: string; time_zone: string };
  consumerStripe: { connected: boolean; mode: "test" | "live" | null };
  provider: null | {
    id: string; business_name: string; bio: string; phone: string | null; city: string; state: string;
    service_radius_miles: number; has_in_person_services: boolean; plan: ProviderPlan; is_active: boolean; is_verified: boolean;
    phone_verified: boolean; identity_verified: boolean; business_verified: boolean;
    screening_status: string; screening_score: number | null; screening_summary: string; screening_checked_at: string | null;
    stripe_subscription_status: string; stripe_subscription_checkout_pending: boolean; stripe_charges_enabled: boolean; stripe_payouts_enabled: boolean;
    age_verification_status: "not_started" | "pending" | "requires_input" | "verified" | "failed";
    age_verification_source: "stripe_identity" | "admin_exception" | null;
    age_verification_exception_eligible: boolean; age_verification_exception_note: string | null;
    age_verification_exception_granted_at: string | null;
    age_identity_verified_at: string | null; age_verification_failure_code: string | null;
    stripe_identity_verification_mode: "test" | "live" | null;
    extra_team_seats: number; reserved_worker_count: number;
    stripe_current_period_end: string | null; stripe_connected: boolean;
    provider_agreement_accepted_at: string | null; provider_agreement_version: string | null;
    pro_trial_used_at_test: string | null; pro_trial_used_at_live: string | null; created_at: string; updated_at: string;
    public_profile_slug: string; public_profile_visible: boolean; years_experience: number | null; experience_summary: string;
    specialties: string[]; languages: string[]; provider_highlights: string[];
  };
  complimentaryPro: null | { active: boolean; grantId: string | null; startsAt: string | null; expiresAt: string | null; lifetime: boolean; reason: string | null };
  complimentaryProHistory: Array<{ id: string; grant_id: string; action: string; reason: string | null; previous_expires_at: string | null; new_expires_at: string | null; created_at: string; actor_name: string }>;
  counts: { bookings: number; listings: number; reviews: number; safety_reports: number; disputes: number; support_requests: number };
  services: Array<{ id: string; slug: string; title: string; category: string; business_name: string; price_cents: number; duration_minutes: number; pricing_type: "FIXED" | "HOURLY" | "QUOTE_ONLY"; hourly_rate_cents: number | null; minimum_duration_minutes: number | null; is_active: boolean; created_at: string }>;
  bookings: Array<{ id: string; service_title: string; status: string; payment_status: string; price_cents: number; starts_at: string; created_at: string; other_party_name: string; account_role: string }>;
  reviews: Array<{ id: string; rating: number; body: string; is_hidden: boolean; created_at: string; service_title: string; customer_name: string; relationship: string }>;
  reports: Array<{ id: string; category: string; details: string; status: string; created_at: string; reporter_name: string; reported_name: string; relationship: string }>;
  disputes: Array<{ id: string; category: string; details: string; requested_resolution: string; status: string; admin_note: string; created_at: string; service_title: string; opened_by_name: string; against_name: string }>;
  supportRequests: Array<{ id: string; subject: string; message: string; status: string; admin_reply: string; created_at: string }>;
  activity: Array<{ id: string; action: string; target_type: string; target_id: string | null; created_at: string }>;
  welcomeEmail: null | { status: "sent" | "skipped" | "failed"; created_at: string };
  providerWelcomeEmail: { status: "not_attempted" | "queued" | "sending" | "sent" | "delivered" | "failed"; attempt_count: number; queued_at?: string; attempted_at?: string; sent_at?: string; delivered_at?: string; updated_at?: string; last_error?: string | null };
  affiliateAttribution: null | { affiliate_name: string; affiliate_code: string; program_name: string; attributed_at: string; provider_signup_at: string; qualified_at: string | null; revenue_share_started_at: string | null; revenue_share_ends_at: string | null; status: string };
  portfolio: Array<{ id: string; url: string; caption: string; alt_text: string; moderation_status: "active" | "hidden"; created_at: string }>;
  privacyNote: string;
};

const navItems: Array<{ id: AdminSection; label: string; icon: string }> = [
  { id: "overview", label: "Overview", icon: "▦" },
  { id: "reports", label: "Safety reports", icon: "⚑" },
  { id: "moderation", label: "Safety Bot", icon: "◇" },
  { id: "accounts", label: "Accounts", icon: "◎" },
  { id: "listings", label: "Listings", icon: "▤" },
  { id: "reviews", label: "Reviews", icon: "☆" },
  { id: "payouts", label: "Payouts", icon: "$" },
  { id: "audit", label: "Audit history", icon: "↺" },
];

function formatDate(value: string) {
  return new Date(value).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function providerAgeVerificationFailureLabel(code: string | null) {
  if (!code) return null;
  if (code === "underage") return "The verified date of birth did not meet the 18+ requirement.";
  if (code === "date_of_birth_unavailable") return "Stripe did not return enough verified age information.";
  return `Stripe requires another verification attempt (${code.replaceAll("_", " ")}).`;
}

function StatusPill({ value }: { value: string }) {
  const warning = ["open", "critical", "high", "suspended", "banned", "inactive", "frozen", "failed", "verification required"].includes(value);
  const success = ["active", "resolved"].includes(value);
  const color = warning
    ? "bg-[#fff0e7] text-[#9a4e25]"
    : success
      ? "bg-[#e5f1e5] text-[#34704a]"
      : "bg-[#f5f0c9] text-[#78681f]";
  return <span className={"rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider " + color}>{label(value)}</span>;
}

export default function AdminDashboard({ adminName, adminImage = "" }: { adminName: string; adminImage?: string }) {
  const router = useRouter();
  const [section, setSection] = useState<AdminSection>("overview");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [accountSearch, setAccountSearch] = useState("");
  const [accountScope, setAccountScope] = useState<"all" | "active_providers">("all");
  const [listingDeliveryFilter, setListingDeliveryFilter] = useState<"ALL" | "IN_PERSON" | "REMOTE" | "BOTH">("ALL");
  const [moderationRiskFilter, setModerationRiskFilter] = useState<"all" | "low" | "medium" | "high">("all");
  const [moderationStatusFilter, setModerationStatusFilter] = useState("all");
  const [pendingAction, setPendingAction] = useState<AdminActionOptions | null>(null);
  const [selectedStatId, setSelectedStatId] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [accountDetails, setAccountDetails] = useState<AccountDetails | null>(null);
  const [accountDetailsLoading, setAccountDetailsLoading] = useState(false);
  const [accountDetailsError, setAccountDetailsError] = useState("");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const response = await fetch("/api/admin", { cache: "no-store" }).catch(() => null);
    if (!response?.ok) {
      setError("The admin dashboard could not be loaded.");
      setLoading(false);
      return;
    }
    setData(await response.json() as DashboardData);
    setError("");
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/admin", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<DashboardData> : null)
      .catch(() => null)
      .then((result) => {
        if (!active) return;
        if (result) {
          setData(result);
          setError("");
        } else setError("The admin dashboard could not be loaded.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function runAction(options: AdminActionOptions) {
    if (options.confirmText) { setPendingAction(options); return; }
    await executeAction(options);
  }

  async function executeAction(options: AdminActionOptions) {
    let reason = "";
    let amountCents: number | undefined;
    if (options.needsReason) {
      reason = window.prompt("Add a clear reason. This is saved in the audit history.")?.trim() ?? "";
      if (!reason) return;
    }
    if (options.needsAmount) {
      const entered = window.prompt(`Refund amount (up to $${((options.maximumAmountCents ?? 0) / 100).toFixed(2)}):`);
      if (entered === null) return;
      const normalized = Number(entered.trim());
      amountCents = Number.isFinite(normalized) ? Math.round(normalized * 100) : NaN;
      if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > (options.maximumAmountCents ?? 0)) {
        setError(`Enter an amount from $0.01 to $${((options.maximumAmountCents ?? 0) / 100).toFixed(2)}.`);
        return;
      }
    }
    setBusyId(options.targetId);
    setError("");
    const response = await fetch("/api/admin", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: options.action, targetId: options.targetId, status: options.status, reason, amountCents }),
    }).catch(() => null);
    const result = response ? await response.json() as { error?: string; message?: string } : null;
    if (!response?.ok) setError(result?.error ?? "That change could not be saved.");
    else {
      setNotice(result?.message ?? options.successText);
      await load();
    }
    setBusyId("");
    setPendingAction(null);
  }

  async function signOut() {
    await authClient.signOut();
    router.push("/");
    router.refresh();
  }

  async function openAccount(account: Account) {
    setSelectedAccount(account);
    setAccountDetails(null);
    setAccountDetailsError("");
    setAccountDetailsLoading(true);
    const response = await fetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { cache: "no-store" }).catch(() => null);
    const result = response ? await response.json() as AccountDetails & { error?: string } : null;
    if (!response?.ok || !result) setAccountDetailsError(result?.error ?? "The account details could not be loaded.");
    else setAccountDetails(result);
    setAccountDetailsLoading(false);
  }

  function closeAccount() {
    setSelectedAccount(null);
    setAccountDetails(null);
    setAccountDetailsError("");
  }

  useEffect(() => {
    if (!selectedAccount) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeAccount(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedAccount]);

  useEffect(() => {
    if (!selectedStatId) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectedStatId(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedStatId]);

  const firstName = adminName.trim().split(/\s+/)[0] || "Admin";
  const openReports = data?.reports.filter((report) => report.status === "open" || report.status === "reviewing") ?? [];
  const criticalEvents = data?.events.filter((event) => event.severity === "critical" || event.severity === "high") ?? [];
  const normalizedAccountSearch = accountSearch.trim().toLocaleLowerCase();
  const filteredAccounts = data?.accounts.filter((account) => {
    if (accountScope === "active_providers" && (!account.provider_id || account.provider_active !== true)) return false;
    if (!normalizedAccountSearch) return true;
    return [account.id, account.name, account.email, account.role, account.provider_id ? "provider" : "", account.is_partner ? "partner" : "", account.business_name ?? ""]
      .some((value) => value.toLocaleLowerCase().includes(normalizedAccountSearch));
  }) ?? [];
  const filteredListings = data?.listings.filter((listing) => listingDeliveryFilter === "ALL" || listing.delivery_type === listingDeliveryFilter) ?? [];
  const filteredMessageModeration = data?.messageModeration.filter((event) =>
    (moderationRiskFilter === "all" || event.risk_level === moderationRiskFilter)
    && (moderationStatusFilter === "all" || event.status === moderationStatusFilter)) ?? [];
  const statCards: AdminStatCard[] = data ? [
    { id: "accounts", label: "Total accounts", value: data.stats.users, detail: "All registered accounts", description: "Every registered BubsBookings account, including customer, provider, and administrator accounts.", timeRange: "All time", basis: "Current account records", destinationLabel: "View accounts", destinationSection: "accounts" },
    { id: "providers", label: "Active providers", value: data.stats.active_providers, detail: "Active provider profiles", description: "Provider profiles currently marked active. A provider can be active even when an individual listing still needs verification.", timeRange: "Current status", basis: "Active provider profiles", destinationLabel: "View provider accounts", destinationSection: "accounts" },
    { id: "listings", label: "Active listings", value: data.stats.active_services, detail: "Bookable services", description: "Active services belonging to an active company and an active provider whose required age verification is complete.", timeRange: "Current status", basis: "Publicly eligible service listings", destinationLabel: "View listings", destinationSection: "listings" },
    { id: "views", label: "Unique visitors", value: data.stats.unique_site_views, detail: "Analytics-enabled · all time", description: "Distinct visitors who allowed optional first-party analytics and recorded a public-page view. Private admin, account, affiliate, and provider dashboard pages are excluded.", timeRange: "All time", basis: "Consent-enabled first-party analytics visitor identifiers", destinationLabel: "Open growth analytics", destinationHref: "/admin/growth" },
    { id: "affiliate-clicks", label: "Referral clicks", value: data.stats.affiliate_clicks, detail: "Repeat clicks included", description: "Every qualifying visit through an active Partner referral link. Repeat visits are included, so this is not a unique visitor count and must not be added to unique visitors.", timeRange: "All time", basis: "Server-recorded Partner referral landing requests", destinationLabel: "Open Partner analytics", destinationHref: "/admin/affiliates" },
    { id: "bookings", label: "Bookings", value: data.stats.bookings_30d, detail: "Last 30 days", description: "Bookings created during the last 30 days, including every status. This is not limited to completed or paid bookings.", timeRange: "Rolling 30 days", basis: "Booking creation date", destinationLabel: "Open operations", destinationHref: "/admin/operations" },
    { id: "reports", label: "Open reports", value: data.stats.open_reports, detail: "Needs review", description: "Safety reports that are currently open or under review and still need an administrator decision.", timeRange: "Current status", basis: "Open and reviewing safety reports", destinationLabel: "Review reports", destinationSection: "reports" },
    { id: "blocks", label: "Safety blocks", value: data.stats.blocked_30d, detail: "Last 30 days", description: "Safety moderation events and message actions that blocked or restricted content during the last 30 days. Logged-only message events are excluded.", timeRange: "Rolling 30 days", basis: "Safety Bot moderation records", destinationLabel: "Review Safety Bot", destinationSection: "moderation" },
  ] : [];
  const selectedStat = statCards.find((stat) => stat.id === selectedStatId) ?? null;
  const activeNavItem = navItems.find((item) => item.id === section) ?? navItems[0];

  function selectSection(nextSection: AdminSection, nextAccountScope: "all" | "active_providers" = "all") {
    if (nextSection === "accounts") setAccountScope(nextAccountScope);
    setSection(nextSection);
    setMobileNavOpen(false);
  }

  return (
    <main className="admin-page min-h-screen overflow-x-clip bg-[#f4f4ef] text-[#183126]">
      <header className="border-b border-[#183126]/10 bg-white">
        <div className="admin-header-shell dashboard-container flex flex-nowrap items-center justify-between gap-2 px-3 py-4 min-[360px]:px-4 sm:px-8">
          <div className="flex shrink-0 items-center gap-3">
            <Link href="/" className="flex min-w-0 items-center gap-2.5 text-xl font-bold">
              <BrandLockup compact />
            </Link>
            <span className="hidden shrink-0 rounded-full bg-[#eee25a] px-3 py-1 text-xs font-extrabold uppercase tracking-wider sm:inline">Admin</span>
          </div>
          <div aria-label="Admin account actions" className="flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-1 min-[360px]:gap-2 sm:gap-3">
            <Link href="/admin/reported-bugs" className="admin-header-link hidden lg:inline-flex">Bug reports</Link>
            <Link href="/admin/disputes" className="admin-header-link hidden lg:inline-flex">Disputes</Link>
            <Link href="/admin/support" className="admin-header-link hidden lg:inline-flex">Support</Link>
            <Link href="/admin/affiliates" className="admin-header-link hidden min-[1700px]:inline-flex">Partners</Link>
            <Link href="/admin/operations" className="admin-header-link hidden min-[1700px]:inline-flex">Operations</Link>
            <Link href="/admin/integrations/calendly" className="admin-header-link hidden min-[1700px]:inline-flex">Integrations</Link>
            <Link href="/admin/jarvis" className="admin-header-link hidden min-[1700px]:inline-flex">Jarvis</Link>
            <Link href="/admin/growth" className="admin-header-link hidden min-[1700px]:inline-flex">Growth</Link>
            <Link href="/admin/expenses" className="admin-header-link hidden min-[1700px]:inline-flex">Expenses</Link>
            <Link href="/admin/requests" className="admin-header-link hidden min-[1700px]:inline-flex">Requests</Link>
            <Link href="/account" className="admin-marketplace-link hidden sm:inline-flex">View marketplace</Link>
            <span className="hidden min-[375px]:inline-flex"><ProfileAvatar name={adminName} imageUrl={adminImage} className="h-10 w-10 text-sm" /></span>
            <button onClick={signOut} className="min-h-11 rounded-full px-2.5 py-2 text-sm font-bold text-[#66766e] transition hover:bg-[#fff0e7] hover:text-[#8d4827] sm:px-3">Log out</button>
          </div>
        </div>
      </header>

      <div className="dashboard-container grid min-w-0 gap-6 px-4 py-5 sm:px-5 sm:py-7 xl:grid-cols-[240px_minmax(0,1fr)] xl:px-8">
        <aside className="admin-nav-shell min-w-0 overflow-x-hidden rounded-[1.35rem] bg-[#183126] p-3 text-white xl:sticky xl:top-4 xl:max-h-[calc(100dvh-2rem)] xl:overflow-y-auto xl:overscroll-contain xl:rounded-[1.5rem]">
          <div className="hidden px-4 pb-5 pt-3 xl:block">
            <p className="text-xs font-bold uppercase tracking-[.16em] text-[#aabdb3]">Admin console</p>
            <p className="mt-2 text-lg font-bold">Hi, {firstName}</p>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-3 xl:hidden">
            <div className="flex min-w-0 items-center gap-3 px-2">
              <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#eee25a] text-[#183126]">{activeNavItem.icon}</span>
              <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#aabdb3]">Admin section</p><p className="truncate text-sm font-bold">{activeNavItem.label}</p></div>
            </div>
            <button type="button" aria-expanded={mobileNavOpen} aria-controls="admin-mobile-menu" onClick={() => setMobileNavOpen((open) => !open)} className="min-h-11 shrink-0 rounded-xl border border-white/20 px-3 py-2 text-sm font-bold transition hover:bg-white/10">
              {mobileNavOpen ? "Close" : "All sections"} <span aria-hidden="true">{mobileNavOpen ? "−" : "+"}</span>
            </button>
          </div>
          <nav id="admin-mobile-menu" className={(mobileNavOpen ? "mt-3 grid " : "hidden ") + "min-w-0 gap-1 border-t border-white/10 pt-3 sm:grid-cols-2 xl:mt-0 xl:grid xl:grid-cols-1 xl:border-0 xl:pt-0"} aria-label="Admin sections">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => selectSection(item.id)}
                aria-current={section === item.id ? "page" : undefined}
                className={"flex min-h-11 min-w-0 items-center gap-2 rounded-xl px-4 py-2.5 text-left text-sm font-bold transition xl:rounded-2xl xl:py-3 " + (section === item.id ? "bg-[#eee25a] text-[#183126]" : "text-white/80 hover:bg-white/10 hover:text-white")}
              >
                <span className="w-5 shrink-0 text-center">{item.icon}</span><span className="min-w-0 flex-1">{item.label}</span>
                {item.id === "reports" && openReports.length > 0 && <span className="ml-auto rounded-full bg-[#fff0e7] px-2 py-0.5 text-[10px] text-[#9a4e25]">{openReports.length}</span>}
              </button>
            ))}
            <Link href="/admin/recommendations" className="hidden min-h-11 items-center rounded-xl px-4 py-2.5 text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white xl:flex">Client recommendations</Link>
            <div aria-label="Admin tools" className="mt-2 grid gap-1 border-t border-white/10 pt-3 sm:col-span-2 sm:grid-cols-2 xl:hidden">
              <Link href="/admin/reported-bugs" className="flex min-h-11 items-center rounded-xl px-4 py-2.5 text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white">Bug reports</Link>
              <Link href="/admin/disputes" className="flex min-h-11 items-center rounded-xl px-4 py-2.5 text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white">Booking disputes</Link>
              <Link href="/admin/support" className="flex min-h-11 items-center rounded-xl px-4 py-2.5 text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white">Support &amp; verification</Link>
              <Link href="/admin/operations" className="flex min-h-11 items-center rounded-xl px-4 py-2.5 text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white">Operations</Link>
              <Link href="/admin/integrations/calendly" className="flex min-h-11 items-center rounded-xl px-4 py-2.5 text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white">Calendar integrations</Link>
              <Link href="/admin/jarvis" className="flex min-h-11 items-center rounded-xl px-4 py-2.5 text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white">Jarvis assistant</Link>
              <Link href="/admin/growth" className="flex min-h-11 items-center rounded-xl px-4 py-2.5 text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white">Growth dashboard</Link>
              <Link href="/admin/expenses" className="flex min-h-11 items-center rounded-xl px-4 py-2.5 text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white">Expenses</Link>
              <Link href="/admin/requests" className="flex min-h-11 items-center rounded-xl px-4 py-2.5 text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white">Service requests</Link>
              <Link href="/admin/affiliates" className="flex min-h-11 items-center rounded-xl px-4 py-2.5 text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white">Partners &amp; affiliates</Link>
              <Link href="/admin/recommendations" className="flex min-h-11 items-center rounded-xl px-4 py-2.5 text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white">Client recommendations</Link>
              <Link href="/account" className="flex min-h-11 items-center rounded-xl px-4 py-2.5 text-sm font-bold text-white/80 hover:bg-white/10 hover:text-white">View marketplace</Link>
            </div>
          </nav>
        </aside>

        <section className="min-w-0">
          <div className="mb-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div>
              <p className="text-xs font-extrabold uppercase tracking-[.16em] text-[#718078]">Marketplace operations</p>
              <h1 className="mt-2 text-3xl font-bold tracking-[-.04em] sm:text-4xl">{activeNavItem.label}</h1>
            </div>
            <button onClick={() => void load()} disabled={loading} className="self-start rounded-full border border-[#183126]/15 bg-white px-5 py-2.5 text-sm font-bold transition hover:bg-[#eee25a] disabled:opacity-50 sm:self-auto">
              {loading ? "Refreshing…" : "↻ Refresh"}
            </button>
          </div>

          {notice && <div role="status" className="mb-5 flex items-center justify-between rounded-2xl bg-[#e4f0e2] px-5 py-4 text-sm font-bold text-[#34704a]"><span className="inline-flex items-center gap-2"><UiIcon name="check" className="h-4 w-4" />{notice}</span><button onClick={() => setNotice("")} className="grid h-9 w-9 place-items-center rounded-full hover:bg-white/60" aria-label="Dismiss"><UiIcon name="close" className="h-4 w-4" /></button></div>}
          {error && <div role="alert" className="mb-5 rounded-2xl bg-[#fff0e7] px-5 py-4 text-sm font-bold text-[#9a4e25]">{error}</div>}
          {loading && !data && <div className="rounded-[2rem] bg-white p-12 text-center text-[#718078]">Loading your admin console…</div>}

          {data && section === "overview" && (
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {statCards.map((stat) => <button type="button" key={stat.id} onClick={() => setSelectedStatId(stat.id)} aria-label={`View details for ${stat.label}`} className="group rounded-[1.7rem] border border-[#183126]/10 bg-white p-6 text-left shadow-[0_16px_40px_rgba(24,49,38,.05)] transition hover:border-[#34704a]/35 hover:shadow-[0_20px_45px_rgba(24,49,38,.1)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#eee25a]"><span className="flex items-start justify-between gap-4"><span><span className="block text-xs font-extrabold uppercase tracking-[.13em] text-[#718078]">{stat.label}</span><span className="mt-3 block text-4xl font-bold tracking-tight">{stat.value}</span><span className="mt-2 block text-sm text-[#718078]">{stat.detail}</span></span><span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#f1f3ed] text-lg transition group-hover:bg-[#eee25a]">›</span></span><span className="mt-4 block text-xs font-bold text-[#34704a]">View details</span></button>)}
              </div>
              <div className="grid gap-5 xl:grid-cols-2">
                <div className="rounded-[1.7rem] border border-[#183126]/10 bg-white p-6">
                  <div className="flex items-center justify-between"><div><h2 className="text-xl font-bold">Needs attention</h2><p className="mt-1 text-sm text-[#718078]">Reports waiting for an admin decision.</p></div><button onClick={() => setSection("reports")} className="rounded-full px-4 py-2 text-sm font-bold transition hover:bg-[#eee25a]">View all →</button></div>
                  <div className="mt-5 space-y-3">{openReports.slice(0, 4).map((report) => <button key={report.id} onClick={() => setSection("reports")} className="flex w-full items-center gap-4 rounded-2xl bg-[#f7f7f2] p-4 text-left transition hover:bg-[#f1edc7]"><span className="grid h-10 w-10 place-items-center rounded-full bg-[#fff0e7]">⚑</span><span className="min-w-0 flex-1"><span className="block truncate font-bold">{report.reported_name}</span><span className="block truncate text-xs text-[#718078]">{label(report.category)} · {report.service_title}</span></span><StatusPill value={report.status} /></button>)}{openReports.length === 0 && <p className="rounded-2xl bg-[#f7f7f2] p-5 text-sm text-[#718078]">No open safety reports. You’re all caught up.</p>}</div>
                </div>
                <div className="rounded-[1.7rem] border border-[#183126]/10 bg-white p-6">
                  <div className="flex items-center justify-between"><div><h2 className="text-xl font-bold">High-risk blocks</h2><p className="mt-1 text-sm text-[#718078]">Recent Safety Bot activity.</p></div><button onClick={() => setSection("moderation")} className="rounded-full px-4 py-2 text-sm font-bold transition hover:bg-[#eee25a]">Review →</button></div>
                  <div className="mt-5 space-y-3">{criticalEvents.slice(0, 4).map((event) => <button key={event.id} onClick={() => setSection("moderation")} className="flex w-full items-center gap-4 rounded-2xl bg-[#f7f7f2] p-4 text-left transition hover:bg-[#f1edc7]"><span className="grid h-10 w-10 place-items-center rounded-full bg-[#fff0e7]">◇</span><span className="min-w-0 flex-1"><span className="block truncate font-bold">{event.user_name}</span><span className="block truncate text-xs text-[#718078]">{label(event.category)} · {label(event.surface)}</span></span><StatusPill value={event.severity} /></button>)}{criticalEvents.length === 0 && <p className="rounded-2xl bg-[#f7f7f2] p-5 text-sm text-[#718078]">No high-risk events in the recent activity.</p>}</div>
                </div>
              </div>
            </div>
          )}

          {data && section === "reports" && (
            <div className="space-y-4">
              {data.reports.map((report) => (
                <article key={report.id} className="rounded-[1.7rem] border border-[#183126]/10 bg-white p-6">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><StatusPill value={report.status} /><span className="text-xs font-bold uppercase tracking-wider text-[#718078]">{label(report.category)}</span></div><h2 className="mt-3 text-xl font-bold">{report.reported_name} was reported</h2><p className="mt-1 text-sm text-[#718078]">{report.service_title} · {formatDate(report.created_at)}</p></div><div className="admin-action-row flex flex-wrap gap-2">{report.status === "open" && <button disabled={busyId === report.id} onClick={() => void runAction({ action: "report_status", targetId: report.id, status: "reviewing", successText: "Report marked as under review." })} className="rounded-full border border-[#183126]/15 px-4 py-2 text-sm font-bold transition hover:bg-[#eee25a]">Start review</button>}<button disabled={busyId === report.id} onClick={() => void runAction({ action: "report_status", targetId: report.id, status: "resolved", confirmText: "Mark this safety report as resolved?", successText: "Report resolved." })} className="rounded-full bg-[#183126] px-4 py-2 text-sm font-bold text-white transition hover:bg-[#315846]">Resolve</button><button disabled={busyId === report.id} onClick={() => void runAction({ action: "report_status", targetId: report.id, status: "dismissed", confirmText: "Dismiss this safety report?", successText: "Report dismissed." })} className="rounded-full px-4 py-2 text-sm font-bold transition hover:bg-[#fff0e7]">Dismiss</button></div></div>
                  <div className="mt-5 grid gap-4 rounded-2xl bg-[#f7f7f2] p-5 md:grid-cols-2"><div><p className="text-xs font-extrabold uppercase tracking-wider text-[#718078]">Reported by</p><p className="mt-2 font-bold">{report.reporter_name}</p><p className="text-sm text-[#718078]">{report.reporter_email}</p></div><div><p className="text-xs font-extrabold uppercase tracking-wider text-[#718078]">Reported account</p><p className="mt-2 font-bold">{report.reported_name}</p><p className="text-sm text-[#718078]">{report.reported_email}</p></div>{report.details && <div className="md:col-span-2"><p className="text-xs font-extrabold uppercase tracking-wider text-[#718078]">Details</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6">{report.details}</p></div>}</div>
                </article>
              ))}
              {data.reports.length === 0 && <EmptyState title="No safety reports" body="Customer and provider reports will appear here." />}
            </div>
          )}

          {data && section === "moderation" && (
            <div className="space-y-5">
              <section className="overflow-hidden rounded-[1.7rem] border border-[#183126]/10 bg-white" aria-labelledby="message-moderation-title">
                <div className="border-b border-[#183126]/10 p-5 sm:p-6">
                  <h2 id="message-moderation-title" className="text-xl font-bold">Off-platform message review</h2>
                  <p className="mt-1 text-sm text-[#718078]">Secure evidence for marketplace-integrity review. This information is visible only to administrators.</p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
                    <label className="text-xs font-bold">Risk level<CustomSelect ariaLabel="Filter moderation by risk level" value={moderationRiskFilter} onChange={(value) => setModerationRiskFilter(value as typeof moderationRiskFilter)} buttonClassName="mt-1 min-h-11 w-full rounded-xl border border-[#183126]/15 bg-[#fafaf6] px-3 text-sm"><option value="all">All risks</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></CustomSelect></label>
                    <label className="text-xs font-bold">Review status<CustomSelect ariaLabel="Filter moderation by review status" value={moderationStatusFilter} onChange={(value) => setModerationStatusFilter(value)} buttonClassName="mt-1 min-h-11 w-full rounded-xl border border-[#183126]/15 bg-[#fafaf6] px-3 text-sm"><option value="all">All statuses</option><option value="open">Open</option><option value="resolved">Resolved</option><option value="false_positive">False positive</option><option value="under_review">Under review</option><option value="suspended">Suspended</option><option value="banned">Banned</option><option value="confirmed">Confirmed violation</option><option value="warning_only">Warning only</option></CustomSelect></label>
                  </div>
                </div>
                <div className="divide-y divide-[#183126]/10">{filteredMessageModeration.map((event) => <article key={event.id} className="p-5 sm:p-6">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><StatusPill value={event.risk_level} /><StatusPill value={event.status} /><StatusPill value={event.current_account_status} /></div>
                      <h3 className="mt-3 text-lg font-bold">{event.sender_name} → {event.recipient_name}</h3>
                      <p className="mt-1 break-words text-sm text-[#718078]">{event.sender_email} · {event.service_title} · {formatDate(event.created_at)}</p>
                      <div className="mt-4 rounded-2xl border border-[#183126]/10 bg-[#f7f7f2] p-4"><p className="text-[10px] font-extrabold uppercase tracking-wider text-[#718078]">Blocked or reviewed message</p><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{event.message_content}</p></div>
                      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
                        <div><dt className="font-extrabold uppercase tracking-wider text-[#718078]">Detection reason</dt><dd className="mt-1 leading-5">{event.triggered_rules.map(label).join(", ") || "Contextual signal"}</dd></div>
                        <div><dt className="font-extrabold uppercase tracking-wider text-[#718078]">Booking context</dt><dd className="mt-1 leading-5">{label(event.booking_context?.state || "none")} · {event.booking_id ? `Booking ${event.booking_id}` : "No associated booking"}</dd></div>
                        <div><dt className="font-extrabold uppercase tracking-wider text-[#718078]">History</dt><dd className="mt-1 leading-5">{event.previous_violations} previous detection{event.previous_violations === 1 ? "" : "s"}</dd></div>
                        <div><dt className="font-extrabold uppercase tracking-wider text-[#718078]">Conversation ID</dt><dd className="mt-1 break-all leading-5">{event.conversation_id || "Unavailable"}</dd></div>
                        <div><dt className="font-extrabold uppercase tracking-wider text-[#718078]">Message ID</dt><dd className="mt-1 break-all leading-5">{event.message_id}</dd></div>
                        <div><dt className="font-extrabold uppercase tracking-wider text-[#718078]">Action</dt><dd className="mt-1 leading-5">{label(event.action_taken)}</dd></div>
                      </dl>
                      {event.admin_notes && <p className="mt-3 rounded-xl bg-[#eef3ea] px-3 py-2 text-xs"><strong>Admin notes:</strong> {event.admin_notes}</p>}
                    </div>
                    <div className="admin-action-row flex max-w-xl flex-wrap gap-2 xl:w-80 xl:justify-end">
                      <button disabled={busyId === event.id} onClick={() => void runAction({ action: "message_moderation_status", targetId: event.id, status: "confirmed", successText: "Violation confirmed." })} className="rounded-full border border-[#183126]/15 px-4 py-2 text-xs font-bold hover:bg-[#eee25a]">Confirm violation</button>
                      <button disabled={busyId === event.id} onClick={() => void runAction({ action: "message_moderation_status", targetId: event.id, status: "false_positive", confirmText: "Mark this detection as a false positive and clear a related account review when no other review remains?", successText: "Marked as a false positive." })} className="rounded-full border border-[#183126]/15 px-4 py-2 text-xs font-bold hover:bg-[#e5eddf]">False positive</button>
                      <button disabled={busyId === event.id} onClick={() => void runAction({ action: "message_moderation_status", targetId: event.id, status: "warning_only", needsReason: true, successText: "Warning-only resolution saved." })} className="rounded-full border border-[#183126]/15 px-4 py-2 text-xs font-bold hover:bg-[#f5f0c9]">Warning only</button>
                      <button disabled={busyId === event.id} onClick={() => void runAction({ action: "message_moderation_status", targetId: event.id, status: "under_review", successText: "Account placed under review." })} className="rounded-full bg-[#f5f0c9] px-4 py-2 text-xs font-bold text-[#78681f]">Account review</button>
                      <button disabled={busyId === event.id} onClick={() => void runAction({ action: "message_moderation_status", targetId: event.id, status: "suspended", needsReason: true, confirmText: "Suspend this account and sign it out everywhere?", successText: "Account suspended." })} className="rounded-full bg-[#9a4e25] px-4 py-2 text-xs font-bold text-white">Suspend</button>
                      <button disabled={busyId === event.id} onClick={() => void runAction({ action: "message_moderation_status", targetId: event.id, status: "banned", needsReason: true, confirmText: "Permanently ban this account after reviewing the evidence?", successText: "Account banned." })} className="rounded-full bg-[#521f1f] px-4 py-2 text-xs font-bold text-white">Ban</button>
                      <button disabled={busyId === event.id} onClick={() => void runAction({ action: "message_moderation_status", targetId: event.id, status: "resolved", confirmText: "Resolve this moderation event?", successText: "Moderation event resolved." })} className="rounded-full bg-[#34704a] px-4 py-2 text-xs font-bold text-white">Resolve</button>
                    </div>
                  </div>
                </article>)}</div>
                {filteredMessageModeration.length === 0 && <EmptyState title="No matching message reviews" body="Try another risk or status filter." />}
              </section>
              <section className="overflow-hidden rounded-[1.7rem] border border-[#183126]/10 bg-white" aria-labelledby="general-safety-title">
                <div className="border-b border-[#183126]/10 p-6"><h2 id="general-safety-title" className="text-xl font-bold">Other Safety Bot activity</h2><p className="mt-1 text-sm text-[#718078]">Privacy-safe fingerprints for other blocked marketplace content.</p></div>
                <div className="divide-y divide-[#183126]/10">{data.events.map((event) => <div key={event.id} className="grid gap-3 p-5 sm:grid-cols-[1.2fr_1fr_auto] sm:items-center"><div><p className="font-bold">{event.user_name}</p><p className="text-sm text-[#718078]">{event.user_email}</p></div><div><p className="text-sm font-bold">{label(event.category)} · {label(event.surface)}</p><p className="mt-1 text-xs text-[#718078]">{formatDate(event.created_at)}</p></div><StatusPill value={event.severity} /></div>)}</div>
                {data.events.length === 0 && <EmptyState title="No other blocked content" body="Other Safety Bot activity will appear here when content is stopped." />}
              </section>
            </div>
          )}

          {data && section === "accounts" && (
            <div className="space-y-4">
              {accountScope === "active_providers" && <div role="status" className="flex flex-col gap-3 rounded-[1.7rem] border border-[#34704a]/20 bg-[#e9f3e7] p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-bold text-[#285b3b]">Showing active providers only</p><p className="mt-1 text-sm text-[#52665b]">Inactive providers, customers, administrators, and other accounts are hidden from this view.</p></div><button type="button" onClick={() => setAccountScope("all")} className="min-h-11 shrink-0 rounded-full bg-white px-5 py-2.5 text-sm font-bold text-[#183126] transition hover:bg-[#eee25a]">Show all accounts</button></div>}
              <div className="rounded-[1.7rem] border border-[#183126]/10 bg-white p-5">
                <label htmlFor="admin-account-search" className="text-sm font-bold">Search accounts</label>
                <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="relative flex-1">
                    <span aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-lg">⌕</span>
                    <input
                      id="admin-account-search"
                      type="search"
                      value={accountSearch}
                      onChange={(event) => setAccountSearch(event.target.value)}
                      placeholder="Search by name, email, account ID, role, account type, or business"
                      autoComplete="off"
                      className="w-full rounded-2xl border border-[#183126]/15 bg-[#fafaf6] py-3 pl-11 pr-4 text-sm outline-none transition placeholder:text-[#8a9690] focus:border-[#4d725d] focus:ring-2 focus:ring-[#4d725d]/20"
                    />
                  </div>
                  <p className="shrink-0 text-xs font-semibold text-[#718078]" aria-live="polite">
                    {accountScope === "active_providers" ? `${filteredAccounts.length} active provider${filteredAccounts.length === 1 ? "" : "s"}` : normalizedAccountSearch ? `${filteredAccounts.length} of ${data.accounts.length} accounts` : `${data.accounts.length} accounts`}
                  </p>
                </div>
              </div>
              {filteredAccounts.map((account) => (
                <article key={account.id} className="rounded-[1.7rem] border border-[#183126]/10 bg-white p-5">
                  <div className="grid gap-4 2xl:grid-cols-[minmax(20rem,1fr)_minmax(0,2fr)] 2xl:items-center">
                    <button type="button" onClick={() => void openAccount(account)} className="group -m-2 flex min-w-0 items-start gap-4 rounded-2xl p-2 text-left transition hover:bg-[#f4f6f1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#34704a] sm:items-center" aria-label={`View ${account.name}'s account details`}>
                      <ProfileAvatar name={account.name} imageUrl={account.image} className="h-12 w-12 shrink-0 text-sm" />
                      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="font-bold group-hover:underline">{account.name}</h2><StatusPill value={account.restriction_status ?? "active"} /><span className="rounded-full bg-[#f0f1eb] px-2.5 py-1 text-[10px] font-bold uppercase">{account.role}</span>{account.provider_id && account.role !== "provider" && <span className="rounded-full bg-[#e5f1e5] px-2.5 py-1 text-[10px] font-extrabold uppercase text-[#34704a]">Provider</span>}{account.is_partner && <span className="rounded-full bg-[#e8effa] px-2.5 py-1 text-[10px] font-extrabold uppercase text-[#315a8c]">Partner</span>}{account.provider_effective_plan && <span className="rounded-full bg-[#fff3c4] px-2.5 py-1 text-[10px] font-extrabold uppercase text-[#775f00]">{PLAN_ENTITLEMENTS[account.provider_effective_plan].name}</span>}{account.provider_over_listing_limit && <span className="rounded-full bg-[#fde3d6] px-2.5 py-1 text-[10px] font-extrabold uppercase text-[#8d3d20]">Listing limit review</span>}</div><p className="mt-1 break-words text-sm text-[#718078] [overflow-wrap:anywhere]">{account.email}</p><p className="mt-1 text-xs text-[#8a9690]">Joined {formatDate(account.created_at)}{account.business_name ? " · " + account.business_name : ""}</p>{account.provider_id && account.provider_current_listing_count !== null && <p className="mt-1 text-xs font-semibold text-[#718078]">Current services: {account.provider_current_listing_count}{account.provider_listing_limit !== null ? ` of ${account.provider_listing_limit}` : ""}</p>}{account.restriction_reason && <p className="mt-2 text-xs font-semibold text-[#9a4e25]">Reason: {account.restriction_reason}</p>}<span className="mt-2 inline-block text-xs font-bold text-[#34704a]">View account →</span></div>
                    </button>
                    <div className="admin-action-row flex flex-wrap gap-2 2xl:justify-end">
                      <button disabled={busyId === account.id} onClick={() => void runAction({ action: "warn_account", targetId: account.id, needsReason: true, successText: "Warning sent to the account." })} className="rounded-full border border-[#183126]/15 px-4 py-2 text-xs font-bold transition hover:bg-[#eee25a]">Warn</button>
                      {account.restriction_status ? <button disabled={busyId === account.id} onClick={() => void runAction({ action: "account_status", targetId: account.id, status: "active", confirmText: "Restore this account and allow it to sign in?", successText: "Account restored." })} className="rounded-full bg-[#34704a] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#285b3b]">Restore</button> : <>
                        <button disabled={busyId === account.id} onClick={() => void runAction({ action: "account_status", targetId: account.id, status: "suspended", needsReason: true, confirmText: "Suspend this account and sign it out everywhere?", successText: "Account suspended and signed out." })} className="rounded-full bg-[#9a4e25] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#7b3c1b]">Suspend</button>
                        <button disabled={busyId === account.id} onClick={() => void runAction({ action: "account_status", targetId: account.id, status: "banned", needsReason: true, confirmText: "Permanently ban this account and sign it out everywhere?", successText: "Account banned and signed out." })} className="rounded-full bg-[#521f1f] px-4 py-2 text-xs font-bold text-white transition hover:bg-black">Ban</button>
                      </>}
                      {account.provider_id && <button disabled={busyId === account.provider_id} onClick={() => void runAction({ action: "provider_status", targetId: account.provider_id!, status: account.provider_active ? "inactive" : "active", confirmText: account.provider_active ? "Pause this provider and hide all of their services?" : "Restore this provider profile?", successText: account.provider_active ? "Provider profile paused." : "Provider profile restored." })} className="rounded-full px-4 py-2 text-xs font-bold transition hover:bg-[#e5eddf]">{account.provider_active ? "Pause provider" : "Restore provider"}</button>}
                      {account.provider_id && <><span className={`rounded-full px-4 py-2 text-xs font-bold ${account.phone_verified ? "bg-[#e5f1e5] text-[#34704a]" : "bg-[#f0f1eb] text-[#718078]"}`}>{account.phone_verified ? "✓ Phone details" : "○ Phone details"}</span><span className={`rounded-full px-4 py-2 text-xs font-bold ${account.identity_verified ? "bg-[#e5f1e5] text-[#34704a]" : "bg-[#f0f1eb] text-[#718078]"}`}>{account.identity_verified ? "✓ Stripe identity" : "○ Stripe identity"}</span><span className={`rounded-full px-4 py-2 text-xs font-bold ${account.business_verified ? "bg-[#e5f1e5] text-[#34704a]" : "bg-[#f0f1eb] text-[#718078]"}`}>{account.business_verified ? "✓ Business profile" : "○ Business profile"}</span></>}
                    </div>
                  </div>
                </article>
              ))}
              {filteredAccounts.length === 0 && <EmptyState title={accountScope === "active_providers" ? "No matching active providers" : "No matching accounts"} body={accountScope === "active_providers" ? "No active providers match this search. Clear the search or show all accounts." : "Try searching with a different name, email, account ID, role, account type, or business."} />}
            </div>
          )}

          {data && section === "listings" && (
            <div className="space-y-4">
              <div className="flex flex-col justify-between gap-3 rounded-[1.7rem] border border-[#183126]/10 bg-white p-5 sm:flex-row sm:items-center"><div><h2 className="font-bold">Filter listings by delivery</h2><p className="mt-1 text-xs text-[#718078]">Review local, remote, or dual-delivery services.</p></div><label className="text-xs font-bold">Delivery type<CustomSelect ariaLabel="Filter listings by delivery type" value={listingDeliveryFilter} onChange={(value) => setListingDeliveryFilter(value as typeof listingDeliveryFilter)} buttonClassName="ml-3 min-h-11 rounded-xl border border-[#183126]/15 bg-[#fafaf6] px-3 text-sm"><option value="ALL">All</option><option value="IN_PERSON">In person</option><option value="REMOTE">Remote</option><option value="BOTH">Both</option></CustomSelect></label></div>
              <div className="grid gap-4 xl:grid-cols-2">
              {filteredListings.map((listing) => {
                const canRestore = listing.provider_is_active && listing.company_is_active && listing.age_verification_status === "verified";
                const publicStatus = listing.publicly_available ? "active" : listing.age_verification_status !== "verified" ? "verification required" : "inactive";
                const inactiveReasons = [
                  listing.age_verification_status !== "verified" ? "Provider must complete required age verification." : "",
                  !listing.provider_is_active ? "Provider profile is paused." : "",
                  !listing.company_is_active ? "Provider company page is inactive." : "",
                  !listing.is_active && !listing.age_verification_blocked ? "Service listing is inactive." : "",
                ].filter(Boolean);
                const payoutStatus = !listing.stripe_connected ? "Not connected" : listing.stripe_payouts_enabled ? "Payout ready" : "Setup incomplete or under review";
                const availabilityNotice = inactiveReasons[0] ? `Not public: ${inactiveReasons[0]}` : "Listing can be restored.";
return <article key={listing.id} className="rounded-[1.7rem] border border-[#183126]/10 bg-white p-6"><div className="flex h-full flex-col"><div className="flex flex-wrap items-center gap-2"><StatusPill value={publicStatus} /><StatusPill value={listing.delivery_type === "REMOTE" ? "remote" : listing.delivery_type === "BOTH" ? "remote or in person" : "in person"} /><span className="text-xs font-bold uppercase tracking-wider text-[#718078]">{listing.category}</span></div><h2 className="mt-3 text-xl font-bold">{listing.title}</h2><p className="mt-1 text-sm text-[#718078]">{listing.business_name} · {listing.delivery_type === "REMOTE" ? "Available online" : `${listing.city}, ${listing.state}`} · {listing.pricing_type === "QUOTE_ONLY" ? "Custom Quote" : listing.pricing_type === "HOURLY" && listing.hourly_rate_cents !== null ? `${formatHourlyRate(listing.hourly_rate_cents)} · ${formatDurationMinutes(listing.minimum_duration_minutes ?? 60)} minimum` : "$" + (listing.price_cents / 100).toFixed(0)}</p><p className="mt-2 line-clamp-2 text-sm leading-6 text-[#64756c]">{listing.description}</p><p className="mt-2 text-xs text-[#8a9690]">Added {formatDate(listing.created_at)} · Status updated {formatDate(listing.last_status_update)}</p>{!listing.publicly_available && <ul className="mt-3 list-disc space-y-1 pl-5 text-xs font-semibold text-[#9a4e25]">{inactiveReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}<dl className="mt-4 grid gap-2 rounded-2xl bg-[#f5f5ef] p-4 text-xs sm:grid-cols-3"><div><dt className="font-bold uppercase tracking-wide text-[#718078]">Age verification</dt><dd className="mt-1 font-semibold">{label(listing.age_verification_status)}</dd></div><div><dt className="font-bold uppercase tracking-wide text-[#718078]">Stripe payouts, last known</dt><dd className="mt-1 font-semibold">{payoutStatus}</dd></div><div><dt className="font-bold uppercase tracking-wide text-[#718078]">Safety review</dt><dd className="mt-1 font-semibold">{label(listing.safety_review_status)}{listing.safety_reviewed_at ? ` · ${formatDate(listing.safety_reviewed_at)}` : ""}</dd></div></dl><p className="mt-2 text-[11px] text-[#718078]">Stripe payout setup does not control listing publication.</p><div className="admin-action-row mt-5 flex flex-wrap gap-2"><Link href={`/admin/listings/${listing.id}`} className="rounded-full border border-[#183126]/15 px-4 py-2 text-xs font-bold transition hover:bg-[#e5eddf]">View listing</Link><button disabled={busyId === listing.id} onClick={() => void runAction({ action: "listing_safety_scan", targetId: listing.id, successText: "Safety review completed." })} className="rounded-full bg-[#eee25a] px-4 py-2 text-xs font-bold transition hover:bg-[#e1d43d] disabled:opacity-50">{busyId === listing.id ? "Checking…" : "Run safety check"}</button><button disabled={busyId === listing.id || (!listing.is_active && !canRestore)} title={!listing.is_active && !canRestore ? availabilityNotice : undefined} onClick={() => void runAction({ action: "listing_status", targetId: listing.id, status: listing.is_active ? "inactive" : "active", confirmText: listing.is_active ? "Remove this listing from the marketplace?" : "Restore this listing to the marketplace?", successText: listing.is_active ? "Listing removed." : "Listing restored." })} className={"rounded-full px-4 py-2 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-50 " + (listing.is_active ? "bg-[#fff0e7] text-[#9a4e25] hover:bg-[#f8d9ca]" : "bg-[#34704a] text-white hover:bg-[#285b3b]")}>{listing.is_active ? "Remove" : canRestore ? "Restore" : "Verification required"}</button><button type="button" disabled={busyId === listing.id} onClick={() => void runAction({ action: "listing_delete", targetId: listing.id, needsReason: true, confirmText: `Delete “${listing.title}” from provider and admin listing dashboards?`, successText: "Listing deleted." })} className="rounded-full border border-[#9a4e25]/30 bg-white px-4 py-2 text-xs font-bold text-[#8a4628] transition hover:bg-[#fff0e7] disabled:opacity-50">Delete listing</button></div></div></article>;
              })}
              {filteredListings.length === 0 && <EmptyState title="No matching listings" body="No listings use this delivery type yet." />}
              </div>
            </div>
          )}

          {data && section === "reviews" && (
            <div className="grid gap-4 xl:grid-cols-2">
              {data.reviews.map((review) => <article key={review.id} className="rounded-[1.7rem] border border-[#183126]/10 bg-white p-6"><div className="flex flex-col items-start gap-4 sm:flex-row sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><StatusPill value={review.is_hidden ? "hidden" : "active"} /><span className="text-[#d0a51d]">{"★".repeat(review.rating)}<span className="text-[#d8ddd9]">{"★".repeat(5 - review.rating)}</span></span></div><h2 className="mt-3 font-bold">{review.customer_name}</h2><p className="mt-1 text-xs text-[#718078]">{review.customer_email} · {review.service_title}</p><p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-[#52665b]">{review.body || "No written comment."}</p><p className="mt-3 text-xs text-[#8a9690]">{review.business_name} · {formatDate(review.created_at)}</p></div><button disabled={busyId === review.id} onClick={() => void runAction({ action: "review_status", targetId: review.id, status: review.is_hidden ? "visible" : "hidden", confirmText: review.is_hidden ? "Restore this review?" : "Hide this review from BubsBookings?", successText: review.is_hidden ? "Review restored." : "Review hidden." })} className={"min-h-11 w-full shrink-0 rounded-full px-4 py-2 text-xs font-bold transition sm:w-auto " + (review.is_hidden ? "bg-[#34704a] text-white hover:bg-[#285b3b]" : "bg-[#fff0e7] text-[#9a4e25] hover:bg-[#f8d9ca]")}>{review.is_hidden ? "Restore" : "Hide"}</button></div></article>)}
              {data.reviews.length === 0 && <EmptyState title="No reviews yet" body="Verified customer reviews will appear here." />}
            </div>
          )}

          {data && section === "payouts" && (
            <div className="space-y-4">
              {data.payouts.map((payout) => {
                const canFreeze = ["secured", "awaiting_customer", "failed"].includes(payout.payment_release_status);
                const frozen = payout.payment_release_status === "frozen";
                return <article key={payout.id} className="rounded-[1.7rem] border border-[#183126]/10 bg-white p-6"><div className="flex flex-col gap-4 xl:flex-row xl:items-center"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><StatusPill value={payout.payment_release_status} /><span className="text-xs font-bold uppercase tracking-wider text-[#718078]">${(payout.provider_payout_cents / 100).toFixed(2)} provider share</span></div><h2 className="mt-3 text-xl font-bold">{payout.service_title}</h2><p className="mt-1 text-sm text-[#718078]">{payout.customer_name} → {payout.provider_name}</p>{payout.completion_confirmation_due_at && payout.payment_release_status === "awaiting_customer" && <p className="mt-2 text-xs font-semibold text-[#78681f]">Automatic release after {formatDate(payout.completion_confirmation_due_at)}</p>}{payout.payout_freeze_reason && <p className="mt-2 text-xs font-semibold text-[#9a4e25]">Hold reason: {payout.payout_freeze_reason}</p>}{payout.payout_failure_reason && <p className="mt-2 text-xs font-semibold text-[#9a4e25]">Stripe error: {payout.payout_failure_reason}</p>}</div><div className="admin-action-row flex flex-wrap gap-2"><Link href={`/provider/dashboard/bookings/${payout.id}`} className="rounded-full border border-[#183126]/15 px-4 py-2 text-xs font-bold transition hover:bg-[#e5eddf]">View booking</Link>{payout.payment_release_status === "failed" && <button disabled={busyId === payout.id} onClick={() => void runAction({ action: "payout_retry", targetId: payout.id, confirmText: "Retry this failed Stripe payout now?", successText: "Payout released." })} className="rounded-full bg-[#183126] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#315846]">Retry payout</button>}{canFreeze && <button disabled={busyId === payout.id} onClick={() => void runAction({ action: "payout_freeze", targetId: payout.id, status: "frozen", needsReason: true, confirmText: "Freeze this payout while the booking is reviewed?", successText: "Payout frozen." })} className="rounded-full bg-[#9a4e25] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#7b3c1b]">Freeze payout</button>}{frozen && <button disabled={busyId === payout.id} onClick={() => void runAction({ action: "payout_freeze", targetId: payout.id, status: "active", confirmText: "Remove this payout hold? The payout can release automatically if its confirmation window has ended.", successText: "Payout hold removed." })} className="rounded-full bg-[#34704a] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#285b3b]">Remove hold</button>}</div></div></article>;
              })}
              <details open={data.tips.some((tip) => tip.risk_status === "review" || tip.payment_status === "disputed")} className="rounded-[1.7rem] border border-[#183126]/10 bg-white p-6">
                <summary className="cursor-pointer font-bold">Customer tips <span className="text-sm font-normal text-[#718078]">({data.tips.length}) · separate from service payouts and marketplace fees</span></summary>
                <div className="mt-5 space-y-3">
                  {data.tips.map((tip) => {
                    const remainingRefundCents = Math.max(0, tip.amount_cents - tip.refunded_amount_cents);
                    const mayRefund = ["paid", "partially_refunded"].includes(tip.payment_status) && remainingRefundCents > 0;
                    const needsRelease = tip.risk_status === "review" && tip.payment_status === "paid" && ["not_ready", "failed"].includes(tip.transfer_status);
                    return <article key={tip.id} className="rounded-2xl bg-[#f5f6f1] p-4"><div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><StatusPill value={tip.payment_status} /><StatusPill value={tip.transfer_status} />{tip.risk_status === "review" && <StatusPill value="review" />}<span className="text-xs font-bold uppercase tracking-wider text-[#718078]">${(tip.amount_cents / 100).toFixed(2)} {tip.tip_type === "percentage" ? `(${tip.percentage}%)` : "custom"} tip</span></div><h3 className="mt-3 font-bold">{tip.service_title}</h3><p className="mt-1 text-sm text-[#718078]">{tip.customer_name} → {tip.provider_name}</p>{tip.refunded_amount_cents > 0 && <p className="mt-2 text-xs font-semibold text-[#9a4e25]">Refunded: ${(tip.refunded_amount_cents / 100).toFixed(2)}</p>}{tip.failure_reason && <p className="mt-2 text-xs font-semibold text-[#9a4e25]">Payment: {tip.failure_reason}</p>}{tip.transfer_failure_reason && <p className="mt-2 text-xs font-semibold text-[#9a4e25]">Transfer: {tip.transfer_failure_reason}</p>}{tip.stripe_dispute_id && <p className="mt-2 text-xs font-semibold text-[#9a4e25]">Stripe dispute: {tip.stripe_dispute_status || "open"}</p>}</div><div className="admin-action-row flex shrink-0 flex-wrap gap-2"><Link href={`/provider/dashboard/bookings/${tip.booking_id}`} className="rounded-full border border-[#183126]/15 px-4 py-2 text-xs font-bold transition hover:bg-[#e5eddf]">View booking</Link>{needsRelease && <button disabled={busyId === tip.id} onClick={() => void runAction({ action: "tip_release", targetId: tip.id, confirmText: "Release this reviewed tip to the provider's Stripe balance?", successText: "Tip released." })} className="rounded-full bg-[#183126] px-4 py-2 text-xs font-bold text-white">Release tip</button>}{mayRefund && <button disabled={busyId === tip.id} onClick={() => void runAction({ action: "tip_refund", targetId: tip.id, needsAmount: true, maximumAmountCents: remainingRefundCents, confirmText: "Refund part or all of this tip to the customer's original payment method?", successText: "Tip refund completed." })} className="rounded-full bg-[#9a4e25] px-4 py-2 text-xs font-bold text-white">Refund tip</button>}</div></div><div className="mt-3 break-all font-mono text-[10px] text-[#718078]"><p>PaymentIntent: {tip.stripe_payment_intent_id || "Not available"} · Charge: {tip.stripe_charge_id || "Not available"}</p><p>Transfer: {tip.stripe_transfer_id || "Not available"} · Refund: {tip.stripe_refund_id || "Not available"} · Tip {tip.id}</p></div></article>;
                  })}
                  {data.tips.length === 0 && <p className="text-sm text-[#718078]">Customer tips will appear here after a completed booking.</p>}
                </div>
              </details>
              {data.payouts.length > 0 && <details className="rounded-[1.7rem] border border-[#183126]/10 bg-white p-6"><summary className="cursor-pointer font-bold">Financial reconciliation details</summary><div className="mt-5 space-y-4">{data.payouts.map((payout) => <div key={`financial-${payout.id}`} className="rounded-2xl bg-[#f5f6f1] p-4"><div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4"><span>Service <strong>${(payout.price_cents / 100).toFixed(2)}</strong></span><span>Customer fee <strong>${(payout.customer_service_fee_cents / 100).toFixed(2)}</strong></span><span>Platform fee <strong>${(payout.platform_fee_cents / 100).toFixed(2)}</strong></span><span>Provider share <strong>${(payout.provider_payout_cents / 100).toFixed(2)}</strong></span></div><p className="mt-3 text-xs font-bold">{payout.service_title} · Booking {payout.id}</p><div className="mt-2 space-y-1 break-all font-mono text-[10px] text-[#718078]"><p>PaymentIntent: {payout.stripe_payment_intent_id || "Not available"}</p><p>Charge: {payout.stripe_charge_id || "Not available"}</p><p>Transfer: {payout.stripe_transfer_id || "Not available"}</p><p>Refund: {payout.stripe_refund_id || "Not available"}</p></div></div>)}</div></details>}
              {data.payouts.length === 0 && <EmptyState title="No held payments" body="Paid bookings and payout controls will appear here." />}
            </div>
          )}

          {data && section === "audit" && (
            <div className="overflow-hidden rounded-[1.7rem] border border-[#183126]/10 bg-white">
              <div className="border-b border-[#183126]/10 p-6"><h2 className="text-xl font-bold">Permanent action history</h2><p className="mt-1 text-sm text-[#718078]">A record of marketplace decisions for accountability.</p></div>
              <div className="divide-y divide-[#183126]/10">{data.audit.map((entry) => <div key={entry.id} className="grid gap-2 p-5 sm:grid-cols-[1fr_1fr_auto] sm:items-center"><div><p className="font-bold">{label(entry.action)}</p><p className="mt-1 text-sm text-[#718078]">by {entry.actor_name}</p></div><div><p className="text-sm font-semibold">{label(entry.target_type)}</p><p className="mt-1 max-w-xs truncate text-xs text-[#8a9690]">{entry.target_id}</p></div><time className="text-xs font-semibold text-[#718078]">{formatDate(entry.created_at)}</time></div>)}</div>
              {data.audit.length === 0 && <EmptyState title="No admin actions yet" body="Warnings, account restrictions, and review decisions will be recorded here." />}
            </div>
          )}
        </section>
      </div>
      {selectedStat && <AdminStatDialog stat={selectedStat} onClose={() => setSelectedStatId(null)} onOpenSection={(nextSection) => { setSelectedStatId(null); selectSection(nextSection, selectedStat.id === "providers" ? "active_providers" : "all"); }} />}
      {selectedAccount && <AccountDetailDialog account={selectedAccount} details={accountDetails} loading={accountDetailsLoading} error={accountDetailsError} onClose={closeAccount} onRetry={() => openAccount(selectedAccount)} onDashboardRefresh={load} />}
      {pendingAction && <div className="fixed inset-0 z-[100] grid place-items-center bg-[#10251c]/55 p-3 sm:p-5" role="dialog" aria-modal="true" aria-labelledby="admin-confirm-title"><div className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto rounded-[2rem] bg-white p-6 shadow-2xl sm:max-h-[calc(100dvh-2.5rem)] sm:p-8"><p className="text-xs font-bold uppercase tracking-[.14em] text-[#718078]">Confirm admin action</p><h2 id="admin-confirm-title" className="mt-2 text-2xl font-bold">Are you sure?</h2><p className="mt-3 text-sm leading-6 text-[#687970]">{pendingAction.confirmText}</p><p className="mt-4 rounded-2xl bg-[#f5f5ef] p-4 text-xs leading-5 text-[#718078]">This change is recorded in the permanent admin audit history.</p><div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" disabled={Boolean(busyId)} onClick={() => setPendingAction(null)} className="min-h-11 rounded-full px-5 py-3 text-sm font-bold transition hover:bg-[#edf1ec]">Cancel</button><button type="button" disabled={Boolean(busyId)} onClick={() => void executeAction({ ...pendingAction, confirmText: undefined })} className="min-h-11 rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#315846] disabled:opacity-50">{busyId ? "Saving…" : pendingAction.status === "active" || pendingAction.status === "visible" ? "Restore" : "Confirm"}</button></div></div></div>}
    </main>
  );
}

function AdminStatDialog({ stat, onClose, onOpenSection }: { stat: AdminStatCard; onClose: () => void; onOpenSection: (section: AdminSection) => void }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  const dialog = <div className="fixed inset-0 z-[650] grid place-items-center overflow-y-auto bg-[#10251c]/55 p-3 sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
    <section role="dialog" aria-modal="true" aria-labelledby="admin-stat-detail-title" className="max-h-[calc(100dvh-1.5rem)] w-full max-w-xl overflow-y-auto rounded-[2rem] bg-white shadow-2xl sm:max-h-[calc(100dvh-3rem)]">
      <header className="sticky top-0 flex items-start justify-between gap-4 border-b border-[#183126]/10 bg-white/95 px-5 py-5 backdrop-blur sm:px-7">
        <div><p className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#718078]">Overview metric</p><h2 id="admin-stat-detail-title" className="mt-1 text-2xl font-bold">{stat.label}</h2></div>
        <button type="button" onClick={onClose} className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-[#183126]/20 text-xl transition hover:bg-[#edf1ec]" aria-label="Close metric details">×</button>
      </header>
      <div className="p-5 sm:p-7">
        <div className="rounded-3xl bg-[#183126] p-6 text-white"><p className="text-5xl font-bold tracking-tight">{stat.value}</p><p className="mt-2 text-sm text-[#c5d3cc]">{stat.detail}</p></div>
        <p className="mt-6 text-base leading-7 text-[#43574d]">{stat.description}</p>
        <dl className="mt-6 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl bg-[#f4f4ef] p-4"><dt className="text-[10px] font-extrabold uppercase tracking-wider text-[#718078]">Time range</dt><dd className="mt-2 text-sm font-bold">{stat.timeRange}</dd></div>
          <div className="rounded-2xl bg-[#f4f4ef] p-4"><dt className="text-[10px] font-extrabold uppercase tracking-wider text-[#718078]">How it is counted</dt><dd className="mt-2 text-sm font-bold">{stat.basis}</dd></div>
        </dl>
        <div className="mt-7 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} className="min-h-11 rounded-full px-5 py-3 text-sm font-bold transition hover:bg-[#edf1ec]">Close</button>
          {stat.destinationSection && <button type="button" onClick={() => onOpenSection(stat.destinationSection!)} className="min-h-11 rounded-full bg-[#eee25a] px-5 py-3 text-sm font-bold text-[#183126] transition hover:bg-[#dfd23d]">{stat.destinationLabel}</button>}
          {stat.destinationHref && <Link href={stat.destinationHref} className="inline-flex min-h-11 items-center justify-center rounded-full bg-[#eee25a] px-5 py-3 text-sm font-bold text-[#183126] transition hover:bg-[#dfd23d]">{stat.destinationLabel}</Link>}
        </div>
      </div>
    </section>
  </div>;

  return typeof document === "undefined" ? null : createPortal(dialog, document.body);
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="col-span-full p-10 text-center"><p className="text-3xl">✓</p><h3 className="mt-3 text-lg font-bold">{title}</h3><p className="mt-2 text-sm text-[#718078]">{body}</p></div>;
}

function show(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined || value === "") return "Not provided";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function DetailGrid({ items }: { items: Array<{ label: string; value: string | number | boolean | null | undefined }> }) {
  return <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{items.map((item) => <div key={item.label} className="rounded-2xl border border-[#183126]/10 bg-[#f8f8f4] p-4"><dt className="text-[10px] font-extrabold uppercase tracking-[.12em] text-[#718078]">{item.label}</dt><dd className="mt-1 break-words text-sm font-semibold [overflow-wrap:anywhere]">{show(item.value)}</dd></div>)}</dl>;
}

function StripeConnectionSummary({ consumerStripe, provider }: {
  consumerStripe: AccountDetails["consumerStripe"];
  provider: AccountDetails["provider"];
}) {
  const providerConnected = Boolean(provider?.stripe_connected);
  const ready = Boolean(providerConnected && provider?.stripe_charges_enabled && provider?.stripe_payouts_enabled);
  const providerTitle = ready ? "Connected and ready" : providerConnected ? "Setup incomplete" : "Not connected";
  const providerDescription = ready
    ? "Stripe onboarding is complete. This provider can accept payments and receive payouts."
    : providerConnected
      ? "A Stripe account exists, but the provider still needs to finish Stripe onboarding before payments and payouts are fully enabled."
      : "This provider has not connected a Stripe payout account yet.";
  const providerTone = ready
    ? "border-[#34704a]/30 bg-[#e7f3e7] text-[#245c38]"
    : providerConnected
      ? "border-[#a66a1f]/30 bg-[#fff6dc] text-[#7a5711]"
      : "border-[#9a4e25]/25 bg-[#fff0e7] text-[#7b3c1b]";

  return <section className="rounded-3xl border border-[#183126]/15 bg-[#f8f8f4] p-5" aria-label="Stripe account status">
    <div><p className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#718078]">Stripe status</p><h3 className="mt-1 text-lg font-bold">Payment and payout accounts</h3></div>
    <div className={`mt-4 grid gap-4 ${provider ? "lg:grid-cols-2" : ""}`}>
      <div className={`rounded-2xl border p-4 ${consumerStripe.connected ? "border-[#34704a]/30 bg-[#e7f3e7] text-[#245c38]" : "border-[#183126]/15 bg-white text-[#52665b]"}`}>
        <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-[10px] font-extrabold uppercase tracking-[.12em] opacity-75">Consumer payments</p><h4 className="mt-1 font-bold">{consumerStripe.connected ? "Stripe profile connected" : "No Stripe profile yet"}</h4></div><span className="rounded-full border border-current/20 bg-white/70 px-3 py-1 text-xs font-bold">{consumerStripe.connected ? "Connected" : "Not connected"}</span></div>
        <p className="mt-2 text-sm leading-6 opacity-90">{consumerStripe.connected ? "A Stripe Customer profile exists for this person, allowing secure customer payments. Card details remain private in Stripe." : "Stripe will create a Customer profile when this person first uses a payment feature."}</p>
        {consumerStripe.mode && <span className="mt-3 inline-flex rounded-full bg-white/70 px-3 py-1 text-xs font-bold">{consumerStripe.mode === "live" ? "Live payments" : "Test data"}</span>}
      </div>
      {provider && <div className={`rounded-2xl border p-4 ${providerTone}`}>
        <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-[10px] font-extrabold uppercase tracking-[.12em] opacity-75">Provider payouts</p><h4 className="mt-1 font-bold">{providerTitle}</h4></div><span className="rounded-full border border-current/20 bg-white/70 px-3 py-1 text-xs font-bold">{ready ? "Ready" : "Action needed"}</span></div>
        <p className="mt-2 text-sm leading-6 opacity-90">{providerDescription}</p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold"><span className="rounded-full bg-white/70 px-3 py-1">Account: {providerConnected ? "Connected" : "Not connected"}</span><span className="rounded-full bg-white/70 px-3 py-1">Charges: {provider.stripe_charges_enabled ? "Enabled" : "Disabled"}</span><span className="rounded-full bg-white/70 px-3 py-1">Payouts: {provider.stripe_payouts_enabled ? "Enabled" : "Disabled"}</span></div>
      </div>}
    </div>
  </section>;
}

function AccountDetailDialog({ account, details, loading, error, onClose, onRetry, onDashboardRefresh }: {
  account: Account; details: AccountDetails | null; loading: boolean; error: string; onClose: () => void; onRetry: () => Promise<void>; onDashboardRefresh: () => Promise<void>;
}) {
  const [welcomeBusy, setWelcomeBusy] = useState(false);
  const [welcomeResult, setWelcomeResult] = useState("");
  const [providerWelcomeBusy, setProviderWelcomeBusy] = useState(false);
  const [providerWelcomeResult, setProviderWelcomeResult] = useState("");
  const [ageExceptionBusy, setAgeExceptionBusy] = useState(false);
  const [ageExceptionResult, setAgeExceptionResult] = useState("");
  const [ageExceptionAction, setAgeExceptionAction] = useState<"revoke" | null>(null);
  const [ageExceptionNote, setAgeExceptionNote] = useState("");
  const [ageExceptionError, setAgeExceptionError] = useState(false);
  const welcomeSent = details?.welcomeEmail?.status === "sent" || welcomeResult === "Welcome email sent.";

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  async function sendWelcomeEmail() {
    setWelcomeBusy(true);
    setWelcomeResult("");
    const response = await fetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { method: "POST" }).catch(() => null);
    const result = response ? await response.json() as { error?: string; message?: string } : null;
    setWelcomeResult(response?.ok ? result?.message ?? "Welcome email sent." : result?.error ?? "The welcome email could not be sent.");
    setWelcomeBusy(false);
  }
  async function retryProviderWelcome() {
    if (!window.confirm("Send this provider welcome email now? This action is recorded in the admin audit history.")) return;
    setProviderWelcomeBusy(true);
    setProviderWelcomeResult("");
    const response = await fetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry_provider_welcome" }),
    }).catch(() => null);
    const result = response ? await response.json() as { error?: string; message?: string } : null;
    setProviderWelcomeResult(response?.ok ? result?.message ?? "Provider welcome email sent." : result?.error ?? "The provider welcome email could not be sent.");
    if (response?.ok) await onRetry();
    setProviderWelcomeBusy(false);
  }
  async function moderatePortfolio(id: string, status: "active" | "hidden") {
    const response = await fetch("/api/admin", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "portfolio_status", targetId: id, status }) });
    if (response.ok) onRetry();
  }
  function beginAgeException() {
    setAgeExceptionAction("revoke");
    setAgeExceptionNote("");
    setAgeExceptionResult("");
    setAgeExceptionError(false);
  }
  async function changeAgeException() {
    if (!details?.provider) return;
    if (!ageExceptionAction) return;
    const note = ageExceptionNote.trim();
    if (!note) {
      setAgeExceptionError(true);
      setAgeExceptionResult("Add an audit note before continuing.");
      return;
    }
    setAgeExceptionBusy(true);
    setAgeExceptionResult("");
    setAgeExceptionError(false);
    const response = await fetch("/api/admin", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "provider_age_exception", targetId: details.provider.id, status: ageExceptionAction, reason: note }),
    }).catch(() => null);
    const result = response ? await response.json() as { error?: string } : null;
    if (!response?.ok) {
      setAgeExceptionError(true);
      setAgeExceptionResult(result?.error ?? "The provider exception could not be saved.");
    }
    else {
      setAgeExceptionResult("Provider age-verification exception revoked.");
      setAgeExceptionAction(null);
      setAgeExceptionNote("");
      await Promise.all([onDashboardRefresh(), onRetry()]);
    }
    setAgeExceptionBusy(false);
  }

  const dialog = <div className="fixed inset-0 z-[600] flex min-w-0 justify-end overflow-hidden bg-[#10251c]/55" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
    <section className="admin-account-dialog h-[100dvh] min-w-0 w-full max-w-4xl overflow-x-hidden overflow-y-auto overscroll-contain bg-white shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="account-detail-title">
      <header className="sticky top-0 z-10 flex min-w-0 items-start justify-between gap-3 border-b border-[#183126]/10 bg-white/95 px-4 py-4 backdrop-blur sm:gap-4 sm:px-8 sm:py-5">
        <div className="flex min-w-0 items-center gap-4"><ProfileAvatar name={account.name} imageUrl={account.image} className="h-12 w-12 shrink-0 text-sm" /><div className="min-w-0"><p className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#718078]">Admin account view</p><h2 id="account-detail-title" className="truncate text-2xl font-bold">{account.name}</h2><p className="truncate text-sm text-[#718078]">{account.email}</p></div></div>
        <button type="button" onClick={onClose} className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-[#183126]/20 text-xl transition hover:bg-[#edf1ec]" aria-label="Close account details">×</button>
      </header>
      <div className="admin-safe-content space-y-6 p-5 sm:p-8">
        {loading && <div className="grid min-h-80 place-items-center"><div className="text-center"><div className="mx-auto h-9 w-9 animate-spin rounded-full border-4 border-[#dfe8df] border-t-[#34704a]" /><p className="mt-4 text-sm font-semibold text-[#718078]">Loading permitted account information…</p></div></div>}
        {error && <div className="rounded-3xl border border-[#9a4e25]/20 bg-[#fff0e7] p-6"><h3 className="font-bold text-[#7b3c1b]">Account details unavailable</h3><p className="mt-2 text-sm text-[#9a4e25]">{error}</p><button type="button" onClick={() => void onRetry()} className="mt-4 rounded-full bg-[#183126] px-5 py-2.5 text-sm font-bold text-white">Try again</button></div>}
        {details && <>
          <div className="rounded-3xl border border-[#183126]/10 bg-[#f4f4ef] p-5"><p className="text-sm leading-6 text-[#52665b]">{details.privacyNote} Opening this view is recorded in the admin audit history.</p></div>
          <section className="flex flex-col justify-between gap-4 rounded-3xl border border-[#183126]/15 bg-[#f8f8f4] p-5 sm:flex-row sm:items-center"><div><p className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#718078]">Account welcome</p><h3 className="mt-1 text-lg font-bold">Welcome email</h3><p className="mt-1 text-sm text-[#52665b]">{welcomeSent ? `Sent${details.welcomeEmail?.created_at ? ` ${formatDate(details.welcomeEmail.created_at)}` : ""}.` : "Send the branded new-account introduction and add it to the notification inbox."}</p>{welcomeResult && <p role="status" className={`mt-2 text-sm font-bold ${welcomeResult.includes("could not") ? "text-[#9a4e25]" : "text-[#34704a]"}`}>{welcomeResult}</p>}</div><button type="button" disabled={welcomeBusy || welcomeSent} onClick={() => void sendWelcomeEmail()} className="shrink-0 rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#315846] disabled:cursor-not-allowed disabled:opacity-50">{welcomeBusy ? "Sending…" : welcomeSent ? "Welcome email sent" : "Send welcome email"}</button></section>
          {details.provider && <section className="flex flex-col justify-between gap-4 rounded-3xl border border-[#183126]/15 bg-[#f8f8f4] p-5 sm:flex-row sm:items-center"><div><p className="text-[10px] font-extrabold uppercase tracking-[.14em] text-[#718078]">Provider welcome</p><h3 className="mt-1 text-lg font-bold">Provider welcome email</h3><p className="mt-1 text-sm text-[#52665b]">Status: <strong>{label(details.providerWelcomeEmail.status)}</strong>{details.providerWelcomeEmail.delivered_at ? ` ${formatDate(details.providerWelcomeEmail.delivered_at)}` : details.providerWelcomeEmail.sent_at ? ` ${formatDate(details.providerWelcomeEmail.sent_at)}` : ""}. Attempts: {details.providerWelcomeEmail.attempt_count}.</p>{details.providerWelcomeEmail.last_error && <p className="mt-2 text-sm font-semibold text-[#9a4e25]">Last delivery error: {details.providerWelcomeEmail.last_error}</p>}{providerWelcomeResult && <p role="status" className={`mt-2 text-sm font-bold ${providerWelcomeResult.includes("could not") || providerWelcomeResult.includes("failed") ? "text-[#9a4e25]" : "text-[#34704a]"}`}>{providerWelcomeResult}</p>}</div>{!["sent", "delivered", "sending"].includes(details.providerWelcomeEmail.status) && <button type="button" disabled={providerWelcomeBusy} onClick={() => void retryProviderWelcome()} className="shrink-0 rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#315846] disabled:cursor-not-allowed disabled:opacity-50">{providerWelcomeBusy ? "Sending…" : details.providerWelcomeEmail.status === "failed" ? "Retry provider welcome" : "Send provider welcome"}</button>}</section>}
          <StripeConnectionSummary consumerStripe={details.consumerStripe} provider={details.provider} />
          <section><h3 className="mb-3 text-lg font-bold">Account and contact</h3><DetailGrid items={[
            { label: "Full name", value: details.account.name }, { label: "Email", value: details.account.email }, { label: "Phone", value: details.account.phone },
            { label: "Role", value: label(details.account.role) }, { label: "Email verified", value: details.account.email_verified }, { label: "Authenticator protection", value: details.account.two_factor_enabled },
            { label: "Account created", value: formatDate(details.account.created_at) }, { label: "Last updated", value: formatDate(details.account.updated_at) }, { label: "Account ID", value: details.account.id },
            { label: "Restriction", value: details.account.restriction_status ? label(details.account.restriction_status) : "None" }, { label: "Restriction reason", value: details.account.restriction_reason }, { label: "Restriction expires", value: details.account.restriction_expires_at ? formatDate(details.account.restriction_expires_at) : null },
          ]} /></section>
          <section><h3 className="mb-3 text-lg font-bold">Policy acknowledgements</h3><DetailGrid items={[
            { label: "Terms accepted", value: details.account.terms_accepted_at ? formatDate(details.account.terms_accepted_at) : null },
            { label: "Privacy acknowledged", value: details.account.privacy_acknowledged_at ? formatDate(details.account.privacy_acknowledged_at) : null },
            { label: "AI safety acknowledged", value: details.account.ai_safety_acknowledged_at ? formatDate(details.account.ai_safety_acknowledged_at) : null },
            { label: "Policy version", value: details.account.policy_version },
          ]} /></section>
          <section><h3 className="mb-1 text-lg font-bold">General account location</h3><p className="mb-3 text-sm text-[#718078]">Account-level location only. This is separate from provider service areas and private booking addresses.</p><DetailGrid items={[
            { label: "City", value: details.account.location_city }, { label: "State", value: details.account.location_state },
            { label: "ZIP code", value: details.account.location_postal_code }, { label: "Country", value: details.account.location_country },
            { label: "Source", value: accountLocationSourceLabel(details.account.location_source) }, { label: "Last confirmed", value: details.account.location_updated_at ? formatDate(details.account.location_updated_at) : null },
          ]} /></section>
          {details.settings && <section><h3 className="mb-3 text-lg font-bold">Preferences</h3><DetailGrid items={[
            { label: "Saved area", value: [details.settings.city, details.settings.state].filter(Boolean).join(", ") }, { label: "Search radius", value: `${details.settings.search_radius_miles} miles` },
            { label: "Time zone", value: details.settings.time_zone }, { label: "Theme", value: label(details.settings.theme) },
            { label: "Booking notifications", value: details.settings.booking_notifications }, { label: "Message notifications", value: details.settings.message_notifications },
          ]} /></section>}
          <section><h3 className="mb-3 text-lg font-bold">Marketplace history</h3><div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">{Object.entries(details.counts).map(([key, value]) => <div key={key} className="rounded-2xl bg-[#183126] p-4 text-white"><p className="text-2xl font-bold">{value}</p><p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-[#bdd0c6]">{label(key)}</p></div>)}</div></section>
          {details.provider && <details open className="rounded-3xl border border-[#183126]/10 p-5"><summary className="cursor-pointer text-lg font-bold">Provider profile, service area, and billing</summary><div className="mt-4 space-y-4"><p className="text-sm text-[#718078]">Provider business and service coverage. This does not replace the general account location above.</p><DetailGrid items={[
            { label: "Business", value: details.provider.business_name }, { label: "Provider plan", value: PLAN_ENTITLEMENTS[details.provider.plan].name }, { label: "Provider active", value: details.provider.is_active },
            { label: "Business phone", value: details.provider.phone }, { label: "Service base", value: `${details.provider.city}, ${details.provider.state}` }, { label: "Travel radius", value: details.provider.has_in_person_services ? `${details.provider.service_radius_miles} miles` : "Not used for remote-only services" },
            { label: "Phone details checked", value: details.provider.phone_verified }, { label: "Stripe identity", value: details.provider.identity_verified }, { label: "Business profile checked", value: details.provider.business_verified },
            { label: "Safety screening", value: label(details.provider.screening_status) }, { label: "Screening score", value: details.provider.screening_score }, { label: "Screening checked", value: details.provider.screening_checked_at ? formatDate(details.provider.screening_checked_at) : null },
            { label: "Stripe connected", value: details.provider.stripe_connected }, { label: "Charges enabled", value: details.provider.stripe_charges_enabled }, { label: "Payouts enabled", value: details.provider.stripe_payouts_enabled },
            { label: "Age eligibility", value: details.provider.age_verification_status === "verified" ? details.provider.age_verification_source === "admin_exception" ? "BubsBookings admin exception" : "Stripe document verified" : label(details.provider.age_verification_status) },
            { label: "Verification completed", value: details.provider.age_identity_verified_at ? formatDate(details.provider.age_identity_verified_at) : null },
            { label: "Identity environment", value: details.provider.stripe_identity_verification_mode ? `${label(details.provider.stripe_identity_verification_mode)} mode` : null },
            { label: "Verification detail", value: providerAgeVerificationFailureLabel(details.provider.age_verification_failure_code) },
            { label: "Admin exception", value: details.provider.age_verification_source === "admin_exception" ? "Active" : "Not active" }, { label: "Exception approved", value: details.provider.age_verification_exception_granted_at ? formatDate(details.provider.age_verification_exception_granted_at) : null },
            { label: "Subscription", value: label(details.provider.stripe_subscription_status) }, { label: "Current period ends", value: details.provider.stripe_current_period_end ? formatDate(details.provider.stripe_current_period_end) : null }, { label: "Live Pro trial used", value: details.provider.pro_trial_used_at_live ? formatDate(details.provider.pro_trial_used_at_live) : "No" },
            { label: "Included team seats", value: details.provider.plan === "pro" ? 3 : PLAN_ENTITLEMENTS[details.provider.plan].teamSeatLimit ?? "Unlimited" }, { label: "Purchased extra seats", value: details.provider.extra_team_seats }, { label: "Seats used", value: details.provider.reserved_worker_count + 1 },
            { label: "Extra seat cost", value: `$${(details.provider.extra_team_seats * 0.5).toFixed(2)}/month` },
            { label: "Provider agreement", value: details.provider.provider_agreement_accepted_at ? formatDate(details.provider.provider_agreement_accepted_at) : null }, { label: "Agreement version", value: details.provider.provider_agreement_version },
            { label: "Public profile", value: details.provider.public_profile_visible ? "Visible" : "Hidden" }, { label: "Public slug", value: details.provider.public_profile_slug }, { label: "Years experience", value: details.provider.years_experience },
          ]} />
            {details.complimentaryPro && <AdminComplimentaryPro providerId={details.provider.id} status={details.complimentaryPro} history={details.complimentaryProHistory} paidBillingConflict={["active", "trialing", "past_due"].includes(details.provider.stripe_subscription_status) || details.provider.stripe_subscription_checkout_pending} onChanged={onRetry} />}
            <section className={`rounded-2xl border p-4 ${details.provider.age_verification_source === "admin_exception" ? "border-[#d9ca55] bg-[#fff8cf]" : "border-[#183126]/10 bg-[#f8f8f4]"}`}>
              <p className="text-[10px] font-extrabold uppercase tracking-wider text-[#718078]">Provider age verification</p>
              <h4 className="mt-1 font-bold">{details.provider.age_verification_source === "admin_exception" ? "Historical admin exception is active" : details.provider.age_verification_source === "stripe_identity" ? "Stripe verification completed" : "Stripe verification required"}</h4>
              <p className="mt-2 text-sm leading-6 text-[#52665b]">{details.provider.age_verification_source === "admin_exception" ? "This provider has a historical exception that predates the current mandatory Stripe Identity policy. It can be revoked, but administrators cannot create a new exception. Stripe payout eligibility is separate." : details.provider.age_verification_source === "stripe_identity" ? "Stripe completed this provider's document verification and BubsBookings confirmed the provider is at least 18." : "The provider must complete Stripe Identity age verification. Administrators cannot mark this requirement complete or publish blocked listings on the provider's behalf."}</p>
              {details.provider.age_verification_exception_note && <p className="mt-3 rounded-xl bg-white/70 p-3 text-xs leading-5"><strong>Latest audit note:</strong> {details.provider.age_verification_exception_note}</p>}
              {!ageExceptionAction && details.provider.age_verification_source === "admin_exception" && <div className="mt-4"><button type="button" disabled={ageExceptionBusy} onClick={beginAgeException} className="rounded-full bg-[#9a4e25] px-4 py-2 text-xs font-bold text-white disabled:opacity-50">Revoke historical exception</button></div>}
              {ageExceptionAction && <form onSubmit={(event) => { event.preventDefault(); void changeAgeException(); }} className="mt-4 rounded-xl border border-[#183126]/10 bg-white/70 p-4">
                <label htmlFor="provider-age-exception-note" className="text-sm font-bold">Revocation reason</label>
                <p className="mt-1 text-xs leading-5 text-[#718078]">This required note is saved in the permanent admin audit history.</p>
                <textarea id="provider-age-exception-note" required autoFocus value={ageExceptionNote} onChange={(event) => setAgeExceptionNote(event.target.value)} maxLength={500} rows={3} placeholder="Explain why this historical exception is being revoked" className="mt-3 w-full resize-y rounded-xl border border-[#183126]/15 bg-white px-3 py-2 text-sm outline-none focus:border-[#4d725d] focus:ring-2 focus:ring-[#4d725d]/20" />
                <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={ageExceptionBusy} onClick={() => { setAgeExceptionAction(null); setAgeExceptionNote(""); setAgeExceptionResult(""); setAgeExceptionError(false); }} className="rounded-full border border-[#183126]/15 px-4 py-2 text-xs font-bold">Cancel</button><button type="submit" disabled={ageExceptionBusy || !ageExceptionNote.trim()} className="rounded-full bg-[#9a4e25] px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{ageExceptionBusy ? "Saving…" : "Confirm revocation"}</button></div>
              </form>}
              {ageExceptionResult && <p role="status" className={`mt-3 text-sm font-bold ${ageExceptionError ? "text-[#9a4e25]" : "text-[#34704a]"}`}>{ageExceptionResult}</p>}
            </section>
            {details.provider.bio && <div className="rounded-2xl bg-[#f8f8f4] p-4"><p className="text-[10px] font-extrabold uppercase tracking-wider text-[#718078]">Business description</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6">{details.provider.bio}</p></div>}
            {details.provider.screening_summary && <div className="rounded-2xl bg-[#f8f8f4] p-4"><p className="text-[10px] font-extrabold uppercase tracking-wider text-[#718078]">Screening summary</p><p className="mt-2 text-sm leading-6">{details.provider.screening_summary}</p></div>}
          </div></details>}
          {details.portfolio.length > 0 && <section><h3 className="mb-3 text-lg font-bold">Provider portfolio moderation</h3><div className="grid gap-3 sm:grid-cols-2">{details.portfolio.map((item) => <article key={item.id} className="overflow-hidden rounded-2xl border border-[#183126]/10"><Image src={item.url} alt={item.alt_text || item.caption || "Provider portfolio"} width={600} height={450} unoptimized className="aspect-[4/3] w-full object-cover" /><div className="p-4"><div className="flex items-center justify-between gap-2"><p className="text-sm font-bold">{item.caption || "Untitled work"}</p><StatusPill value={item.moderation_status} /></div><button type="button" onClick={() => void moderatePortfolio(item.id, item.moderation_status === "hidden" ? "active" : "hidden")} className="mt-3 rounded-full border border-[#183126]/15 px-4 py-2 text-xs font-bold">{item.moderation_status === "hidden" ? "Restore image" : "Hide image"}</button></div></article>)}</div></section>}
          {details.affiliateAttribution && <section className="rounded-3xl border border-[#183126]/10 bg-[#edf5e9] p-5"><h3 className="text-lg font-bold">Affiliate attribution</h3><p className="mt-1 text-sm text-[#52665b]">Private attribution and snapshotted program status for this provider.</p><div className="mt-4"><DetailGrid items={[
            { label: "Referred by", value: details.affiliateAttribution.affiliate_name }, { label: "Affiliate code", value: details.affiliateAttribution.affiliate_code },
            { label: "Program", value: details.affiliateAttribution.program_name }, { label: "Referral date", value: formatDate(details.affiliateAttribution.attributed_at) },
            { label: "Provider signup", value: formatDate(details.affiliateAttribution.provider_signup_at) }, { label: "Qualified", value: details.affiliateAttribution.qualified_at ? formatDate(details.affiliateAttribution.qualified_at) : "No" },
            { label: "Referral status", value: label(details.affiliateAttribution.status) }, { label: "Revenue share started", value: details.affiliateAttribution.revenue_share_started_at ? formatDate(details.affiliateAttribution.revenue_share_started_at) : null },
            { label: "Revenue share ends", value: details.affiliateAttribution.revenue_share_ends_at ? formatDate(details.affiliateAttribution.revenue_share_ends_at) : null },
          ]} /></div></section>}
<RecordSection title="Listings" empty="No listings on this account." records={details.services.map((service) => ({ id: service.id, title: service.title, meta: `${label(service.category)} · ${service.pricing_type === "QUOTE_ONLY" ? "Custom Quote" : service.pricing_type === "HOURLY" && service.hourly_rate_cents !== null ? `${formatHourlyRate(service.hourly_rate_cents)} · ${formatDurationMinutes(service.minimum_duration_minutes ?? service.duration_minutes)} minimum` : `$${(service.price_cents / 100).toFixed(2)} · ${service.duration_minutes} min`}`, status: service.is_active ? "active" : "inactive", body: service.business_name }))} />
          <RecordSection title="Bookings" empty="No bookings on this account." records={details.bookings.map((booking) => ({ id: booking.id, title: booking.service_title, meta: `${booking.account_role} · ${formatDate(booking.starts_at)} · $${(booking.price_cents / 100).toFixed(2)}`, status: `${label(booking.status)} · ${label(booking.payment_status)}`, body: `Other party: ${booking.other_party_name}` }))} />
          <RecordSection title="Reviews" empty="No reviews connected to this account." records={details.reviews.map((review) => ({ id: review.id, title: `${review.relationship} · ${review.rating}/5 stars`, meta: `${review.service_title} · ${formatDate(review.created_at)}`, status: review.is_hidden ? "Hidden" : "Visible", body: review.body || "No written comment." }))} />
          <RecordSection title="Safety reports" empty="No safety reports connected to this account." records={details.reports.map((report) => ({ id: report.id, title: `${report.relationship} · ${label(report.category)}`, meta: `${report.reporter_name} → ${report.reported_name} · ${formatDate(report.created_at)}`, status: label(report.status), body: report.details || "No additional details." }))} />
          <RecordSection title="Booking disputes" empty="No disputes connected to this account." records={details.disputes.map((dispute) => ({ id: dispute.id, title: `${label(dispute.category)} · ${dispute.service_title}`, meta: `${dispute.opened_by_name} → ${dispute.against_name} · ${formatDate(dispute.created_at)}`, status: label(dispute.status), body: `${dispute.details}${dispute.requested_resolution ? `\nRequested resolution: ${dispute.requested_resolution}` : ""}${dispute.admin_note ? `\nAdmin note: ${dispute.admin_note}` : ""}` }))} />
          <RecordSection title="Support requests" empty="No support requests from this account." records={details.supportRequests.map((request) => ({ id: request.id, title: request.subject, meta: formatDate(request.created_at), status: label(request.status), body: `${request.message}${request.admin_reply ? `\nAdmin reply: ${request.admin_reply}` : ""}` }))} />
          <RecordSection title="Recent account activity" empty="No recent activity recorded." records={details.activity.map((event) => ({ id: event.id, title: label(event.action), meta: `${label(event.target_type)} · ${formatDate(event.created_at)}`, status: "Recorded", body: event.target_id ? `Record: ${event.target_id}` : "" }))} />
        </>}
      </div>
    </section>
  </div>;

  // Keep the account drawer outside the dashboard's animated stacking context so
  // site content (including the footer promotion) can never render above it.
  return typeof document === "undefined" ? null : createPortal(dialog, document.body);
}

function RecordSection({ title, empty, records }: { title: string; empty: string; records: Array<{ id: string; title: string; meta: string; status: string; body: string }> }) {
  return <details className="rounded-3xl border border-[#183126]/10 p-5"><summary className="cursor-pointer text-lg font-bold">{title} <span className="text-sm text-[#718078]">({records.length})</span></summary>{records.length === 0 ? <p className="mt-4 text-sm text-[#718078]">{empty}</p> : <div className="mt-4 divide-y divide-[#183126]/10">{records.map((record) => <article key={record.id} className="py-4 first:pt-0 last:pb-0"><div className="flex flex-wrap items-start justify-between gap-2"><div><h4 className="font-bold">{record.title}</h4><p className="mt-1 text-xs text-[#718078]">{record.meta}</p></div><span className="rounded-full bg-[#f0f1eb] px-3 py-1 text-[10px] font-bold uppercase">{record.status}</span></div>{record.body && <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[#52665b]">{record.body}</p>}</article>)}</div>}</details>;
}
