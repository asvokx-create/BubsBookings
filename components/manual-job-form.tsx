"use client";
import DatePicker from "@/components/date-picker";
import TimePicker from "@/components/time-picker";
import { useRef, useState, type FormEvent } from "react";
export default function ManualJobForm() {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const pending = useRef(false);
  const [startDate, setStartDate] = useState(""), [startTime, setStartTime] = useState("");
  const [endDate, setEndDate] = useState(""), [endTime, setEndTime] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending.current) return;
    const form = event.currentTarget, values = new FormData(form);
    pending.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/providers/manual-jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: values.get("title"), startsAt: new Date(`${startDate}T${startTime}`).toISOString(), endsAt: new Date(`${endDate}T${endTime}`).toISOString() }) });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "The job could not be saved.");
      form.reset(); setStartDate(""); setStartTime(""); setEndDate(""); setEndTime(""); setOpen(false); setMessage("External job saved. Your time is blocked; no payment or invitation was created.");
      window.dispatchEvent(new Event("bubsbookings:calendar-refresh"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Check your connection and try again. Your entries are still here."); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="mt-5">
    <button type="button" disabled={busy} onClick={() => { setOpen(!open); setError(""); setMessage(""); }} className="rounded-full bg-[#eee25a] px-5 py-3 font-bold">{open ? "Close add job" : "+ Add job"}</button>
    {message && <p role="status" className="mt-3 text-sm">{message}</p>}
    {open && <form onSubmit={save} className="mt-4 grid gap-3 rounded-2xl border p-4 sm:grid-cols-2">
      <p className="text-sm sm:col-span-2">Add work booked outside BubsBookings. This blocks the company owner&apos;s availability only, not other staff. It does not create a customer booking, invitation, invoice, or payment. Times use this device&apos;s local timezone.</p>
      <label className="sm:col-span-2">Job title<input name="title" required minLength={2} maxLength={180} className="mt-1 w-full rounded-xl border p-3" /></label>
      <div>Start<DatePicker ariaLabel="External job start date" value={startDate} onChange={setStartDate} required disabled={busy} /><TimePicker ariaLabel="External job start time" value={startTime} onChange={setStartTime} required disabled={busy} /></div>
      <div>End<DatePicker ariaLabel="External job end date" value={endDate} onChange={setEndDate} required disabled={busy} /><TimePicker ariaLabel="External job end time" value={endTime} onChange={setEndTime} required disabled={busy} /></div>
      {error && <p role="alert" className="text-sm text-red-800 sm:col-span-2">{error}</p>}
      <div className="flex gap-3"><button disabled={busy} className="rounded-full bg-[#183126] px-5 py-3 text-white">{busy ? "Saving…" : "Save job"}</button><button type="button" disabled={busy} onClick={() => setOpen(false)} className="rounded-full border px-5 py-3">Cancel</button></div>
    </form>}
  </div>;
}
