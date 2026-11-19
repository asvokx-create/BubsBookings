"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import UiIcon from "@/components/ui-icon";
import { canonicalListingUrl, listingShareDestinations, listingShareText, type ListingShareMethod } from "@/lib/listing-share";
import { analyticsAllowed } from "@/components/analytics-consent";

type ListingShareButtonProps = {
  serviceId?: string;
  slug?: string;
  providerSlug?: string;
  title: string;
  description?: string;
  action?: "share" | "copy";
  className?: string;
};

const eventByMethod: Record<ListingShareMethod, string> = {
  opened: "listing_share_opened",
  native: "listing_share_native",
  copy_link: "listing_share_copy_link",
  facebook: "listing_share_facebook",
  x: "listing_share_x",
  whatsapp: "listing_share_whatsapp",
  linkedin: "listing_share_linkedin",
  email: "listing_share_email",
};

function trackShare(target: { serviceId?: string; providerSlug?: string }, method: ListingShareMethod) {
  if (!analyticsAllowed()) return;
  let anonymousId: string | undefined;
  try {
    anonymousId = window.localStorage.getItem("bubs-analytics-id") ?? undefined;
    if (!anonymousId) {
      anonymousId = window.crypto.randomUUID();
      window.localStorage.setItem("bubs-analytics-id", anonymousId);
    }
  } catch {
    anonymousId = undefined;
  }
  void fetch("/api/analytics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventName: target.providerSlug ? eventByMethod[method].replace("listing_", "provider_") : eventByMethod[method], anonymousId, path: window.location.pathname, metadata: { serviceId: target.serviceId, providerSlug: target.providerSlug, method } }),
    keepalive: true,
  }).catch(() => undefined);
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  try {
    return document.execCommand("copy");
  } finally {
    input.remove();
  }
}

export default function ListingShareButton({ serviceId, slug, providerSlug, title, description, action = "share", className = "" }: ListingShareButtonProps) {
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const manualLinkRef = useRef<HTMLInputElement>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const url = providerSlug ? `https://bubsbookings.com/providers/${encodeURIComponent(providerSlug)}` : canonicalListingUrl(slug ?? "");
  const text = description?.trim() || listingShareText(title);
  const destinations = providerSlug ? {
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
    x: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
    email: `mailto:?subject=${encodeURIComponent(`${title} on BubsBookings`)}&body=${encodeURIComponent(`${text}\n\n${url}`)}`,
  } : listingShareDestinations(title, slug ?? "");

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const trigger = triggerRef.current;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button, a[href], input:not([disabled])') ?? []);
    (manualLinkRef.current ?? focusable()[0])?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (open && copyState === "manual") manualLinkRef.current?.focus();
  }, [open, copyState]);

  async function copyLink() {
    window.clearTimeout(copyTimer.current);
    let copied = false;
    try { copied = await copyText(url); } catch { /* Offer a manual copy instead. */ }
    setCopyState(copied ? "copied" : "manual");
    if (copied) {
      trackShare({ serviceId, providerSlug }, "copy_link");
      copyTimer.current = window.setTimeout(() => setCopyState("idle"), 2400);
    } else {
      setOpen(true);
    }
  }

  async function activate() {
    if (action === "copy") {
      await copyLink();
      return;
    }
    trackShare({ serviceId, providerSlug }, "opened");
    const mobileLike = window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 768;
    if (mobileLike && typeof navigator.share === "function") {
      try {
        await navigator.share({ title: `${title} | BubsBookings`, text, url });
        trackShare({ serviceId, providerSlug }, "native");
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    setOpen(true);
  }

  function record(method: Exclude<ListingShareMethod, "opened" | "native" | "copy_link">) {
    trackShare({ serviceId, providerSlug }, method);
  }

  const triggerLabel = action === "copy" ? (copyState === "copied" ? "Link copied ✓" : "Copy link") : "Share";
  const dialog = open ? createPortal(
    <div className="listing-share-backdrop fixed inset-0 z-[320] grid place-items-end bg-black/55 sm:place-items-center sm:p-5" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="listing-share-title" className="listing-share-dialog max-h-[calc(100dvh-1rem)] w-full overflow-y-auto rounded-t-[2rem] border border-[#183126]/10 bg-[#fbfaf6] p-5 text-[#183126] shadow-2xl sm:max-w-md sm:rounded-[2rem] sm:p-7">
        <header className="listing-share-header flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1 [overflow-wrap:anywhere]"><p className="text-xs font-extrabold uppercase tracking-[.14em] text-[#718078]">BubsBookings</p><h2 id="listing-share-title" className="mt-1 text-2xl font-bold">Share this {providerSlug ? "provider" : "service"}</h2><p className="mt-2 line-clamp-2 text-sm text-[#687970]">{title}</p></div>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close share menu" className="listing-share-close grid h-11 w-11 shrink-0 place-items-center rounded-full border border-[#183126]/15 bg-white"><UiIcon name="close" className="h-5 w-5" /></button>
        </header>

        <button type="button" onClick={copyLink} className="listing-share-copy mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#eee25a] px-5 py-3 text-sm font-bold text-[#183126] transition hover:bg-[#f6ea69] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#6b8d77]/40"><span aria-hidden="true">⧉</span>{copyState === "copied" ? "Link copied ✓" : "Copy link"}</button>
        <p aria-live="polite" role="status" className="mt-2 min-h-5 text-center text-xs font-semibold text-[#5f7168]">{copyState === "copied" ? `The canonical ${providerSlug ? "provider" : "listing"} link is ready to paste.` : copyState === "manual" ? "Copy was unavailable. Select the link below." : ""}</p>
        {copyState === "manual" && <input ref={manualLinkRef} readOnly value={url} onFocus={(event) => event.currentTarget.select()} aria-label={`${providerSlug ? "Provider" : "Listing"} link`} className="listing-share-url mt-1 w-full rounded-xl border border-[#183126]/15 bg-white px-3 py-3 text-sm" />}

        <p className="mt-4 text-xs font-bold uppercase tracking-[.13em] text-[#718078]">Share with</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <a href={destinations.facebook} target="_blank" rel="noopener noreferrer" onClick={() => record("facebook")} className="listing-share-option"><span aria-hidden="true">f</span>Facebook</a>
          <a href={destinations.x} target="_blank" rel="noopener noreferrer" onClick={() => record("x")} className="listing-share-option"><span aria-hidden="true">𝕏</span>X</a>
          <a href={destinations.whatsapp} target="_blank" rel="noopener noreferrer" onClick={() => record("whatsapp")} className="listing-share-option"><span aria-hidden="true" className="grid place-items-center"><UiIcon name="messages" className="h-4 w-4" /></span>WhatsApp</a>
          <a href={destinations.linkedin} target="_blank" rel="noopener noreferrer" onClick={() => record("linkedin")} className="listing-share-option"><span aria-hidden="true">in</span>LinkedIn</a>
          <a href={destinations.email} onClick={() => record("email")} className="listing-share-option col-span-2"><span aria-hidden="true" className="grid place-items-center"><UiIcon name="mail" className="h-4 w-4" /></span>Email</a>
        </div>
        <p className="mt-4 break-all rounded-xl bg-[#f0f2ed] px-3 py-2 text-xs text-[#687970]">{url}</p>
        <button type="button" onClick={() => setOpen(false)} className="mt-4 min-h-11 w-full rounded-full border border-[#183126]/15 px-5 py-2.5 text-sm font-bold">Close</button>
      </div>
    </div>,
    document.body,
  ) : null;

  return <>
    <button ref={triggerRef} type="button" onClick={activate} aria-label={action === "share" ? `Share ${title}` : `Copy link for ${title}`} aria-haspopup="dialog" aria-expanded={open} className={`listing-share-trigger inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-[#183126]/15 bg-white px-4 py-2.5 text-sm font-bold text-[#183126] transition hover:border-[#597563] hover:bg-[#e5eddf] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#eee25a]/70 ${className}`}><UiIcon name={action === "share" ? "share" : "copy"} className="h-4 w-4" />{triggerLabel}</button>
    <span className="sr-only" aria-live="polite">{action === "copy" && copyState === "copied" ? "Link copied" : ""}</span>
    {dialog}
  </>;
}
