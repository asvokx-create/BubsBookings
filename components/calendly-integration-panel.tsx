"use client";

import { useEffect, useState } from "react";

type Connection = {
  id: string;
  accountName: string;
  accountEmail: string;
  accountTimezone: string;
  schedulingUrl: string | null;
  webhookStatus: "not_configured" | "active" | "unsupported" | "failed";
  webhookError: string | null;
  blockConflictingBookings: boolean;
  lastSyncStartedAt: string | null;
  lastSyncSucceededAt: string | null;
  lastSyncError: string | null;
  connectedAt: string;
};

export default function CalendlyIntegrationPanel() {
  const [configured, setConfigured] = useState(true);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<"sync" | "disconnect" | "settings" | "">("");
  const [message, setMessage] = useState("");

  async function load() {
    try {
      const response = await fetch("/api/integrations/calendly", { cache: "no-store" });
      const data = await response.json() as { configured?: boolean; connection?: Connection | null; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Calendly status could not be loaded.");
      setConfigured(data.configured === true);
      setConnection(data.connection ?? null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Calendly status could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;

    fetch("/api/integrations/calendly", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { configured?: boolean; connection?: Connection | null; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Calendly status could not be loaded.");
        return data;
      })
      .then((data) => {
        if (!active) return;
        setConfigured(data.configured === true);
        setConnection(data.connection ?? null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMessage(error instanceof Error ? error.message : "Calendly status could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => { active = false; };
  }, []);

  async function synchronize() {
    setWorking("sync"); setMessage("");
    const response = await fetch("/api/integrations/calendly/sync", { method: "POST" });
    const data = await response.json() as { error?: string };
    if (!response.ok) setMessage(data.error ?? "Calendly could not be synchronized.");
    else { setMessage("Calendly appointments are up to date."); await load(); window.dispatchEvent(new Event("bubsbookings:calendar-refresh")); }
    setWorking("");
  }

  async function updateConflictSetting(enabled: boolean) {
    setWorking("settings"); setMessage("");
    const response = await fetch("/api/integrations/calendly", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockConflictingBookings: enabled }) });
    const data = await response.json() as { error?: string };
    if (!response.ok) setMessage(data.error ?? "The calendar setting could not be saved.");
    else setConnection((current) => current ? { ...current, blockConflictingBookings: enabled } : current);
    setWorking("");
  }

  async function disconnect() {
    if (!window.confirm("Disconnect Calendly? Imported appointments will remain in history but future updates will stop.")) return;
    setWorking("disconnect"); setMessage("");
    const response = await fetch("/api/integrations/calendly", { method: "DELETE" });
    const data = await response.json() as { error?: string };
    if (!response.ok) setMessage(data.error ?? "Calendly could not be disconnected.");
    else { setConnection(null); setMessage("Calendly was disconnected."); window.dispatchEvent(new Event("bubsbookings:calendar-refresh")); }
    setWorking("");
  }

  const automaticMessage = connection?.webhookStatus === "active"
    ? "Automatic updates are active."
    : connection?.webhookStatus === "unsupported"
      ? "Automatic updates require Calendly Standard, Teams, or Enterprise and approved webhook permissions. Use Sync now whenever appointments change."
      : connection?.webhookStatus === "failed"
        ? "Automatic updates need attention. Manual synchronization remains available."
        : "Automatic updates are not configured. Manual synchronization remains available.";

  return <section className="mb-5 rounded-[2rem] border border-[#183126]/10 bg-white p-5 sm:p-6" aria-labelledby="calendly-heading">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div><p className="text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Calendar integration</p><h2 id="calendly-heading" className="mt-2 text-xl font-bold">Calendly</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-[#65756d]">Show external Calendly appointments beside BubsBookings bookings. External appointments never create charges, commissions, or payouts.</p></div>
      {!loading && !connection && <a href="/api/integrations/calendly/connect" aria-disabled={!configured} className={`inline-flex min-h-11 shrink-0 items-center justify-center rounded-full px-5 py-3 text-sm font-bold ${configured ? "bg-[#eee25a] text-[#183126] hover:bg-[#f5eb74]" : "pointer-events-none bg-[#ecece5] text-[#7b857f]"}`}>Connect Calendly</a>}
    </div>
    {loading ? <p className="mt-5 rounded-2xl bg-[#f5f5ef] p-4 text-sm text-[#718078]">Loading Calendly status…</p> : connection ? <div className="mt-5 rounded-2xl border border-[#183126]/10 bg-[#f8f8f3] p-4 sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-[#e4f1e5] px-3 py-1 text-xs font-bold text-[#35704a]">Connected</span><span className={`rounded-full px-3 py-1 text-xs font-bold ${connection.webhookStatus === "active" ? "bg-[#e3edf6] text-[#315e7a]" : "bg-[#fff1bf] text-[#786317]"}`}>{connection.webhookStatus === "active" ? "Automatic sync" : "Manual sync"}</span></div><p className="mt-3 break-words font-bold">{connection.accountName}</p><p className="mt-1 break-all text-xs text-[#718078]">{connection.accountEmail} · {connection.accountTimezone}</p><p className="mt-2 text-xs leading-5 text-[#65756d]">{automaticMessage}</p><p className="mt-1 text-xs text-[#718078]">Last successful sync: {connection.lastSyncSucceededAt ? new Date(connection.lastSyncSucceededAt).toLocaleString() : "Not completed yet"}</p></div>
        <div className="flex flex-wrap gap-2"><button type="button" disabled={Boolean(working)} onClick={() => void synchronize()} className="min-h-11 rounded-full bg-[#183126] px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50">{working === "sync" ? "Syncing…" : "Sync now"}</button><button type="button" disabled={Boolean(working)} onClick={() => void disconnect()} className="min-h-11 rounded-full border border-[#9a4e3a]/20 bg-white px-4 py-2.5 text-xs font-bold text-[#8a4c3a] disabled:opacity-50">{working === "disconnect" ? "Disconnecting…" : "Disconnect"}</button></div></div>
      <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl bg-white p-4"><input type="checkbox" className="mt-1 h-5 w-5 accent-[#183126]" checked={connection.blockConflictingBookings} disabled={Boolean(working)} onChange={(event) => void updateConflictSetting(event.target.checked)} /><span><span className="block text-sm font-bold">Block conflicting BubsBookings times</span><span className="mt-1 block text-xs leading-5 text-[#65756d]">Use synchronized active Calendly appointments to prevent the provider owner from receiving a conflicting booking. Manual-sync accounts can become stale, so keep them updated.</span></span></label>
      {connection.lastSyncError && <p role="alert" className="mt-3 rounded-xl bg-[#fff1e8] px-4 py-3 text-xs font-semibold text-[#9a4e25]"><span className="block font-bold">Appointment sync failed</span>{connection.lastSyncError} Reconnect Calendly if the account was connected before calendar permissions were approved.</p>}
      {connection.webhookError && <p className="mt-3 rounded-xl bg-[#fff8dc] px-4 py-3 text-xs font-semibold text-[#786317]">{connection.webhookError}</p>}
    </div> : <div className="mt-5 rounded-2xl bg-[#f5f5ef] p-5"><p className="font-bold">No Calendly account connected</p><p className="mt-1 text-sm leading-6 text-[#65756d]">Connect securely with Calendly OAuth. You will never be asked to paste a private API token.</p>{!configured && <p role="alert" className="mt-3 text-sm font-semibold text-[#9a4e25]">The BubsBookings administrator must finish the Calendly app configuration before accounts can connect.</p>}</div>}
    {message && <p role="status" className="mt-4 rounded-xl bg-[#edf2e8] px-4 py-3 text-sm font-semibold text-[#315846]">{message}</p>}
  </section>;
}
