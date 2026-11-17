"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import ReportUserButton from "@/components/report-user-button";
import UiIcon from "@/components/ui-icon";
import BookingDatePicker from "@/components/booking-date-picker";
import CustomSelect from "@/components/custom-select";
import { formatInUserTimeZone, useUserTimeZone } from "@/components/preferences-provider";
import { analyticsAllowed } from "@/components/analytics-consent";
import { formatDurationMinutes } from "@/lib/service-pricing";
import BookingTip from "@/components/booking-tip";
import { zonedDateTimeToUtc } from "@/lib/zoned-date-time";

type BookingStatus = "requested" | "confirmed" | "completed" | "cancelled";
type Booking = {
  id: string;
  hourlyProjectId?: string | null;
  viewerRole: "customer" | "provider" | "worker";
  customerName: string;
  providerId: string;
  providerName: string;
  serviceId: string;
  serviceSlug: string;
  serviceTitle: string;
  category: string;
  startsAt: string;
  endsAt: string;
  location: string;
  addressIsApproximate: boolean;
  accessInstructions: string;
  notes: string;
  bookingAnswers: Record<string, string>;
  price: number;
  pricing: { type: "FIXED" | "HOURLY" | "QUOTE_ONLY"; hourlyRate: number | null; billableDurationMinutes: number; billingIncrementMinutes: number | null; minimumDurationMinutes: number | null; maximumDurationMinutes: number | null; actualDurationMinutes: number | null };
  customerServiceFee: number;
  customerServiceFeeRefunded: number;
  tip: { id: string | null; amount: number; type: "percentage" | "custom" | null; percentage: number | null; status: "none" | "pending" | "paid" | "failed" | "cancelled" | "refunded" | "partially_refunded" | "disputed"; transferStatus: string; refundedAmount: number; riskStatus: "clear" | "review"; failureReason: string | null };
  tipEligible: boolean;
  paymentStatus: "unpaid" | "pending" | "paid" | "refunded" | "failed";
  paidAt: string | null;
  paymentRelease: {
    status: "not_applicable" | "awaiting_payment" | "secured" | "awaiting_customer" | "processing" | "paid_out" | "partially_released" | "frozen" | "reversed" | "failed";
    platformFee: number; platformFeeBasisPoints: number; platformFeeCap: number | null; providerProcessingFee: number; transferReversed: number; processingFeeStatus: "not_applicable" | "pending" | "final" | "unavailable"; providerPayout: number; estimatedProviderProcessingFee: number; estimatedProviderPayout: number; processingEstimateBasisPoints: number; processingEstimateFixedFee: number; confirmationDueAt: string | null; customerConfirmedAt: string | null;
    releasedAt: string | null; failureReason: string | null; freezeReason: string | null;
  };
  refund: { status: "none" | "requested" | "processing" | "refunded" | "rejected" | "failed"; reason: string | null; requestedAmount: number | null; refundedAmount: number; failureReason: string | null };
  status: BookingStatus;
  cancelledBy: string | null;
  cancellationReason: string | null;
  lateCancellation: boolean;
  cancellationWindowHours: number;
  cancellationPolicy: string;
  completedAt: string | null;
  conversationId: string | null;
  assignedTeamMemberId: string | null;
  assigneeName: string;
  ownerName: string;
  assignedProfessionals: Array<{ memberId: string | null; name: string }>;
  teamMembers: Array<{ id: string; name: string }>;
  reschedule: { id: string; requestedByViewer: boolean; requesterRole: "customer" | "provider"; originalStartsAt: string; originalEndsAt: string; startsAt: string; endsAt: string; reason: string; requestedAt: string; expiresAt: string } | null;
  rescheduleHistory: Array<{ id: string; requesterRole: "customer" | "provider"; requestedByViewer: boolean; originalStartsAt: string; originalEndsAt: string; proposedStartsAt: string; proposedEndsAt: string; reason: string; status: "pending" | "approved" | "declined" | "withdrawn" | "expired" | "time_unavailable"; responseReason: string; respondedAt: string | null; expiresAt: string; createdAt: string }>;
  history: Array<{ id: string; type: string; message: string; createdAt: string }>;
  review: { id: string; rating: number; body: string } | null;
  quote: { status: "none" | "pending" | "accepted" | "declined"; price: number | null; message: string; sentAt: string | null; respondedAt: string | null; pricingType: "FIXED" | "HOURLY" | null; hourlyRate: number | null; durationMinutes: number | null };
  commerce: { basePrice: number; addOnTotal: number; discount: number; package: { name?: string; description?: string; features?: string[] } | null; addOns: Array<{ name?: string; quantity?: number; lineTotalCents?: number }>; couponCode: string | null; bookingKind: "service" | "consultation" | "milestone" };
  recurrence: { seriesId: string; index: number | null; frequency: string | null; status: string | null } | null;
  pendingDurationChange: { id: string; requestedByViewer: boolean; originalDurationMinutes: number; requestedDurationMinutes: number; originalSubtotal: number; requestedSubtotal: number; reason: string; createdAt: string } | null;
};

const statusStyles: Record<BookingStatus, string> = {
  requested: "bg-[#fff1bf] text-[#786317]",
  confirmed: "bg-[#e3f1e5] text-[#2f6d46]",
  completed: "bg-[#e6ece8] text-[#405f4d]",
  cancelled: "bg-[#f5e5df] text-[#8a4f3d]",
};

const statusLabels: Record<BookingStatus, string> = {
  requested: "Awaiting provider",
  confirmed: "Confirmed",
  completed: "Completed",
  cancelled: "Cancelled",
};

export default function BookingDetails({ bookingId, expectedRole }: { bookingId: string; expectedRole: "customer" | "provider" }) {
  const timeZone = useUserTimeZone();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [rating, setRating] = useState(5);
  const [review, setReview] = useState("");
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [rescheduleTime, setRescheduleTime] = useState("");
  const [rescheduleTimes, setRescheduleTimes] = useState<string[]>([]);
  const [rescheduleTimeZone, setRescheduleTimeZone] = useState("America/Los_Angeles");
  const [rescheduleSlotsLoading, setRescheduleSlotsLoading] = useState(false);
  const [rescheduleConfirmed, setRescheduleConfirmed] = useState(false);
  const [rescheduleReason, setRescheduleReason] = useState("");
  const [rescheduleResponseReason, setRescheduleResponseReason] = useState("");
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [quotePrice, setQuotePrice] = useState("");
  const [quoteHourlyRate, setQuoteHourlyRate] = useState("");
  const [quoteDurationMinutes, setQuoteDurationMinutes] = useState("");
  const [quoteMessage, setQuoteMessage] = useState("");
  const [durationChangeOpen, setDurationChangeOpen] = useState(false);
  const [requestedDurationMinutes, setRequestedDurationMinutes] = useState("");
  const [durationChangeReason, setDurationChangeReason] = useState("");

  const loadBooking = useCallback(async () => {
    const response = await fetch(`/api/bookings/${bookingId}`, { cache: "no-store" }).catch(() => null);
    const result = response ? await response.json() as { booking?: Booking; error?: string } : null;
    if (!response?.ok || !result?.booking || (expectedRole === "customer" ? result.booking.viewerRole !== "customer" : result.booking.viewerRole === "customer")) {
      setError(result?.error ?? "We could not load this booking.");
      setLoading(false);
      return;
    }
    setBooking(result.booking);
    setLoading(false);
  }, [bookingId, expectedRole]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadBooking();
      if (new URLSearchParams(window.location.search).get("reschedule") === "1") setRescheduleOpen(true);
      if (new URLSearchParams(window.location.search).get("payment") === "success") setNotice("Payment submitted through Stripe. Your receipt and payment status will appear after confirmation.");
      if (new URLSearchParams(window.location.search).get("tip") === "success") setNotice("Tip submitted through Stripe. Your receipt will update after payment confirmation.");
      if (new URLSearchParams(window.location.search).get("tip") === "cancelled") setNotice("Tip checkout was cancelled. Nothing was charged.");
      if (new URLSearchParams(window.location.search).get("payment") === "cancelled") {
        setNotice("Payment checkout was cancelled. Nothing was charged.");
        if (analyticsAllowed()) void fetch("/api/analytics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventName: "checkout_abandoned", path: window.location.pathname, metadata: { bookingId } }) });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [bookingId, loadBooking]);

  useEffect(() => {
    if (!rescheduleOpen || !rescheduleDate || !booking || booking.hourlyProjectId) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setRescheduleSlotsLoading(true);
      fetch(`/api/bookings/${bookingId}/reschedule/availability?date=${encodeURIComponent(rescheduleDate)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { times?: string[]; timeZone?: string; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Available times could not be loaded.");
        setRescheduleTimes(data.times ?? []);
        setRescheduleTimeZone(data.timeZone ?? "America/Los_Angeles");
        setRescheduleTime((current) => data.times?.includes(current) ? current : "");
        setRescheduleSlotsLoading(false);
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        setRescheduleTimes([]);
        setRescheduleTime("");
        setError(loadError instanceof Error ? loadError.message : "Available times could not be loaded.");
        setRescheduleSlotsLoading(false);
      });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [bookingId, rescheduleDate, rescheduleOpen, booking]);

  async function providerAction(action: "accepted" | "declined" | "completed" | "cancel", reason = "") {
    setWorking(true);
    setError("");
    const response = await fetch(`/api/providers/bookings/${bookingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, reason }),
    }).catch(() => null);
    const result = response ? await response.json() as { error?: string; refundWarning?: string } : null;
    if (!response?.ok) setError(result?.error ?? "We could not update this booking.");
    else {
      setCancelOpen(false);
      setCancelReason("");
      if (result?.refundWarning) setError(result.refundWarning);
      await loadBooking();
    }
    setWorking(false);
  }

  async function requestReschedule(event: FormEvent) {
    event.preventDefault();
    const proposed = zonedDateTimeToUtc(rescheduleDate, rescheduleTime, rescheduleTimeZone);
    if (!proposed || !rescheduleConfirmed) { setError("Choose an available time and confirm that the original booking remains active until approval."); return; }
    setWorking(true); setError("");
    const response = await fetch(`/api/bookings/${bookingId}/reschedule`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startsAt: proposed.toISOString(), reason: rescheduleReason }) }).catch(() => null);
    const result = response ? await response.json() as { error?: string; refundWarning?: string } : null;
    if (!response?.ok) setError(result?.error ?? "We could not send your reschedule request.");
    else { setRescheduleOpen(false); setRescheduleDate(""); setRescheduleTime(""); setRescheduleReason(""); setRescheduleConfirmed(false); await loadBooking(); }
    setWorking(false);
  }

  async function respondToReschedule(action: "approve" | "decline" | "withdraw") {
    if (!booking?.reschedule) return;
    if (action === "withdraw" && !window.confirm("Withdraw this proposed time? The original booking will remain confirmed.")) return;
    setWorking(true); setError("");
    const response = await fetch(`/api/bookings/${bookingId}/reschedule`, { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: booking.reschedule.id, action, reason: action === "withdraw" ? "" : rescheduleResponseReason }) }).catch(() => null);
    const result = response ? await response.json() as { error?: string; status?: string } : null;
    if (!response?.ok) { setError(result?.error ?? "We could not update the reschedule request."); if (result?.status === "time_unavailable") await loadBooking(); }
    else { setRescheduleResponseReason(""); await loadBooking(); }
    setWorking(false);
  }

  async function assignBooking(memberIds: string[]) {
    if (!memberIds.length) { setError("Assign at least one professional to this booking."); return; }
    setWorking(true); setError("");
    const response = await fetch(`/api/providers/bookings/${bookingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "assign", memberIds }) }).catch(() => null);
    const result = response ? await response.json() as { error?: string; refundWarning?: string } : null;
    if (!response?.ok) setError(result?.error ?? "We could not assign this booking."); else await loadBooking();
    setWorking(false);
  }

  async function sendQuote(event: FormEvent) {
    event.preventDefault(); setWorking(true); setError("");
    const response = await fetch(`/api/providers/bookings/${bookingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send_quote", price: Number(quotePrice), hourlyRate: Number(quoteHourlyRate), durationMinutes: Number(quoteDurationMinutes), reason: quoteMessage }) }).catch(() => null);
    const result = response ? await response.json() as { error?: string } : null;
    if (!response?.ok) setError(result?.error ?? "We could not send this quote."); else { setQuoteOpen(false); setQuotePrice(""); setQuoteHourlyRate(""); setQuoteDurationMinutes(""); setQuoteMessage(""); await loadBooking(); }
    setWorking(false);
  }

  async function respondToQuote(action: "accept_quote" | "decline_quote") {
    setWorking(true); setError("");
    const response = await fetch(`/api/bookings/${bookingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }).catch(() => null);
    const result = response ? await response.json() as { error?: string } : null;
    if (!response?.ok) setError(result?.error ?? "We could not update this quote."); else await loadBooking();
    setWorking(false);
  }

  async function payForBooking() {
    setWorking(true); setError(""); setNotice("");
    const response = await fetch(`/api/stripe/bookings/${bookingId}/checkout`, { method: "POST" }).catch(() => null);
    const result = response ? await response.json() as { url?: string; error?: string } : null;
    if (!response?.ok || !result?.url) {
      setError(result?.error ?? "We could not open Stripe checkout.");
      setWorking(false);
      return;
    }
    window.location.assign(result.url);
  }

  async function requestDurationChange(event: FormEvent) {
    event.preventDefault(); setWorking(true); setError("");
    const response = await fetch(`/api/bookings/${bookingId}/changes`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ durationMinutes: Number(requestedDurationMinutes), reason: durationChangeReason }) }).catch(() => null);
    const result = response ? await response.json() as { error?: string } : null;
    if (!response?.ok) setError(result?.error ?? "We could not request this duration change.");
    else { setDurationChangeOpen(false); setRequestedDurationMinutes(""); setDurationChangeReason(""); await loadBooking(); }
    setWorking(false);
  }

  async function respondToDurationChange(action: "approve" | "decline") {
    if (!booking?.pendingDurationChange) return;
    setWorking(true); setError("");
    const response = await fetch(`/api/bookings/${bookingId}/changes`, { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changeId: booking.pendingDurationChange.id, action }) }).catch(() => null);
    const result = response ? await response.json() as { error?: string } : null;
    if (!response?.ok) setError(result?.error ?? "We could not update this duration change."); else await loadBooking();
    setWorking(false);
  }

  async function cancelRecurringSeries() {
    if (!booking?.recurrence || !window.confirm("Cancel every future occurrence in this recurring series? Completed bookings and financial history will remain.")) return;
    const reason=window.prompt("Why are you cancelling future recurring bookings?"); if(!reason)return;
    setWorking(true);setError("");const response=await fetch(`/api/recurring-series/${booking.recurrence.seriesId}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"cancel",reason})}).catch(()=>null);const result=response?await response.json() as {error?:string;refundWarnings?:number}:null;setWorking(false);if(!response?.ok){setError(result?.error??"We could not cancel the recurring series.");return;}setNotice(result?.refundWarnings?"Future visits were cancelled. Support will review one or more refunds.":"Future recurring visits were cancelled.");await loadBooking();
  }

  async function refundAction(action: "request" | "approve" | "reject") {
    if (!booking) return;
    let reason = "";
    let amount: number | undefined;
    if (action === "request") {
      reason = window.prompt("Why are you requesting a refund?")?.trim() ?? "";
      if (!reason) return;
    }
    if (action === "approve") {
      const entered = window.prompt("Refund amount in dollars", String(booking.refund.requestedAmount ?? booking.price));
      if (entered === null) return;
      amount = Number(entered);
      if (!Number.isFinite(amount)) { setError("Enter a valid refund amount."); return; }
      const returnsServiceFee = amount >= booking.price - booking.refund.refundedAmount && booking.customerServiceFee > booking.customerServiceFeeRefunded;
      if (!window.confirm(`Approve a $${amount.toFixed(2)} service refund to the original payment method?${returnsServiceFee ? ` The $${(booking.customerServiceFee - booking.customerServiceFeeRefunded).toFixed(2)} service fee will also be returned.` : ""}`)) return;
    }
    if (action === "reject") {
      reason = window.prompt("Why are you declining this refund request?")?.trim() ?? "";
      if (!reason) return;
    }
    setWorking(true); setError(""); setNotice("");
    const response = await fetch(`/api/bookings/${bookingId}/refund`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, reason, amount }) }).catch(() => null);
    const result = response ? await response.json().catch(() => null) as { error?: string; amount?: number; reconciliationRequired?: boolean; reversalNeedsReview?: boolean } | null : null;
    if (result?.reconciliationRequired) setError(result.error ?? "This refund needs reconciliation. Contact support before retrying.");
    else if (!response?.ok) setError(result?.error ?? "The refund outcome could not be confirmed. Contact support before retrying.");
    else { setNotice(action === "request" ? "Refund request sent to the provider." : action === "approve" ? `A $${result?.amount?.toFixed(2)} refund was sent to the original payment method.${result?.reversalNeedsReview ? " Provider transfer recovery is not confirmed. Contact support before retrying recovery." : ""}` : "Refund request declined."); }
    // Even a lost/error response may follow a successful Stripe action. Refresh
    // the claim before enabling controls, including accepted-but-pending refunds.
    await loadBooking();
    setWorking(false);
  }

  async function confirmCompletion() {
    if (!window.confirm("Confirm that the service is complete and release the provider's payout?")) return;
    setWorking(true); setError(""); setNotice("");
    const response = await fetch(`/api/bookings/${bookingId}/completion`, { method: "POST" }).catch(() => null);
    const result = response ? await response.json() as { error?: string } : null;
    if (!response?.ok) setError(result?.error ?? "We could not release this payout.");
    else { setNotice("Service confirmed. The provider's payout was released to Stripe."); await loadBooking(); }
    setWorking(false);
  }

  async function cancelBooking(event: FormEvent) {
    event.preventDefault();
    if (!booking) return;
    if (booking.viewerRole === "provider") {
      await providerAction(booking.status === "requested" ? "declined" : "cancel", cancelReason);
      return;
    }
    setWorking(true);
    setError("");
    const response = await fetch(`/api/bookings/${bookingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel", reason: cancelReason }),
    }).catch(() => null);
    const result = response ? await response.json() as { error?: string; refundWarning?: string } : null;
    if (!response?.ok) setError(result?.error ?? "We could not cancel this booking.");
    else {
      setCancelOpen(false);
      setCancelReason("");
      if (result?.refundWarning) setError(result.refundWarning);
      await loadBooking();
    }
    setWorking(false);
  }

  async function submitReview(event: FormEvent) {
    event.preventDefault();
    if (booking?.hourlyProjectId && !["paid", "refunded"].includes(booking.paymentStatus)) return;
    setWorking(true);
    setError("");
    const response = await fetch(`/api/bookings/${bookingId}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating, review }),
    }).catch(() => null);
    const result = response ? await response.json() as { review?: Booking["review"]; error?: string } : null;
    if (!response?.ok || !result?.review) setError(result?.error ?? "We could not save your review.");
    else {
      const savedReview = result.review;
      setBooking((current) => current ? { ...current, review: savedReview } : current);
    }
    setWorking(false);
  }

  if (loading) return <div className="rounded-[2rem] bg-white p-10 text-center text-sm text-[#6f7e76]">Loading booking details…</div>;
  if (!booking) return <div className="rounded-[2rem] border border-[#d6ca65] bg-[#fff8cd] p-8"><h1 className="text-xl font-bold">Booking unavailable</h1><p className="mt-2 text-sm text-[#6f6840]">{error}</p></div>;

  const start = new Date(booking.startsAt);
  const end = new Date(booking.endsAt);
  const contactHref = booking.viewerRole === "customer"
    ? `/account/messages?${booking.conversationId ? `conversationId=${booking.conversationId}` : `providerId=${booking.providerId}&serviceId=${booking.serviceId}`}`
    : `/provider/dashboard/messages${booking.conversationId ? `?conversationId=${booking.conversationId}` : ""}`;
  const canCancel = !booking.hourlyProjectId && (booking.status === "requested" || booking.status === "confirmed");
  const canComplete = !booking.hourlyProjectId && booking.viewerRole === "provider" && booking.status === "confirmed" && booking.paymentStatus === "paid";
  const releaseCopy = paymentReleaseCopy(booking, timeZone);
  const postedTip = ["paid", "refunded", "partially_refunded", "disputed"].includes(booking.tip.status) ? booking.tip.amount : 0;
  const customerPaymentTotal = booking.price + booking.customerServiceFee + postedTip;
  const processingFeeIsFinal = booking.paymentRelease.processingFeeStatus === "final";
  const displayedProviderProcessingFee = processingFeeIsFinal
    ? booking.paymentRelease.providerProcessingFee
    : booking.paymentRelease.estimatedProviderProcessingFee;
  const providerServiceEarnings = Math.max(0,
    (processingFeeIsFinal || booking.paymentStatus === "refunded" ? booking.paymentRelease.providerPayout : booking.paymentRelease.estimatedProviderPayout)
      - booking.paymentRelease.transferReversed,
  );
  const selectedProfessionalIds = booking.assignedProfessionals.map((professional) => professional.memberId ?? "owner");
  const toggleProfessional = (memberId: string, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...selectedProfessionalIds, memberId]))
      : selectedProfessionalIds.filter((selected) => selected !== memberId);
    void assignBooking(next);
  };

  return <>
    {booking.hourlyProjectId && <section className="mb-5 rounded-2xl border border-[#183126]/15 bg-[#edf3e7] p-5"><p className="text-xs font-bold uppercase tracking-wider">Hourly project payment record</p><h2 className="mt-2 text-xl font-bold">Approved final timesheet</h2><p className="mt-2 text-sm leading-6">This record settles completed project work. It is not a scheduled appointment. Review the approved time entries and payment status in your project.</p><Link className="mt-3 inline-block font-bold underline underline-offset-4" href={`${booking.viewerRole === "customer" ? "/account/projects" : "/provider/dashboard/projects"}/${booking.hourlyProjectId}`}>View hourly project and final timesheet</Link></section>}
    {notice && <p role="status" className="mb-5 rounded-2xl bg-[#e6f2e6] px-5 py-4 text-sm font-semibold text-[#34704a]">{notice}</p>}
    {error && <p role="alert" className="mb-5 rounded-2xl bg-[#fff0e8] px-5 py-4 text-sm font-semibold text-[#964f2c]">{error}</p>}
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-5">
      <section className="overflow-hidden rounded-[2rem] border border-[#183126]/10 bg-white shadow-[0_8px_30px_rgba(24,49,38,.05)]">
        <div className="bg-[#183126] p-6 text-white sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3"><span className={`rounded-full px-3 py-1.5 text-xs font-bold ${statusStyles[booking.status]}`}>{statusLabels[booking.status]}</span><span className="text-sm text-white/65">{booking.hourlyProjectId ? "Payment record" : "Booking"} #{booking.id.slice(0, 8).toUpperCase()}</span></div>
          <p className="mt-7 text-sm font-bold uppercase tracking-[.15em] text-[#b9c9c0]">{booking.category}</p>
          <h1 className="mt-2 text-3xl font-bold tracking-[-.04em] sm:text-4xl">{booking.serviceTitle}</h1>
          <p className="mt-3 text-[#c3d0c9]">{booking.viewerRole === "customer" ? `With ${booking.providerName}` : `Booked by ${booking.customerName}`}</p>
        </div>

        <div className="grid gap-6 p-6 sm:grid-cols-2 sm:p-8">
          {!booking.hourlyProjectId && <Detail icon="◷" label="Date and time" value={formatInUserTimeZone(start, { weekday: "long", month: "long", day: "numeric", year: "numeric" }, timeZone)} note={`${formatInUserTimeZone(start, { hour: "numeric", minute: "2-digit" }, timeZone)}–${formatInUserTimeZone(end, { hour: "numeric", minute: "2-digit" }, timeZone)}`} />}
          {booking.viewerRole !== "worker" && <Detail icon="$" label={booking.pricing.type === "QUOTE_ONLY" ? "Pricing" : booking.quote.status === "accepted" ? "Approved quote" : booking.pricing.type === "HOURLY" ? booking.hourlyProjectId ? "Approved hourly work" : "Hourly booking" : "Service price"} value={booking.pricing.type === "QUOTE_ONLY" ? "Custom quote pending" : booking.pricing.type === "HOURLY" && booking.pricing.hourlyRate !== null ? `$${booking.pricing.hourlyRate.toFixed(2)}/hr × ${formatDurationMinutes(booking.pricing.billableDurationMinutes)}` : `$${booking.price.toLocaleString()}`} note={booking.pricing.type === "QUOTE_ONLY" ? "The provider must send a quote and the customer must accept it before this request can be confirmed or paid." : booking.hourlyProjectId ? "Locked-rate labor from your approved final timesheet." : booking.pricing.type === "HOURLY" ? `$${booking.commerce.basePrice.toFixed(2)} labor before add-ons and discounts. The approved billable duration does not change from clock time alone.` : releaseCopy.detail} />}
          <Detail icon="⌖" label={booking.addressIsApproximate ? "Approximate service area" : "Service address"} value={booking.location} note={booking.addressIsApproximate ? "The street address unlocks after acceptance" : "Private to this booking and its assigned professionals"} />
          <Detail icon="✉" label={booking.viewerRole === "customer" ? "Service professional" : "Customer"} value={booking.viewerRole === "customer" ? booking.assigneeName : booking.customerName} note={booking.viewerRole === "customer" ? `From ${booking.providerName}` : "Message through BubsBookings"} />
        </div>

        {!booking.hourlyProjectId && (booking.pricing.type === "HOURLY" || booking.commerce.package || booking.commerce.addOns.length > 0 || booking.commerce.discount > 0 || booking.recurrence || booking.commerce.bookingKind === "consultation") && <div className="border-t border-[#183126]/10 bg-[#fafaf6] px-6 py-5 sm:px-8"><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Booking selections</p><div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">{booking.pricing.type === "HOURLY" && <div><strong>{formatDurationMinutes(booking.pricing.billableDurationMinutes)} booked</strong><p className="mt-1 text-xs leading-5 text-[#61736a]">Historical rate: ${booking.pricing.hourlyRate?.toFixed(2)}/hr · scheduled {formatDurationMinutes(Math.round((new Date(booking.endsAt).getTime() - new Date(booking.startsAt).getTime()) / 60000))}</p></div>}{booking.commerce.package && <div><strong>{booking.commerce.package.name || "Selected package"}</strong>{booking.commerce.package.description && <p className="mt-1 text-xs leading-5 text-[#61736a]">{booking.commerce.package.description}</p>}</div>}{booking.commerce.addOns.length > 0 && <div><strong>Add-ons</strong><p className="mt-1 text-xs leading-5 text-[#61736a]">{booking.commerce.addOns.map((item)=>`${item.name || "Add-on"}${item.quantity && item.quantity>1?` × ${item.quantity}`:""}`).join(" · ")}</p></div>}{booking.commerce.discount > 0 && <div><strong>{booking.commerce.couponCode ? `Coupon ${booking.commerce.couponCode}` : "Discount"}</strong><p className="mt-1 text-xs text-[#34704a]">−${booking.commerce.discount.toFixed(2)} provider-funded discount</p></div>}{booking.recurrence && <div><strong>Recurring series · occurrence {booking.recurrence.index ?? 1}</strong><p className="mt-1 text-xs capitalize text-[#61736a]">{booking.recurrence.frequency?.replace("biweekly","every 2 weeks")} · {booking.recurrence.status}</p></div>}{booking.commerce.bookingKind === "consultation" && <div><strong>Paid consultation</strong><p className="mt-1 text-xs text-[#61736a]">Coordinate any external meeting link through BubsBookings messages.</p></div>}</div></div>}

        {booking.notes && <div className="border-t border-[#183126]/10 px-6 py-5 sm:px-8"><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Booking notes</p><p className="mt-2 text-sm leading-6 text-[#4f6559]">{booking.notes}</p></div>}
        {booking.accessInstructions && <div className="border-t border-[#183126]/10 px-6 py-5 sm:px-8"><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Arrival and access instructions</p><p className="mt-2 text-sm leading-6 text-[#4f6559]">{booking.accessInstructions}</p></div>}
        {Object.keys(booking.bookingAnswers ?? {}).length > 0 && <div className="border-t border-[#183126]/10 px-6 py-5 sm:px-8"><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Provider questions</p><div className="mt-3 space-y-3">{Object.entries(booking.bookingAnswers).map(([question, answer]) => <div key={question}><p className="text-sm font-bold">{question}</p><p className="mt-1 text-sm leading-6 text-[#4f6559]">{answer}</p></div>)}</div></div>}
        {booking.status === "cancelled" && <div className="border-t border-[#183126]/10 bg-[#fff7f3] px-6 py-5 sm:px-8"><p className="font-bold text-[#854c3b]">Cancelled by {booking.cancelledBy ?? "a booking participant"}{booking.lateCancellation ? " · Late cancellation" : ""}</p><p className="mt-2 text-sm leading-6 text-[#765e55]">{booking.cancellationReason || "No reason was provided."}</p>{booking.lateCancellation && <p className="mt-2 text-xs font-semibold text-[#854c3b]">This was cancelled inside the provider&apos;s {booking.cancellationWindowHours}-hour notice window. Any future refund decision will follow the provider policy and payment terms.</p>}</div>}
        {booking.refund.status !== "none" && <div className="border-t border-[#183126]/10 bg-[#f3f6f0] px-6 py-5 sm:px-8"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-bold capitalize">Refund {booking.refund.status}</p><p className="mt-1 text-sm text-[#61736a]">{booking.refund.failureReason || booking.refund.reason || `${booking.refund.refundedAmount.toFixed(2)} returned to the original payment method.`}</p></div><span className="rounded-full bg-white px-3 py-1 text-xs font-bold">{booking.refund.requestedAmount ? `$${booking.refund.requestedAmount.toFixed(2)}` : "Payment refund"}</span></div></div>}
        {["paid", "refunded"].includes(booking.paymentStatus) && <div className="border-t border-[#183126]/10 bg-[#f7f8f3] px-6 py-5 sm:px-8"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Payment progress</p><p className="mt-2 font-bold">{releaseCopy.label}</p><p className="mt-1 max-w-2xl text-sm leading-6 text-[#61736a]">{releaseCopy.detail}</p>{booking.paymentRelease.freezeReason && <p className="mt-2 text-xs font-semibold text-[#934927]">Admin hold: {booking.paymentRelease.freezeReason}</p>}</div><div className="min-w-56 max-w-sm rounded-2xl bg-white p-4 text-sm"><div className="flex justify-between gap-4 text-[#61736a]"><span>Service subtotal</span><span>${booking.price.toFixed(2)}</span></div><div className="mt-2 flex justify-between gap-4 text-[#61736a]"><span>Customer service fee</span><span>${booking.customerServiceFee.toFixed(2)}</span></div>{postedTip > 0 && <div className="mt-2 flex justify-between gap-4 text-[#61736a]"><span>Tip</span><span>${postedTip.toFixed(2)}</span></div>}{booking.viewerRole === "customer" ? <div className="mt-2 flex justify-between gap-4 border-t border-[#183126]/10 pt-2 font-bold"><span>Total paid</span><span>${customerPaymentTotal.toFixed(2)}</span></div> : <><div className="mt-2 flex justify-between gap-4 text-[#61736a]"><span>BubsBookings platform fee ({(booking.paymentRelease.platformFeeBasisPoints / 100).toFixed(0)}%{booking.paymentRelease.platformFeeCap === null ? "" : `, cap $${booking.paymentRelease.platformFeeCap.toFixed(0)}`})</span><span>−${booking.paymentRelease.platformFee.toFixed(2)}</span></div><div className="mt-2 flex justify-between gap-4 text-[#61736a]"><span>Provider-allocated Stripe processing{processingFeeIsFinal ? "" : " (estimate)"}</span><span>−${displayedProviderProcessingFee.toFixed(2)}</span></div>{booking.paymentRelease.transferReversed > 0 && <div className="mt-2 flex justify-between gap-4 text-[#61736a]"><span>Refund or reversal adjustment</span><span>−${booking.paymentRelease.transferReversed.toFixed(2)}</span></div>}<div className="mt-2 flex justify-between gap-4 text-[#61736a]"><span>Tip, separate</span><span>${postedTip.toFixed(2)}</span></div><div className="mt-2 flex justify-between gap-4 border-t border-[#183126]/10 pt-2 font-bold"><span>{processingFeeIsFinal ? "Final service earnings" : "Estimated service earnings"}</span><span>${providerServiceEarnings.toFixed(2)}</span></div><p className="mt-3 border-t border-[#183126]/10 pt-3 text-xs leading-5 text-[#718078]">The platform fee cap applies only to the BubsBookings fee. {processingFeeIsFinal ? "Stripe has reported the actual processing cost for this payment." : "This estimate will update after Stripe reports the actual processing cost."}</p></>}</div></div></div>}
      </section>

      {booking.quote.status !== "none" && booking.quote.price !== null && <section className={`rounded-[2rem] border p-6 sm:p-8 ${booking.quote.status === "pending" ? "border-[#d1c653] bg-[#fff9d8]" : booking.quote.status === "accepted" ? "border-[#7eaa86] bg-[#e8f3e8]" : "border-[#d8b2a2] bg-[#fff3ee]"}`}><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Custom service quote</p><div className="mt-2 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-2xl font-bold">${booking.quote.price.toLocaleString()} quote</h2>{booking.quote.pricingType === "HOURLY" && booking.quote.hourlyRate !== null && booking.quote.durationMinutes !== null && <p className="mt-2 font-bold">${booking.quote.hourlyRate.toFixed(2)}/hr × {formatDurationMinutes(booking.quote.durationMinutes)}</p>}<p className="mt-2 max-w-2xl text-sm leading-6 text-[#5f7168]">{booking.quote.message}</p></div><span className="rounded-full bg-white/80 px-3 py-1 text-xs font-bold capitalize">{booking.quote.status}</span></div>{booking.viewerRole === "customer" && booking.quote.status === "pending" && <div className="mt-5 flex flex-wrap gap-2"><button disabled={working} onClick={() => void respondToQuote("accept_quote")} className="rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white hover:bg-[#315846] disabled:opacity-50">Approve ${booking.quote.price.toLocaleString()}</button><button disabled={working} onClick={() => void respondToQuote("decline_quote")} className="rounded-full border border-[#183126]/15 px-5 py-3 text-sm font-bold hover:bg-[#f4d8cc] disabled:opacity-50">Decline quote</button></div>}{booking.viewerRole === "provider" && booking.quote.status === "declined" && <p className="mt-4 text-sm font-bold text-[#8a4f3d]">The customer declined this quote. You can send a revised one.</p>}</section>}
      {booking.pendingDurationChange && <section className="rounded-[2rem] border border-[#d1c653] bg-[#fff9d8] p-6 sm:p-8"><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Pending duration change</p><h2 className="mt-2 text-xl font-bold">{formatDurationMinutes(booking.pendingDurationChange.originalDurationMinutes)} → {formatDurationMinutes(booking.pendingDurationChange.requestedDurationMinutes)}</h2><p className="mt-2 text-sm font-bold">${booking.pendingDurationChange.originalSubtotal.toFixed(2)} → ${booking.pendingDurationChange.requestedSubtotal.toFixed(2)} service subtotal</p><p className="mt-2 text-sm leading-6 text-[#5f7168]">{booking.pendingDurationChange.reason}</p>{booking.pendingDurationChange.requestedByViewer ? <p className="mt-4 text-sm font-bold">Waiting for the other party to approve. No charge or schedule change has occurred.</p> : <div className="mt-5 flex flex-wrap gap-2"><button disabled={working} onClick={() => void respondToDurationChange("approve")} className="rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white disabled:opacity-50">Approve change</button><button disabled={working} onClick={() => void respondToDurationChange("decline")} className="rounded-full border border-[#183126]/15 px-5 py-3 text-sm font-bold disabled:opacity-50">Decline</button></div>}</section>}
      </div>

      <aside className="space-y-5">
        <div className="rounded-[2rem] border border-[#183126]/10 bg-white p-6">
          <h2 className="text-lg font-bold">Manage this booking</h2>
          <div className="mt-5 grid gap-3">
            {booking.viewerRole === "worker" && <p className="rounded-2xl bg-[#edf2e8] p-4 text-sm leading-6 text-[#52665b]">This is an assigned company job. The company owner manages customer messages, booking changes, and payments.</p>}
            {booking.viewerRole !== "worker" && <Link href={contactHref} className="inline-flex items-center justify-center gap-2 rounded-full bg-[#eee25a] px-5 py-3 text-center text-sm font-bold transition hover:bg-[#e1d43d]"><UiIcon name="mail" className="h-4 w-4" />Contact {booking.viewerRole === "customer" ? "provider" : "customer"}</Link>}
            {!booking.hourlyProjectId && booking.viewerRole === "customer" && booking.status === "confirmed" && booking.paymentStatus !== "paid" && booking.paymentStatus !== "refunded" && <div className="rounded-2xl border border-[#183126]/10 bg-[#f7f8f3] p-4"><p className="mb-3 font-bold">Pay before your appointment</p><div className="space-y-2 text-sm"><div className="flex justify-between gap-4 text-[#61736a]"><span>Service</span><span>${booking.price.toFixed(2)}</span></div><div className="flex justify-between gap-4 text-[#61736a]"><span>BubsBookings service fee</span><span>${booking.customerServiceFee.toFixed(2)}</span></div><div className="flex justify-between gap-4 border-t border-[#183126]/10 pt-2 font-bold"><span>Total due at checkout</span><span>${customerPaymentTotal.toFixed(2)}</span></div></div><button disabled={working} onClick={() => void payForBooking()} className="mt-4 w-full rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#315846] disabled:opacity-50">{working ? "Opening Stripe…" : `Pay $${customerPaymentTotal.toFixed(2)} securely`}</button><p className="mt-2 text-center text-xs leading-5 text-[#7b8982]">You are charged only when you complete payment in Stripe. Review the <Link href="/cancellations-refunds" className="font-bold underline">Cancellation &amp; Refund Policy</Link> and <Link href="/payment-billing" className="font-bold underline">Payment &amp; Billing Policy</Link>.</p></div>}
            {!booking.hourlyProjectId && booking.viewerRole === "provider" && booking.status === "confirmed" && booking.paymentStatus !== "paid" && <p className="rounded-2xl bg-[#fff8cd] p-4 text-sm font-semibold text-[#6f642d]">Waiting for secure customer payment. You can mark the job complete after payment succeeds.</p>}
            {booking.paymentStatus === "paid" && <div className="rounded-2xl bg-[#e6f2e6] px-4 py-3 text-center text-sm font-bold text-[#34704a]">✓ {releaseCopy.label}</div>}
            {booking.viewerRole === "customer" && (booking.paymentRelease.status === "awaiting_customer" || (booking.paymentRelease.status === "failed" && Boolean(booking.paymentRelease.customerConfirmedAt))) && <button disabled={working} onClick={() => void confirmCompletion()} className="rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#315846] disabled:opacity-50">{working ? "Releasing payout…" : booking.paymentRelease.status === "failed" ? "Retry payout release" : "Confirm service complete"}</button>}
            {booking.viewerRole === "customer" && booking.paymentRelease.status === "awaiting_customer" && <Link href={`/disputes?bookingId=${booking.id}`} className="rounded-full bg-[#9b4e3a] px-5 py-3 text-center text-sm font-bold text-white transition hover:bg-[#7f3d2d]">Report a problem</Link>}
            {booking.viewerRole === "customer" && booking.paymentStatus === "paid" && !["requested", "processing", "refunded"].includes(booking.refund.status) && <button disabled={working} onClick={() => void refundAction("request")} className="rounded-full border border-[#9b4e3a]/25 px-5 py-3 text-sm font-bold text-[#8a4c3a] transition hover:bg-[#f4d8cc] disabled:opacity-50">Request a refund</button>}
            {booking.viewerRole === "provider" && booking.refund.status === "requested" && <><button disabled={working} onClick={() => void refundAction("approve")} className="rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#315846] disabled:opacity-50">Approve refund</button><button disabled={working} onClick={() => void refundAction("reject")} className="rounded-full border border-[#9b4e3a]/25 px-5 py-3 text-sm font-bold text-[#8a4c3a] transition hover:bg-[#f4d8cc] disabled:opacity-50">Decline refund</button></>}
            {booking.viewerRole === "provider" && canCancel && <fieldset disabled={working} className="rounded-2xl border border-[#183126]/15 bg-[#fafaf6] p-4"><legend className="px-1 text-sm font-bold">Assigned professionals</legend><p className="mb-3 text-xs font-normal text-[#718078]">Select everyone working on this job.</p><div className="grid gap-2"><label className="flex cursor-pointer items-center gap-3 rounded-xl bg-white px-3 py-2.5 text-sm font-bold"><input type="checkbox" checked={selectedProfessionalIds.includes("owner")} onChange={(event) => toggleProfessional("owner", event.target.checked)} className="h-4 w-4 accent-[#183126]" />{booking.ownerName}</label>{booking.teamMembers.map((member) => <label key={member.id} className="flex cursor-pointer items-center gap-3 rounded-xl bg-white px-3 py-2.5 text-sm font-bold"><input type="checkbox" checked={selectedProfessionalIds.includes(member.id)} onChange={(event) => toggleProfessional(member.id, event.target.checked)} className="h-4 w-4 accent-[#183126]" />{member.name}</label>)}</div></fieldset>}
            {booking.viewerRole === "provider" && booking.status === "requested" && <button disabled={working} onClick={() => { setQuotePrice(String(booking.quote.price ?? booking.price)); setQuoteHourlyRate(String(booking.quote.hourlyRate ?? booking.pricing.hourlyRate ?? "")); setQuoteDurationMinutes(String(booking.quote.durationMinutes ?? booking.pricing.billableDurationMinutes)); setQuoteMessage(booking.quote.message); setQuoteOpen(true); }} className="rounded-full border border-[#183126]/15 px-5 py-3 text-sm font-bold transition hover:bg-[#eee25a] disabled:opacity-50">{booking.quote.status === "none" ? "Send a custom quote" : "Send revised quote"}</button>}
            {!booking.hourlyProjectId && booking.viewerRole !== "worker" && booking.status === "confirmed" && start > new Date() && !booking.reschedule && <button onClick={() => { setError(""); setRescheduleOpen(true); }} className="rounded-full border border-[#183126]/15 px-5 py-3 text-sm font-bold transition hover:bg-[#eee25a]">Request reschedule</button>}
            {!booking.hourlyProjectId && booking.pricing.type === "HOURLY" && booking.paymentStatus === "unpaid" && ["requested", "confirmed"].includes(booking.status) && !booking.pendingDurationChange && booking.viewerRole !== "worker" && <button onClick={() => { setRequestedDurationMinutes(String(booking.pricing.billableDurationMinutes)); setDurationChangeReason(""); setDurationChangeOpen(true); }} className="rounded-full border border-[#183126]/15 px-5 py-3 text-sm font-bold transition hover:bg-[#eee25a]">Request duration change</button>}
            {!booking.hourlyProjectId && booking.status === "confirmed" && <a href={`/api/bookings/${booking.id}/calendar`} className="rounded-full border border-[#183126]/15 px-5 py-3 text-center text-sm font-bold transition hover:bg-[#e5eddf]">Add to Google / Apple Calendar</a>}
            {booking.recurrence && !["cancelled","completed"].includes(booking.recurrence.status ?? "") && booking.viewerRole !== "worker" && <button type="button" disabled={working} onClick={()=>void cancelRecurringSeries()} className="rounded-full border border-[#9b4e3a]/25 px-5 py-3 text-sm font-bold text-[#8a4c3a] transition hover:bg-[#f4d8cc] disabled:opacity-50">Cancel future recurring visits</button>}
          {booking.viewerRole === "provider" && booking.status === "requested" && booking.pricing.type !== "QUOTE_ONLY" && <div className="rounded-2xl border border-[#183126]/10 bg-[#f7f8f3] p-4" aria-label="Estimated provider earnings before acceptance"><p className="font-bold">Estimated earnings</p><p className="mt-1 text-xs leading-5 text-[#718078]">Review this estimate before accepting. Stripe&apos;s actual fee can vary by payment method and is finalized after payment.</p><div className="mt-3 space-y-2 text-sm"><div className="flex justify-between gap-4 text-[#61736a]"><span>Service subtotal</span><span>${booking.price.toFixed(2)}</span></div><div className="flex justify-between gap-4 text-[#61736a]"><span>BubsBookings platform fee ({(booking.paymentRelease.platformFeeBasisPoints / 100).toFixed(0)}%{booking.paymentRelease.platformFeeCap === null ? "" : `, max $${booking.paymentRelease.platformFeeCap.toFixed(0)}`})</span><span>−${booking.paymentRelease.platformFee.toFixed(2)}</span></div><div className="flex justify-between gap-4 text-[#61736a]"><span>Estimated Stripe processing</span><span>−${booking.paymentRelease.estimatedProviderProcessingFee.toFixed(2)}</span></div><div className="flex justify-between gap-4 border-t border-[#183126]/10 pt-2 font-bold"><span>Estimated service earnings</span><span>${booking.paymentRelease.estimatedProviderPayout.toFixed(2)}</span></div></div><p className="mt-3 text-xs leading-5 text-[#718078]">Estimate uses {(booking.paymentRelease.processingEstimateBasisPoints / 100).toFixed(1)}% + ${booking.paymentRelease.processingEstimateFixedFee.toFixed(2)} on the customer charge, then allocates only the service portion to you. Tips are separate.</p></div>}
          {booking.viewerRole === "provider" && booking.status === "requested" && <button disabled={working || booking.quote.status === "pending" || booking.quote.status === "declined" || (booking.pricing.type === "QUOTE_ONLY" && booking.quote.status !== "accepted")} onClick={() => providerAction("accepted")} className="rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#315846] disabled:cursor-not-allowed disabled:opacity-50">{booking.quote.status === "pending" ? "Waiting for quote approval" : booking.quote.status === "declined" ? "Send a revised quote" : booking.pricing.type === "QUOTE_ONLY" && booking.quote.status !== "accepted" ? "Send a quote first" : "Accept booking"}</button>}
            {canComplete && <button disabled={working} onClick={() => providerAction("completed")} className="rounded-full border border-[#183126]/15 px-5 py-3 text-sm font-bold transition hover:bg-[#e5eddf] disabled:opacity-50">Mark job complete</button>}
            {booking.viewerRole !== "worker" && canCancel && <button onClick={() => { setError(""); setCancelOpen(true); }} className="rounded-full px-5 py-3 text-sm font-bold text-[#8a4c3a] transition hover:bg-[#f4d8cc]">{booking.viewerRole === "provider" && booking.status === "requested" ? "Decline request" : "Cancel booking"}</button>}
            {booking.viewerRole !== "worker" && <ReportUserButton bookingId={booking.id} targetLabel={booking.viewerRole === "customer" ? "provider" : "customer"} />}
            {booking.viewerRole !== "worker" && booking.status !== "requested" && !(booking.viewerRole === "customer" && booking.paymentRelease.status === "awaiting_customer") && <Link href={`/disputes?bookingId=${booking.id}`} className="rounded-full border border-[#183126]/15 px-5 py-3 text-center text-sm font-bold transition hover:bg-[#fff3b0]">Open a dispute</Link>}
          </div>
          <p className="mt-5 text-center text-xs leading-5 text-[#7b8982]">Both sides are notified whenever the booking status changes.</p>
        </div>
        <div className="rounded-[2rem] bg-[#e7eee2] p-6"><p className="text-2xl">☂</p><h2 className="mt-3 font-bold">BubsBookings Promise</h2><p className="mt-2 text-sm leading-6 text-[#61736a]">Your booking information, payment status, messages, and support path stay together. This is not insurance or a guarantee of the provider&apos;s work.</p><Link href="/promise" className="mt-3 inline-flex text-xs font-bold underline decoration-[#b8a91d] decoration-2 underline-offset-4">See coverage and limitations →</Link></div>
      </aside>
    </div>

    {!booking.hourlyProjectId && booking.reschedule && <section className="mt-6 rounded-[2rem] border border-[#d1c653] bg-[#fff9d8] p-6 sm:p-8" aria-labelledby="pending-reschedule-title"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[.13em] text-[#756d3f]">Pending Approval</p><h2 id="pending-reschedule-title" className="mt-2 text-2xl font-bold">Proposed appointment change</h2></div><span className="rounded-full bg-white px-3 py-1.5 text-xs font-bold">Original time still confirmed</span></div><div className="mt-5 grid gap-3 sm:grid-cols-2"><div className="rounded-2xl bg-white/75 p-4"><p className="text-xs font-bold uppercase tracking-wide text-[#756d3f]">Original</p><p className="mt-2 font-bold">{formatInUserTimeZone(booking.reschedule.originalStartsAt, { dateStyle: "medium", timeStyle: "short" }, timeZone)}</p></div><div className="rounded-2xl bg-white p-4"><p className="text-xs font-bold uppercase tracking-wide text-[#756d3f]">Proposed</p><p className="mt-2 font-bold">{formatInUserTimeZone(booking.reschedule.startsAt, { dateStyle: "medium", timeStyle: "short" }, timeZone)}</p></div></div>{booking.reschedule.reason && <p className="mt-4 text-sm leading-6 text-[#6f6840]">{booking.reschedule.reason}</p>}<p className="mt-3 text-xs font-semibold text-[#756d3f]">The proposed time is not held or guaranteed. Availability is checked again if it is approved.</p>{booking.reschedule.requestedByViewer ? <div className="mt-5"><p className="text-sm font-bold">Waiting for the {booking.reschedule.requesterRole === "customer" ? "provider" : "customer"} to respond.</p><button disabled={working} onClick={() => void respondToReschedule("withdraw")} className="mt-3 rounded-full border border-[#8a4c3a]/25 px-5 py-3 text-sm font-bold text-[#8a4c3a] hover:bg-[#f4d8cc] disabled:opacity-50">Withdraw request</button></div> : <div className="mt-5"><label htmlFor="reschedule-response-reason" className="block text-sm font-bold">Response note <span className="font-normal text-[#756d3f]">(optional)</span></label><textarea id="reschedule-response-reason" maxLength={500} rows={2} value={rescheduleResponseReason} onChange={(event) => setRescheduleResponseReason(event.target.value)} className="mt-2 w-full rounded-2xl border border-[#183126]/15 bg-white px-4 py-3 text-sm" placeholder="Add context for the customer or provider." /><div className="mt-3 flex flex-wrap gap-2"><button disabled={working} onClick={() => void respondToReschedule("approve")} className="rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white hover:bg-[#315846] disabled:opacity-50">Approve new time</button><button disabled={working} onClick={() => void respondToReschedule("decline")} className="rounded-full border border-[#183126]/15 px-5 py-3 text-sm font-bold hover:bg-[#f4d8cc] disabled:opacity-50">Decline</button></div></div>}</section>}

    {!booking.hourlyProjectId && booking.rescheduleHistory.length > 0 && <section className="mt-6 rounded-[2rem] border border-[#183126]/10 bg-white p-6 sm:p-8"><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Schedule changes</p><h2 className="mt-2 text-2xl font-bold">Rescheduling history</h2><div className="mt-5 space-y-3">{booking.rescheduleHistory.map((request) => <article key={request.id} className="rounded-2xl bg-[#f7f8f3] p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-bold capitalize">{request.requesterRole} request</p><span className={`rounded-full px-3 py-1 text-xs font-bold ${request.status === "approved" ? "bg-[#e3f1e5] text-[#2f6d46]" : request.status === "pending" ? "bg-[#fff1bf] text-[#786317]" : "bg-[#f2e5df] text-[#854c3b]"}`}>{request.status === "time_unavailable" ? "Time No Longer Available" : request.status.replace("_", " ")}</span></div><p className="mt-2 text-sm">{formatInUserTimeZone(request.originalStartsAt, { dateStyle: "medium", timeStyle: "short" }, timeZone)} → {formatInUserTimeZone(request.proposedStartsAt, { dateStyle: "medium", timeStyle: "short" }, timeZone)}</p>{request.reason && <p className="mt-2 text-xs leading-5 text-[#61736a]">{request.reason}</p>}{request.responseReason && <p className="mt-2 text-xs leading-5 text-[#61736a]">Response: {request.responseReason}</p>}</article>)}</div></section>}

    <section className="mt-6 rounded-[2rem] border border-[#183126]/10 bg-white p-6 sm:p-8"><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Activity</p><h2 className="mt-2 text-2xl font-bold">Booking history</h2><div className="mt-5 space-y-4">{booking.history.length ? booking.history.map((event) => <div key={event.id} className="flex gap-4"><span className="mt-1 h-3 w-3 shrink-0 rounded-full bg-[#eee25a] ring-4 ring-[#f8f3bd]" /><div><p className="text-sm font-semibold">{event.message}</p><p className="mt-1 text-xs text-[#7a8881]">{formatInUserTimeZone(event.createdAt, { dateStyle: "medium", timeStyle: "short" }, timeZone)}</p></div></div>) : <p className="text-sm text-[#718078]">Future booking changes will be recorded here.</p>}</div></section>

    {booking.viewerRole === "customer" && booking.status === "completed" && (booking.review || !booking.hourlyProjectId || ["paid", "refunded"].includes(booking.paymentStatus)) && <section className="mt-6 rounded-[2rem] border border-[#183126]/10 bg-white p-6 sm:p-8">
      <p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Verified booking</p>
      <h2 className="mt-2 text-2xl font-bold">{booking.review ? "Your review" : "How was your service?"}</h2>
      {booking.review ? <div className="mt-5 rounded-2xl bg-[#f5f5ef] p-5"><p className="text-xl text-[#d0a51d]">{"★".repeat(booking.review.rating)}<span className="text-[#d8ddd9]">{"★".repeat(5 - booking.review.rating)}</span></p><p className="mt-3 text-sm leading-6 text-[#52665b]">{booking.review.body}</p></div> : <form onSubmit={submitReview} className="mt-5 max-w-2xl"><div className="flex gap-1" aria-label="Rating">{[1, 2, 3, 4, 5].map((star) => <button key={star} type="button" onClick={() => setRating(star)} aria-label={`${star} stars`} className={`rounded-lg px-1 text-3xl transition hover:bg-[#fff4b5] ${star <= rating ? "text-[#d0a51d]" : "text-[#d8ddd9]"}`}>★</button>)}</div><label htmlFor="review" className="mt-5 block text-sm font-bold">Share your experience</label><textarea id="review" value={review} onChange={(event) => setReview(event.target.value)} minLength={3} maxLength={1000} rows={4} required className="mt-2 w-full rounded-2xl border border-[#183126]/15 bg-[#fafaf6] px-4 py-3 text-sm outline-none focus:border-[#6f7f4c] focus:ring-2 focus:ring-[#eee25a]/50" placeholder="What went well? What should future customers know?" /><button disabled={working} className="mt-4 rounded-full bg-[#183126] px-6 py-3 text-sm font-bold text-white transition hover:bg-[#315846] disabled:opacity-50">{working ? "Saving…" : "Post verified review"}</button></form>}
    </section>}
    {booking.viewerRole === "customer" && booking.status === "completed" && <BookingTip bookingId={booking.id} serviceSubtotal={booking.price} tip={booking.tip} eligible={booking.tipEligible} />}

    {cancelOpen && <div className="fixed inset-0 z-[70] grid place-items-center bg-[#10251c]/55 p-5" role="dialog" aria-modal="true" aria-labelledby="cancel-title"><form onSubmit={cancelBooking} className="w-full max-w-lg rounded-[2rem] bg-white p-6 shadow-2xl sm:p-8"><h2 id="cancel-title" className="text-2xl font-bold">{booking.viewerRole === "provider" && booking.status === "requested" ? "Decline this request?" : "Cancel this booking?"}</h2><p className="mt-2 text-sm leading-6 text-[#687970]">Give a short reason. It will be shared with the other person so they know what happened.</p>{booking.viewerRole === "customer" && booking.status === "confirmed" && <div className="mt-4 rounded-2xl bg-[#fff5cf] p-4 text-xs leading-5 text-[#6f642d]"><p className="font-bold">Provider notice window: {booking.cancellationWindowHours} hours</p><p className="mt-1">{booking.cancellationPolicy}</p><p className="mt-2">If your payment is still held, cancellations outside this notice window are refunded automatically. Late cancellations require review.</p></div>}<label htmlFor="cancellation-reason" className="mt-5 block text-sm font-bold">Reason</label><textarea id="cancellation-reason" autoFocus required minLength={3} maxLength={500} rows={4} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} className="mt-2 w-full rounded-2xl border border-[#183126]/15 bg-[#fafaf6] px-4 py-3 text-sm outline-none focus:border-[#6f7f4c] focus:ring-2 focus:ring-[#eee25a]/50" placeholder="For example: My schedule changed unexpectedly." /><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setCancelOpen(false)} className="rounded-full px-5 py-3 text-sm font-bold transition hover:bg-[#edf1ec]">Keep booking</button><button disabled={working} className="rounded-full bg-[#9b4e3a] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#7f3d2d] disabled:opacity-50">{working ? "Saving…" : "Confirm cancellation"}</button></div></form></div>}
    {!booking.hourlyProjectId && rescheduleOpen && booking.viewerRole !== "worker" && <div className="fixed inset-0 z-[70] grid place-items-center overflow-y-auto bg-[#10251c]/55 p-4" role="dialog" aria-modal="true" aria-labelledby="reschedule-title"><form onSubmit={requestReschedule} className="my-auto w-full max-w-2xl rounded-[2rem] bg-white p-6 shadow-2xl sm:p-8"><h2 id="reschedule-title" className="text-2xl font-bold">Request a new appointment time</h2><p className="mt-2 text-sm leading-6 text-[#687970]">The {booking.viewerRole === "customer" ? "provider" : "customer"} must approve this proposal. Your confirmed booking does not move until approval.</p><div className="mt-5 rounded-2xl bg-[#f3f5ef] p-4"><p className="text-xs font-bold uppercase tracking-wide text-[#718078]">Original booking</p><p className="mt-2 font-bold">{formatInUserTimeZone(booking.startsAt, { dateStyle: "full", timeStyle: "short" }, timeZone)}</p></div><div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="block text-sm font-bold">Available date<span className="mt-2 block"><BookingDatePicker serviceId={booking.serviceId} value={rescheduleDate} onChange={(date) => { setRescheduleDate(date); setRescheduleTime(""); setError(""); }} availabilityBaseUrl={`/api/bookings/${booking.id}/reschedule/availability`} /></span></label><label className="block text-sm font-bold">Available time<CustomSelect ariaLabel="Available reschedule time" value={rescheduleTime} onChange={setRescheduleTime} disabled={!rescheduleDate || rescheduleSlotsLoading} className="mt-2 w-full" buttonClassName="min-h-12 rounded-2xl border border-[#183126]/15 bg-[#faf9f5] px-4 py-3 text-sm font-semibold"><option value="">{rescheduleSlotsLoading ? "Checking times…" : rescheduleDate && !rescheduleTimes.length ? "No available times" : "Select a time"}</option>{rescheduleTimes.map((time) => <option key={time} value={time}>{new Date(`2000-01-01T${time}:00`).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</option>)}</CustomSelect></label></div>{rescheduleDate && rescheduleTime && <div className="mt-4 rounded-2xl border border-[#d1c653] bg-[#fff9d8] p-4"><p className="text-xs font-bold uppercase tracking-wide text-[#756d3f]">Proposed new time</p><p className="mt-2 font-bold">{rescheduleDate} at {new Date(`2000-01-01T${rescheduleTime}:00`).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} · {rescheduleTimeZone}</p></div>}<label htmlFor="reschedule-reason" className="mt-4 block text-sm font-bold">Explanation <span className="font-normal text-[#718078]">(optional)</span></label><textarea id="reschedule-reason" maxLength={500} rows={3} value={rescheduleReason} onChange={(event) => setRescheduleReason(event.target.value)} className="mt-2 w-full rounded-2xl border border-[#183126]/15 bg-[#fafaf6] px-4 py-3" placeholder="Share why another time would work better." /><label className="mt-4 flex items-start gap-3 rounded-2xl bg-[#f3f5ef] p-4 text-sm font-semibold"><input required type="checkbox" checked={rescheduleConfirmed} onChange={(event) => setRescheduleConfirmed(event.target.checked)} className="mt-0.5 h-5 w-5 accent-[#183126]" /><span>I understand the original appointment remains confirmed and the proposed time is not guaranteed until the other party approves it.</span></label><div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" onClick={() => setRescheduleOpen(false)} className="rounded-full px-5 py-3 text-sm font-bold hover:bg-[#edf1ec]">Close</button><button disabled={working || !rescheduleDate || !rescheduleTime || !rescheduleConfirmed} className="rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white hover:bg-[#315846] disabled:opacity-50">{working ? "Sending…" : "Send for approval"}</button></div></form></div>}
    {durationChangeOpen && booking.pricing.type === "HOURLY" && <div className="fixed inset-0 z-[70] grid place-items-center bg-[#10251c]/55 p-5" role="dialog" aria-modal="true" aria-labelledby="duration-change-title"><form onSubmit={requestDurationChange} className="w-full max-w-lg rounded-[2rem] bg-white p-6 shadow-2xl sm:p-8"><h2 id="duration-change-title" className="text-2xl font-bold">Request a duration change</h2><p className="mt-2 text-sm leading-6 text-[#687970]">The other party must approve the new booked time and service subtotal. This does not use actual clock time and will not charge anyone automatically.</p><label className="mt-5 block text-sm font-bold">New booked duration (minutes)<input required type="number" min={booking.pricing.minimumDurationMinutes ?? 15} max={booking.pricing.maximumDurationMinutes ?? undefined} step={booking.pricing.billingIncrementMinutes ?? 15} inputMode="numeric" value={requestedDurationMinutes} onChange={(event) => setRequestedDurationMinutes(event.target.value)} className="mt-2 w-full rounded-2xl border border-[#183126]/15 bg-[#fafaf6] px-4 py-3" /></label>{booking.pricing.hourlyRate !== null && Number(requestedDurationMinutes) > 0 && <p aria-live="polite" className="mt-3 rounded-2xl bg-[#f3f5ef] p-4 text-sm font-bold">Estimated labor: ${((booking.pricing.hourlyRate * Number(requestedDurationMinutes)) / 60).toFixed(2)}</p>}<label className="mt-4 block text-sm font-bold">Reason<textarea required minLength={3} maxLength={500} rows={3} value={durationChangeReason} onChange={(event) => setDurationChangeReason(event.target.value)} className="mt-2 w-full rounded-2xl border border-[#183126]/15 bg-[#fafaf6] px-4 py-3" /></label><div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" onClick={() => setDurationChangeOpen(false)} className="rounded-full px-5 py-3 text-sm font-bold hover:bg-[#edf1ec]">Cancel</button><button disabled={working} className="rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white disabled:opacity-50">{working ? "Sending…" : "Send request"}</button></div></form></div>}
    {quoteOpen && booking.viewerRole === "provider" && <div className="fixed inset-0 z-[70] grid place-items-center overflow-y-auto bg-[#10251c]/55 p-5" role="dialog" aria-modal="true" aria-labelledby="quote-title"><form onSubmit={sendQuote} className="my-auto w-full max-w-lg rounded-[2rem] bg-white p-6 shadow-2xl sm:p-8"><p className="text-xs font-bold uppercase tracking-[.14em] text-[#718078]">Before confirmation</p><h2 id="quote-title" className="mt-2 text-2xl font-bold">Send a custom quote</h2><p className="mt-2 text-sm leading-6 text-[#687970]">The customer must approve the scope, price, and booked duration before the booking can be confirmed.</p>{booking.pricing.type === "HOURLY" ? <div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="block text-sm font-bold">Hourly rate ($)<input required type="number" min="0.5" max="1000000" step="0.01" inputMode="decimal" value={quoteHourlyRate} onChange={(event) => setQuoteHourlyRate(event.target.value)} className="mt-2 w-full rounded-2xl border border-[#183126]/15 bg-[#fafaf6] px-4 py-3" /></label><label className="block text-sm font-bold">Booked duration (minutes)<input required type="number" min={booking.pricing.minimumDurationMinutes ?? 15} max={booking.pricing.maximumDurationMinutes ?? undefined} step={booking.pricing.billingIncrementMinutes ?? 15} inputMode="numeric" value={quoteDurationMinutes} onChange={(event) => setQuoteDurationMinutes(event.target.value)} className="mt-2 w-full rounded-2xl border border-[#183126]/15 bg-[#fafaf6] px-4 py-3" /></label>{Number(quoteHourlyRate) > 0 && Number(quoteDurationMinutes) > 0 && <p role="status" aria-live="polite" className="sm:col-span-2 rounded-2xl bg-[#f3f5ef] p-4 text-sm"><strong>Labor estimate:</strong> ${((Number(quoteHourlyRate) * Number(quoteDurationMinutes)) / 60).toFixed(2)} for {formatDurationMinutes(Number(quoteDurationMinutes))}. Existing selected add-ons and discounts remain in the final service total.</p>}</div> : <label className="mt-5 block text-sm font-bold">Quoted price ($)<input required type="number" min="1" max="1000000" step="0.01" inputMode="decimal" value={quotePrice} onChange={(event) => setQuotePrice(event.target.value)} className="mt-2 w-full rounded-2xl border border-[#183126]/15 bg-[#fafaf6] px-4 py-3" /></label>}<label className="mt-4 block text-sm font-bold">What changed?<textarea required minLength={3} maxLength={500} rows={4} value={quoteMessage} onChange={(event) => setQuoteMessage(event.target.value)} className="mt-2 w-full rounded-2xl border border-[#183126]/15 bg-[#fafaf6] px-4 py-3" placeholder="Describe the updated scope and what the customer will receive." /></label><div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" onClick={() => setQuoteOpen(false)} className="rounded-full px-5 py-3 text-sm font-bold hover:bg-[#edf1ec]">Cancel</button><button disabled={working} className="rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white disabled:opacity-50">{working ? "Sending…" : "Send quote"}</button></div></form></div>}
  </>;
}

function Detail({ icon, label, value, note }: { icon: string; label: string; value: string; note: string }) {
  return <div className="flex gap-4"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#edf2e9] font-bold">{icon}</span><div><p className="text-xs font-bold uppercase tracking-[.1em] text-[#718078]">{label}</p><p className="mt-1 font-bold">{value}</p><p className="mt-1 text-xs text-[#7d8983]">{note}</p></div></div>;
}

function paymentReleaseCopy(booking: Booking, timeZone?: string) {
  if (booking.refund?.status === "failed") return { label: "Refund needs review", detail: booking.refund.failureReason || "Stripe could not complete the refund. Contact support before taking another payment action." };
  if (booking.paymentStatus === "refunded") return { label: "Payment refunded", detail: `The payment was returned to the original payment method.${booking.paymentRelease.failureReason ? ` ${booking.paymentRelease.failureReason}` : ""}` };
  if (booking.paymentRelease.failureReason) return { label: "Payout needs attention", detail: booking.paymentRelease.failureReason };
  if (booking.paymentStatus !== "paid") return { label: "Payment not completed", detail: booking.quote.status === "accepted" ? "Customer approved this price. Payment through Stripe is required before the provider can mark the job complete." : "Payment is due after booking confirmation and before completion." };
  switch (booking.paymentRelease.status) {
    case "secured": return { label: "Payment secured · Awaiting completion", detail: "Stripe has collected the payment. The provider share stays held until the service is completed." };
    case "awaiting_customer": return { label: "48-hour review window", detail: `The provider marked the service complete. Confirm it or report a problem${booking.paymentRelease.confirmationDueAt ? ` before ${formatInUserTimeZone(booking.paymentRelease.confirmationDueAt, { dateStyle: "medium", timeStyle: "short" }, timeZone)}` : " within 48 hours"}. If you take no action, the provider payout releases automatically.` };
    case "processing": return { label: "Payout processing", detail: "The provider payout is being released through Stripe." };
    case "paid_out": return { label: "Paid out", detail: "The provider's full share has been released to their Stripe balance." };
    case "partially_released": return { label: "Partially released", detail: "Part of the provider payout was reversed because of a partial refund." };
    case "frozen": return { label: "Payout on hold", detail: "An administrator paused this payout while the booking is reviewed." };
    case "reversed": return { label: "Payout reversed", detail: "The provider payout was withheld or reversed because the payment was refunded." };
    case "failed": return { label: "Payout needs attention", detail: booking.paymentRelease.failureReason || "Stripe could not release this payout. BubsBookings support has been notified." };
    default: return { label: "Payment complete", detail: "Payment processed through Stripe." };
  }
}
