"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useModalAccessibility } from "@/components/use-modal-accessibility";

export default function ContactSupportButton({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const submitting = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const confirmationRef = useRef<HTMLHeadingElement>(null);
  const close = () => { if (!submitting.current) setOpen(false); };
  const dialogRef = useModalAccessibility<HTMLDivElement>(open, close, busy);

  useEffect(() => {
    if (open && sent) confirmationRef.current?.focus();
    else if (open && error) errorRef.current?.focus();
  }, [open, error, sent]);

  const deliveryUnknown = "We couldn’t confirm that your message was sent. Your draft is still here. If you’re unsure whether it went through, wait before trying again.";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, message }),
      });
      const payload: unknown = await response.json();
      const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
      if (response.ok && data?.ok === true && typeof data.id === "string" && data.id.trim()) {
        setSent(true);
        setSubject("");
        setMessage("");
      } else if (response.status >= 400 && response.status < 500 && typeof data?.error === "string" && data.error.trim()) {
        setError(`${data.error} Your draft is still here.`);
      } else {
        setError(deliveryUnknown);
      }
    } catch {
      setError(deliveryUnknown);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return <>
    <Link href="/support" onClick={(event) => { event.preventDefault(); setOpen(true); setSent(false); setError(""); }} className={`inline-flex min-h-11 items-center justify-center ${className}`}>Contact support</Link>
    {open && <div className="fixed inset-0 z-[100] grid place-items-center bg-[#10251c]/55 p-5" role="dialog" aria-modal="true" aria-labelledby="support-title">
      <div ref={dialogRef} tabIndex={-1} className="w-full max-w-lg rounded-[2rem] bg-white p-6 text-[#183126] shadow-2xl sm:p-8">
        {sent ? <div className="text-center"><span aria-hidden="true" className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#e5f1e5] text-2xl">✓</span><h2 ref={confirmationRef} tabIndex={-1} id="support-title" className="mt-4 text-2xl font-bold">Message sent to support</h2><p className="mt-2 text-sm text-[#687970]">Your request is now in the BubsBookings admin support inbox.</p><button onClick={close} className="mt-6 rounded-full bg-[#183126] px-6 py-3 text-sm font-bold text-white">Done</button></div> :
          <form onSubmit={submit}><p className="text-xs font-bold uppercase tracking-[.14em] text-[#718078]">BubsBookings support</p><h2 id="support-title" className="mt-2 text-2xl font-bold">How can we help?</h2><p className="mt-2 text-sm text-[#687970]">Send a message directly to the admin team. Do not include passwords or payment-card information.</p><label className="mt-5 block text-sm font-bold">Subject<input readOnly={busy} required minLength={4} maxLength={120} value={subject} onChange={(event) => setSubject(event.target.value)} className="mt-2 w-full rounded-2xl border border-[#183126]/15 bg-[#fafaf6] px-4 py-3" placeholder="What do you need help with?" /></label><label className="mt-4 block text-sm font-bold">Message<textarea readOnly={busy} required minLength={10} maxLength={2000} rows={5} value={message} onChange={(event) => setMessage(event.target.value)} className="mt-2 w-full resize-none rounded-2xl border border-[#183126]/15 bg-[#fafaf6] px-4 py-3" /></label>{error && <p ref={errorRef} tabIndex={-1} className="mt-3 rounded-xl bg-[#fff0e8] px-3 py-2 text-xs font-bold text-[#964f2c]">{error}</p>}<div className="mt-5 flex justify-end gap-2"><button type="button" disabled={busy} onClick={close} className="rounded-full px-5 py-3 text-sm font-bold hover:bg-[#edf1ec]">Cancel</button><button disabled={busy} className="rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white disabled:opacity-50">{busy ? "Sending…" : error ? "Try again" : "Send to support"}</button></div><p role="status" className="sr-only">{busy ? "Sending your message to support." : ""}</p></form>}
      </div>
    </div>}
  </>;
}
