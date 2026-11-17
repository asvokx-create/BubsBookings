"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PLAN_ENTITLEMENTS, type ProviderPlan } from "@/lib/plans";
import type { ProviderPayoutSetupState } from "@/lib/provider-payout-status";

type StripeStatus = {
  configured: boolean;
  mode: "test" | "live";
  hasCustomer: boolean;
  subscriptionStatus: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  subscriptionStateVerified: boolean;
  extraTeamSeats: number;
  seatsUsed: number;
  trialEligible: boolean;
  complimentaryPro: { active: boolean; startsAt: string | null; expiresAt: string | null; lifetime: boolean };
  connect: { started: boolean; chargesEnabled: boolean; payoutsEnabled: boolean; state: ProviderPayoutSetupState; requirements: string[]; disabledReason: string | null; taxReportingStatus: string | null };
  ageVerification: { status: "not_started" | "pending" | "requires_input" | "verified" | "failed" };
};

export default function BillingPanel({ plan }: { plan: ProviderPlan }) {
  const current = PLAN_ENTITLEMENTS[plan];
  const [status, setStatus] = useState<StripeStatus | null>(null);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [seatDraft, setSeatDraft] = useState(0);

  useEffect(() => {
    const noticeTimer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      if (params.get("stripe") === "subscription-success") setNotice("Stripe received your subscription. Your plan or free trial will update after the secure webhook confirms it.");
      if (params.get("stripe") === "connect-return") setNotice("Payout details submitted. Stripe may take a moment to finish verification.");
      if (params.get("stripe") === "age-verification-return") setNotice("Age verification was submitted. Stripe may take a moment to finish reviewing it.");
      if (params.get("stripe") === "age-verification-error") setError("We could not open Stripe verification. Please try again in a moment.");
      if (params.get("stripe") === "tax-return") setNotice("Tax information submitted. Stripe will verify it and prepare eligible year-end forms.");
      if (params.get("stripe") === "cancelled") setNotice("Checkout was cancelled. Nothing was charged.");
    }, 0);
    fetch("/api/stripe/status", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<StripeStatus> : null)
      .then((data) => { setStatus(data); setSeatDraft(data?.extraTeamSeats ?? 0); })
      .catch(() => setError("We could not load Stripe status."));
    return () => window.clearTimeout(noticeTimer);
  }, []);

  async function openStripe(path: string, body?: Record<string, string>) {
    setWorking(path);
    setError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(path, { method: "POST", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
      const result = await response.json().catch(() => null) as { url?: string; error?: string } | null;
      if (!response.ok || !result?.url) {
        setError(result?.error ?? "We could not open Stripe right now. Please try again.");
        return;
      }
      window.location.assign(result.url);
    } catch {
      setError("We could not open Stripe right now. Please check your connection and try again.");
    } finally {
      window.clearTimeout(timeout);
      setWorking("");
    }
  }

  async function updateTeamSeats() {
    setWorking("team-seats"); setError(""); setNotice("");
    const response = await fetch("/api/stripe/team-seats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ extraSeats: seatDraft, operationId: crypto.randomUUID() }) }).catch(() => null);
    const result = response ? await response.json() as { extraTeamSeats?: number; error?: string } : null;
    setWorking("");
    if (!response?.ok || result?.extraTeamSeats === undefined) { setError(result?.error ?? "We could not update your employee seats."); return; }
    setStatus((currentStatus) => currentStatus ? { ...currentStatus, extraTeamSeats: result.extraTeamSeats! } : currentStatus);
    setSeatDraft(result.extraTeamSeats);
    setNotice(`Your Pro plan now includes ${3 + result.extraTeamSeats} total team seats.`);
  }

  async function changeSubscription(action: "cancel" | "resume") {
    if (action === "cancel") {
      if (!status?.currentPeriodEnd) {
        setError("We could not confirm your current billing-period end date. Refresh the page and try again.");
        return;
      }
      if (!window.confirm(`Cancel Pro renewal? You will keep Pro access through ${formatBillingDate(status.currentPeriodEnd)}, and Stripe will not renew the subscription after that date.`)) return;
    }
    setWorking(`subscription-${action}`); setError(""); setNotice("");
    const response = await fetch("/api/stripe/subscriptions/manage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, operationId: crypto.randomUUID() }),
    }).catch(() => null);
    const result = response ? await response.json() as { cancelAtPeriodEnd?: boolean; subscriptionStatus?: string; currentPeriodEnd?: string | null; inboxConfirmationCreated?: boolean; emailConfirmationSent?: boolean; localReconciled?: boolean; error?: string } : null;
    setWorking("");
    if (!response?.ok || result?.cancelAtPeriodEnd === undefined) {
      setError(result?.error ?? "We could not update your subscription. Please try again.");
      return;
    }
    setStatus((currentStatus) => currentStatus ? {
      ...currentStatus,
      cancelAtPeriodEnd: result.cancelAtPeriodEnd!,
      subscriptionStatus: result.subscriptionStatus ?? currentStatus.subscriptionStatus,
      currentPeriodEnd: result.currentPeriodEnd ?? currentStatus.currentPeriodEnd,
    } : currentStatus);
    const confirmationDelivery = result.emailConfirmationSent
      ? " A confirmation email was sent."
      : result.inboxConfirmationCreated ? " A confirmation is available in your BubsBookings inbox." : "";
    const reconciliationNotice = result.localReconciled === false ? " The billing page may need a moment to refresh." : "";
    setNotice((action === "cancel"
      ? `Stripe confirmed that your Pro subscription will not renew. You will keep access through ${formatBillingDate(result.currentPeriodEnd)}.`
      : "Stripe confirmed that your Pro subscription will continue and renew normally.") + confirmationDelivery + reconciliationNotice);
  }

  const providerAgeVerified = status?.ageVerification.status === "verified";
  const payoutReady = status?.connect.state === "ready" && providerAgeVerified;
  const taxReportingReady = status?.connect.taxReportingStatus === "active";
  const hasSubscription = status?.subscriptionStatus === "active" || status?.subscriptionStatus === "trialing" || status?.subscriptionStatus === "past_due";
  const complimentaryProActive = Boolean(status?.complimentaryPro.active);
  const seatPurchasesAllowed = status?.subscriptionStatus === "active" || status?.subscriptionStatus === "trialing";
  const isTrialing = status?.subscriptionStatus === "trialing";
  const isOwner = plan === "owner";
  const monthlyTotal = complimentaryProActive ? 0 : current.monthlyPrice + (plan === "pro" ? (status?.extraTeamSeats ?? 0) * 0.5 : 0);
  const trialEndLabel = status?.currentPeriodEnd
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(new Date(status.currentPeriodEnd))
    : "the date shown in Stripe";

  const cancellationScheduled = Boolean(hasSubscription && status?.cancelAtPeriodEnd);
  const platformFeeSummary = plan === "starter"
    ? "10% · max $200"
    : plan === "pro"
      ? "6% · max $100"
      : `${current.bookingFeePercent}%`;
  const payoutExplanation = plan === "starter"
    ? "Your service earnings equal the service subtotal minus the 10% BubsBookings platform fee, capped at $200, and the provider-allocated Stripe processing cost."
    : plan === "pro"
      ? "Your service earnings equal the service subtotal minus the 6% BubsBookings platform fee, capped at $100, and the provider-allocated Stripe processing cost."
      : `BubsBookings keeps the ${current.bookingFeePercent}% plan fee and Stripe sends your share to your payout account.`;

  return <div>
    <div><div className="flex flex-wrap items-center gap-3"><p className="text-sm font-semibold text-[#687a70]">Billing & subscription</p>{status && <span className={`rounded-full px-3 py-1 text-xs font-bold ${status.mode === "live" ? "bg-[#e6f2e6] text-[#34704a]" : "bg-[#fff3c4] text-[#775f00]"}`}>{status.mode === "live" ? "Live payments" : "Test mode"}</span>}</div><h1 className="mt-1 text-3xl font-bold tracking-[-.04em] sm:text-4xl">Billing & payouts</h1><p className="mt-2 text-sm text-[#687a70]">Manage your provider plan, customer payments, and Stripe payouts.</p></div>
    {notice && <p role="status" className="mt-5 rounded-2xl bg-[#e6f2e6] px-5 py-4 text-sm font-bold text-[#34704a]">{notice}</p>}
    {error && <p role="alert" className="mt-5 rounded-2xl bg-[#fff0e8] px-5 py-4 text-sm font-bold text-[#964f2c]">{error}</p>}
    {complimentaryProActive && <div className="mt-5 rounded-2xl border border-[#8cb795] bg-[#e9f4e8] px-5 py-4"><p className="font-bold text-[#245b3d]">Complimentary Pro</p><p className="mt-1 text-sm text-[#34704a]">{status?.complimentaryPro.lifetime ? "Your complimentary Pro access does not expire." : `You have complimentary Pro access until ${formatComplimentaryExpiration(status?.complimentaryPro.expiresAt)}.`} You will not be charged a Pro subscription fee. {status?.complimentaryPro.lifetime ? "No paid subscription will be created automatically." : "When your complimentary access expires, your account will automatically return to Starter unless you choose to subscribe to Pro."} Booking commissions and Stripe processing costs still apply.</p></div>}
    {status && !status.subscriptionStateVerified && hasSubscription && <p role="alert" className="mt-5 rounded-2xl bg-[#fff9d9] px-5 py-4 text-sm font-bold text-[#775f00]">Stripe could not refresh your subscription status. The date and renewal setting shown below are the last Stripe-confirmed values. Refresh before making a change.</p>}
    <div className="mt-7 grid gap-6 xl:grid-cols-[1.1fr_.9fr]">
      <section className="rounded-[2rem] bg-[#183126] p-7 text-white"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.14em] text-[#b4c5bc]">Current plan</p><h2 className="mt-2 text-3xl font-bold">{current.name}</h2></div><span className="rounded-full bg-[#eee25a] px-4 py-2 text-xs font-bold text-[#183126]">{isOwner ? "Private" : cancellationScheduled ? "Cancellation scheduled" : isTrialing ? "Trial active" : "Active"}</span></div><p className="mt-7 text-4xl font-bold">${isTrialing ? "0.00" : monthlyTotal.toFixed(2)}<span className="text-sm font-normal text-[#b7c7be]">{isTrialing ? " during trial" : " / month"}</span></p>{isTrialing && <p className="mt-2 text-sm font-semibold text-[#d8e5dd]">{cancellationScheduled ? `Your trial ends ${trialEndLabel}. You will not be charged.` : `Renews at $${monthlyTotal.toFixed(2)}/month on ${trialEndLabel} unless canceled.`}</p>}{cancellationScheduled && !isTrialing && <p className="mt-2 text-sm font-semibold text-[#d8e5dd]">Pro access continues through {trialEndLabel}. Your subscription will not renew.</p>}{plan === "pro" && Boolean(status?.extraTeamSeats) && <p className="mt-1 text-xs text-[#b7c7be]">$9.99 Pro + ${((status?.extraTeamSeats ?? 0) * 0.5).toFixed(2)} employee seats</p>}<div className="mt-6 grid gap-3 sm:grid-cols-2"><BillingFact label="Platform fee" value={platformFeeSummary} /><BillingFact label="Stripe processing" value="Separate actual cost" /><BillingFact label="Services" value={current.serviceLimit === null ? "Unlimited" : `Up to ${current.serviceLimit}`} /><BillingFact label="Team seats" value={current.teamSeatLimit === null ? "Unlimited" : String(current.teamSeatLimit + (plan === "pro" ? status?.extraTeamSeats ?? 0 : 0))} /><BillingFact label="Features" value={isOwner ? "All unlocked" : current.advancedAnalytics ? "Advanced" : "Essentials"} /></div>{(plan === "starter" || plan === "pro") && <p className="mt-4 text-xs leading-5 text-[#d8e5dd]">The maximum shown applies only to the BubsBookings platform fee for each booking. Stripe processing is separate, varies by transaction, and is deducted from provider earnings after Stripe reports the actual cost.</p>}{!isOwner && !hasSubscription && status?.trialEligible && <p className="mt-6 rounded-2xl bg-white/10 p-4 text-sm leading-6 text-[#d8e5dd]"><strong className="text-white">Try Pro free for 30 days.</strong> A card is required. You will pay $9.99 per month after the trial unless you cancel before it ends.</p>}<div className="mt-7 flex flex-wrap gap-2">{isOwner ? <span className="rounded-full bg-white/10 px-5 py-3 text-sm font-bold">Only your owner account can use this plan</span> : hasSubscription ? <><button disabled={Boolean(working)} onClick={() => void openStripe("/api/stripe/customer-portal")} className="rounded-full bg-white px-5 py-3 text-sm font-bold text-[#183126] transition hover:bg-[#eee25a] disabled:opacity-50">Manage billing</button><button disabled={Boolean(working)} onClick={() => void changeSubscription(cancellationScheduled ? "resume" : "cancel")} className={`rounded-full border px-5 py-3 text-sm font-bold transition disabled:opacity-50 ${cancellationScheduled ? "border-[#eee25a]/60 text-[#fff6a5] hover:bg-white/10" : "border-white/25 text-white hover:bg-white/10"}`}>{working.startsWith("subscription-") ? "Updating…" : cancellationScheduled ? "Keep Pro plan" : "Cancel subscription"}</button></> : <button disabled={Boolean(working) || !status?.configured} onClick={() => void openStripe("/api/stripe/subscriptions/checkout", { plan: "pro" })} className="rounded-full bg-[#eee25a] px-5 py-3 text-sm font-bold text-[#183126] hover:bg-[#f5ea6b] disabled:opacity-50">{status?.trialEligible ? "Start 30-day free trial" : "Choose Pro for $9.99"}</button>}<Link href="/pricing" className="rounded-full border border-white/20 px-5 py-3 text-sm font-bold hover:bg-white/10">Compare plans</Link></div></section>
      <section id="provider-eligibility" className={`scroll-mt-24 rounded-[2rem] border p-7 ${payoutReady ? "border-[#8cb795] bg-[#e9f4e8]" : "border-[#d8cb63] bg-[#fff9d9]"}`}><span className="text-3xl">{payoutReady ? "✓" : "💳"}</span><h2 className="mt-4 text-xl font-bold">{payoutReady ? "Payouts are ready" : !providerAgeVerified ? "Verify your provider eligibility" : status?.connect.state === "under_review" ? "Stripe is reviewing your details" : status?.connect.state === "action_required" ? "Payout setup needs attention" : "Connect provider payouts"}</h2><p className="mt-2 text-sm leading-6 text-[#706942]">{payoutReady ? "Customers can pay confirmed bookings through Stripe. Stripe sends the provider share to your connected payout account." : !providerAgeVerified ? status?.ageVerification.status === "pending" ? "Stripe is reviewing your age-verification document. Listings, booking acceptance, and payouts remain unavailable until it is complete." : "Providers must satisfy the 18+ age requirement through Stripe document verification or an independently reviewed admin pass. Stripe payout onboarding and other account requirements remain separate." : status?.connect.state === "under_review" ? "Your information was submitted. Stripe will enable booking payments after verification finishes." : status?.connect.state === "action_required" ? "Stripe needs additional information before payouts can be enabled." : "Complete Stripe’s identity and bank setup before customers can pay for their confirmed bookings."}</p>{status?.connect.requirements.length ? <div className="mt-4 rounded-2xl bg-white/70 p-4"><p className="text-xs font-bold uppercase tracking-wider">Still needed</p><ul className="mt-2 space-y-1 text-xs text-[#706942]">{status.connect.requirements.slice(0, 5).map((item) => <li key={item}>• {item.replaceAll("_", " ").replaceAll(".", " › ")}</li>)}</ul></div> : null}{!providerAgeVerified && <button type="button" onClick={() => void openStripe("/api/stripe/provider-age-verification")} disabled={Boolean(working) || !status || status.configured === false || status.ageVerification.status === "pending"} aria-busy={working === "/api/stripe/provider-age-verification"} className="mt-5 min-w-40 rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white hover:bg-[#315846] disabled:cursor-wait disabled:opacity-60">{working === "/api/stripe/provider-age-verification" ? "Opening Stripe..." : status?.ageVerification.status === "pending" ? "Verification in progress" : status?.ageVerification.status === "requires_input" ? "Continue age verification" : "Verify age with Stripe"}</button>}<button disabled={Boolean(working) || status?.configured === false} onClick={() => void openStripe("/api/stripe/connect")} aria-busy={working === "/api/stripe/connect"} className="mt-3 min-w-40 rounded-full border border-[#183126]/20 bg-white px-5 py-3 text-sm font-bold text-[#183126] hover:bg-[#f6f7f2] disabled:cursor-wait disabled:opacity-60">{working === "/api/stripe/connect" ? "Opening Stripe..." : payoutReady ? "Review payout account" : status?.connect.started ? "Continue payout setup" : "Set up payouts"}</button>{working === "/api/stripe/connect" && <p role="status" className="mt-3 text-xs font-semibold text-[#706942]">Creating a Stripe connection. This normally takes a few seconds.</p>}{!status && !error && <p className="mt-3 text-xs text-[#706942]">Checking payment status... You can still begin payout setup.</p>}{!status?.configured && status && <p className="mt-4 rounded-2xl bg-white/70 p-4 text-xs font-semibold leading-5 text-[#776f45]">Stripe is installed in the app, but the administrator still needs to add the Stripe API key and webhook secret.</p>}</section>
    </div>
    {plan === "pro" && hasSubscription && <TeamSeatAddon currentExtraSeats={status?.extraTeamSeats ?? 0} seatsUsed={status?.seatsUsed ?? 1} seatDraft={seatDraft} working={working === "team-seats"} trialing={isTrialing} disabled={!seatPurchasesAllowed} onChange={setSeatDraft} onSave={() => void updateTeamSeats()} />}
    <section className="mt-6 rounded-[2rem] border border-[#183126]/10 bg-white p-7"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-bold">How payments work</h2><p className="mt-1 text-sm text-[#738179]">Clear separation between your subscription and customer booking money.</p></div><span className="rounded-full bg-[#edf2e8] px-3 py-1.5 text-xs font-bold">Powered by Stripe</span></div><div className="mt-6 grid gap-4 md:grid-cols-3"><Step number="1" title="Confirm the booking" body="Approve the customer’s request and any custom quote first." /><Step number="2" title="Customer pays" body="The customer uses Stripe Checkout from their booking page." /><Step number="3" title="Stripe pays you" body={payoutExplanation} /></div></section>
    <section className="mt-6 rounded-[2rem] border border-[#183126]/10 bg-white p-7"><div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center"><div><div className="flex flex-wrap items-center gap-2"><p className="text-xs font-bold uppercase tracking-[.14em] text-[#718078]">Tax center</p><span className={`rounded-full px-3 py-1 text-[11px] font-bold ${taxReportingReady ? "bg-[#e5f1e5] text-[#34704a]" : "bg-[#fff3c4] text-[#775f00]"}`}>{taxReportingReady ? "Tax details ready" : "Setup required"}</span></div><h2 className="mt-2 text-xl font-bold">Year-end 1099 documents</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-[#687970]">Stripe collects the required tax information and prepares forms for eligible US providers after the tax year ends. When a form is available, you can securely view and download it from Stripe.</p></div><button disabled={Boolean(working) || !status?.connect.started} onClick={() => void openStripe("/api/stripe/tax-documents", { action: taxReportingReady ? "dashboard" : "setup" })} className="shrink-0 rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#315846] disabled:opacity-50">{working === "/api/stripe/tax-documents" ? "Opening Stripe…" : taxReportingReady ? "Open tax documents" : "Complete tax setup"}</button></div><div className="mt-5 rounded-2xl bg-[#f5f5ef] p-4 text-xs leading-5 text-[#718078]"><strong className="text-[#183126]">Important:</strong> A form is issued only when required under the applicable tax rules and BubsBookings&apos; configured Stripe filing settings. Providers remain responsible for their own records and taxes. This is not tax advice.</div></section>
  </div>;
}

function BillingFact({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl bg-white/10 p-4"><p className="text-xs text-[#b8c7bf]">{label}</p><p className="mt-1 font-bold">{value}</p></div>; }
function formatBillingDate(value: string | null | undefined) { return value ? new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(new Date(value)) : "the end of the current billing period"; }
function formatComplimentaryExpiration(value: string | null | undefined) { return value ? new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value)) : "the stated expiration time"; }
function Step({ number, title, body }: { number: string; title: string; body: string }) { return <div className="rounded-2xl bg-[#f5f5ef] p-5"><span className="grid h-8 w-8 place-items-center rounded-full bg-[#eee25a] text-xs font-bold">{number}</span><p className="mt-4 font-bold">{title}</p><p className="mt-2 text-xs leading-5 text-[#718078]">{body}</p></div>; }

function TeamSeatAddon({ currentExtraSeats, seatsUsed, seatDraft, working, trialing, disabled, onChange, onSave }: { currentExtraSeats: number; seatsUsed: number; seatDraft: number; working: boolean; trialing: boolean; disabled: boolean; onChange: (value: number) => void; onSave: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const minimumExtraSeats = Math.max(seatsUsed - 3, 0);
  const newTotalSeats = 3 + seatDraft;
  const newRecurringTotal = 9.99 + seatDraft * 0.5;
  return <section className="mt-6 rounded-[2rem] border border-[#183126]/10 bg-white p-5 sm:p-7"><div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-center"><div><div className="flex flex-wrap items-center gap-2"><p className="text-xs font-bold uppercase tracking-[.14em] text-[#718078]">Team add-on</p><span className="rounded-full bg-[#e7f1e3] px-3 py-1 text-[11px] font-bold text-[#34704a]">3 total seats included</span></div><h2 className="mt-2 text-xl font-bold">Extra employee seats</h2><p className="mt-2 max-w-xl text-sm leading-6 text-[#687970]">Your owner account uses one included seat and two included seats remain for workers. Active workers and pending invitations both use capacity. Every additional seat is $0.50/month.</p><div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4"><BillingFact label="Seats used" value={String(seatsUsed)} /><BillingFact label="Current capacity" value={String(3 + currentExtraSeats)} /><BillingFact label="Purchased extras" value={String(currentExtraSeats)} /><BillingFact label="Extra cost" value={`$${(currentExtraSeats * 0.5).toFixed(2)}/mo`} /></div></div><div className="flex w-full flex-col gap-3 rounded-2xl bg-[#f5f5ef] p-4 lg:max-w-[370px]"><div className="flex items-center justify-between gap-4"><button type="button" onClick={() => onChange(Math.max(minimumExtraSeats, seatDraft - 1))} disabled={seatDraft <= minimumExtraSeats || working || disabled} aria-label="Remove one extra employee seat" className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-[#183126]/15 bg-white text-xl font-bold disabled:opacity-40">−</button><div className="min-w-0 text-center"><p className="text-2xl font-bold">{seatDraft}</p><p className="text-xs text-[#718078]">extra {seatDraft === 1 ? "seat" : "seats"}</p></div><button type="button" onClick={() => onChange(Math.min(97, seatDraft + 1))} disabled={seatDraft === 97 || working || disabled} aria-label="Add one extra employee seat" className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#183126] text-xl font-bold text-white disabled:opacity-40">+</button></div><dl className="space-y-2 border-t border-[#183126]/10 pt-3 text-sm"><div className="flex justify-between gap-4"><dt className="text-[#687970]">New total seats</dt><dd className="font-bold">{newTotalSeats}</dd></div><div className="flex justify-between gap-4"><dt className="text-[#687970]">Extra seats</dt><dd className="font-bold">{seatDraft} × $0.50</dd></div><div className="flex justify-between gap-4"><dt className="text-[#687970]">Extra monthly charge</dt><dd className="font-bold">${(seatDraft * 0.5).toFixed(2)}</dd></div><div className="flex justify-between gap-4 border-t border-[#183126]/10 pt-2"><dt className="font-bold">Recurring total</dt><dd className="font-bold">${newRecurringTotal.toFixed(2)}/mo</dd></div></dl><button disabled={working || disabled || seatDraft === currentExtraSeats} onClick={() => setConfirming(true)} className="min-h-11 rounded-full bg-[#eee25a] px-5 py-3 text-sm font-bold disabled:opacity-50">{working ? "Updating Stripe…" : "Review seat change"}</button>{disabled && <p role="alert" className="text-xs font-semibold leading-5 text-[#914e3a]">Resolve the subscription payment issue before changing paid seats. Existing team access remains available during Stripe&apos;s retry period.</p>}</div></div><p className="mt-4 text-xs leading-5 text-[#718078]">{trialing ? "Extra seats are free for the rest of your trial. Their monthly cost starts with the first subscription charge on the trial-end date." : "Stripe prorates increases and reductions for the current billing period. Removing a worker frees capacity but never lowers billing unless you choose a lower quantity here."}</p>{confirming && <div role="presentation" className="fixed inset-0 z-[100] grid place-items-center bg-black/45 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirming(false); }}><div role="dialog" aria-modal="true" aria-labelledby="seat-confirm-title" className="w-full max-w-md rounded-[2rem] bg-white p-6 shadow-2xl"><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Confirm subscription change</p><h3 id="seat-confirm-title" className="mt-2 text-2xl font-bold">{seatDraft > currentExtraSeats ? "Add" : "Reduce"} paid team seats?</h3><p className="mt-3 text-sm leading-6 text-[#687970]">Your Pro subscription will include {newTotalSeats} total seats. The recurring total will be ${newRecurringTotal.toFixed(2)}/month, with Stripe applying any current-period proration.</p><div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={() => setConfirming(false)} className="min-h-11 rounded-full border border-[#183126]/15 px-5 py-3 text-sm font-bold">Go back</button><button type="button" autoFocus onClick={() => { setConfirming(false); onSave(); }} className="min-h-11 rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white">Confirm change</button></div></div></div>}</section>;
}
