"use client";

import { useMemo, useState } from "react";
import { maximumTipCents, MINIMUM_TIP_CENTS, requiresHighTipConfirmation, TIP_PERCENTAGES } from "@/lib/tips";

type Tip = {
  amount: number;
  type: "percentage" | "custom" | null;
  percentage: number | null;
  status: "none" | "pending" | "paid" | "failed" | "cancelled" | "refunded" | "partially_refunded" | "disputed";
  transferStatus: string;
  refundedAmount: number;
  failureReason: string | null;
};

function dollarsFromCents(cents: number) { return `$${(cents / 100).toFixed(2)}`; }

function parseCurrencyToCents(value: string) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, decimals = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number((decimals + "00").slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

export default function BookingTip({ bookingId, serviceSubtotal, tip, eligible }: { bookingId: string; serviceSubtotal: number; tip: Tip; eligible: boolean }) {
  const [selection, setSelection] = useState<"percentage" | "custom" | null>(null);
  const [percentage, setPercentage] = useState<number | null>(null);
  const [custom, setCustom] = useState("");
  const [highTipConfirmed, setHighTipConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const subtotalCents = Math.round(serviceSubtotal * 100);
  const amountCents = selection === "percentage" && percentage ? Math.round(subtotalCents * percentage / 100) : selection === "custom" ? parseCurrencyToCents(custom) : null;
  const highTip = amountCents !== null && requiresHighTipConfirmation(amountCents, subtotalCents);
  const maximum = maximumTipCents(subtotalCents);
  const paidOrFinal = ["paid", "refunded", "partially_refunded", "disputed"].includes(tip.status);

  async function continueToCheckout() {
    if (!selection || amountCents === null) { setError("Choose a tip amount before continuing."); return; }
    if (amountCents < MINIMUM_TIP_CENTS || amountCents > maximum) { setError(`Enter a tip from ${dollarsFromCents(MINIMUM_TIP_CENTS)} to ${dollarsFromCents(maximum)}.`); return; }
    if (highTip && !highTipConfirmed) { setError("Confirm this unusually large tip before continuing."); return; }
    setWorking(true); setError("");
    const response = await fetch(`/api/stripe/bookings/${bookingId}/tip/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: selection, percentage, amountCents, highTipConfirmed }) }).catch(() => null);
    const result = response ? await response.json() as { url?: string; error?: string } : null;
    if (!response?.ok || !result?.url) { setError(result?.error ?? "We could not open Stripe checkout for your tip."); setWorking(false); return; }
    window.location.assign(result.url);
  }

  const statusCopy = useMemo(() => {
    if (tip.status === "pending") return "Tip payment is awaiting confirmation";
    if (tip.status === "paid") return tip.transferStatus === "paid_out" ? "Tip paid to provider" : "Tip payment received";
    if (tip.status === "partially_refunded") return "Tip partially refunded";
    if (tip.status === "refunded") return "Tip refunded";
    if (tip.status === "disputed") return "Tip under payment review";
    return tip.status === "failed" ? "Tip payment was not completed" : "Tip checkout was cancelled";
  }, [tip.status, tip.transferStatus]);

  if (paidOrFinal) return <section className="mt-6 rounded-[2rem] border border-[#183126]/10 bg-white p-6 sm:p-8"><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Tip</p><div className="mt-2 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-2xl font-bold">{statusCopy}</h2><p className="mt-2 text-sm leading-6 text-[#61736a]">{dollarsFromCents(Math.round(tip.amount * 100))}{tip.percentage ? ` · ${tip.percentage}% of the service subtotal` : " · Custom amount"}{tip.refundedAmount > 0 ? ` · ${dollarsFromCents(Math.round(tip.refundedAmount * 100))} refunded` : ""}</p></div><span className="rounded-full bg-[#e7f1e5] px-3 py-1 text-xs font-bold text-[#35704a]">Thank you</span></div></section>;
  if (!eligible && tip.status === "none") return null;

  return <section className="mt-6 rounded-[2rem] border border-[#183126]/10 bg-white p-6 sm:p-8"><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Optional</p><h2 className="mt-2 text-2xl font-bold">Add a tip</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-[#61736a]">Thank your provider if you&apos;d like. 100% of your tip goes to your provider; BubsBookings covers payment processing costs.</p>
    {tip.status !== "none" && <p className="mt-4 rounded-2xl bg-[#fff5d5] p-4 text-sm font-semibold text-[#72632b]">{statusCopy}{tip.status === "pending" ? ". Check this booking again later for an update." : tip.failureReason ? `: ${tip.failureReason}` : ". You can try again when you are ready."}</p>}
    <div className="mt-5 grid gap-3 min-[390px]:grid-cols-3" role="group" aria-label="Tip amount">
      {TIP_PERCENTAGES.map((option) => { const selected = selection === "percentage" && percentage === option; const amount = Math.round(subtotalCents * option / 100); return <button key={option} type="button" aria-pressed={selected} onClick={() => { setSelection("percentage"); setPercentage(option); setCustom(""); setHighTipConfirmed(false); setError(""); }} className={`rounded-2xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#eee25a]/60 ${selected ? "border-[#183126] bg-[#e7eee2]" : "border-[#183126]/15 bg-[#fafaf6] hover:bg-[#f1f5ee]"}`}><span className="block text-lg font-bold">{option}%</span><span className="mt-1 block text-sm text-[#61736a]">{dollarsFromCents(amount)}</span></button>; })}
    </div>
    <div className="mt-3 grid gap-3 sm:grid-cols-2"><button type="button" aria-pressed={selection === "custom"} onClick={() => { setSelection("custom"); setPercentage(null); setHighTipConfirmed(false); setError(""); }} className={`rounded-2xl border px-4 py-3 text-left text-sm font-bold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#eee25a]/60 ${selection === "custom" ? "border-[#183126] bg-[#e7eee2]" : "border-[#183126]/15 bg-[#fafaf6] hover:bg-[#f1f5ee]"}`}>Custom amount</button><button type="button" aria-pressed={selection === null} onClick={() => { setSelection(null); setPercentage(null); setCustom(""); setHighTipConfirmed(false); setError(""); }} className={`rounded-2xl border px-4 py-3 text-left text-sm font-bold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#eee25a]/60 ${selection === null ? "border-[#183126] bg-[#e7eee2]" : "border-[#183126]/15 bg-[#fafaf6] hover:bg-[#f1f5ee]"}`}>No tip</button></div>
    {selection === "custom" && <label className="mt-4 block max-w-sm text-sm font-bold">Custom tip amount<input aria-describedby="tip-limit" autoComplete="off" inputMode="decimal" value={custom} onChange={(event) => { setCustom(event.target.value); setError(""); }} placeholder="0.00" className="mt-2 w-full rounded-xl border border-[#183126]/15 bg-[#fafaf6] px-4 py-3 text-base outline-none focus:border-[#4d725d] focus:ring-2 focus:ring-[#eee25a]/50" /></label>}
    {selection !== null && amountCents !== null && <p id="tip-limit" className="mt-3 text-sm text-[#61736a]">Tip: <strong>{dollarsFromCents(amountCents)}</strong> · calculated from the {dollarsFromCents(subtotalCents)} service subtotal only.</p>}
    {highTip && <label className="mt-4 flex items-start gap-3 rounded-2xl bg-[#fff5d5] p-4 text-sm leading-5 text-[#675c2b]"><input type="checkbox" checked={highTipConfirmed} onChange={(event) => setHighTipConfirmed(event.target.checked)} className="mt-0.5 h-4 w-4 accent-[#183126]" />I confirm that I want to leave this unusually large tip.</label>}
    {error && <p role="alert" className="mt-4 text-sm font-semibold text-[#9a4e3c]">{error}</p>}
    <div className="mt-5 flex flex-wrap items-center gap-3"><button type="button" disabled={working || selection === null} onClick={() => void continueToCheckout()} className="rounded-full bg-[#183126] px-6 py-3 text-sm font-bold text-white transition hover:bg-[#315846] disabled:cursor-not-allowed disabled:opacity-45">{working ? "Opening Stripe…" : "Continue to secure tip"}</button><span className="text-xs leading-5 text-[#718078]">You are charged only after confirming in Stripe.</span></div>
  </section>;
}
