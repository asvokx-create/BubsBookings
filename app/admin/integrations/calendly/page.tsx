import { redirect } from "next/navigation";
import BackButton from "@/components/back-button";
import { getAdminSession } from "@/lib/admin";
import { database } from "@/lib/database";

export const dynamic = "force-dynamic";

export default async function AdminCalendlyPage() {
  if (!await getAdminSession()) redirect("/login?redirect=/admin/integrations/calendly");
  const [connections, failures] = await Promise.all([
    database.query<{ id: string; provider_name: string; account_name: string; account_email: string; webhook_status: string; webhook_error: string | null; last_sync_succeeded_at: Date | null; last_sync_error: string | null; connected_at: Date }>(
      `SELECT connection.id::text,provider.business_name AS provider_name,connection.account_name,connection.account_email,
              connection.webhook_status,connection.webhook_error,connection.last_sync_succeeded_at,connection.last_sync_error,connection.connected_at
       FROM provider_calendly_connections connection JOIN provider_profiles provider ON provider.id=connection.provider_id
       WHERE connection.disconnected_at IS NULL ORDER BY connection.connected_at DESC`,
    ),
    database.query<{ event_type: string; error_message: string | null; received_at: Date }>(
      `SELECT event_type,error_message,received_at FROM calendly_webhook_deliveries
       WHERE status='failed' ORDER BY received_at DESC LIMIT 25`,
    ),
  ]);
  return <main className="min-h-screen bg-[#f4f4ef] px-4 py-7 text-[#183126] sm:px-8"><div className="mx-auto max-w-5xl">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-bold uppercase tracking-[.14em] text-[#718078]">Admin integrations</p><h1 className="mt-2 text-3xl font-bold">Calendly monitoring</h1><p className="mt-2 text-sm text-[#65756d]">Connection health only. OAuth credentials and appointment attendee details are never displayed.</p></div><BackButton label="Back to admin" fallbackHref="/admin" /></div>
    <section className="mt-7 rounded-[2rem] border border-[#183126]/10 bg-white p-5 sm:p-6"><h2 className="text-xl font-bold">Connected providers</h2><div className="mt-5 space-y-3">{connections.rows.map((item) => <article key={item.id} className="rounded-2xl bg-[#f7f7f2] p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><p className="font-bold">{item.provider_name}</p><p className="mt-1 text-xs text-[#718078]">Calendly: {item.account_name} · {item.account_email}</p><p className="mt-2 text-xs text-[#65756d]">Last sync: {item.last_sync_succeeded_at?.toLocaleString() ?? "Not completed"}</p></div><span className={`w-fit rounded-full px-3 py-1 text-xs font-bold ${item.webhook_status === "active" ? "bg-[#e4f1e5] text-[#35704a]" : "bg-[#fff1bf] text-[#786317]"}`}>{item.webhook_status.replaceAll("_", " ")}</span></div>{item.last_sync_error && <p className="mt-3 rounded-xl bg-[#fff1e8] p-3 text-xs font-semibold text-[#9a4e25]">Appointment sync: {item.last_sync_error}</p>}{item.webhook_error && <p className="mt-3 rounded-xl bg-[#fff8dc] p-3 text-xs font-semibold text-[#786317]">Automatic updates: {item.webhook_error}</p>}</article>)}{connections.rows.length === 0 && <p className="rounded-2xl bg-[#f5f5ef] p-6 text-sm text-[#718078]">No providers have connected Calendly.</p>}</div></section>
    <section className="mt-5 rounded-[2rem] border border-[#183126]/10 bg-white p-5 sm:p-6"><h2 className="text-xl font-bold">Recent webhook failures</h2><div className="mt-5 divide-y divide-[#183126]/10">{failures.rows.map((item, index) => <div key={`${item.received_at.toISOString()}-${index}`} className="py-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-bold">{item.event_type}</p><time className="text-xs text-[#718078]">{item.received_at.toLocaleString()}</time></div><p className="mt-1 text-xs text-[#9a4e25]">{item.error_message ?? "Processing failed."}</p></div>)}{failures.rows.length === 0 && <p className="py-5 text-sm text-[#718078]">No webhook processing failures are recorded.</p>}</div></section>
  </div></main>;
}
