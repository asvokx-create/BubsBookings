"use client";

import BrandLockup from "@/components/brand-lockup";
import BackButton from "@/components/back-button";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";

type Support = { id: string; subject: string; message: string; status: string; admin_reply: string; created_at: string; user_name: string; user_email: string; user_plan: string; priority: boolean };
type SupportAction = { item: Support; kind: "review" | "resolve" | "reopen" };
type Verification = { id: string; verification_type: string; status: string; business_name: string; user_name: string; user_email: string };
type CheckResult = { key: string; label: string; passed: boolean; verifiedBy: string; detail: string };
type AutomatedCheck = { id: string; overall_status: string; score: number; results: CheckResult[]; created_at: string; business_name: string; user_name: string; user_email: string };

export default function AdminSupportQueue() {
  const [support, setSupport] = useState<Support[]>([]);
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [automatedChecks, setAutomatedChecks] = useState<AutomatedCheck[]>([]);
  const [tab, setTab] = useState<"support" | "verification">("support");
  const [supportTab, setSupportTab] = useState<"unresolved" | "resolved">("unresolved");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [action, setAction] = useState<SupportAction | null>(null);
  const [note, setNote] = useState("");
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const savingRef = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const unresolvedTabRef = useRef<HTMLButtonElement>(null);
  const resolvedTabRef = useRef<HTMLButtonElement>(null);
  const dialogId = useId();

  const load = useCallback(async () => {
    setLoading(true);
    const response = await fetch("/api/admin/support", { cache: "no-store" }).catch(() => null);
    const data = response ? await response.json().catch(() => null) as { support?: Support[]; verifications?: Verification[]; automatedChecks?: AutomatedCheck[]; error?: string } | null : null;
    if (!response?.ok || !data) setError(data?.error ?? "The admin inbox could not be loaded.");
    else {
      setSupport(data?.support ?? []);
      setVerifications(data?.verifications ?? []);
      setAutomatedChecks(data?.automatedChecks ?? []);
      setError("");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;
    async function initialize() {
      await fetch("/api/admin/support/automatic", { method: "POST" }).catch(() => null);
      if (active) await load();
    }
    void initialize();
    return () => { active = false; };
  }, [load]);


  useEffect(() => {
    const dialog = dialogRef.current;
    if (!action || !dialog) return;
    const viewport = window.visualViewport;
    const syncViewport = () => {
      dialog.style.setProperty("--support-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
      dialog.style.setProperty("--support-viewport-top", `${viewport?.offsetTop ?? 0}px`);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    syncViewport();
    viewport?.addEventListener("resize", syncViewport);
    viewport?.addEventListener("scroll", syncViewport);
    window.addEventListener("resize", syncViewport);
    dialog.showModal();
    cancelRef.current?.focus({ preventScroll: true });
    return () => {
      viewport?.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("resize", syncViewport);
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [action]);

  function openAction(item: Support, kind: SupportAction["kind"], trigger: HTMLButtonElement) {
    triggerRef.current = trigger;
    setNote("");
    setActionError("");
    setNotice("");
    setAction({ item, kind });
  }

  function closeAction() {
    if (savingRef.current) return;
    dialogRef.current?.close();
    const fallback = supportTab === "resolved" ? resolvedTabRef.current : unresolvedTabRef.current;
    const trigger = triggerRef.current;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    else fallback?.focus({ preventScroll: true });
    setAction(null);
  }

  async function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || savingRef.current) return;
    const message = note.trim();
    const status = action.kind === "resolve" ? "resolved" : "reviewing";
    savingRef.current = true;
    setSaving(true);
    setActionError("");
    headingRef.current?.focus({ preventScroll: true });
    try {
      const response = await fetch("/api/admin/support", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "support", id: action.item.id, status, note: message }) });
      if (!response.ok) {
        const data: { error?: string } | null = await response.json().catch(() => null);
        setActionError(data?.error ?? "That update could not be saved.");
        return;
      }
      // The PATCH succeeded; update the visible queue immediately, even if a subsequent reload fails.
      setSupport((items) => items.map((item) => item.id === action.item.id ? { ...item, status, admin_reply: message } : item));
      setNotice(`${action.kind === "resolve" ? "Ticket resolved." : action.kind === "reopen" ? "Ticket reopened." : "Ticket marked as reviewing."}${message ? " In-app reply sent." : ""}`);
      savingRef.current = false;
      if (action.kind !== "review") triggerRef.current = null;
      closeAction();
      void load();
    } catch {
      setActionError("That update could not be saved. Check your connection and try again.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const actionTitle = action?.kind === "resolve" ? "Resolve support request" : action?.kind === "reopen" ? "Reopen support request" : "Reply / review";
  const actionLabel = action?.kind === "resolve" ? (note.trim() ? "Send reply and resolve" : "Resolve request") : action?.kind === "reopen" ? (note.trim() ? "Send reply and reopen" : "Reopen request") : note.trim() ? "Send reply" : "Mark as reviewing";
  const statusDescription = action?.kind === "resolve" ? "This moves the ticket to Resolved." : action?.kind === "reopen" ? "This moves the ticket back to Reviewing." : "This marks the ticket as Reviewing and keeps it open.";

  const pendingVerifications = verifications.filter((item) => item.status === "pending");
  const unresolvedSupport = support.filter((item) => item.status !== "resolved");
  const resolvedSupport = support.filter((item) => item.status === "resolved");
  const visibleSupport = supportTab === "resolved" ? resolvedSupport : unresolvedSupport;

  return <main className="min-h-screen overflow-x-clip bg-[#f4f4ef] text-[#183126]">
    <header className="border-b border-[#183126]/10 bg-white"><div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5"><Link href="/admin" className="flex items-center gap-2 font-bold"><BrandLockup compact /><span className="hidden sm:inline">Admin</span></Link><BackButton label="Back to admin" fallbackHref="/admin" /></div></header>
    <div className="mx-auto min-w-0 max-w-6xl px-4 py-7 sm:px-5 sm:py-10">
      <p className="text-xs font-bold uppercase tracking-[.15em] text-[#718078]">Admin inbox</p><h1 className="mt-2 text-3xl font-bold sm:text-4xl">Support &amp; verification</h1>
      <div className="mt-6 grid gap-2 sm:flex sm:flex-wrap"><button onClick={() => setTab("support")} className={`admin-support-filter min-h-11 rounded-full px-5 py-2.5 text-sm font-bold ${tab === "support" ? "bg-[#183126] text-white" : "bg-white hover:bg-[#eee25a]"}`}>Support ({support.length})</button><button onClick={() => setTab("verification")} className={`admin-support-filter min-h-11 rounded-full px-5 py-2.5 text-sm font-bold ${tab === "verification" ? "bg-[#183126] text-white" : "bg-white hover:bg-[#eee25a]"}`}>Automatic verification ({automatedChecks.length})</button></div>
      {tab === "support" && <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Support request status">
        <button ref={unresolvedTabRef} type="button" role="tab" aria-selected={supportTab === "unresolved"} onClick={() => setSupportTab("unresolved")} className={`admin-support-filter min-h-11 rounded-full border px-5 py-2.5 text-sm font-bold ${supportTab === "unresolved" ? "border-[#183126] bg-[#183126] text-white" : "border-[#183126]/15 bg-white text-[#183126] hover:bg-[#eef3ec]"}`}>Unresolved ({unresolvedSupport.length})</button>
        <button ref={resolvedTabRef} type="button" role="tab" aria-selected={supportTab === "resolved"} onClick={() => setSupportTab("resolved")} className={`admin-support-filter min-h-11 rounded-full border px-5 py-2.5 text-sm font-bold ${supportTab === "resolved" ? "border-[#183126] bg-[#183126] text-white" : "border-[#183126]/15 bg-white text-[#183126] hover:bg-[#eef3ec]"}`}>Resolved ({resolvedSupport.length})</button>
      </div>}
      {error && <p className="mt-5 rounded-2xl bg-[#fff0e8] p-4 text-sm font-bold text-[#964f2c]">{error}</p>}
      <p role="status" className={notice ? "mt-5 rounded-2xl bg-[#e7f1e3] p-4 text-sm font-bold" : "sr-only"}>{notice}</p>
      <div className="mt-7 space-y-4">
        {tab === "support" ? visibleSupport.map((item) => <article key={item.id} className="min-w-0 rounded-[1.7rem] bg-white p-5 sm:p-6"><div className="flex flex-col justify-between gap-4 sm:flex-row"><div className="min-w-0"><span className={`rounded-full px-3 py-1 text-xs font-bold capitalize ${item.status === "resolved" ? "bg-[#e4f1e5] text-[#35704a]" : "bg-[#fff1bf] text-[#75651d]"}`}>{item.status}</span><h2 className="mt-3 text-xl font-bold">{item.subject}</h2><p className="mt-1 break-words text-sm text-[#718078]">{item.user_name} · {item.user_email} · {new Date(item.created_at).toLocaleString()}</p></div><div className="admin-action-row flex w-full gap-2 sm:w-auto">{item.status === "resolved" ? <button type="button" aria-haspopup="dialog" onClick={(event) => openAction(item, "reopen", event.currentTarget)} className="rounded-full border px-4 py-2 text-sm font-bold hover:bg-[#eef3ec]">Reopen</button> : <><button type="button" aria-haspopup="dialog" onClick={(event) => openAction(item, "review", event.currentTarget)} className="rounded-full border px-4 py-2 text-sm font-bold hover:bg-[#eee25a]">Reply / review</button><button type="button" aria-haspopup="dialog" onClick={(event) => openAction(item, "resolve", event.currentTarget)} className="rounded-full bg-[#183126] px-4 py-2 text-sm font-bold text-white">Resolve</button></>}</div></div><p className="mt-5 whitespace-pre-wrap rounded-2xl bg-[#f7f7f2] p-5 text-sm leading-6">{item.message}</p>{item.admin_reply && <p className="mt-3 rounded-2xl bg-[#e7f1e3] p-4 text-sm"><strong>Admin reply:</strong> {item.admin_reply}</p>}</article>) : <>
          <section className="rounded-[1.7rem] border border-[#9db7a2] bg-[#e9f3e7] p-6"><h2 className="text-xl font-bold">No routine approval needed</h2><p className="mt-2 text-sm leading-6 text-[#52685c]">Opening this inbox automatically processes pending requests. BubsBookings checks the account, matching phone details, Stripe onboarding, and every active business listing. An incomplete check stays flagged instead of granting an unverified badge.</p></section>
          {automatedChecks.map((check) => <article key={check.id} className="rounded-[1.7rem] bg-white p-6"><div className="flex flex-wrap items-start justify-between gap-4"><div><span className={`rounded-full px-3 py-1 text-xs font-bold ${check.overall_status === "passed" ? "bg-[#e4f1e5] text-[#35704a]" : "bg-[#fff1bf] text-[#75651d]"}`}>{check.overall_status === "passed" ? "Passed" : "Needs attention"}</span><h2 className="mt-3 text-xl font-bold">{check.business_name}</h2><p className="mt-1 text-sm text-[#718078]">{check.user_name} · {check.user_email} · checked {new Date(check.created_at).toLocaleString()}</p></div><span className="rounded-full bg-[#f0f1eb] px-4 py-2 text-sm font-bold">{check.score}%</span></div><div className="mt-5 grid gap-3 sm:grid-cols-2">{check.results.map((result) => <div key={result.key} className={`rounded-2xl p-4 ${result.passed ? "bg-[#e9f3e7]" : "bg-[#fff4df]"}`}><p className="font-bold">{result.passed ? "✓" : "○"} {result.label}</p><p className="mt-1 text-xs leading-5 text-[#687970]">{result.detail}</p><p className="mt-2 text-[10px] font-bold uppercase tracking-wider text-[#819087]">Checked by {result.verifiedBy === "stripe" ? "Stripe" : "BubsBookings"}</p></div>)}</div></article>)}
          {pendingVerifications.map((item) => <article key={item.id} className="rounded-[1.7rem] border border-[#d8cb63] bg-white p-6"><span className="rounded-full bg-[#fff1bf] px-3 py-1 text-xs font-bold">Automatic check incomplete</span><h2 className="mt-3 text-xl font-bold capitalize">{item.verification_type} · {item.business_name}</h2><p className="mt-1 text-sm text-[#718078]">{item.user_name} · {item.user_email}</p><p className="mt-4 text-sm leading-6 text-[#75651d]">No badge was granted. The provider can correct their profile or Stripe onboarding and run the check again.</p></article>)}
        </>}
        {!loading && tab === "support" && !visibleSupport.length && <p className="rounded-[1.7rem] bg-white p-10 text-center text-[#718078]">{supportTab === "resolved" ? "No resolved support requests yet." : "No unresolved support requests."}</p>}
        {!loading && tab === "verification" && !automatedChecks.length && !pendingVerifications.length && <p className="rounded-[1.7rem] bg-white p-10 text-center text-[#718078]">No provider checks yet.</p>}
        {loading && <p className="rounded-[1.7rem] bg-white p-10 text-center text-[#718078]">Running automatic checks…</p>}
      </div>
    </div>

    {action && <dialog
      ref={dialogRef}
      aria-labelledby={`${dialogId}-title`}
      aria-describedby={`${dialogId}-details`}
      onCancel={(event) => { event.preventDefault(); closeAction(); }}
      className="fixed inset-x-0 top-[calc(var(--support-viewport-top,0px)_+_var(--support-viewport-height,100dvh)/2)] m-0 mx-auto w-[calc(100%_-_2rem)] max-w-lg -translate-y-1/2 overflow-y-auto overscroll-contain rounded-[1.7rem] border border-[#183126]/15 bg-white p-0 text-[#183126] shadow-2xl backdrop:bg-[#10251c]/60 [max-height:calc(var(--support-viewport-height,100dvh)_-_2rem)]"
    >
      <form onSubmit={update} className="p-5 sm:p-7">
        <p className="text-xs font-bold uppercase tracking-[.14em] text-[#466453]">BubsBookings support</p>
        <h2 ref={headingRef} tabIndex={-1} id={`${dialogId}-title`} className="mt-2 text-xl font-bold sm:text-2xl">{actionTitle}</h2>
        <p className="mt-2 break-words text-sm font-semibold">{action.item.subject}</p>
        <p id={`${dialogId}-details`} className="mt-2 text-sm leading-6 text-[#516558]">{statusDescription}</p>
        <label htmlFor={`${dialogId}-message`} className="mt-4 block text-sm font-bold">Reply to requester (optional)</label>
        <p id={`${dialogId}-help`} className="mt-1 text-sm leading-5 text-[#516558]">The requester will see any message you enter in their BubsBookings notifications.
          {action.item.admin_reply && " Leaving the field blank clears the reply shown on this ticket but does not remove previously sent notifications."}</p>
        <textarea
          id={`${dialogId}-message`}
          aria-describedby={`${dialogId}-help`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={4}
          maxLength={1000}
          disabled={saving}
          className="mt-2 min-h-24 w-full resize-y rounded-xl border border-[#789082] bg-[#fafaf6] px-3 py-2.5 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#183126]"
        />
        {actionError && <p role="alert" className="mt-3 rounded-xl bg-[#fff0e8] p-3 text-sm font-bold text-[#773a1e]">{actionError}</p>}
        <div className="mt-4 grid gap-2 sm:flex sm:justify-end">
          <button ref={cancelRef} type="button" onClick={closeAction} disabled={saving} className="min-h-11 rounded-full border border-[#789082] px-5 text-sm font-bold hover:bg-[#edf1ec] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#183126] disabled:opacity-60">Cancel</button>
          <button type="submit" disabled={saving} className="min-h-11 rounded-full bg-[#183126] px-5 text-sm font-bold text-white hover:bg-[#294b3b] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#183126] disabled:opacity-60">{saving ? "Saving…" : actionLabel}</button>
        </div>
      </form>
    </dialog>}
  </main>;
}
