"use client";

import BrandLockup from "@/components/brand-lockup";
import AccountLocationReminder from "@/components/account-location-reminder";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { authClient } from "@/lib/auth-client";
import ServiceImageManager from "@/components/service-image-manager";
import ServiceCategoryIcon from "@/components/service-category-icon";
import AvailabilityEditor from "@/components/availability-editor";
import CustomSelect from "@/components/custom-select";
import NotificationBell from "@/components/notification-bell";
import MessagingCenter from "@/components/messaging-center";
import TeamManager from "@/components/team-manager";
import BillingPanel from "@/components/billing-panel";
import ProviderTrustSettings from "@/components/provider-trust-settings";
import ProviderSettingsSearch from "@/components/provider-settings-search";
import BookingCalendar from "@/components/booking-calendar";
import CalendlyIntegrationPanel from "@/components/calendly-integration-panel";
import ProfileAvatar from "@/components/profile-avatar";
import LocationManager from "@/components/location-manager";
import ProviderMarketingTools from "@/components/provider-marketing-tools";
import ProviderProfileEditor from "@/components/provider-profile-editor";
import ProviderCustomerTools from "@/components/provider-customer-tools";
import ProviderDashboardIcon from "@/components/provider-dashboard-icon";
import UiIcon from "@/components/ui-icon";
import JobRequestCenter from "@/components/job-request-center";
import { PLAN_ENTITLEMENTS, type ProviderPlan } from "@/lib/plans";
import { isAllDayAvailability } from "@/lib/availability-hours";
import { formatInUserTimeZone, useUserTimeZone } from "@/components/preferences-provider";
import { dashboardWidgetDetails, ownerDashboardWidgets, workerDashboardWidgets, type DashboardWidgetId } from "@/lib/provider-dashboard-widgets";
import { formatDurationMinutes, formatHourlyRate, formatServicePrice } from "@/lib/service-pricing";
import ProviderActivationChecklist, { type ProviderActivation } from "@/components/provider-activation-checklist";

type RequestStatus = "new" | "accepted" | "cancelled" | "completed";
export type DashboardSection = "projects" | "overview" | "bookings" | "opportunities" | "calendar" | "messages" | "customers" | "revenue" | "services" | "profile" | "marketing" | "locations" | "availability" | "reviews" | "team" | "billing" | "settings";

type ProviderBooking = { id: string; customer: string; customerImage: string; initials: string; service: string; startsAt: string; location: string; price: number; pricingType: "FIXED" | "HOURLY" | "QUOTE_ONLY"; hourlyRateCents: number | null; status: RequestStatus; assigneeName: string; repeatBookings: number };
const initialRequests: ProviderBooking[] = [];

type ProviderSummary = {
  name: string;
  accessRole: "owner" | "worker";
  teamMemberId: string | null;
  teamRole: string;
  businessName: string;
  location: string;
  plan: ProviderPlan;
  isAdmin: boolean;
  service: ProviderService | null;
  services: ProviderService[];
  archivedServices: ArchivedProviderService[];
  availability: Array<{ weekday: number; startTime: string; endTime: string }>;
  availabilityByService: Record<string, Array<{ weekday: number; startTime: string; endTime: string }>>;
  emailVerified: boolean;
  accountVerified: boolean;
  phoneVerified: boolean;
  identityVerified: boolean;
  businessVerified: boolean;
  screeningStatus: "not_screened" | "passed" | "needs_changes";
  screeningScore: number | null;
  screeningSummary: string;
  screeningCheckedAt: string | null;
  screeningCurrent: boolean;
  automaticVerificationChecks: Array<{ key: string; label: string; passed: boolean; detail: string }> | null;
  cancellationWindowHours: number;
  cancellationPolicy: string;
  noShowPolicy: string;
  serviceRadiusMiles: number;
  hasInPersonServices: boolean;
  publicProfileSlug: string;
  publicProfileVisible: boolean;
  activation: ProviderActivation;
};

type ProviderService = { id: string; companyId: string; companySlug: string; businessName: string; locationId: string | null; locationName: string | null; location: string; deliveryType: "IN_PERSON" | "REMOTE" | "BOTH"; slug: string; title: string; category: string; price: number; durationMinutes: number; pricingType: "FIXED" | "HOURLY" | "QUOTE_ONLY"; hourlyRateCents: number | null; minimumDurationMinutes: number | null; imageUrls: string[]; createdAt: string; viewCount: number; completedBookingCount: number };
type ArchivedProviderService = { id: string; title: string; category: string; businessName: string; createdAt: string };

type RevenueSummary = {
  totalRevenue: number;
  thisMonthRevenue: number;
  lastMonthRevenue: number;
  paidOutJobs: number;
  securedEarnings: number;
  securedJobs: number;
  pendingEarnings: number;
  pendingJobs: number;
  refundedAmount: number;
  refundedJobs: number;
  monthlyRevenue: Array<{ month: string; label: string; revenue: number }>;
  recentEarnings: Array<{ id: string; service: string; customer: string; paidOutAt: string; amount: number }>;
  repeatMetrics: { customers: number; repeatCustomers: number; repeatBookings: number; repeatBookingRate: number; returningRevenue: number } | null;
  hourlyMetrics: { bookings: number; bookedHours: number; averageDurationMinutes: number | null; serviceRevenue: number };
  tipMetrics: { total: number; thisMonth: number; count: number; average: number };
};

type ProviderReview = {
  id: string; bookingId: string; customerName: string; serviceTitle: string;
  rating: number; body: string; createdAt: string;
};

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
}

function formatBookedPrice(booking: ProviderBooking) {
  if (booking.pricingType === "QUOTE_ONLY") return "Custom quote pending";
  const total = formatCurrency(booking.price);
  return booking.pricingType === "HOURLY" && booking.hourlyRateCents !== null
    ? `${formatHourlyRate(booking.hourlyRateCents)} · ${total} booked`
    : total;
}

function formatDuration(minutes: number) {
  if (minutes >= 1440) {
    const days = Math.floor(minutes / 1440);
    const remainingHours = Math.round(((minutes % 1440) / 60) * 100) / 100;
    return `Est. ${days} ${days === 1 ? "day" : "days"}${remainingHours ? `, ${remainingHours} ${remainingHours === 1 ? "hour" : "hours"}` : ""}`;
  }
  if (minutes < 60) return `Est. ${minutes} minutes`;
  const hours = minutes / 60;
  return `Est. ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatTime(time: string) {
  const [hourText, minute = "00"] = time.split(":");
  const hour = Number(hourText);
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

function formatBookingDate(startsAt: string, timeZone?: string) {
  return formatInUserTimeZone(startsAt, { month: "short", day: "numeric", year: "numeric" }, timeZone);
}

function formatBookingTime(startsAt: string, timeZone?: string) {
  return formatInUserTimeZone(startsAt, { hour: "numeric", minute: "2-digit" }, timeZone);
}

type DashboardNavGroup = "Business" | "Growth" | "Financial" | "Account";

const dashboardNav: Array<{ section: DashboardSection; href: string; label: string; group: DashboardNavGroup }> = [
  { section: "overview", href: "/provider/dashboard", label: "Overview", group: "Business" },
  { section: "projects", href: "/provider/dashboard/projects", label: "Hourly projects", group: "Business" },
  { section: "bookings", href: "/provider/dashboard/bookings", label: "Bookings", group: "Business" },
  { section: "opportunities", href: "/provider/dashboard/opportunities", label: "Opportunities", group: "Business" },
  { section: "calendar", href: "/provider/dashboard/calendar", label: "Calendar", group: "Business" },
  { section: "messages", href: "/provider/dashboard/messages", label: "Messages", group: "Business" },
  { section: "customers", href: "/provider/dashboard/customers", label: "Customers", group: "Business" },
  { section: "services", href: "/provider/dashboard/services", label: "Listings", group: "Business" },
  { section: "marketing", href: "/provider/dashboard/marketing", label: "Marketing", group: "Growth" },
  { section: "reviews", href: "/provider/dashboard/reviews", label: "Reviews", group: "Growth" },
  { section: "revenue", href: "/provider/dashboard/revenue", label: "Earnings", group: "Financial" },
  { section: "billing", href: "/provider/dashboard/billing", label: "Billing & subscription", group: "Financial" },
  { section: "profile", href: "/provider/dashboard/profile", label: "Company profile", group: "Account" },
  { section: "locations", href: "/provider/dashboard/locations", label: "Locations", group: "Account" },
  { section: "availability", href: "/provider/dashboard/availability", label: "Availability", group: "Account" },
  { section: "team", href: "/provider/dashboard/team", label: "Team", group: "Account" },
  { section: "settings", href: "/provider/dashboard/settings", label: "Settings", group: "Account" },
];

const sectionsNeedingPageHeading: Partial<Record<DashboardSection, string>> = {
  bookings: "Booking requests",
  opportunities: "Customer opportunities",
  messages: "Provider messages",
  services: "Company listings",
  availability: "Service availability",
  reviews: "Verified reviews",
  settings: "Provider settings",
};

type DashboardNotice = { kind: "welcome" } | { kind: "saved"; message: string };
const welcomeNoticeStorageKey = (userId: string) => `bubsbookings.provider-welcome-dismissed.${userId}`;
const SAVED_NOTICE_DURATION_MS = 5000;

export default function ProviderDashboard({ section = "overview", initialConversationId = "" }: { section?: DashboardSection; initialConversationId?: string }) {
  const router = useRouter();
  const timeZone = useUserTimeZone();
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;
  const [requests, setRequests] = useState(initialRequests);
  const [notice, setNotice] = useState<DashboardNotice | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const [provider, setProvider] = useState<ProviderSummary | null>(null);
  const [providerLoaded, setProviderLoaded] = useState(false);
  const [photoUploadFailed, setPhotoUploadFailed] = useState(false);
  const [listingDeleted, setListingDeleted] = useState(false);
  const [servicePendingDeletion, setServicePendingDeletion] = useState<ProviderService | ArchivedProviderService | null>(null);
  const [serviceDeleteBusy, setServiceDeleteBusy] = useState(false);
  const [serviceDeleteError, setServiceDeleteError] = useState("");
  const [revenue, setRevenue] = useState<RevenueSummary | null>(null);
  const [revenueLoaded, setRevenueLoaded] = useState(false);
  const [bookingActionId, setBookingActionId] = useState("");
  const [bookingError, setBookingError] = useState("");
  const [reviews, setReviews] = useState<ProviderReview[]>([]);
  const [reviewsLoaded, setReviewsLoaded] = useState(false);
  const [selectedAvailabilityServiceId, setSelectedAvailabilityServiceId] = useState("");
  const [dashboardWidgets, setDashboardWidgets] = useState<DashboardWidgetId[]>([...ownerDashboardWidgets]);
  const [widgetDraft, setWidgetDraft] = useState<DashboardWidgetId[]>([...ownerDashboardWidgets]);
  const [widgetCustomizerOpen, setWidgetCustomizerOpen] = useState(false);
  const [widgetSaving, setWidgetSaving] = useState(false);
  const [widgetError, setWidgetError] = useState("");
  const providerAccessRole = provider?.accessRole;

  function clearNoticeTimer() {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
  }

  function showSavedNotice(message: string) {
    clearNoticeTimer();
    setNotice({ kind: "saved", message });
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), SAVED_NOTICE_DURATION_MS);
  }

  function dismissNotice() {
    if (notice?.kind === "welcome" && userId) window.localStorage.setItem(welcomeNoticeStorageKey(userId), "1");
    clearNoticeTimer();
    setNotice(null);
  }

  useEffect(() => () => clearNoticeTimer(), []);

  useEffect(() => {
    const welcomeNoticeTimer = window.setTimeout(() => {
      if (!userId) {
        setNotice(null);
        return;
      }
      if (window.localStorage.getItem(welcomeNoticeStorageKey(userId)) !== "1") setNotice({ kind: "welcome" });
    }, 0);
    return () => window.clearTimeout(welcomeNoticeTimer);
  }, [userId]);

  useEffect(() => {
    const photoNoticeTimer = window.setTimeout(() => {
      const searchParams = new URLSearchParams(window.location.search);
      setPhotoUploadFailed(searchParams.get("photos") === "failed");
      setListingDeleted(searchParams.get("listing") === "deleted");
    }, 0);
    let active = true;
    fetch("/api/providers/me")
      .then(async (response) => response.ok ? response.json() as Promise<ProviderSummary> : null)
      .then((data) => { if (active) { setProvider(data); setSelectedAvailabilityServiceId((current) => current || data?.services[0]?.id || ""); if (data?.accessRole === "worker") { setDashboardWidgets([...workerDashboardWidgets]); setWidgetDraft([...workerDashboardWidgets]); } } })
      .finally(() => { if (active) setProviderLoaded(true); });
    return () => { active = false; window.clearTimeout(photoNoticeTimer); };
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/providers/bookings")
      .then(async (response) => response.ok ? response.json() as Promise<{ bookings: ProviderBooking[] }> : null)
      .catch(() => null)
      .then((data) => { if (active && data) setRequests(data.bookings); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (section !== "revenue" && section !== "overview") return;
    let active = true;
    fetch("/api/providers/revenue", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<RevenueSummary> : null)
      .catch(() => null)
      .then((data) => { if (active) setRevenue(data); })
      .finally(() => { if (active) setRevenueLoaded(true); });
    return () => { active = false; };
  }, [section]);

  useEffect(() => {
    if (section !== "reviews") return;
    let active = true;
    fetch("/api/providers/reviews", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ reviews: ProviderReview[] }> : null)
      .catch(() => null)
      .then((data) => { if (active && data) setReviews(data.reviews); })
      .finally(() => { if (active) setReviewsLoaded(true); });
    return () => { active = false; };
  }, [section]);

  useEffect(() => {
    if (section !== "overview" || !providerAccessRole) return;
    let active = true;
    fetch("/api/providers/dashboard-preferences", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ widgets: DashboardWidgetId[] }> : null)
      .catch(() => null)
      .then((data) => {
        if (!active || !data) return;
        setDashboardWidgets(data.widgets);
        setWidgetDraft(data.widgets);
      });
    return () => { active = false; };
  }, [section, providerAccessRole]);

  function openWidgetCustomizer() {
    setWidgetDraft(dashboardWidgets);
    setWidgetError("");
    setWidgetCustomizerOpen(true);
  }

  function toggleWidget(widget: DashboardWidgetId) {
    setWidgetDraft((current) => current.includes(widget) ? current.filter((item) => item !== widget) : [...current, widget]);
    setWidgetError("");
  }

  function moveWidget(widget: DashboardWidgetId, direction: -1 | 1) {
    setWidgetDraft((current) => {
      const index = current.indexOf(widget);
      const destination = index + direction;
      if (index < 0 || destination < 0 || destination >= current.length) return current;
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  }

  async function saveWidgetLayout() {
    if (!widgetDraft.length) {
      setWidgetError("Choose at least one widget for your overview.");
      return;
    }
    setWidgetSaving(true);
    setWidgetError("");
    const response = await fetch("/api/providers/dashboard-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ widgets: widgetDraft }),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) as { widgets?: DashboardWidgetId[]; error?: string } | null : null;
    if (!response?.ok || !payload?.widgets) {
      setWidgetError(payload?.error ?? "We could not save your layout. Please try again.");
    } else {
      setDashboardWidgets(payload.widgets);
      setWidgetDraft(payload.widgets);
      setWidgetCustomizerOpen(false);
      showSavedNotice("Your dashboard layout has been saved.");
    }
    setWidgetSaving(false);
  }

  const visibleDashboardWidgets = widgetCustomizerOpen ? widgetDraft : dashboardWidgets;

  function renderWidgetEditorBar(widget: DashboardWidgetId) {
    if (!widgetCustomizerOpen) return null;
    const index = widgetDraft.indexOf(widget);
    const detail = dashboardWidgetDetails[widget];
    return <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-[#b8c7bb] bg-[#eef4ea] px-4 py-3">
      <span className="mr-auto text-xs font-extrabold uppercase tracking-[.12em] text-[#52665b]">{detail.label}</span>
      <button type="button" onClick={() => moveWidget(widget, -1)} disabled={index === 0} aria-label={`Move ${detail.label} up`} className="rounded-full border border-[#183126]/15 bg-white px-3 py-1.5 text-xs font-bold text-[#183126] disabled:opacity-30">↑ Move up</button>
      <button type="button" onClick={() => moveWidget(widget, 1)} disabled={index === widgetDraft.length - 1} aria-label={`Move ${detail.label} down`} className="rounded-full border border-[#183126]/15 bg-white px-3 py-1.5 text-xs font-bold text-[#183126] disabled:opacity-30">↓ Move down</button>
      <button type="button" onClick={() => toggleWidget(widget)} className="rounded-full border border-[#9b5a45]/20 bg-[#fff1e8] px-3 py-1.5 text-xs font-bold text-[#8b4934]">Remove</button>
    </div>;
  }

  async function updateRequest(id: string, action: "accepted" | "declined" | "completed") {
    setBookingActionId(id);
    setBookingError("");
    const response = await fetch(`/api/providers/bookings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }).catch(() => null);
    if (!response) {
      setBookingError("We could not update this booking. Please try again.");
      setBookingActionId("");
      return;
    }
    const data = await response.json() as { error?: string };
    if (!response.ok) {
      setBookingError(data.error ?? "We could not update this booking.");
      setBookingActionId("");
      return;
    }
    const refreshed = await fetch("/api/providers/bookings");
    if (refreshed.ok) {
      const refreshedData = await refreshed.json() as { bookings: ProviderBooking[] };
      setRequests(refreshedData.bookings);
    }
    setBookingActionId("");
  }

  async function deleteCancelledRequest(id: string) {
    if (!window.confirm("Are you sure you want to remove this cancelled request from your dashboard?")) return;
    setBookingActionId(id);
    setBookingError("");
    const response = await fetch(`/api/providers/bookings/${id}`, { method: "DELETE" }).catch(() => null);
    const data = response ? await response.json() as { error?: string } : null;
    if (!response?.ok) setBookingError(data?.error ?? "We could not delete this booking request.");
    else setRequests((current) => current.filter((request) => request.id !== id));
    setBookingActionId("");
  }

  async function deleteProviderService() {
    const service = servicePendingDeletion;
    if (!service) return;

    setServiceDeleteBusy(true);
    setServiceDeleteError("");
    const response = await fetch(`/api/providers/services/${service.id}`, { method: "DELETE" }).catch(() => null);
    const result = response ? await response.json().catch(() => null) as { error?: string; action?: "archived" | "deleted" } | null : null;
    if (!response?.ok) {
      setServiceDeleteError(result?.error ?? "We could not delete this listing. Please try again.");
      setServiceDeleteBusy(false);
      return;
    }

    setProvider((current) => {
      if (!current) return current;
      const services = current.services.filter((item) => item.id !== service.id);
      return { ...current, services, archivedServices: current.archivedServices.filter((item) => item.id !== service.id), service: current.service?.id === service.id ? services[0] ?? null : current.service };
    });
    setSelectedAvailabilityServiceId((current) => current === service.id ? "" : current);
    setServicePendingDeletion(null);
    setServiceDeleteBusy(false);
    showSavedNotice(`“${service.title}” was deleted and removed from all listing dashboards.`);
    router.refresh();
  }

  const accountName = provider?.name ?? session?.user.name ?? "Provider";
  const firstName = accountName.trim().split(/\s+/)[0] || "Provider";
  const hasListingPhotos = provider?.services.some((service) => service.imageUrls.length > 0) ?? false;
  const activeRequests = requests.filter((request) => request.status === "new").length;
  const acceptedRequests = requests.filter((request) => request.status === "accepted").length;
  const nextAvailability = provider?.availability[0];
  const profileChecklist = [
    { label: "Business profile", complete: Boolean(provider) },
    { label: "Active service", complete: Boolean(provider?.services.length) },
    { label: "Listing photos", complete: hasListingPhotos },
    { label: "Working hours", complete: Boolean(provider?.availability.length) },
  ];
  const completedProfileItems = profileChecklist.filter((item) => item.complete).length;
  const isWorker = provider?.accessRole === "worker";
  const availableWidgets: readonly DashboardWidgetId[] = isWorker ? workerDashboardWidgets : ownerDashboardWidgets;
  const visibleNav = isWorker ? dashboardNav.filter((item) => ["overview", "bookings", "locations", "team", "settings"].includes(item.section)) : dashboardNav;
  const ownerOnlySection = isWorker && ["opportunities", "calendar", "messages", "revenue", "services", "marketing", "availability", "reviews", "billing"].includes(section);

  return (
    <main className="dashboard-page min-h-screen scroll-smooth bg-[#f4f4ef] text-[#183126]">
      <header className="sticky top-0 z-50 border-b border-[#183126]/10 bg-white/95 backdrop-blur-xl">
        <div className="dashboard-container flex items-center justify-between gap-2 px-3 py-3 sm:px-8 sm:py-4">
          <Link href="/" aria-label="BubsBookings home" className="flex min-w-0 items-center gap-2"><BrandLockup priority compact markOnlyOnMobile /><span className="hidden rounded-full bg-[#e8f0e5] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[#55705e] lg:inline">Provider</span></Link>
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">{provider?.isAdmin && <Link href="/admin" className="whitespace-nowrap rounded-full bg-[#eee25a] px-3.5 py-2.5 text-[11px] font-bold shadow-[0_5px_16px_rgba(202,185,42,.18)] transition hover:bg-[#f5ea6b] min-[370px]:text-xs sm:px-4 sm:text-sm">Admin</Link>}<Link href="/account" aria-label="Switch to consumer" className="whitespace-nowrap rounded-full bg-[#183126] px-3.5 py-2.5 text-[11px] font-bold text-white shadow-[0_6px_18px_rgba(24,49,38,.16)] transition hover:bg-[#315846] min-[370px]:text-xs sm:px-4 sm:text-sm">Switch to consumer</Link><NotificationBell /><ProfileAvatar name={accountName} imageUrl={session?.user.image} className="hidden h-10 w-10 text-sm md:grid" /></div>
        </div>
      </header>

      {isWorker && provider && <div className="border-b border-[#183126]/10 bg-[#e8f0e5]">
        <div className="dashboard-container flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm sm:px-8"><span className="font-bold">Company: {provider.businessName}</span><span className="text-[#687a70]">Your role: {provider.teamRole || "Team member"}</span><Link href="/provider/dashboard/team" className="ml-auto font-bold underline decoration-[#c5b940] decoration-2 underline-offset-4">View my team & hours</Link></div>
      </div>}

      <div className="dashboard-shell dashboard-container grid gap-6 px-4 py-6 sm:px-8 sm:py-8 lg:grid-cols-[236px_minmax(0,1fr)] lg:gap-8">
        <aside className="dashboard-sidebar hidden lg:block">
          <nav className="dashboard-sidebar-nav w-full space-y-1 text-sm font-semibold">
            {visibleNav.map((item, index) => <div key={item.section}>{(index === 0 || visibleNav[index - 1]?.group !== item.group) && <p className={`dashboard-nav-group px-4 pb-1 text-[10px] font-extrabold uppercase tracking-[.16em] text-white/45 ${index ? "mt-5 border-t border-white/10 pt-4" : "pt-2"}`}>{item.group}</p>}<Link href={item.href} className={`dashboard-nav-link flex items-center gap-3 rounded-xl px-4 py-3 transition ${section === item.section ? "dashboard-nav-link-active bg-[#eee25a] text-[#183126]" : "text-white/75 hover:bg-white/10 hover:text-white"}`}><span className="dashboard-nav-icon"><ProviderDashboardIcon name={item.section} /></span>{item.label}{item.section === "bookings" && <span className="ml-auto rounded-full bg-white/10 px-2 py-0.5 text-[10px]">{activeRequests}</span>}</Link></div>)}
          </nav>
        </aside>

        <div className="dashboard-content min-w-0 lg:col-start-2">
          <nav aria-label="Provider dashboard sections" className="mb-6 lg:hidden"><CustomSelect ariaLabel="Provider dashboard section" value={visibleNav.some((item) => item.section === section) ? section : "overview"} options={visibleNav.map((item) => ({ value: item.section, label: item.label, icon: <ProviderDashboardIcon name={item.section} /> }))} onChange={(nextSection) => { const next = visibleNav.find((item) => item.section === nextSection); if (next) router.push(next.href); }} buttonClassName="min-h-12 rounded-2xl border-[#183126]/15 bg-white px-4 text-sm font-bold shadow-sm" /></nav>
          {section === "settings" && <ProviderSettingsSearch />}
          {!ownerOnlySection && sectionsNeedingPageHeading[section] && <h1 className="sr-only">{sectionsNeedingPageHeading[section]}</h1>}
          {ownerOnlySection && <section className="rounded-[2rem] border border-[#d6ca65] bg-[#fff8cd] p-7"><h1 className="text-2xl font-bold">Owner-only company area</h1><p className="mt-2 text-sm leading-6 text-[#6f6840]">Workers can view assigned bookings and manage their own requested hours. Revenue, billing, listings, company messages, and business settings stay private to the company owner.</p><Link href="/provider/dashboard/team" className="mt-5 inline-flex rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white">Open my worker area</Link></section>}
          {notice && provider && <div role="status" aria-live="polite" className="mb-6 flex items-start justify-between gap-5 rounded-2xl border border-[#a8c1a9] bg-[#e8f2e7] p-4 text-sm"><div><p className="font-bold">{notice.kind === "welcome" ? `Welcome to BubsBookings, ${firstName}!` : "Changes saved"}</p><p className="mt-1 text-[#567060]">{notice.kind === "welcome" ? (isWorker ? `You have worker access to ${provider.businessName}.` : "Your provider profile and services are saved.") : notice.message}</p></div><button onClick={dismissNotice} aria-label="Dismiss" className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[#64786a] transition hover:bg-[#cbdcc8]"><UiIcon name="close" className="h-4 w-4" /></button></div>}
          {photoUploadFailed && <div className="mb-6 flex items-start justify-between gap-5 rounded-2xl border border-[#e0b58f] bg-[#fff3e9] p-4 text-sm"><div><p className="font-bold">Your listing was saved, but a photo did not upload.</p><p className="mt-1 text-[#765e4c]">You can add it again under Your services below.</p></div><button onClick={() => setPhotoUploadFailed(false)} aria-label="Dismiss" className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[#806b5b] transition hover:bg-[#f4d8cc]"><UiIcon name="close" className="h-4 w-4" /></button></div>}
          {listingDeleted && <div className="mb-6 flex items-start justify-between gap-5 rounded-2xl border border-[#a8c1a9] bg-[#e8f2e7] p-4 text-sm"><div><p className="font-bold">Listing deleted.</p><p className="mt-1 text-[#567060]">It is no longer visible in customer searches.</p></div><button onClick={() => setListingDeleted(false)} aria-label="Dismiss" className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[#64786a] transition hover:bg-[#cbdcc8]"><UiIcon name="close" className="h-4 w-4" /></button></div>}

          {providerLoaded && !provider && <div className="mb-6 rounded-2xl border border-[#d6ca65] bg-[#fff8cd] p-5 text-sm"><p className="font-bold">Create your provider profile to use this dashboard.</p><p className="mt-1 text-[#6f6840]">Add your business, first service, and availability to start getting discovered.</p><Link href="/providers/join" className="mt-4 inline-flex rounded-full bg-[#183126] px-4 py-2 font-bold text-white">Start provider setup</Link></div>}

          {provider && !isWorker && <ProviderActivationChecklist activation={provider.activation} />}

          {section === "overview" && <AccountLocationReminder />}

          {section === "overview" && !ownerOnlySection && <><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div><p className="text-sm font-semibold text-[#687a70]">Today&apos;s overview</p><h1 className="mt-1 text-3xl font-bold tracking-[-.04em] sm:text-4xl">Welcome, {firstName}.</h1><div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-[#687a70]"><span>{provider ? `${provider.services.length} ${provider.services.length === 1 ? "service" : "services"} · ${provider.location}` : "Here's what’s happening with your business."}</span>{provider && <span className="rounded-full bg-[#eee25a] px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider text-[#183126]">{provider.plan} plan</span>}</div></div>
            <div className="flex flex-wrap gap-2"><button type="button" onClick={openWidgetCustomizer} className="rounded-full border border-[#183126]/15 bg-white px-5 py-3 text-sm font-bold shadow-sm transition hover:border-[#183126]/35">Customize page</button>{!isWorker && <Link href="/providers/join" className="rounded-full bg-[#eee25a] px-5 py-3 text-sm font-bold shadow-sm transition">+ Add a service</Link>}</div>
          </div>

          {widgetCustomizerOpen && <section className="mt-6 rounded-[2rem] border-2 border-[#8da691] bg-white p-5 shadow-[0_16px_45px_rgba(24,49,38,.09)] sm:p-7">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div><p className="text-xs font-bold uppercase tracking-[.14em] text-[#55705e]">Page editor</p><h2 className="mt-2 text-2xl font-bold">Customize your entire overview</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-[#687a70]">Remove or rearrange widgets directly on the page below. Add anything you removed from the widget library.</p></div><div className="flex flex-wrap gap-2"><button type="button" onClick={() => { setWidgetDraft(dashboardWidgets); setWidgetCustomizerOpen(false); setWidgetError(""); }} className="rounded-full border border-[#183126]/15 px-4 py-2.5 text-xs font-bold">Cancel</button><button type="button" disabled={widgetSaving} onClick={saveWidgetLayout} className="rounded-full bg-[#eee25a] px-5 py-2.5 text-xs font-bold shadow-sm disabled:opacity-50">{widgetSaving ? "Saving…" : "Save page"}</button></div></div>
            <div className="mt-6 rounded-2xl bg-[#f5f5ef] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-bold">Add widgets</p><p className="mt-1 text-xs text-[#6c7b73]">Choose from the widgets BubsBookings offers for your role.</p></div><button type="button" onClick={() => { const defaults = isWorker ? workerDashboardWidgets : ownerDashboardWidgets; setWidgetDraft([...defaults]); setWidgetError(""); }} className="rounded-full border border-[#183126]/15 bg-white px-4 py-2 text-xs font-bold">Reset default</button></div><div className="mt-4 flex flex-wrap gap-2">{availableWidgets.filter((widget) => !widgetDraft.includes(widget)).map((widget) => { const detail = dashboardWidgetDetails[widget]; return <button key={widget} type="button" onClick={() => toggleWidget(widget)} className="inline-flex items-center gap-2 rounded-full border border-[#183126]/15 bg-white px-4 py-2.5 text-xs font-bold transition hover:border-[#6f8b77] hover:bg-[#e8f0e5]"><span>{detail.icon}</span>+ {detail.label}</button>; })}{availableWidgets.every((widget) => widgetDraft.includes(widget)) && <p className="text-xs font-semibold text-[#607269]">Every available widget is already on your page.</p>}</div></div>
            {widgetError && <p role="alert" className="mt-4 rounded-xl bg-[#fff1e8] px-4 py-3 text-sm font-semibold text-[#9a4e25]">{widgetError}</p>}
          </section>}

          <div className="mt-8 flex flex-col gap-5">
          {visibleDashboardWidgets.includes("performance") && <div style={{ order: visibleDashboardWidgets.indexOf("performance") }} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="col-span-full">{renderWidgetEditorBar("performance")}</div>
            {([...(!isWorker ? [{ label: "Paid out this month", value: revenue ? formatCurrency(revenue.thisMonthRevenue) : "$0", note: revenue?.thisMonthRevenue ? "Net earnings sent to Stripe" : "No payouts received yet", icon: "$" }] : []), { label: "Upcoming jobs", value: String(acceptedRequests), note: acceptedRequests ? "Accepted bookings" : "Your schedule is clear", icon: "◷" }, { label: "New requests", value: String(activeRequests), note: activeRequests ? "Waiting for a response" : "No requests yet", icon: "↗" }, { label: isWorker ? "My role" : "Average rating", value: isWorker ? provider?.teamRole ?? "Worker" : "Not available", note: isWorker ? provider?.businessName ?? "Company team" : "No reviews yet", icon: isWorker ? "♙" : "★" }]).map((stat) => <div key={stat.label} className="rounded-2xl border border-[#183126]/10 bg-white p-5 shadow-[0_4px_18px_rgba(24,49,38,.04)]"><div className="flex items-center justify-between"><p className="text-xs font-bold uppercase tracking-[.12em] text-[#718078]">{stat.label}</p><span className="grid h-8 w-8 place-items-center rounded-xl bg-[#edf2e8] text-sm font-bold">{stat.icon}</span></div><p className="mt-4 text-3xl font-bold tracking-tight">{stat.value}</p><p className="mt-1 text-xs text-[#77857e]">{stat.note}</p></div>)}
          </div>}

          {!isWorker && visibleDashboardWidgets.includes("quick-actions") && <section style={{ order: visibleDashboardWidgets.indexOf("quick-actions") }} className="rounded-[2rem] bg-[#183126] p-6 text-white sm:p-7">
            {renderWidgetEditorBar("quick-actions")}
            <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center"><div><p className="text-xs font-bold uppercase tracking-[.14em] text-[#acc0b5]">Quick actions</p><h2 className="mt-2 text-2xl font-bold">What would you like to manage?</h2></div><div className="flex flex-wrap gap-2"><Link href="/providers/join" className="rounded-full bg-[#eee25a] px-4 py-2.5 text-xs font-bold text-[#183126]">+ Add service</Link><Link href="/provider/dashboard/services" className="rounded-full border border-white/20 px-4 py-2.5 text-xs font-bold">Manage listings</Link><Link href="/provider/dashboard/availability" className="rounded-full border border-white/20 px-4 py-2.5 text-xs font-bold">Update hours</Link></div></div>
          </section>}

          {!isWorker && visibleDashboardWidgets.includes("latest-bookings") && <section style={{ order: visibleDashboardWidgets.indexOf("latest-bookings") }} className="rounded-[2rem] border border-[#183126]/10 bg-white p-6">
              {renderWidgetEditorBar("latest-bookings")}
              <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.12em] text-[#718078]">Bookings</p><h2 className="mt-2 text-xl font-bold">Latest requests</h2></div><Link href="/provider/dashboard/bookings" className="text-sm font-bold underline decoration-[#c5b940] decoration-2 underline-offset-4">View bookings</Link></div>
              {requests.length ? <div className="mt-5 space-y-3">{requests.slice(0, 3).map((request) => <div key={request.id} className="flex items-center gap-3 rounded-2xl bg-[#f5f5ef] p-4"><ProfileAvatar name={request.customer} imageUrl={request.customerImage} className="h-10 w-10 text-xs" /><div className="min-w-0 flex-1"><p className="truncate font-bold">{request.customer}</p><p className="truncate text-xs text-[#738179]">{request.service} · {formatBookingDate(request.startsAt, timeZone)}</p></div><span className="rounded-full bg-[#fff1bf] px-2.5 py-1 text-[10px] font-bold uppercase">{request.status}</span></div>)}</div> : <div className="mt-5 rounded-2xl bg-[#f5f5ef] px-5 py-8 text-center"><p className="text-2xl">📅</p><p className="mt-2 font-bold">No requests yet</p><p className="mt-1 text-sm text-[#738179]">New customer booking requests will appear here.</p></div>}
          </section>}

          {visibleDashboardWidgets.includes("active-listings") && <section style={{ order: visibleDashboardWidgets.indexOf("active-listings") }} className="rounded-[2rem] border border-[#183126]/10 bg-white p-6">
              {renderWidgetEditorBar("active-listings")}
              <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.12em] text-[#718078]">Services</p><h2 className="mt-2 text-xl font-bold">Active listings</h2></div><Link href="/provider/dashboard/services" className="text-sm font-bold underline decoration-[#c5b940] decoration-2 underline-offset-4">Manage</Link></div>
              {provider?.services.length ? <div className="mt-5 space-y-3">{provider.services.slice(0, 3).map((service) => <div key={service.id} className="flex items-center gap-4 rounded-2xl bg-[#f5f5ef] p-4">{service.imageUrls[0] ? <span role="img" aria-label={`${service.title} cover`} style={{ backgroundImage: `url("${service.imageUrls[0]}")` }} className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-cover bg-center" /> : <ServiceCategoryIcon category={service.category} compact className="h-12 min-h-12 w-12 min-w-12 rounded-xl [&_svg]:h-8 [&_svg]:w-8" />}<div className="min-w-0 flex-1"><p className="truncate font-bold">{service.title}</p><Link href={`/companies/${service.companySlug}`} className="mt-1 block truncate text-xs font-semibold text-[#52665b] underline decoration-[#c5b940] underline-offset-2">{service.businessName}</Link><p className="mt-1 text-xs text-[#738179]">{service.pricingType === "FIXED" ? "From " : ""}{formatServicePrice(service)} · {service.pricingType === "HOURLY" ? `${formatDurationMinutes(service.minimumDurationMinutes ?? service.durationMinutes)} minimum` : formatDuration(service.durationMinutes)}</p><p className="mt-1 text-xs font-bold text-[#496756]">◉ {service.viewCount.toLocaleString()} {service.viewCount === 1 ? "view" : "views"}</p></div><Link href={`/provider/services/${service.id}/edit`} className="rounded-full border border-[#183126]/15 bg-white px-3 py-2 text-xs font-bold">Edit</Link></div>)}</div> : <div className="mt-5 rounded-2xl bg-[#f5f5ef] px-5 py-8 text-center"><p className="text-2xl">◇</p><p className="mt-2 font-bold">No active listings</p><Link href="/providers/join" className="mt-3 inline-flex text-sm font-bold underline">Create your first service</Link></div>}
          </section>}

          {!isWorker && visibleDashboardWidgets.includes("working-hours") && <section style={{ order: visibleDashboardWidgets.indexOf("working-hours") }} className="rounded-[2rem] border border-[#183126]/10 bg-white p-6">{renderWidgetEditorBar("working-hours")}<div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.12em] text-[#718078]">Schedule</p><h2 className="mt-2 text-xl font-bold">Working hours</h2></div><Link href="/provider/dashboard/availability" className="text-sm font-bold">Edit</Link></div>{nextAvailability ? <div className="mt-5 rounded-2xl bg-[#e8f0e5] p-5"><p className="text-sm font-bold">Next saved schedule</p><p className="mt-2 text-lg font-bold">{dayNames[nextAvailability.weekday]}</p><p className="mt-1 text-sm text-[#5f7367]">{isAllDayAvailability(nextAvailability.startTime, nextAvailability.endTime) ? "Open 24 hours" : `${formatTime(nextAvailability.startTime)}–${formatTime(nextAvailability.endTime)}`}</p><p className="mt-3 text-xs text-[#718078]">{provider?.availability.length} working {provider?.availability.length === 1 ? "day" : "days"} saved</p></div> : <div className="mt-5 rounded-2xl bg-[#fff6cf] p-5"><p className="font-bold">Add your working hours</p><p className="mt-1 text-sm text-[#776c3e]">Customers need your availability before they can choose a time.</p></div>}</section>}

          {!isWorker && visibleDashboardWidgets.includes("profile-setup") && <section style={{ order: visibleDashboardWidgets.indexOf("profile-setup") }} className="rounded-[2rem] border border-[#183126]/10 bg-white p-6">{renderWidgetEditorBar("profile-setup")}<div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.12em] text-[#718078]">Profile setup</p><h2 className="mt-2 text-xl font-bold">Ready to get booked</h2></div><span className="rounded-full bg-[#edf2e8] px-3 py-1.5 text-xs font-bold">{completedProfileItems}/{profileChecklist.length}</span></div><div className="mt-5 grid gap-3 sm:grid-cols-2">{profileChecklist.map((item) => <div key={item.label} className={`flex items-center gap-3 rounded-2xl p-4 text-sm font-bold ${item.complete ? "bg-[#e8f0e5]" : "bg-[#f5f5ef] text-[#718078]"}`}><span className={`grid h-6 w-6 place-items-center rounded-full text-xs ${item.complete ? "bg-[#183126] text-white" : "border border-[#183126]/20"}`}>{item.complete ? "✓" : ""}</span>{item.label}</div>)}</div></section>}
          {isWorker && visibleDashboardWidgets.includes("worker-schedule") && <div style={{ order: visibleDashboardWidgets.indexOf("worker-schedule") }}>{renderWidgetEditorBar("worker-schedule")}<Link href="/provider/dashboard/team" className="block rounded-[2rem] bg-[#183126] p-6 text-white"><p className="text-xs font-bold uppercase tracking-[.13em] text-[#b8c7bf]">My schedule</p><h2 className="mt-2 text-xl font-bold">Submit working hours</h2><p className="mt-2 text-sm text-[#c2d0c8]">Choose when you can work and send the changes to the company owner for approval.</p><span className="mt-4 inline-flex rounded-full bg-[#eee25a] px-4 py-2 text-xs font-bold text-[#183126]">Open worker schedule</span></Link></div>}
          </div></>}

          {section === "bookings" && <section className="rounded-[2rem] border border-[#183126]/10 bg-white p-5 shadow-[0_6px_24px_rgba(24,49,38,.05)] sm:p-7">
            <div className="flex items-center justify-between"><div><h2 className="text-xl font-bold tracking-tight">Booking requests</h2><p className="mt-1 text-sm text-[#73827b]">Respond quickly to keep customers in the loop.</p></div><span className="rounded-full bg-[#f0f1eb] px-3 py-1.5 text-xs font-bold">{requests.length} total</span></div>
            {bookingError && <p role="alert" className="mt-5 rounded-xl bg-[#fff1e8] px-4 py-3 text-sm font-semibold text-[#9a4e25]">{bookingError}</p>}
            <div className="mt-6 divide-y divide-[#183126]/10">
              {requests.length === 0 && <div className="rounded-2xl bg-[#f5f5ef] px-5 py-8 text-center"><p className="font-bold">No booking requests yet</p><p className="mt-1 text-sm text-[#73827b]">New customer requests will appear here.</p></div>}
              {requests.map((request) => <div key={request.id} className="flex flex-col gap-4 py-5 first:pt-0 last:pb-0 xl:flex-row xl:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-4"><ProfileAvatar name={request.customer} imageUrl={request.customerImage} className="h-11 w-11 text-sm" /><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-bold">{request.customer}</p>{request.status === "new" && <span className="rounded-full bg-[#fff2c1] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#806817]">New</span>}{request.repeatBookings > 0 && <span className="rounded-full bg-[#e7f1e3] px-2 py-0.5 text-[10px] font-bold text-[#35704a]">Repeat · #{request.repeatBookings + 1}</span>}</div><p className="mt-1 truncate text-sm text-[#6f7e76]">{request.service} · {request.location}</p></div></div>
                <div className="flex flex-wrap items-center justify-between gap-4 xl:w-[58%]"><div><p className="text-sm font-bold">{formatBookingDate(request.startsAt, timeZone)}</p><p className="mt-1 text-xs text-[#74827b]">{formatBookingTime(request.startsAt, timeZone)}{!isWorker && ` · ${formatBookedPrice(request)}`}</p><p className="mt-1 text-xs font-semibold text-[#55705e]">Assigned: {request.assigneeName}</p></div><div className="flex flex-wrap items-center justify-end gap-2"><Link href={`/provider/dashboard/bookings/${request.id}`} className="rounded-full border border-[#183126]/15 px-3 py-2 text-xs font-bold transition hover:bg-[#e5eddf]">View details</Link>{!isWorker && (request.status === "new" ? <button disabled={bookingActionId === request.id} onClick={() => updateRequest(request.id, "accepted")} className="rounded-full bg-[#183126] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#315846] disabled:opacity-50">{bookingActionId === request.id ? "Saving…" : "Accept"}</button> : request.status === "accepted" ? <><span className="rounded-full bg-[#e4f1e5] px-3 py-1.5 text-xs font-bold text-[#35704a]">Accepted ✓</span><button disabled={bookingActionId === request.id} onClick={() => updateRequest(request.id, "completed")} className="rounded-full border border-[#183126]/15 px-3 py-2 text-xs font-bold transition hover:bg-[#eee25a] disabled:opacity-50">Mark complete</button></> : <span className={`rounded-full px-3 py-1.5 text-xs font-bold ${request.status === "completed" ? "bg-[#e4f1e5] text-[#35704a]" : "bg-[#f2ebe7] text-[#805747]"}`}>{request.status === "completed" ? "Completed ✓" : "Cancelled"}</span>)}{!isWorker && request.status === "cancelled" && <button disabled={bookingActionId === request.id} onClick={() => deleteCancelledRequest(request.id)} className="rounded-full px-3 py-2 text-xs font-bold text-[#8a4c3a] transition hover:bg-[#f4d8cc] disabled:opacity-50">Delete</button>}</div></div>
              </div>)}
            </div>
          </section>}

          {section === "messages" && !isWorker && <><section className="mb-5 flex flex-col justify-between gap-3 rounded-2xl border border-[#d7ca4d]/45 bg-[#fff9cf] px-5 py-4 sm:flex-row sm:items-center"><div><p className="text-xs font-extrabold uppercase tracking-[.13em] text-[#716a31]">No pay-to-chat fees</p><p className="mt-1 font-bold">Reply to every genuine customer inquiry for free.</p><p className="mt-1 text-xs leading-5 text-[#647064]">BubsBookings never charges you to receive a lead, send a message, or provide a quote.</p></div><Link href="/guides/why-bubsbookings-does-not-charge-for-leads" className="shrink-0 text-sm font-bold underline decoration-[#ad9e25] decoration-2 underline-offset-4">Learn how fees work →</Link></section><MessagingCenter mode="provider" initialConversationId={initialConversationId} /></>}

          {section === "customers" && <ProviderCustomerTools />}

          {section === "opportunities" && !isWorker && <JobRequestCenter mode="provider" />}

          {section === "calendar" && !isWorker && <><CalendlyIntegrationPanel /><BookingCalendar role="provider" /></>}

          {section === "revenue" && !isWorker && <RevenuePanel revenue={revenue} loaded={revenueLoaded} plan={provider?.plan ?? "starter"} />}

          {section === "services" && !isWorker && <div className="grid gap-5 xl:grid-cols-[1.2fr_.8fr]">
            <section className="rounded-[2rem] border border-[#183126]/10 bg-white p-5 sm:p-6"><div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-xl font-bold">Company listings</h2><p className="mt-1 text-xs text-[#738179]">See each listing&apos;s lifetime views since it was published.</p></div><Link href="/providers/join" className="inline-flex shrink-0 rounded-full bg-[#eee25a] px-4 py-2.5 text-sm font-bold">+ Add a listing</Link></div>{provider?.services.length ? <div className="mt-5 space-y-5">{provider.services.map((service) => <div key={service.id} className="rounded-2xl bg-[#f5f5ef] p-4"><div className="mb-4 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3"><Link href={`/companies/${service.companySlug}`} className="max-w-full truncate text-xs font-bold uppercase tracking-[.1em] text-[#52665b] underline decoration-[#c5b940] underline-offset-4">{service.businessName}</Link><Link href={`/companies/${service.companySlug}`} className="shrink-0 text-xs font-bold">View company →</Link></div><div className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-start gap-3 sm:flex sm:items-center sm:gap-4">{service.imageUrls[0] ? <span role="img" aria-label={`${service.title} cover`} style={{ backgroundImage: `url("${service.imageUrls[0]}")` }} className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-cover bg-center" /> : <ServiceCategoryIcon category={service.category} compact className="h-14 min-h-14 w-14 min-w-14 rounded-2xl [&_svg]:h-9 [&_svg]:w-9" />}<div className="min-w-0"><p className="font-bold leading-snug">{service.title}</p><p className="mt-1 text-xs text-[#738179]">{service.pricingType === "FIXED" ? "From " : ""}{formatServicePrice(service)} · {service.pricingType === "HOURLY" ? `${formatDurationMinutes(service.minimumDurationMinutes ?? service.durationMinutes)} minimum` : formatDuration(service.durationMinutes)}</p><div className="mt-2 flex flex-wrap items-center gap-2"><span className="rounded-full bg-white px-3 py-1.5 text-xs font-bold text-[#183126]">◉ {service.viewCount.toLocaleString()} {service.viewCount === 1 ? "view" : "views"}</span><span className="text-[11px] text-[#738179]">Since {new Date(service.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span></div></div><div className="col-span-2 mt-1 flex w-full flex-wrap gap-2 sm:col-auto sm:mt-0 sm:w-auto"><Link href={`/provider/services/${service.id}/edit`} className="inline-flex min-h-11 flex-1 items-center justify-center rounded-full border border-[#183126]/15 bg-white px-4 py-2.5 text-xs font-bold hover:border-[#4d725d] sm:flex-none">Edit listing</Link><button type="button" onClick={() => { setServicePendingDeletion(service); setServiceDeleteError(""); }} className="min-h-11 rounded-full border border-[#9a4e3a]/20 bg-[#fff6f1] px-4 py-2.5 text-xs font-bold text-[#9a4e3a] transition hover:bg-[#fff0e8]">Delete listing</button></div></div><ServiceImageManager serviceId={service.id} initialImageUrls={service.imageUrls} compact /></div>)}</div> : <p className="mt-5 rounded-2xl bg-[#f5f5ef] p-5 text-sm text-[#738179]">Create a company page and its first service to appear in customer searches.</p>}</section>
            <section className="rounded-[2rem] bg-[#183126] p-6 text-white"><p className="text-xs font-bold uppercase tracking-[.14em] text-[#a9c1b1]">Profile strength</p><div className="mt-3 flex items-end justify-between"><p className="text-3xl font-bold">{hasListingPhotos ? "100%" : "75%"}</p><p className="text-xs text-[#adbbb3]">{hasListingPhotos ? "Complete" : "Add listing photos"}</p></div><div className="mt-4 h-2 rounded-full bg-white/15"><div className={`h-full rounded-full bg-[#eee25a] ${hasListingPhotos ? "w-full" : "w-3/4"}`} /></div><p className="mt-5 text-sm font-bold text-[#eee25a]">{hasListingPhotos ? "Your profile is ready ✓" : "Add photos to a service"}</p></section>
          </div>}

          {section === "services" && !isWorker && provider && <section className="mt-5 rounded-[2rem] border border-[#183126]/10 bg-white p-5 sm:p-6">
            <div><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Not public</p><h2 className="mt-2 text-xl font-bold">Archived listings</h2><p className="mt-1 text-sm text-[#738179]">Archived listings are hidden from customers. You can remove old listings from this archive without affecting required booking or payment records.</p></div>
            {provider.archivedServices.length ? <div className="mt-5 divide-y divide-[#183126]/10 rounded-2xl border border-[#183126]/10 bg-[#f8f8f3] px-4">{provider.archivedServices.map((service) => <article key={service.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="font-bold">{service.title}</p><p className="mt-1 text-xs text-[#738179]">{service.businessName} · {service.category} · Archived</p></div><button type="button" onClick={() => { setServicePendingDeletion(service); setServiceDeleteError(""); }} className="min-h-11 shrink-0 rounded-full border border-[#9a4e3a]/20 bg-[#fff6f1] px-4 py-2.5 text-xs font-bold text-[#9a4e3a] transition hover:bg-[#fff0e8]">Delete from archive</button></article>)}</div> : <p className="mt-5 rounded-2xl bg-[#f5f5ef] p-5 text-sm text-[#738179]">You do not have any archived listings.</p>}
          </section>}

          {section === "marketing" && !isWorker && <ProviderMarketingTools services={provider?.services ?? []} providerProfile={provider ? { slug: provider.publicProfileSlug, name: provider.businessName, visible: provider.publicProfileVisible } : null} plan={provider?.plan ?? "starter"} />}
          {section === "profile" && !isWorker && <ProviderProfileEditor />}

          {section === "locations" && <LocationManager />}

          {section === "availability" && !isWorker && <section className="rounded-[2rem] border border-[#183126]/10 bg-white p-6">
              <div><h2 className="text-xl font-bold">Set each service&apos;s working hours</h2><p className="mt-1 text-sm text-[#738179]">Choose a listing, then set the days and times customers can request that service.</p></div>
              {provider?.services.length ? <>{provider.services.length > 1 && <label className="mt-6 block"><span className="mb-2 block text-xs font-bold uppercase tracking-[.12em] text-[#61736a]">Service listing</span><CustomSelect ariaLabel="Availability service listing" searchable={provider.services.length > 8} value={selectedAvailabilityServiceId} onChange={setSelectedAvailabilityServiceId} className="w-full sm:max-w-md" buttonClassName="rounded-2xl border border-[#183126]/15 bg-[#f8f8f3] px-4 py-3 font-bold">{provider.services.map((service) => <option key={service.id} value={service.id}>{service.title} · {service.businessName}</option>)}</CustomSelect></label>}{(() => { const selectedService = provider.services.find((service) => service.id === selectedAvailabilityServiceId) ?? provider.services[0]; const slots = provider.availabilityByService?.[selectedService.id] ?? provider.availability; return <div className="mt-6 rounded-2xl border border-[#183126]/10 bg-[#fafaf6] p-4 sm:p-5"><div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-xl bg-[#e6eee2] text-xl">□</span><div><p className="font-bold">{selectedService.title}</p><p className="text-xs text-[#738179]">{selectedService.businessName}</p></div></div><AvailabilityEditor key={`${selectedService.id}-${slots.map((slot) => `${slot.weekday}-${slot.startTime}-${slot.endTime}`).join("|")}`} serviceId={selectedService.id} serviceTitle={selectedService.title} initialSlots={slots} onSaved={(savedSlots) => setProvider((current) => current ? { ...current, availability: selectedService.id === current.services[0]?.id ? savedSlots : current.availability, availabilityByService: { ...current.availabilityByService, [selectedService.id]: savedSlots } } : current)} /></div>; })()}</> : <div className="mt-6 rounded-2xl bg-[#f5f5ef] p-6 text-sm text-[#738179]">{providerLoaded ? "Add an active service before setting working hours." : "Loading your services and hours…"}</div>}
          </section>}
          {section === "reviews" && !isWorker && <section className="rounded-[2rem] border border-[#183126]/10 bg-white p-6">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><h2 className="text-xl font-bold">Verified reviews</h2><p className="mt-1 text-sm text-[#738179]">Feedback can only come from completed BubsBookings bookings.</p></div>{reviews.length > 0 && <div className="rounded-full bg-[#edf2e8] px-4 py-2 text-sm font-bold"><span className="text-[#d0a51d]">★</span> {(reviews.reduce((total, item) => total + item.rating, 0) / reviews.length).toFixed(1)} · {reviews.length} {reviews.length === 1 ? "review" : "reviews"}</div>}</div>
              {!reviewsLoaded ? <p className="mt-6 rounded-2xl bg-[#f5f5ef] p-5 text-sm text-[#738179]">Loading reviews…</p> : reviews.length ? <div className="mt-6 grid gap-4 lg:grid-cols-2">{reviews.map((item) => <article key={item.id} className="rounded-2xl border border-[#183126]/10 bg-[#fafaf6] p-5"><div className="flex items-start justify-between gap-4"><div><p className="font-bold">{item.customerName}</p><p className="mt-1 text-xs text-[#74827b]">{item.serviceTitle} · {new Date(item.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</p></div><span className="shrink-0 text-[#d0a51d]">{"★".repeat(item.rating)}<span className="text-[#d8ddd9]">{"★".repeat(5 - item.rating)}</span></span></div><p className="mt-4 text-sm leading-6 text-[#52665b]">{item.body}</p><Link href={`/provider/dashboard/bookings/${item.bookingId}`} className="mt-4 inline-flex text-xs font-bold underline decoration-[#c5b940] decoration-2 underline-offset-4">View booking</Link></article>)}</div> : <div className="mt-5 rounded-2xl bg-[#f5f5ef] px-5 py-8 text-center"><p className="text-2xl">☆</p><p className="mt-2 font-bold">No reviews yet</p><p className="mt-1 text-sm text-[#738179]">Your first review will appear here after a completed booking.</p></div>}
          </section>}

          {section === "team" && <TeamManager />}

          {section === "billing" && !isWorker && (provider ? <BillingPanel plan={provider.plan} /> : <section className="rounded-[2rem] border border-[#183126]/10 bg-white p-7"><h1 className="text-xl font-bold">{providerLoaded ? "Create your provider profile first" : "Loading billing…"}</h1>{providerLoaded && <><p className="mt-2 text-sm text-[#738179]">Billing and provider plans become available after your business profile is created.</p><Link href="/providers/join" className="mt-5 inline-flex rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white">Start provider setup</Link></>}</section>)}

          {section === "settings" && <section data-provider-settings-hub className="rounded-[2rem] border border-[#183126]/10 bg-white p-6">
            <div><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Provider account</p><h2 className="mt-2 text-2xl font-bold">Settings</h2><p className="mt-1 text-sm text-[#738179]">Manage your BubsBookings account, security, business profile, listings, and schedule.</p></div>
            <div className="mt-6 grid gap-4 md:grid-cols-2"><Link href="/account/settings" className="rounded-2xl border border-[#183126]/15 bg-[#183126] p-5 text-white transition hover:border-[#eee25a]/70 hover:bg-[#315846] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#eee25a]"><span className="text-2xl">⚙</span><p className="mt-3 font-bold">Account settings</p><p className="mt-1 text-xs leading-5 text-[#b8c7bf]">Name, phone, location, notifications, password, and security.</p></Link>{isWorker ? <Link href="/provider/dashboard/team" className="rounded-2xl border border-[#183126]/15 bg-[#f5f5ef] p-5 transition hover:border-[#70877a] hover:bg-[#e3ecde] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#eee25a]"><span className="text-2xl">♙</span><p className="mt-3 font-bold">My worker profile</p><p className="mt-1 text-xs leading-5 text-[#738179]">View your team and submit working hours for owner approval.</p></Link> : <><Link href="/providers/join" className="rounded-2xl border border-[#183126]/15 bg-[#f5f5ef] p-5 transition hover:border-[#70877a] hover:bg-[#e3ecde] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#eee25a]"><span className="text-2xl">▦</span><p className="mt-3 font-bold">Business profile</p><p className="mt-1 text-xs leading-5 text-[#738179]">{provider ? `${provider.services.length} ${provider.services.length === 1 ? "listing" : "listings"} · ${provider.location}` : "Create your provider profile."}</p></Link><Link href="/provider/dashboard/services" className="rounded-2xl border border-[#183126]/15 bg-[#f5f5ef] p-5 transition hover:border-[#70877a] hover:bg-[#e3ecde] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#eee25a]"><span className="text-2xl">◇</span><p className="mt-3 font-bold">Services and pricing</p><p className="mt-1 text-xs leading-5 text-[#738179]">Edit listings, prices, descriptions, duration, and photos.</p></Link><Link href="/provider/dashboard/locations" className="rounded-2xl border border-[#183126]/15 bg-[#f5f5ef] p-5 transition hover:border-[#70877a] hover:bg-[#e3ecde] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#eee25a]"><span className="text-2xl">⌖</span><p className="mt-3 font-bold">Service locations</p><p className="mt-1 text-xs leading-5 text-[#738179]">Manage branches, service areas, and worker coverage.</p></Link><Link href="/provider/dashboard/availability" className="rounded-2xl border border-[#183126]/15 bg-[#f5f5ef] p-5 transition hover:border-[#70877a] hover:bg-[#e3ecde] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#eee25a]"><span className="text-2xl">□</span><p className="mt-3 font-bold">Availability</p><p className="mt-1 text-xs leading-5 text-[#738179]">Control the days and times customers can request.</p></Link><Link href="/provider/dashboard/team" className="rounded-2xl border border-[#183126]/15 bg-[#f5f5ef] p-5 transition hover:border-[#70877a] hover:bg-[#e3ecde] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#eee25a]"><span className="text-2xl">♙</span><p className="mt-3 font-bold">Company team</p><p className="mt-1 text-xs leading-5 text-[#738179]">Add workers within your plan&apos;s seat allowance.</p></Link><Link href="/provider/dashboard/billing" className="rounded-2xl border border-[#183126]/15 bg-[#f5f5ef] p-5 transition hover:border-[#70877a] hover:bg-[#e3ecde] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#eee25a]"><span className="text-2xl">▤</span><p className="mt-3 font-bold">Plan and billing</p><p className="mt-1 text-xs leading-5 text-[#738179]">Review plan limits and future Stripe billing.</p></Link></>}</div>
            {provider && !isWorker && <ProviderTrustSettings initial={provider} />}
          </section>}
        </div>
      </div>
      {servicePendingDeletion && typeof document !== "undefined" && createPortal(<div className="fixed inset-0 z-[700] grid place-items-end bg-[#10251c]/55 p-0 sm:place-items-center sm:p-5" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !serviceDeleteBusy) setServicePendingDeletion(null); }}><section role="dialog" aria-modal="true" aria-labelledby="provider-delete-listing-title" className="w-full rounded-t-[2rem] bg-white p-5 shadow-2xl sm:max-w-md sm:rounded-[2rem] sm:p-7"><p className="text-xs font-bold uppercase tracking-[.14em] text-[#9a4e3a]">Delete service</p><h2 id="provider-delete-listing-title" className="mt-2 text-2xl font-bold">Delete this listing?</h2><p className="mt-3 text-sm leading-6 text-[#687970]"><strong>{servicePendingDeletion.title}</strong> will immediately disappear from customer searches. Existing bookings and payment records are kept so they can still be completed correctly.</p>{serviceDeleteError && <p role="alert" className="mt-4 rounded-xl bg-[#fff1e8] p-3 text-sm font-bold text-[#9a4e25]">{serviceDeleteError}</p>}<div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" disabled={serviceDeleteBusy} onClick={() => setServicePendingDeletion(null)} className="min-h-11 rounded-full border border-[#183126]/15 px-5 py-3 text-sm font-bold">Keep listing</button><button type="button" disabled={serviceDeleteBusy} onClick={() => void deleteProviderService()} className="min-h-11 rounded-full bg-[#9a4e3a] px-5 py-3 text-sm font-bold text-white disabled:opacity-60">{serviceDeleteBusy ? "Deleting…" : "Yes, delete listing"}</button></div></section></div>, document.body)}
    </main>
  );
}

function RevenuePanel({ revenue, loaded, plan }: { revenue: RevenueSummary | null; loaded: boolean; plan: ProviderPlan }) {
  if (!loaded) return <div className="rounded-[2rem] border border-[#183126]/10 bg-white p-8 text-sm text-[#738179]">Loading your revenue…</div>;
  if (!revenue) return <div className="rounded-[2rem] border border-[#d6ca65] bg-[#fff8cd] p-6"><h1 className="text-xl font-bold">Revenue is not available yet</h1><p className="mt-2 text-sm text-[#6f6840]">Complete your provider profile to start tracking completed jobs and revenue.</p></div>;

  const maxRevenue = Math.max(...revenue.monthlyRevenue.map((month) => month.revenue), 1);
  const chartPoints = revenue.monthlyRevenue.map((month, index) => {
    const x = 30 + (index * 660) / Math.max(revenue.monthlyRevenue.length - 1, 1);
    const y = 205 - (month.revenue / maxRevenue) * 160;
    return { ...month, x, y };
  });
  const change = revenue.lastMonthRevenue > 0
    ? ((revenue.thisMonthRevenue - revenue.lastMonthRevenue) / revenue.lastMonthRevenue) * 100
    : null;

  return <div>
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p className="text-sm font-semibold text-[#687a70]">Business performance</p><h1 className="mt-1 text-3xl font-bold tracking-[-.04em] sm:text-4xl">Revenue</h1><p className="mt-2 text-sm text-[#687a70]">Track secured payments, pending earnings, and the net amount released to your Stripe balance.</p></div><span className="w-fit rounded-full bg-[#e7eee2] px-4 py-2 text-xs font-bold">{revenue.paidOutJobs} paid out {revenue.paidOutJobs === 1 ? "job" : "jobs"}</span></div>

    <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <RevenueCard label="Paid out" value={formatCurrency(revenue.totalRevenue)} note="Lifetime net earnings sent to Stripe" featured />
      <RevenueCard label="Estimated earnings secured" value={formatCurrency(revenue.securedEarnings)} note={`${revenue.securedJobs} ${revenue.securedJobs === 1 ? "job" : "jobs"} awaiting service. Final after Stripe processing.`} />
      <RevenueCard label="Estimated pending release" value={formatCurrency(revenue.pendingEarnings)} note={`${revenue.pendingJobs} completed ${revenue.pendingJobs === 1 ? "job" : "jobs"} in review. Final after Stripe processing.`} />
      <RevenueCard label="Customer refunds" value={formatCurrency(revenue.refundedAmount)} note={`${revenue.refundedJobs} ${revenue.refundedJobs === 1 ? "booking" : "bookings"} refunded`} />
    </div>

    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <RevenueCard label="Paid out this month" value={formatCurrency(revenue.thisMonthRevenue)} note={change === null ? "No prior-month comparison yet" : `${change >= 0 ? "+" : ""}${change.toFixed(0)}% from last month`} />
      <RevenueCard label="Paid out last month" value={formatCurrency(revenue.lastMonthRevenue)} note="Net earnings released last month" />
    </div>
    <p className="mt-4 rounded-2xl bg-[#f5f5ef] px-5 py-4 text-xs leading-5 text-[#687970]">Estimated amounts use the booking&apos;s recorded BubsBookings platform fee but may not yet include the final provider-allocated Stripe processing cost. Paid-out amounts are net service earnings after the recorded platform fee, finalized processing cost, and any recorded transfer reversal. Tips are shown separately.</p>
    {revenue.tipMetrics.count > 0 && <section className="mt-6 rounded-[2rem] border border-[#183126]/10 bg-white p-6"><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Tips</p><h2 className="mt-2 text-xl font-bold">Provider tips</h2><p className="mt-2 text-sm leading-6 text-[#687a70]">Tips are separate from service revenue and BubsBookings does not take a marketplace fee from them.</p><div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><RevenueCard label="Total tips" value={formatCurrency(revenue.tipMetrics.total)} note="Released through Stripe" /><RevenueCard label="Tips this month" value={formatCurrency(revenue.tipMetrics.thisMonth)} note="Released this month" /><RevenueCard label="Tip count" value={String(revenue.tipMetrics.count)} note="Completed customer tips" /><RevenueCard label="Average tip" value={formatCurrency(revenue.tipMetrics.average)} note="Per released tip" /></div></section>}
    {revenue.hourlyMetrics.bookings > 0 && <section className="mt-6 rounded-[2rem] border border-[#183126]/10 bg-white p-6"><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Hourly services</p><h2 className="mt-2 text-xl font-bold">Booked-time performance</h2><div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><RevenueCard label="Hourly bookings" value={String(revenue.hourlyMetrics.bookings)} note="Confirmed and completed" /><RevenueCard label="Booked hours" value={revenue.hourlyMetrics.bookedHours.toLocaleString("en-US", { maximumFractionDigits: 2 })} note="Approved billable time" /><RevenueCard label="Average duration" value={revenue.hourlyMetrics.averageDurationMinutes === null ? "Not available" : formatDurationMinutes(revenue.hourlyMetrics.averageDurationMinutes)} note="Per hourly booking" /><RevenueCard label="Service revenue" value={formatCurrency(revenue.hourlyMetrics.serviceRevenue)} note="After recorded service refunds" /></div></section>}
    {revenue.repeatMetrics?<section className="mt-6 rounded-[2rem] border border-[#183126]/10 bg-white p-6"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Pro insight</p><h2 className="mt-2 text-xl font-bold">Repeat customers</h2></div><Link href="/provider/dashboard/customers" className="text-sm font-bold underline underline-offset-4">View past customers →</Link></div><div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><RevenueCard label="Repeat customers" value={String(revenue.repeatMetrics.repeatCustomers)} note={`${revenue.repeatMetrics.customers} total customers`} /><RevenueCard label="Repeat bookings" value={String(revenue.repeatMetrics.repeatBookings)} note={`${revenue.repeatMetrics.repeatBookingRate}% of completed bookings`} /><RevenueCard label="Returning revenue" value={formatCurrency(revenue.repeatMetrics.returningRevenue)} note="Service value after recorded refunds" /><RevenueCard label="Retention tools" value="Available" note="Send a limited in-app booking offer" /></div></section>:null}

    {PLAN_ENTITLEMENTS[plan].advancedAnalytics ? <section className="mt-6 rounded-[2rem] border border-[#183126]/10 bg-white p-5 shadow-[0_5px_22px_rgba(24,49,38,.04)] sm:p-7">
      <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Last six months</p><h2 className="mt-2 text-xl font-bold">Revenue trend</h2></div><p className="text-sm font-bold">{formatCurrency(revenue.monthlyRevenue.reduce((sum, month) => sum + month.revenue, 0))}</p></div>
      <div className="mt-6 overflow-x-auto">
        <div className="min-w-[620px]">
          <svg viewBox="0 0 720 235" role="img" aria-label="Revenue by month for the last six months" className="revenue-chart h-auto w-full">
            {[45, 85, 125, 165, 205].map((y) => <line className="revenue-chart-grid" key={y} x1="30" x2="690" y1={y} y2={y} stroke="#183126" strokeOpacity="0.08" />)}
            {chartPoints.length > 1 && <polyline className="revenue-chart-line" points={chartPoints.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke="#183126" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />}
            {chartPoints.map((point) => <g key={point.month}><line className="revenue-chart-bar" x1={point.x} x2={point.x} y1={point.y} y2="205" stroke="#d9e5d4" strokeWidth="12" strokeLinecap="round" /><circle className="revenue-chart-point" cx={point.x} cy={point.y} r="7" fill="#eee25a" stroke="#183126" strokeWidth="3" /><text x={point.x} y="230" textAnchor="middle" className="revenue-chart-label fill-[#718078] text-[12px] font-bold">{point.label}</text>{point.revenue > 0 && <text x={point.x} y={Math.max(point.y - 14, 18)} textAnchor="middle" className="revenue-chart-value fill-[#183126] text-[11px] font-bold">{formatCurrency(point.revenue)}</text>}</g>)}
          </svg>
        </div>
      </div>
      {revenue.paidOutJobs === 0 && <div className="mt-3 rounded-2xl bg-[#f5f5ef] p-4 text-center text-sm text-[#738179]">Your graph will grow as payouts are released to your Stripe balance.</div>}
    </section> : <section className="mt-6 rounded-[2rem] border border-[#d8cb63] bg-[#fff9d9] p-7"><p className="text-xs font-bold uppercase tracking-[.13em] text-[#756d3f]">Pro feature</p><h2 className="mt-2 text-xl font-bold">Unlock advanced revenue analytics</h2><p className="mt-2 text-sm leading-6 text-[#706942]">Starter includes your revenue totals. Pro adds the six-month graph and detailed trends.</p><Link href="/provider/dashboard/billing" className="mt-5 inline-flex rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white">Compare plans</Link></section>}

    <section className="mt-6 rounded-[2rem] border border-[#183126]/10 bg-white p-5 sm:p-7"><div><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Activity</p><h2 className="mt-2 text-xl font-bold">Recent payouts</h2></div>{revenue.recentEarnings.length ? <div className="mt-5 divide-y divide-[#183126]/10">{revenue.recentEarnings.map((earning) => <div key={earning.id} className="flex items-center gap-4 py-4"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#e7eee2] font-bold text-[#476452]">$</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{earning.service}</p><p className="mt-1 text-xs text-[#74827b]">{earning.customer} · Paid out {new Date(earning.paidOutAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</p></div><p className="font-bold text-[#35704a]">+{formatCurrency(earning.amount)}</p></div>)}</div> : <div className="mt-5 rounded-2xl bg-[#f5f5ef] px-5 py-8 text-center"><p className="text-2xl">↗</p><p className="mt-2 font-bold">No payouts yet</p><p className="mt-1 text-sm text-[#738179]">Released provider earnings will appear here automatically.</p></div>}</section>
  </div>;
}

function RevenueCard({ label, value, note, featured = false }: { label: string; value: string; note: string; featured?: boolean }) {
  return <div className={`revenue-card rounded-[1.75rem] p-6 ${featured ? "revenue-card--featured bg-[#183126] text-white" : "border border-[#183126]/10 bg-white"}`}><div className="flex items-center justify-between"><p className={`text-xs font-bold uppercase tracking-[.12em] ${featured ? "text-[#b6c8bf]" : "text-[#718078]"}`}>{label}</p><span className={`grid h-9 w-9 place-items-center rounded-xl text-sm font-bold ${featured ? "bg-[#eee25a] text-[#183126]" : "bg-[#edf2e8]"}`}>$</span></div><p className="mt-5 text-3xl font-bold tracking-tight">{value}</p><p className={`mt-2 text-xs ${featured ? "text-[#b6c8bf]" : "text-[#77857e]"}`}>{note}</p></div>;
}
