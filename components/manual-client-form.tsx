"use client";
import { useRef, useState, type FormEvent } from "react";

export default function ManualClientForm({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const pending = useRef(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending.current) return;
    const form = event.currentTarget, values = new FormData(form);
    pending.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/providers/manual-clients", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: values.get("name"), email: values.get("email"), phone: values.get("phone"), notes: values.get("notes"), lawfulBasis: values.get("lawfulBasis") === "on" }) });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "The client could not be saved.");
      form.reset(); setOpen(false); setMessage("Client saved. No invitation or marketing was sent."); onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Check your connection and try again. Your entries are still here."); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="mb-5 border-b pb-5">
    <button type="button" onClick={() => { setOpen(!open); setError(""); setMessage(""); }} disabled={busy} className="rounded-full bg-[#eee25a] px-5 py-3 font-bold">{open ? "Close add client" : "+ Add client"}</button>
    {message && <p role="status" className="mt-3 text-sm">{message}</p>}
    {open && <form onSubmit={save} className="mt-4 grid gap-3 sm:grid-cols-2">
      <p className="text-sm sm:col-span-2">Save an existing client privately. This does not create an account, send an invitation, or subscribe them to marketing.</p>
      <label>Name<input name="name" required maxLength={200} className="mt-1 w-full rounded-xl border p-3" /></label>
      <label>Email (optional)<input name="email" type="email" maxLength={254} className="mt-1 w-full rounded-xl border p-3" /></label>
      <label>Phone (optional)<input name="phone" type="tel" maxLength={40} className="mt-1 w-full rounded-xl border p-3" /></label>
      <label>Notes (optional)<textarea name="notes" maxLength={4000} className="mt-1 w-full rounded-xl border p-3" /></label>
      <label className="text-sm sm:col-span-2"><input name="lawfulBasis" type="checkbox" required /> I have permission to store this client&apos;s details.</label>
      {error && <p role="alert" className="text-sm text-red-800 sm:col-span-2">{error}</p>}
      <div className="flex gap-3"><button disabled={busy} className="rounded-full bg-[#183126] px-5 py-3 text-white">{busy ? "Saving…" : "Save client"}</button><button type="button" disabled={busy} onClick={() => setOpen(false)} className="rounded-full border px-5 py-3">Cancel</button></div>
    </form>}
  </div>;
}
