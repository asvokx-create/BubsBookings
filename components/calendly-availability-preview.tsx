"use client";

import { useEffect, useRef, useState } from "react";

type Preview = {
  mode: "preview_only"; eventName: string; durationMinutes: number; timeZone: string;
  checkedAt: string; through: string; slots: { startsAt: string; endsAt: string }[]; moreAvailable: boolean;
};

export default function CalendlyAvailabilityPreview({ serviceId }: { serviceId: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!preview) return;
    const remaining = Math.max(0, Date.parse(preview.checkedAt) + 60_000 - Date.now());
    const timer = setTimeout(() => { setPreview(null); setError("These times need a fresh check. Refresh the preview before relying on them."); }, remaining);
    return () => clearTimeout(timer);
  }, [preview]);

  async function check() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPreview(null); setError(""); setLoading(true);
    try {
      const response = await fetch(`/api/services/${encodeURIComponent(serviceId)}/calendly-preview`, { cache: "no-store", signal: controller.signal });
      const data = await response.json() as Preview & { error?: string };
      if (!response.ok || data.mode !== "preview_only") throw new Error(data.error ?? "The availability preview is unavailable.");
      if (request.current === controller && !controller.signal.aborted) setPreview(data);
    } catch (caught) {
      if (!controller.signal.aborted && request.current === controller) setError(caught instanceof Error ? caught.message : "The availability preview is unavailable.");
    } finally { if (request.current === controller && !controller.signal.aborted) setLoading(false); }
  }

  return <section className="mt-6 rounded-2xl border border-[#183126]/10 bg-[#f5f7f2] p-5" aria-labelledby="calendly-preview-heading">
    <h2 id="calendly-preview-heading" className="text-lg font-bold">Calendly availability preview</h2>
    <p className="mt-2 text-sm leading-6 text-[#65756d]">See open times for the provider&apos;s selected Calendly event in the next 7 days. This is a read-only preview, not a booking option.</p>
    <p className="mt-2 text-sm font-semibold">No meeting is reserved here. BubsBookings requests are separate and do not create a Calendly booking or a video-call link.</p>
    <button type="button" disabled={loading} onClick={() => void check()} className="mt-4 min-h-11 rounded-full bg-[#183126] px-5 py-2 text-sm font-bold text-white disabled:opacity-50">{loading ? "Checking times…" : "Refresh Calendly preview"}</button>
    {error && <p role="alert" className="mt-3 text-sm text-[#8a4c3a]">{error}</p>}
    {preview && <div role="status" className="mt-4">
      <p className="font-bold">{preview.eventName} · {preview.durationMinutes} minutes</p>
      <p className="mt-1 text-xs text-[#65756d]">Times in {preview.timeZone}. Checked {new Date(preview.checkedAt).toLocaleTimeString("en-US", { timeZone: preview.timeZone, timeZoneName: "short" })}. Availability may change.</p>
      {preview.slots.length ? <ul className="mt-3 grid max-h-80 gap-2 overflow-y-auto sm:grid-cols-2">{preview.slots.map(slot => <li key={slot.startsAt} className="rounded-xl bg-white px-3 py-2 text-sm">{new Date(slot.startsAt).toLocaleString("en-US", { timeZone: preview.timeZone, month: "short", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "shortOffset" })}</li>)}</ul> : <p className="mt-3 text-sm">No open times were returned for this event in the next 7 days after known BubsBookings owner conflicts were excluded.</p>}
      {preview.moreAvailable && <p className="mt-2 text-xs">Showing the first 60 open times.</p>}
    </div>}
  </section>;
}
