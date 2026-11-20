"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import UiIcon from "@/components/ui-icon";
import { authClient } from "@/lib/auth-client";
import { getMobileNavigationState } from "@/lib/mobile-navigation-state";
import styles from "./mobile-site-nav.module.css";

const links = [
  ["Find a Service", "/#nearby-listings"],
  ["For Providers", "/providers/join"],
  ["How It Works", "/#how-it-works"],
  ["Resources", "/guides"],
  ["Pricing", "/pricing"],
] as const;

export default function MobileSiteNav({ homeOverlay = false }: { homeOverlay?: boolean } = {}) {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const [open, setOpen] = useState(false);
  const [navigationAccess, setNavigationAccess] = useState<{ userId: string; isAdmin: boolean; isAffiliate: boolean } | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const focusListingsOnClose = useRef(false);
  const pendingDestinationFocus = useRef<number | null>(null);

  useEffect(() => {
    if (!session?.user.id) return;

    let active = true;
    const userId = session.user.id;
    void fetch("/api/account/navigation", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ authenticated: boolean; isAdmin: boolean; isAffiliate: boolean }> : null)
      .then((result) => {
        if (active) setNavigationAccess({ userId, isAdmin: Boolean(result?.authenticated && result.isAdmin), isAffiliate: Boolean(result?.authenticated && result.isAffiliate) });
      })
      .catch(() => {
        if (active) setNavigationAccess({ userId, isAdmin: false, isAffiliate: false });
      });
    return () => { active = false; };
  }, [session?.user.id]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const siteContent = document.getElementById("site-content");
    const triggerButton = triggerButtonRef.current;
    const previousSiteInert = siteContent?.inert ?? false;
    const desktop = homeOverlay ? window.matchMedia("(min-width: 64rem)") : null;
    const closeAtDesktop = () => { if (desktop?.matches) setOpen(false); };
    if (pendingDestinationFocus.current !== null) {
      window.cancelAnimationFrame(pendingDestinationFocus.current);
      pendingDestinationFocus.current = null;
    }
    if (desktop?.matches) { closeAtDesktop(); return; }
    desktop?.addEventListener("change", closeAtDesktop);
    document.body.style.overflow = "hidden";
    if (siteContent) siteContent.inert = true;
    closeButtonRef.current?.focus();
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key !== "Tab") return;
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      if (siteContent) siteContent.inert = previousSiteInert;
      window.removeEventListener("keydown", closeWithEscape);
      desktop?.removeEventListener("change", closeAtDesktop);
      if (focusListingsOnClose.current) {
        focusListingsOnClose.current = false;
        pendingDestinationFocus.current = window.requestAnimationFrame(() => {
          pendingDestinationFocus.current = null;
          document.getElementById("nearby-listings")?.focus({ preventScroll: true });
        });
      } else if (desktop?.matches) {
        triggerButton?.closest("header")?.querySelector<HTMLElement>('nav[aria-label="Primary navigation"] a')?.focus({ preventScroll: true });
      } else {
        triggerButton?.focus();
      }
    };
  }, [homeOverlay, open]);

  const navigationState = getMobileNavigationState({
    isPending,
    authenticated: Boolean(session),
    role: session?.user.role,
    isAdmin: Boolean(session?.user.id && navigationAccess?.userId === session.user.id && navigationAccess.isAdmin),
    isAffiliate: Boolean(session?.user.id && navigationAccess?.userId === session.user.id && navigationAccess.isAffiliate),
  });

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    await authClient.signOut();
    setOpen(false);
    setSigningOut(false);
    router.push("/");
    router.refresh();
  }

  return <>
    <button ref={triggerButtonRef} type="button" aria-label="Open navigation menu" aria-controls="mobile-site-navigation" aria-expanded={open} onClick={() => setOpen(true)} className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-[#183126]/10 bg-white/75 shadow-sm lg:hidden"><UiIcon name="menu" className="h-5 w-5" /></button>
    {open && createPortal(<div className={`fixed inset-0 z-[200] bg-[#10251c]/55 lg:hidden ${homeOverlay ? styles.overlay : "backdrop-blur-sm"}`} role="dialog" aria-modal="true" aria-label="Site navigation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <nav ref={drawerRef} id="mobile-site-navigation" aria-label="Mobile navigation" className={`absolute inset-y-0 right-0 flex w-[min(88vw,22rem)] flex-col overflow-y-auto bg-[#f8f7f3] px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))] shadow-2xl ${homeOverlay ? styles.drawer : ""}`}>
        <div className="flex items-center justify-between gap-4 border-b border-[#183126]/10 pb-4">
          <p className="text-xs font-extrabold uppercase tracking-[.15em] text-[#66796f]">Explore BubsBookings</p>
          <button ref={closeButtonRef} type="button" aria-label="Close navigation menu" onClick={() => setOpen(false)} className={homeOverlay ? styles.close : "grid h-11 w-11 place-items-center rounded-full bg-white shadow-sm"}><UiIcon name="close" className="h-5 w-5" />{homeOverlay && <span>Close</span>}</button>
        </div>
        <div className="grid gap-2 py-5">
          {links.map(([label, href], index) => <Link key={href} href={href} onClick={(event) => {
            if (homeOverlay && href === "/#nearby-listings" && !event.defaultPrevented && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
              focusListingsOnClose.current = true;
            }
            setOpen(false);
          }} className={homeOverlay ? `${styles.navLink} ${index === 0 ? styles.primaryLink : ""}` : "flex min-h-12 items-center justify-between rounded-2xl px-4 py-3 text-base font-bold hover:bg-[#e5eddf]"}>{label}<UiIcon name="arrow-right" className="h-4 w-4 shrink-0" /></Link>)}
        </div>
        <div className="mt-auto grid gap-3 border-t border-[#183126]/10 pt-5">
          {navigationState.status === "loading" && <div aria-label="Loading account" className="grid gap-3" aria-live="polite"><span className="h-12 animate-pulse rounded-full bg-[#183126]/8" /><span className="h-12 animate-pulse rounded-full bg-[#183126]/8" /></div>}
          {navigationState.showAccount && <Link href="/account" onClick={() => setOpen(false)} className="flex min-h-12 items-center justify-center rounded-full border border-[#183126]/15 bg-white px-5 py-3 font-bold">Account</Link>}
          {navigationState.showProviderDashboard && <Link href="/provider/dashboard" onClick={() => setOpen(false)} className="flex min-h-12 items-center justify-center rounded-full border border-[#183126]/15 bg-white px-5 py-3 font-bold">Provider dashboard</Link>}
          {navigationState.showAffiliateDashboard && <Link href="/affiliate" onClick={() => setOpen(false)} className="flex min-h-12 items-center justify-center rounded-full border border-[#183126]/15 bg-white px-5 py-3 font-bold">Partner dashboard</Link>}
          {navigationState.showAdminDashboard && <Link href="/admin" onClick={() => setOpen(false)} className="flex min-h-12 items-center justify-center rounded-full border border-[#183126]/15 bg-white px-5 py-3 font-bold">Admin dashboard</Link>}
          {navigationState.showLogout && <button type="button" disabled={signingOut} onClick={() => void signOut()} className={`flex min-h-12 items-center justify-center rounded-full px-5 py-3 font-bold disabled:cursor-wait disabled:opacity-60 ${homeOverlay ? styles.secondaryAction : "bg-[#eee25a]"}`}>{signingOut ? "Logging out…" : "Log out"}</button>}
          {navigationState.showLogin && <Link href="/login" onClick={() => setOpen(false)} className="flex min-h-12 items-center justify-center rounded-full border border-[#183126]/15 bg-white px-5 py-3 font-bold">Log in</Link>}
          {navigationState.showCreateAccount && <Link href="/signup" onClick={() => setOpen(false)} className={`flex min-h-12 items-center justify-center rounded-full px-5 py-3 font-bold ${homeOverlay ? styles.secondaryAction : "bg-[#eee25a]"}`}>Create account</Link>}
        </div>
      </nav>
    </div>, document.body)}
  </>;
}
