"use client";

import Link from "next/link";
import CustomSelect from "@/components/custom-select";
import { projectCapMinutes, MAX_PROJECT_CAP_MINUTES } from "@/components/hourly-project-cap";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ServiceDeliveryType } from "@/lib/service-delivery";

const input = "mt-2 w-full rounded-xl border border-[#183126]/20 bg-white px-3 py-3 text-base";
const button = "min-h-11 rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white disabled:opacity-50";
const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function HourlyProjectRequest({ serviceId, hourlyRateCents, serviceTitle, provider, serviceCity, serviceState, deliveryType, isSignedIn, returnPath, bookingDisabled = false }: {
  serviceId: string; hourlyRateCents: number | null; serviceTitle: string; provider: string; serviceCity: string; serviceState: string; deliveryType: ServiceDeliveryType; isSignedIn: boolean; returnPath: string; bookingDisabled?: boolean;
}) {
  const router = useRouter();
  const [delivery, setDelivery] = useState(deliveryType === "BOTH" ? "" : deliveryType);
  const [hours, setHours] = useState("");
  const [minutes, setMinutes] = useState("");
  const cap = projectCapMinutes(hours, minutes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const lock = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || uncertain) return;
    if (cap === null) { setError("Enter a valid maximum work time of at least 1 minute and no more than 1,000 hours."); return; }
    const form = new FormData(event.currentTarget);
    lock.current = true;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/hourly-projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serviceId, title: serviceTitle, description: form.get("description"), capMinutes: cap, deliveryMethod: delivery, addressLine1: form.get("addressLine1") ?? "", addressLine2: form.get("addressLine2") ?? "", city: form.get("city") ?? "", state: form.get("state") ?? "", postalCode: form.get("postalCode") ?? "", accessInstructions: form.get("accessInstructions") ?? "" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not request this project.");
      const id = data.project?.id ?? data.projectId;
      if (!id) { setUncertain(true); throw new Error("The request may have been saved. Check your projects before submitting again."); }
      router.push(`/account/projects/${id}`);
    } catch (cause) {
      if (cause instanceof TypeError) setUncertain(true);
      setError(cause instanceof TypeError ? "Connection interrupted. Your request may have been saved. Check your projects before submitting again." : cause instanceof Error ? cause.message : "Could not request this project.");
    } finally { setBusy(false); lock.current = false; }
  }
  return <section className="rounded-[2rem] border border-[#183126]/10 bg-white p-5 shadow-lg sm:p-7">
    <p className="text-xs font-bold uppercase tracking-widest text-[#687a70]">Tracked hourly project</p>
    <h2 className="mt-2 text-2xl font-bold">Request a project</h2>
    <p className="mt-3 text-sm leading-6">{provider} tracks the work at <strong>{money(hourlyRateCents ?? 0)}/hour</strong>. Review one final timesheet, then approve and pay. No upfront payment or automatic charges.</p>
    {!isSignedIn ? <Link className={`${button} mt-5 inline-flex`} href={`/login?redirect=${encodeURIComponent(returnPath)}`}>Log in to request a project</Link> : bookingDisabled ? <p role="status" className="mt-5 rounded-xl bg-amber-50 p-4">This provider is not accepting new projects right now.</p> : <form onSubmit={submit} className="mt-5 space-y-4">
      <fieldset disabled={busy || uncertain} className="space-y-4 disabled:opacity-60">
        <label className="block text-sm font-bold">What needs to be done?<textarea name="description" required minLength={3} maxLength={3000} rows={4} className={input} placeholder="Describe the project, desired outcome, and timing." /></label>
        <fieldset className="min-w-0" aria-describedby="project-cap-help">
          <legend className="text-sm font-bold">Maximum approved work time</legend>
          <div className="grid grid-cols-2 gap-3">
            <label className="block min-w-0 text-sm">Hours<input type="number" inputMode="numeric" value={hours} onChange={e => setHours(e.target.value)} min={0} max={MAX_PROJECT_CAP_MINUTES / 60} step={1} placeholder="0" className={input} aria-describedby="project-cap-help" /></label>
            <label className="block min-w-0 text-sm">Minutes<input type="number" inputMode="numeric" value={minutes} onChange={e => setMinutes(e.target.value)} min={0} max={59} step={1} placeholder="0" className={input} aria-describedby="project-cap-help" /></label>
          </div>
        </fieldset>
        <p id="project-cap-help" className="text-sm leading-6 text-[#687a70]">Enter hours and/or minutes (at least 1 minute). This is a spending limit, not hours purchased. Only completed, approved work is billed by the aggregate minute. You can increase the limit later.</p>
        <div aria-live="polite">{cap !== null && <p className="rounded-xl bg-[#f5f7f2] p-3 text-sm">Maximum labor: <strong>{money(Math.round((hourlyRateCents ?? 0) * cap / 60))}</strong>, plus one $2.99 service fee at final payment.</p>}</div>
        <label className="block text-sm font-bold">Service delivery<CustomSelect ariaLabel="Service delivery" required buttonClassName={input} value={delivery} onChange={value => setDelivery(value as typeof delivery)}><option value="" disabled>Choose delivery</option>{deliveryType !== "REMOTE" && <option value="IN_PERSON">In person</option>}{deliveryType !== "IN_PERSON" && <option value="REMOTE">Remote</option>}</CustomSelect></label>
        {delivery === "IN_PERSON" && <div className="space-y-3"><label className="block text-sm font-bold">Street address<input name="addressLine1" autoComplete="address-line1" required maxLength={120} className={input} /></label><label className="block text-sm font-bold">Apartment / unit (optional)<input name="addressLine2" autoComplete="address-line2" maxLength={80} className={input} /></label><label className="block text-sm font-bold">City<input name="city" autoComplete="address-level2" defaultValue={serviceCity} required maxLength={80} className={input} /></label><div className="grid grid-cols-2 gap-3"><label className="block text-sm font-bold">State<input name="state" autoComplete="address-level1" defaultValue={serviceState} required pattern="[A-Za-z]{2}" maxLength={2} className={input} /></label><label className="block text-sm font-bold">ZIP code<input name="postalCode" autoComplete="postal-code" required pattern="[0-9]{5}(-[0-9]{4})?" maxLength={10} className={input} /></label></div><label className="block text-sm font-bold">Access instructions (optional)<textarea name="accessInstructions" maxLength={500} className={input} /></label></div>}
        <button disabled={!hourlyRateCents} className={`${button} w-full`}>{busy ? "Sending request…" : "Send project request"}</button>
      </fieldset>
      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    </form>}
    <Link href="/account/projects" className="mt-5 inline-block text-sm font-bold underline underline-offset-4">View my hourly projects</Link>
  </section>;
}
