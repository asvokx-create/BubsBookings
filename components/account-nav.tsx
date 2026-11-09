"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { authClient } from "@/lib/auth-client";
import NotificationBell from "@/components/notification-bell";
import ProfileAvatar from "@/components/profile-avatar";

export default function AccountNav() {
  const { data: session, isPending } = authClient.useSession();
  const mounted = useSyncExternalStore(() => () => undefined, () => true, () => false);
  const [affiliateAccess,setAffiliateAccess]=useState<{userId:string;isAffiliate:boolean}|null>(null);

  useEffect(()=>{
    if(!session?.user.id)return;
    let active=true;
    const userId=session.user.id;
    void fetch("/api/account/navigation",{cache:"no-store"})
      .then(async response=>response.ok?response.json() as Promise<{authenticated:boolean;isAffiliate:boolean}>:null)
      .then(result=>{if(active)setAffiliateAccess({userId,isAffiliate:Boolean(result?.authenticated&&result.isAffiliate)});})
      .catch(()=>{if(active)setAffiliateAccess({userId,isAffiliate:false});});
    return()=>{active=false;};
  },[session?.user.id]);

  if (!mounted || isPending) {
    return <div aria-label="Loading account" className="h-10 w-10 animate-pulse rounded-full bg-[#183126]/8 min-[380px]:w-28" />;
  }

  if (session) {
    const name = session.user.name?.trim() || "My account";
    return (
      <div className="flex items-center gap-1.5 sm:gap-2">
        {affiliateAccess?.userId===session.user.id&&affiliateAccess.isAffiliate?<Link href="/affiliate" className="hidden min-h-10 items-center rounded-full bg-[#eee25a] px-4 py-2 text-sm font-bold shadow-sm transition hover:bg-[#f5e96c] md:inline-flex">Partner dashboard</Link>:null}
        <Link href="/account" className="flex items-center gap-2 rounded-full border border-[#183126]/8 bg-white/70 px-2.5 py-1.5 text-sm font-semibold shadow-sm backdrop-blur transition hover:border-[#183126]/15 hover:bg-white hover:shadow-md sm:px-3">
          <ProfileAvatar name={name} imageUrl={session.user.image} className="h-8 w-8 text-xs" />
          <span className="hidden sm:inline">My account</span>
        </Link>
        <Link href="/account/projects" className="hidden rounded-full px-3 py-2 text-sm font-bold md:inline-flex">Projects</Link><NotificationBell />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 sm:gap-3">
      <Link href="/login" className="hidden whitespace-nowrap rounded-full px-3 py-2 text-sm font-semibold hover:bg-white min-[380px]:inline-flex sm:px-4">Log in</Link>
      <Link href="/signup" className="whitespace-nowrap rounded-full bg-[#173d2e] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_8px_22px_rgba(23,61,46,.18)] hover:bg-[#265842] sm:px-5">Sign up</Link>
    </div>
  );
}
