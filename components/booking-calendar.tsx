"use client";

import ManualJobForm from "@/components/manual-job-form";
import UiIcon from "@/components/ui-icon";
import CustomSelect from "@/components/custom-select";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatInUserTimeZone, useUserTimeZone } from "@/components/preferences-provider";

type View = "day" | "week" | "month";
type Event = { id: string; kind: "booking" | "time_off" | "calendly" | "manual_job"; title: string; person: string; startsAt: string; endsAt: string; location: string; status: string; assignedTeamMemberId: string | null; assignedTeamMemberIds: string[]; assigneeName: string };

export default function BookingCalendar({ role }: { role: "customer" | "provider" }) {
  const timeZone = useUserTimeZone();
  const [events, setEvents] = useState<Event[]>([]);
  const [view, setView] = useState<View>("month");
  const [anchor, setAnchor] = useState(() => new Date());
  const [loading, setLoading] = useState(true);
  const [staff, setStaff] = useState<Array<{ id: string; name: string }>>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [staffFilter, setStaffFilter] = useState("all");
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (window.matchMedia("(max-width: 640px)").matches) setView("day");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const load = () => { setLoading(true); fetch(`/api/calendar?role=${role}`, { cache: "no-store" }).then(async (response) => {
      const data = response.ok ? await response.json() as { events: Event[]; staff?: Array<{ id: string; name: string }> } : { events: [], staff: [] }; setEvents(data.events); setStaff(data.staff ?? []); setLoading(false);
    }).catch(() => setLoading(false)); };
    load();
    window.addEventListener("bubsbookings:calendar-refresh", load);
    return () => window.removeEventListener("bubsbookings:calendar-refresh", load);
  }, [role]);

  async function removeJob(id: string) {
    if (removing || !window.confirm("Remove this external job and free this time for bookings?")) return;
    setRemoving(id); setError("");
    try {
      const response = await fetch("/api/providers/manual-jobs", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      if (!response.ok) throw new Error("The job could not be removed. Refresh and try again.");
      window.dispatchEvent(new window.Event("bubsbookings:calendar-refresh"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Check your connection and try again."); }
    finally { setRemoving(null); }
  }
  const range = useMemo(() => {
    const start = new Date(anchor); start.setHours(0, 0, 0, 0);
    if (view === "week") start.setDate(start.getDate() - start.getDay());
    if (view === "month") start.setDate(1);
    const end = new Date(start); end.setDate(end.getDate() + (view === "day" ? 1 : view === "week" ? 7 : new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate()));
    return { start, end };
  }, [anchor, view]);
  const visible = events.filter((event) => { const startsAt = new Date(event.startsAt), endsAt = new Date(event.endsAt); const staffMatches = staffFilter === "all" || event.assignedTeamMemberIds.includes(staffFilter); return startsAt < range.end && endsAt > range.start && staffMatches; }).sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  const title = view === "day" ? anchor.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
    : view === "week" ? `Week of ${range.start.toLocaleDateString("en-US", { month: "long", day: "numeric" })}`
    : anchor.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  function move(direction: number) { const next = new Date(anchor); next.setDate(next.getDate() + direction * (view === "day" ? 1 : view === "week" ? 7 : 30)); setAnchor(next); }
  const href = (event: Event) => event.kind === "time_off" ? "/provider/dashboard/team" : role === "provider" ? `/provider/dashboard/bookings/${event.id}` : `/account/bookings/${event.id}`;
  const eventContents = (event: Event) => <><div className="w-24 shrink-0"><p className="text-xs font-bold uppercase text-[#6f7e76]">{formatInUserTimeZone(event.startsAt, { month: "short", day: "numeric" }, timeZone)}</p><p className="mt-1 font-bold">{formatInUserTimeZone(event.startsAt, { hour: "numeric", minute: "2-digit" }, timeZone)}</p></div>
    <div className="min-w-0 flex-1"><p className="font-bold">{event.kind === "time_off" ? `Time off: ${event.title}` : event.title}</p><p className="mt-1 truncate text-sm text-[#6f7e76]">{event.person} · {event.location}</p>{event.kind === "booking" && <p className="mt-1 text-xs font-semibold text-[#55705e]">Professional: {event.assigneeName}</p>}{(event.kind === "calendly" || event.kind === "manual_job") && <p className="mt-1 text-xs font-semibold text-[#315e7a]">External appointment · No BubsBookings payment</p>}</div><span className={`w-fit rounded-full px-3 py-1 text-xs font-bold ${event.status === "confirmed" ? "bg-[#e3f1e5] text-[#2f6d46]" : event.status === "blocked" ? "bg-[#f2dcd2] text-[#8a4f3d]" : event.kind === "calendly" ? "bg-[#e3edf6] text-[#315e7a]" : "bg-[#fff1bf] text-[#786317]"}`}>{event.status}</span></>;

  return <section className="schedule-calendar rounded-[2rem] border border-[#183126]/10 bg-white p-5 sm:p-7">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><p className="text-xs font-bold uppercase tracking-[.14em] text-[#718078]">Schedule</p><h1 className="mt-2 text-3xl font-bold">Booking calendar</h1></div>
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap">{role === "provider" && <CustomSelect ariaLabel="Filter calendar by worker" value={staffFilter} onChange={setStaffFilter} className="w-full sm:w-auto" buttonClassName="rounded-full border border-[#183126]/15 bg-white px-4 py-2 text-sm font-bold sm:text-xs"><option value="all">All staff</option><option value="owner">Company owner</option>{staff.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</CustomSelect>}<div className="calendar-view-toggle grid grid-cols-3 rounded-full bg-[#eef1eb] p-1">{(["day", "week", "month"] as View[]).map((item) => <button key={item} onClick={() => setView(item)} aria-pressed={view === item} className={`rounded-full px-3 py-2 text-xs font-bold capitalize sm:px-4 ${view === item ? "bg-[#183126] text-white" : "hover:bg-white"}`}>{item}</button>)}</div></div></div>
    {role === "provider" && <ManualJobForm />}
    {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}
    <div className="mt-7 flex items-center justify-between gap-3"><button onClick={() => move(-1)} aria-label="Previous period" className="grid h-11 w-11 place-items-center rounded-full border hover:bg-[#eee25a]"><UiIcon name="chevron-left" className="h-5 w-5" /></button><h2 className="text-center text-lg font-bold">{title}</h2><button onClick={() => move(1)} aria-label="Next period" className="grid h-11 w-11 place-items-center rounded-full border hover:bg-[#eee25a]"><UiIcon name="chevron-right" className="h-5 w-5" /></button></div>
    <div className="mt-6 space-y-3">{loading ? <p className="rounded-2xl bg-[#f5f5ef] p-6 text-sm text-[#718078]">Loading your calendar…</p> : visible.length ? visible.map((event) => (event.kind === "calendly" || event.kind === "manual_job") ? <article key={`${event.kind}-${event.id}`} className="calendar-event flex flex-col gap-3 rounded-2xl border border-[#9cb9cc] bg-[#f4f9fc] p-4 sm:flex-row sm:items-center">{eventContents(event)}{event.kind === "manual_job" && <button type="button" disabled={removing !== null} onClick={() => void removeJob(event.id)} className="rounded-full border px-3 py-2 text-sm font-bold">{removing === event.id ? "Removing…" : "Remove job"}</button>}</article> : <Link key={`${event.kind}-${event.id}`} href={href(event)} className={`calendar-event flex flex-col gap-3 rounded-2xl border p-4 transition hover:border-[#66816f] sm:flex-row sm:items-center ${event.kind === "time_off" ? "calendar-event--blocked border-[#d9b6a8] bg-[#fff5ef]" : "border-[#183126]/10 hover:bg-[#f7f8f3]"}`}>{eventContents(event)}</Link>) : <div className="rounded-2xl bg-[#f5f5ef] p-10 text-center"><p className="text-3xl">📅</p><p className="mt-3 font-bold">No bookings in this {view}</p><p className="mt-1 text-sm text-[#718078]">Use the arrows to look at another time period.</p></div>}</div>
  </section>;
}
