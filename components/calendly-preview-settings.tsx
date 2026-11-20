"use client";

import { useEffect, useRef, useState } from "react";
import CustomSelect from "@/components/custom-select";

type Service = { id: string; title: string; event_type_uri: string | null; event_type_name: string | null };
type Settings = { enabled: boolean; ready?: boolean; error?: string; services?: Service[]; eventTypes?: { uri: string; name: string; durationMinutes: number }[] };

export default function CalendlyPreviewSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [serviceId, setServiceId] = useState("");
  const [eventUri, setEventUri] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    fetch("/api/integrations/calendly/availability-preview", { cache: "no-store", signal: abort.signal })
      .then(async response => { const data = await response.json() as Settings; if (!abort.signal.aborted) setSettings(data); })
      .catch(() => { if (!abort.signal.aborted) setMessage("Preview settings could not be loaded."); });
    return () => { abort.abort(); controller.current?.abort(); };
  }, []);
  const selected = settings?.services?.find(service => service.id === serviceId);
  async function save(remove = false) {
    if (!serviceId || (!remove && !eventUri) || working) return;
    const abort = new AbortController();
    controller.current = abort;
    setWorking(true); setMessage("");
    try {
      const response = await fetch("/api/integrations/calendly/availability-preview", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serviceId, eventTypeUri: remove ? null : eventUri }), signal: abort.signal });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "The preview selection could not be saved.");
      if (abort.signal.aborted) return;
      const event = settings?.eventTypes?.find(item => item.uri === eventUri);
      setSettings(current => current ? { ...current, services: current.services?.map(service => service.id === serviceId ? { ...service, event_type_uri: remove ? null : eventUri, event_type_name: remove ? null : event?.name ?? "Selected event" } : service) } : current);
      setMessage(remove ? "The public preview was removed." : "The selected event's name and availability preview are enabled for this service. No meeting was booked.");
    } catch (caught) { if (!abort.signal.aborted) setMessage(caught instanceof Error ? caught.message : "Preview settings could not be saved."); }
    finally { if (!abort.signal.aborted) setWorking(false); }
  }
  if (!settings?.enabled) return message ? <p role="status" className="mt-4 text-sm">{message}</p> : null;
  return <section className="mt-5 rounded-2xl border border-[#183126]/10 p-4" aria-labelledby="calendly-preview-settings-heading">
    <h3 id="calendly-preview-settings-heading" className="font-bold">Optional Calendly availability preview</h3>
    <p className="mt-2 text-sm leading-6">Publish an event&apos;s name and open times on a selected remote service. Only public, fixed-duration, personal one-to-one events are supported. Nothing is selected automatically. This does not reserve meetings, alter BubsBookings booking times, or create video links.</p>
    {settings.error && <p role="status" className="mt-3 text-sm text-[#8a4c3a]">{settings.error}</p>}
    <label className="mt-3 block text-sm font-bold">Remote service<CustomSelect ariaLabel="Remote service for Calendly preview" value={serviceId} disabled={working} onChange={value => { setServiceId(value); setEventUri(""); setMessage(""); }} buttonClassName="mt-1 min-h-11 w-full rounded-xl border bg-white px-3"><option value="">Choose a service</option>{settings.services?.map(service => <option key={service.id} value={service.id}>{service.title}</option>)}</CustomSelect></label>
    {selected && <p className="mt-2 text-sm">Saved preview: {selected.event_type_name ?? "None"}. Reconnecting Calendly requires selecting the event again.</p>}
    {settings.ready && <label className="mt-3 block text-sm font-bold">Calendly event<CustomSelect ariaLabel="Calendly event to publish" value={eventUri} disabled={working || !serviceId} onChange={value => setEventUri(value)} buttonClassName="mt-1 min-h-11 w-full rounded-xl border bg-white px-3"><option value="">Choose an event to publish</option>{settings.eventTypes?.map(event => <option key={event.uri} value={event.uri}>{event.name} · {event.durationMinutes} minutes</option>)}</CustomSelect></label>}
    {settings.ready && settings.eventTypes?.length === 0 && <p className="mt-2 text-sm">No eligible public personal events were found.</p>}
    <div className="mt-3 flex flex-wrap gap-2">{settings.ready && <button type="button" onClick={() => void save()} disabled={working || !serviceId || !eventUri} className="min-h-11 rounded-full bg-[#183126] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{working ? "Saving…" : "Publish selected preview"}</button>}{selected?.event_type_uri && <button type="button" onClick={() => void save(true)} disabled={working} className="min-h-11 rounded-full border px-4 py-2 text-sm font-bold disabled:opacity-50">Remove preview</button>}</div>
    {message && <p role="status" className="mt-3 text-sm">{message}</p>}
  </section>;
}
