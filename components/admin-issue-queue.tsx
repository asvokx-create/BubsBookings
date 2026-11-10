"use client";

import UiIcon from "@/components/ui-icon";

import BrandLockup from "@/components/brand-lockup";
import BackButton from "@/components/back-button";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Issue = {
  id: string;
  status: string;
  created_at: string;
  reporter_name: string;
  reporter_email: string;
  admin_note: string;
  title?: string;
  details: string;
  steps_to_reproduce?: string;
  page_url?: string;
  category?: string;
  requested_resolution?: string;
  service_title?: string;
  booking_id?: string;
  against_name?: string;
  against_email?: string;
  resolution_outcome?: "provider" | "customer" | "partial" | null;
  resolved_at?: string | null;
};

type UpdateIssue = (
  issue: Issue,
  status: "reviewing" | "resolved" | "dismissed",
  outcome?: "provider" | "customer" | "partial",
) => Promise<void>;

function statusStyle(status: string) {
  if (status === "resolved") return "bg-[#e4f3e4] text-[#2f6f46]";
  if (status === "dismissed") return "bg-[#eceeeb] text-[#59645e]";
  return "bg-[#fff1bf] text-[#745f0d]";
}

function IssueCard({ issue, busy, update, closed = false }: {
  issue: Issue;
  busy: string;
  update: UpdateIssue;
  closed?: boolean;
}) {
  return (
    <article className="min-w-0 rounded-[1.7rem] border border-[#183126]/10 bg-white p-5 sm:p-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row">
        <div>
          <div className="admin-action-row flex w-full flex-wrap gap-2 sm:w-auto">
            <span className={`rounded-full px-3 py-1 text-xs font-bold capitalize ${statusStyle(issue.status)}`}>
              {issue.status}
            </span>
            {issue.category && (
              <span className="rounded-full bg-[#edf2e9] px-3 py-1 text-xs font-bold capitalize">
                {issue.category.replaceAll("_", " ")}
              </span>
            )}
          </div>
          <h3 className="mt-3 text-xl font-bold">{issue.title ?? issue.service_title}</h3>
          <p className="mt-1 text-sm text-[#718078]">
            Submitted by {issue.reporter_name} ({issue.reporter_email}) · {new Date(issue.created_at).toLocaleString()}
          </p>
        </div>
        {!closed && (
          <div className="flex flex-wrap gap-2">
            {issue.status === "open" && (
              <button type="button" disabled={busy === issue.id} onClick={() => void update(issue, "reviewing")} className="rounded-full border px-4 py-2 text-sm font-bold hover:bg-[#eee25a] disabled:opacity-50">
                Start review
              </button>
            )}
            {issue.booking_id ? (
              <>
                <button type="button" disabled={busy === issue.id} onClick={() => void update(issue, "resolved", "provider")} className="rounded-full bg-[#183126] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
                  Provider wins · Release payout
                </button>
                <button type="button" disabled={busy === issue.id} onClick={() => void update(issue, "resolved", "customer")} className="rounded-full bg-[#eee25a] px-4 py-2 text-sm font-bold text-[#183126] disabled:opacity-50">
                  Customer wins · Refund
                </button>
                <button type="button" disabled={busy === issue.id} onClick={() => void update(issue, "resolved", "partial")} className="rounded-full border border-[#183126]/15 px-4 py-2 text-sm font-bold text-[#183126] disabled:opacity-50">
                  Split outcome · Partial refund
                </button>
              </>
            ) : (
              <>
                <button type="button" disabled={busy === issue.id} onClick={() => void update(issue, "resolved")} className="rounded-full bg-[#183126] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
                  Resolve
                </button>
                <button type="button" disabled={busy === issue.id} onClick={() => void update(issue, "dismissed")} className="rounded-full px-4 py-2 text-sm font-bold hover:bg-[#fff0e8] disabled:opacity-50">
                  Dismiss
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="mt-5 grid gap-4 rounded-2xl bg-[#f7f7f2] p-5">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[#718078]">Details</p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{issue.details}</p>
        </div>
        {issue.requested_resolution && (
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-[#718078]">Requested resolution</p>
            <p className="mt-2 text-sm">{issue.requested_resolution}</p>
          </div>
        )}
        {issue.against_name && (
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-[#718078]">Against</p>
            <p className="mt-2 text-sm">{issue.against_name} · {issue.against_email}</p>
          </div>
        )}
        {issue.steps_to_reproduce && (
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-[#718078]">Steps to recreate</p>
            <p className="mt-2 whitespace-pre-wrap text-sm">{issue.steps_to_reproduce}</p>
          </div>
        )}
        {issue.page_url && (
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-[#718078]">Page</p>
            <p className="mt-2 break-all text-sm">{issue.page_url}</p>
          </div>
        )}
        {issue.admin_note && (
          <div className="rounded-xl bg-white p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-[#718078]">Admin note</p>
            <p className="mt-2 text-sm">{issue.admin_note}</p>
          </div>
        )}
        {issue.resolution_outcome && (
          <div className="rounded-xl border border-[#183126]/10 bg-[#e7f1e3] p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-[#718078]">Financial outcome</p>
            <p className="mt-2 text-sm font-bold">
              {issue.resolution_outcome === "provider" ? "Provider won: payout released or queued for release"
                : issue.resolution_outcome === "partial" ? "Partial refund issued; provider share adjusted" : "Customer won: payment refunded"}
            </p>
          </div>
        )}
      </div>
    </article>
  );
}

function BugSection({ title, description, issues, busy, update, closed }: {
  title: string;
  description: string;
  issues: Issue[];
  busy: string;
  update: UpdateIssue;
  closed: boolean;
}) {
  const headingId = `${closed ? "resolved" : "unresolved"}-bugs-heading`;

  return (
    <section aria-labelledby={headingId}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id={headingId} className="text-2xl font-bold">{title}</h2>
          <p className="mt-1 text-sm text-[#718078]">{description}</p>
        </div>
        <span className="rounded-full bg-white px-3 py-1 text-sm font-bold text-[#59645e]">
          {issues.length} {issues.length === 1 ? "report" : "reports"}
        </span>
      </div>
      <div className="space-y-4">
        {issues.map((issue) => (
          <IssueCard key={issue.id} issue={issue} busy={busy} update={update} closed={closed} />
        ))}
        {issues.length === 0 && (
          <p className="rounded-[1.7rem] border border-dashed border-[#183126]/20 bg-white/70 p-8 text-center text-[#718078]">
            {closed ? "No resolved bug reports yet." : "No unresolved bug reports. Everything is clear."}
          </p>
        )}
      </div>
    </section>
  );
}

export default function AdminIssueQueue({ type }: { type: "bugs" | "disputes" }) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [bugTab, setBugTab] = useState<"unresolved" | "resolved">("unresolved");

  const load = useCallback(async () => {
    setLoading(true);
    const response = await fetch(`/api/admin/issues?type=${type}`, { cache: "no-store" }).catch(() => null);
    const data = response ? await response.json() as { issues?: Issue[]; error?: string } : null;

    if (!response?.ok) {
      setError(data?.error ?? "The queue could not be loaded.");
    } else {
      setIssues(data?.issues ?? []);
      setError("");
    }
    setLoading(false);
  }, [type]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function update(issue: Issue, status: "reviewing" | "resolved" | "dismissed", outcome?: "provider" | "customer" | "partial") {
    let amount: number | undefined;
    if (outcome === "partial") {
      const entered = window.prompt("Partial customer refund amount in dollars:");
      if (entered === null) return;
      amount = Number(entered);
      if (!Number.isFinite(amount) || amount <= 0) { setError("Enter a valid partial refund amount."); return; }
    }
    if (outcome) {
      const action = outcome === "provider" ? "release the held payout to the provider" : outcome === "partial" ? `issue a $${amount?.toFixed(2)} partial refund and adjust the provider share` : "refund the held payment to the customer";
      if (!window.confirm(`This will ${action}. This financial decision cannot be undone from this screen. Continue?`)) return;
    }
    // Starting review should be a single, dependable action on mobile. Browser
    // prompts can be blocked or appear behind the page on iPad and Safari.
    const promptedNote = status === "reviewing"
      ? issue.admin_note
      : window.prompt("Explain why this decision was made:", issue.admin_note)?.trim();
    if (promptedNote === undefined) return;
    const note = promptedNote.trim();
    if (outcome && note.length < 3) {
      setError("Add a short note explaining the dispute decision.");
      return;
    }

    setBusy(issue.id);
    const response = await fetch("/api/admin/issues", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, id: issue.id, status, note, outcome, amount }),
    }).catch(() => null);
    setBusy("");

    const data = response ? await response.json().catch(() => null) as { error?: string; reconciliationRequired?: boolean } | null : null;
    if (!response?.ok || response.status === 202 || data?.reconciliationRequired || data?.error) {
      await load();
      setError(data?.error ?? (outcome ? "The financial outcome could not be confirmed. Review the payment before retrying." : "That case could not be updated."));
      return;
    }
    await load();
  }

  const unresolvedBugs = issues.filter((issue) => issue.status !== "resolved" && issue.status !== "dismissed");
  const resolvedBugs = issues.filter((issue) => issue.status === "resolved" || issue.status === "dismissed");
  const title = type === "bugs" ? "Reported bugs" : "Booking disputes";

  return (
    <main className="min-h-screen overflow-x-clip bg-[#f4f4ef] text-[#183126]">
      <header className="border-b border-[#183126]/10 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
          <Link href="/admin" className="flex items-center gap-2 font-bold">
            <BrandLockup compact />
            <span className="hidden sm:inline">Admin</span>
          </Link>
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
            <Link href="/admin/reported-bugs" className="flex min-h-11 items-center justify-center rounded-full px-3 py-2 text-center text-sm font-bold hover:bg-[#eee25a] sm:px-4">Bug reports</Link>
            <Link href="/admin/disputes" className="flex min-h-11 items-center justify-center rounded-full px-3 py-2 text-center text-sm font-bold hover:bg-[#eee25a] sm:px-4">Disputes</Link>
          </div>
        </div>
      </header>
      <div className="mx-auto min-w-0 max-w-6xl px-4 py-7 sm:px-5 sm:py-10">
        <BackButton label="Back to admin" fallbackHref="/admin" className="mb-6" />
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="text-xs font-bold uppercase tracking-[.15em] text-[#718078]">Admin case queue</p>
            <h1 className="mt-2 text-3xl font-bold sm:text-4xl">{title}</h1>
          </div>
          <button type="button" onClick={() => void load()} className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-bold hover:bg-[#eee25a]"><UiIcon name="refresh" className="h-4 w-4" />Refresh</button>
        </div>

        {error && <p className="mt-5 rounded-2xl bg-[#fff0e8] p-4 text-sm font-bold text-[#964f2c]">{error}</p>}

        {loading && issues.length === 0 ? (
          <p className="mt-7 rounded-[1.7rem] bg-white p-10 text-center text-[#718078]">Loading queue…</p>
        ) : type === "bugs" ? (
          <div className="mt-8">
            <div
              role="tablist"
              aria-label="Bug report status"
              className="inline-flex w-full gap-1 rounded-2xl border border-[#183126]/10 bg-white p-1 sm:w-auto"
            >
              <button
                type="button"
                role="tab"
                aria-selected={bugTab === "unresolved"}
                onClick={() => setBugTab("unresolved")}
                className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold transition sm:flex-none ${bugTab === "unresolved" ? "bg-[#183126] text-white" : "text-[#59645e] hover:bg-[#edf2e9]"}`}
              >
                Unresolved bugs
                <span className={`rounded-full px-2 py-0.5 text-xs ${bugTab === "unresolved" ? "bg-white/15" : "bg-[#edf2e9]"}`}>
                  {unresolvedBugs.length}
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={bugTab === "resolved"}
                onClick={() => setBugTab("resolved")}
                className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold transition sm:flex-none ${bugTab === "resolved" ? "bg-[#183126] text-white" : "text-[#59645e] hover:bg-[#edf2e9]"}`}
              >
                Resolved bugs
                <span className={`rounded-full px-2 py-0.5 text-xs ${bugTab === "resolved" ? "bg-white/15" : "bg-[#edf2e9]"}`}>
                  {resolvedBugs.length}
                </span>
              </button>
            </div>

            <div className="mt-7">
              {bugTab === "unresolved" ? (
                <BugSection title="Unresolved bugs" description="Open reports and bugs currently being reviewed." issues={unresolvedBugs} busy={busy} update={update} closed={false} />
              ) : (
                <BugSection title="Resolved bugs" description="Resolved and dismissed reports kept for reference." issues={resolvedBugs} busy={busy} update={update} closed />
              )}
            </div>
          </div>
        ) : (
          <div className="mt-7 space-y-4">
            {issues.map((issue) => <IssueCard key={issue.id} issue={issue} busy={busy} update={update} closed={issue.status === "resolved" || issue.status === "dismissed"} />)}
            {issues.length === 0 && <p className="rounded-[1.7rem] bg-white p-10 text-center text-[#718078]">No disputes yet.</p>}
          </div>
        )}
      </div>
    </main>
  );
}
