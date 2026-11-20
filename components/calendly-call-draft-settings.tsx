"use client";

import { useEffect, useRef, useState } from "react";
import CustomSelect from "@/components/custom-select";
import { parseCallPriceDollars } from "@/lib/calendly-call-drafts";

type Draft = {
  event_type_uri: string | null; event_type_name: string | null; billing_mode: "free" | "paid" | null;
  service_price_cents: number | null; revision: string | null; connection_current: boolean;
};
type Service = Draft & { id: string; title: string };
type Settings = { enabled?: boolean; ready?: boolean; error?: string; services?: Service[]; eventTypes?: { uri: string; name: string; durationMinutes: number }[] };

export default function CalendlyCallDraftSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [serviceId, setServiceId] = useState("");
  const [eventUri, setEventUri] = useState("");
  const [billingMode, setBillingMode] = useState<"" | "free" | "paid">("");
  const [price, setPrice] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [needsReload, setNeedsReload] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const selected = settings?.services?.find(service => service.id === serviceId);

  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    fetch("/api/integrations/calendly/call-drafts", { cache: "no-store", signal: abort.signal })
      .then(async response => {
        const data = await response.json() as Settings;
        if (abort.signal.aborted) return;
        if (!response.ok && !data.enabled) throw new Error("Call drafts could not be loaded. Reload to try again.");
        setSettings(data);
      })
      .catch(() => { if (!abort.signal.aborted) setMessage("Call drafts could not be loaded. Reload to try again."); });
    return () => { abort.abort(); controller.current?.abort(); };
  }, []);

  function selectService(value: string) {
    const service = settings?.services?.find(item => item.id === value);
    setServiceId(value); setEventUri(service?.event_type_uri ?? ""); setBillingMode(service?.billing_mode ?? "");
    setPrice(service?.billing_mode === "paid" && service.service_price_cents !== null ? (service.service_price_cents / 100).toFixed(2) : "");
    setMessage("");
  }

  async function save(remove = false) {
    if (!selected || inFlight.current || needsReload) return;
    const amount = billingMode === "free" ? 0 : parseCallPriceDollars(price);
    if (!remove && (!eventUri || !billingMode || amount === null)) { setMessage("Choose an event and free or paid. Paid service prices must be $0.50–$1,000,000 USD with at most two decimal places."); return; }
    const abort = new AbortController(); controller.current = abort; inFlight.current = true;
    setWorking(true); setMessage("");
    let responseRecognized = false;
    try {
      const response = await fetch("/api/integrations/calendly/call-drafts", {
        method: "PUT", headers: { "Content-Type": "application/json" }, signal: abort.signal,
        body: JSON.stringify({ serviceId, eventTypeUri: eventUri, billingMode, servicePriceCents: amount, revision: selected.revision, remove }),
      });
      const data = await response.json() as { error?: string; status?: string; draft?: Draft | null };
      responseRecognized = Boolean(data && typeof data === "object" && (response.ok
        ? data.status === "draft_only" && (remove ? data.draft === null : data.draft && typeof data.draft.revision === "string")
        : typeof data.error === "string"));
      if (!responseRecognized || !response.ok) {
        // A stale revision or uncertain response must be checked before retrying.
        if (!abort.signal.aborted && (response.status === 409 || response.status >= 500 || response.ok)) setNeedsReload(true);
        throw new Error(data?.error ?? "Saving could not be confirmed. Reload to check the draft.");
      }
      if (abort.signal.aborted) return;
      const draft = data.draft ?? { event_type_uri: null, event_type_name: null, billing_mode: null, service_price_cents: null, revision: null, connection_current: false };
      setSettings(current => current ? { ...current, services: current.services?.map(service => service.id === serviceId ? { ...service, ...draft } : service) } : current);
      if (remove) { setEventUri(""); setBillingMode(""); setPrice(""); }
      setMessage(remove ? "Draft removed. Existing bookings and the public preview were not changed." : "Draft saved, not enabled. Existing listing prices, bookings, checkout and the public preview were not changed.");
    } catch (caught) {
      if (!abort.signal.aborted) {
        if (!responseRecognized) setNeedsReload(true);
        setMessage(caught instanceof Error ? caught.message : "Saving could not be confirmed. Reload to check the draft.");
      }
    } finally { inFlight.current = false; if (!abort.signal.aborted) setWorking(false); }
  }

  if (!settings?.enabled) return message ? <p role="status" className="mt-4 text-sm">{message}</p> : null;
  return <section className="mt-5 rounded-2xl border border-[#183126]/10 p-4" aria-labelledby="calendly-call-draft-heading">
    <h3 id="calendly-call-draft-heading" className="font-bold">Free or paid call setup · Private draft</h3>
    <p className="mt-2 text-sm leading-6">You decide whether a call is free or paid. Save your preference for a remote service here. These drafts are private and cannot be booked. Saving does not change the service&apos;s current price or publish a call offer.</p>
    <p className="mt-2 text-sm leading-6">Paid calls will use BubsBookings checkout and applicable fees, not Calendly payments. Free means no charge to the customer. The coordinated booking, cancellation and payment flow is not enabled yet.</p>
    {settings.error && <p role="status" className="mt-3 text-sm text-[#8a4c3a]">{settings.error}</p>}
    <label className="mt-3 block text-sm font-bold">Remote service<CustomSelect ariaLabel="Remote service for call draft" value={serviceId} disabled={working || needsReload} onChange={selectService} buttonClassName="mt-1 min-h-11 w-full rounded-xl border bg-white px-3"><option value="">Choose a service</option>{settings.services?.map(service => <option key={service.id} value={service.id}>{service.title}</option>)}</CustomSelect></label>
    {selected?.revision && <p className="mt-2 text-sm">Saved draft: {selected.billing_mode === "paid" ? `$${((selected.service_price_cents ?? 0) / 100).toFixed(2)} USD service price, plus applicable customer fees` : "Free call"} · {selected.event_type_name}. Not enabled.{!selected.connection_current && " The connection changed; verify and save your event selection again."}</p>}
    {settings.ready && <>
      <label className="mt-3 block text-sm font-bold">Calendly event<CustomSelect ariaLabel="Calendly event for call draft" value={eventUri} disabled={working || !selected || needsReload} onChange={setEventUri} buttonClassName="mt-1 min-h-11 w-full rounded-xl border bg-white px-3"><option value="">Choose an event</option>{settings.eventTypes?.map(event => <option key={event.uri} value={event.uri}>{event.name} · {event.durationMinutes} minutes</option>)}</CustomSelect></label>
      <p className="mt-2 text-xs leading-5">Only your public, personal, fixed-duration events that Calendly reports as not collecting payment are listed. This setting is checked again when saving. It can change in Calendly later; no Calendly setting is changed here.</p>
      <p className="mt-2 text-xs leading-5">Video location and meeting creation still need validation before launch. Saving a draft does not create a video link.</p>
      {settings.eventTypes?.length === 0 && <p className="mt-2 text-sm">No eligible events were verified. The draft cannot be saved with an unverified or paid Calendly event.</p>}
      <label className="mt-3 block text-sm font-bold">Call pricing<CustomSelect ariaLabel="Free or paid call" value={billingMode} disabled={working || !selected || needsReload} onChange={value => { if (value === "" || value === "free" || value === "paid") setBillingMode(value); }} buttonClassName="mt-1 min-h-11 w-full rounded-xl border bg-white px-3"><option value="">Choose free or paid</option><option value="free">Free call · no customer charge</option><option value="paid">Paid call · BubsBookings checkout</option></CustomSelect></label>
      {billingMode === "paid" && <label className="mt-3 block text-sm font-bold">Service price per call (USD)<input type="text" inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} disabled={working || needsReload} maxLength={10} placeholder="50.00" className="mt-1 block min-h-11 w-full rounded-xl border bg-white px-3" /><span className="mt-1 block text-xs font-normal">This is not the customer total. Applicable BubsBookings customer and provider fees will follow the booking&apos;s fee snapshot. Saving this draft does not change your current listing.</span></label>}
    </>}
    <div className="mt-3 flex flex-wrap gap-2">{settings.ready && <button type="button" onClick={() => void save()} disabled={working || needsReload || !selected || !eventUri || !billingMode} className="min-h-11 rounded-full bg-[#183126] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{working ? "Saving…" : "Save private draft"}</button>}{selected?.revision && <button type="button" onClick={() => void save(true)} disabled={working || needsReload} className="min-h-11 rounded-full border px-4 py-2 text-sm font-bold disabled:opacity-50">Remove draft</button>}</div>
    {needsReload && <p role="alert" className="mt-3 text-sm">Reload this page to check the latest saved draft before making another change.</p>}
    {message && <p role="status" className="mt-3 text-sm">{message}</p>}
  </section>;
}
