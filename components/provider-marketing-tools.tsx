"use client";

import type { ProviderActivation } from "@/components/provider-activation-checklist";
import Link from "next/link";
import { useRef, useState } from "react";
import QRCode from "react-qr-code";
import ListingShareButton from "@/components/listing-share-button";
import ProviderCouponManager from "@/components/provider-coupon-manager";
import ProviderRecommendationManager from "@/components/provider-recommendation-manager";
import ProviderCampaignManager from "@/components/provider-campaign-manager";
import type { ProviderPlan } from "@/lib/plans";
import CustomSelect from "@/components/custom-select";

type MarketingService = {
  id: string;
  slug: string;
  title: string;
  businessName: string;
  category: string;
  location: string;
  viewCount: number;
  completedBookingCount: number;
};

const publicSiteUrl = "https://bubsbookings.com";

function safeFilename(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "listing";
}

export default function ProviderMarketingTools({ services, providerProfile, plan, activation }: { activation?: ProviderActivation; services: MarketingService[]; providerProfile: { slug: string; name: string; visible: boolean } | null; plan: ProviderPlan }) {
  const [selectedId, setSelectedId] = useState(services[0]?.id ?? "");
  const [downloadError, setDownloadError] = useState("");
  const qrRef = useRef<HTMLDivElement>(null);
  const profileQrRef = useRef<HTMLDivElement>(null);
  const selected = services.find((service) => service.id === selectedId) ?? services[0];
  const listingPublic = activation?.listings.find((item) => item.id === selected?.id)?.publiclyAvailable === true;
  const profilePublic = providerProfile?.visible && activation?.ageVerificationStatus === "verified" && Boolean(activation?.publicListingCount);
  const privateMessage = activation?.ageVerificationStatus !== "verified" ? "Verify age to activate this link." : "Complete listing activation to activate this link.";
  const listingUrl = selected ? `${publicSiteUrl}/services/${selected.slug}` : "";
  const profileUrl = providerProfile ? `${publicSiteUrl}/providers/${providerProfile.slug}` : "";

  function downloadQr(ref: HTMLDivElement | null, filename: string) {
    if (!ref) return;
    const svg = ref.querySelector("svg");
    if (!svg) return setDownloadError("The QR code could not be downloaded. Please try again.");
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg"); clone.setAttribute("width", "1200"); clone.setAttribute("height", "1200");
    const objectUrl = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml;charset=utf-8" }));
    const image = new Image();
    image.onload = () => { const canvas = document.createElement("canvas"); canvas.width = 1600; canvas.height = 1600; const context = canvas.getContext("2d"); if (!context) return; context.fillStyle = "#ffffff"; context.fillRect(0, 0, 1600, 1600); context.drawImage(image, 160, 160, 1280, 1280); URL.revokeObjectURL(objectUrl); canvas.toBlob((png) => { if (!png) return; const link = document.createElement("a"); link.href = URL.createObjectURL(png); link.download = filename; link.click(); window.setTimeout(() => URL.revokeObjectURL(link.href), 1000); }, "image/png"); };
    image.onerror = () => { URL.revokeObjectURL(objectUrl); setDownloadError("The QR code could not be downloaded. Please try again."); };
    image.src = objectUrl;
  }

  function downloadQrCode() {
    if (!listingPublic || !selected || !qrRef.current) return;
    downloadQr(qrRef.current, `${safeFilename(selected.title)}-bubsbookings-qr.png`);
  }

  if (!services.length) {
    return <section className="rounded-[2rem] border border-[#183126]/10 bg-white p-7 sm:p-9">
      <div className="max-w-xl">
        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-[#fff4a8] text-2xl">▦</span>
        <h1 className="mt-5 text-3xl font-bold tracking-[-.04em]">Create a listing to start marketing</h1>
        <p className="mt-3 text-sm leading-6 text-[#66776e]">Once your first service is live, BubsBookings will make a shareable link and QR code for it automatically.</p>
        <Link href="/providers/join" className="mt-6 inline-flex rounded-full bg-[#183126] px-6 py-3 text-sm font-bold text-white transition hover:bg-[#315846]">Create a service listing</Link>
      </div>
    </section>;
  }

  return <div>
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div>
        <p className="text-sm font-semibold text-[#687a70]">Grow your business</p>
        <h1 className="mt-1 text-3xl font-bold tracking-[-.04em] sm:text-4xl">Marketing tools</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[#687a70]">Share a direct path to your listing online, on business cards, or anywhere customers discover you.</p>
      </div>
      <span className="w-fit rounded-full bg-[#e7eee2] px-4 py-2 text-xs font-bold">Included with every provider plan</span>
    </div>

    {providerProfile && !profilePublic && <p role="status" className="mt-7 rounded-2xl bg-white p-5">Your provider profile is private. Complete activation and turn on your public profile before sharing.</p>}
    {providerProfile && profilePublic && <section className="mt-7 rounded-[2rem] border border-[#183126]/10 bg-white p-6 shadow-[0_8px_32px_rgba(24,49,38,.06)] sm:p-8"><div className="grid gap-6 md:grid-cols-[auto_1fr] md:items-center"><div ref={profileQrRef} className="mx-auto h-[164px] w-[164px] rounded-2xl bg-white p-2"><QRCode value={profileUrl} size={148} level="H" bgColor="#ffffff" fgColor="#183126" aria-label={`QR code for ${providerProfile.name} provider profile`} /></div><div><p className="text-xs font-bold uppercase tracking-[.14em] text-[#718078]">Provider profile QR · separate from listing QR codes</p><h2 className="mt-2 text-2xl font-bold">Share your complete provider profile</h2><p className="mt-2 break-all text-sm text-[#687a70]">{profileUrl}</p>{!providerProfile.visible && <p className="mt-2 text-sm font-bold text-[#9b4934]">Your public profile is currently hidden. Turn it on in Public profile before sharing.</p>}<div className="mt-4 flex flex-wrap gap-2"><ListingShareButton providerSlug={providerProfile.slug} title={providerProfile.name} /><button type="button" onClick={() => downloadQr(profileQrRef.current, `${safeFilename(providerProfile.name)}-provider-profile-qr.png`)} className="min-h-11 rounded-full bg-[#183126] px-5 py-2.5 text-sm font-bold text-white">Download profile QR</button><Link href={`/providers/${providerProfile.slug}?preview=owner`} target="_blank" className="inline-flex min-h-11 items-center px-2 text-sm font-bold underline underline-offset-4">View my page ↗</Link></div></div></div></section>}

    <div className="mt-8 grid gap-5 xl:grid-cols-[.82fr_1.18fr]">
      <section className="rounded-[2rem] bg-[#183126] p-6 text-white sm:p-8">
        <p className="text-xs font-bold uppercase tracking-[.14em] text-[#b9c9c0]">Choose a listing</p>
        {services.length > 1 ? <label className="mt-4 block">
          <span className="sr-only">Service listing</span>
          <CustomSelect ariaLabel="Service listing" searchable={services.length > 8} value={selected.id} onChange={(value) => { setSelectedId(value); setDownloadError(""); }} buttonClassName="marketing-listing-select w-full rounded-2xl border px-5 py-3.5 text-sm font-bold outline-none">
            {services.map((service) => <option key={service.id} value={service.id}>{service.title} · {service.businessName}</option>)}
          </CustomSelect>
        </label> : null}

        <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-5">
          <p className="text-xs font-bold uppercase tracking-[.12em] text-[#acc0b5]">{selected.category}</p>
          <h2 className="mt-2 text-2xl font-bold">{selected.title}</h2>
          <p className="mt-1 text-sm text-[#c2d0c8]">{selected.businessName} · {selected.location}</p>
        </div>

        <div className="mt-5">
          <p className="text-xs font-bold uppercase tracking-[.12em] text-[#acc0b5]">Your direct link</p>
          <div className="mt-2 break-all rounded-2xl border border-white/10 bg-[#0f271d] p-4 text-sm text-[#eef5f0]">{listingUrl}</div>
          {!listingPublic && <p role="status" className="mt-3 font-bold">{privateMessage} Copy, Share and QR downloads are unavailable while this listing is private.</p>}
          {listingPublic && <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <ListingShareButton action="copy" serviceId={selected.id} slug={selected.slug} title={selected.title} className="!border-0 !bg-[#eee25a] !text-[#183126] hover:!bg-[#f7ed74]" />
            <ListingShareButton serviceId={selected.id} slug={selected.slug} title={selected.title} description={`Check out ${selected.title} by ${selected.businessName} on BubsBookings.`} className="!border-white/20 !bg-transparent !text-white hover:!border-white/40 hover:!bg-white/10" />
          </div>}
          {listingPublic && <Link href={`/services/${selected.slug}`} target="_blank" className="mt-4 inline-flex text-sm font-bold text-[#eee25a] underline decoration-[#eee25a]/60 underline-offset-4">Preview public listing ↗</Link>}
          <div className="mt-5 grid grid-cols-2 gap-2 text-center text-xs"><div className="rounded-xl border border-white/10 bg-white/5 p-3"><p className="text-lg font-bold text-white">{selected.viewCount.toLocaleString()}</p><p className="mt-1 text-[#c2d0c8]">public views</p></div><div className="rounded-xl border border-white/10 bg-white/5 p-3"><p className="text-lg font-bold text-white">{selected.completedBookingCount.toLocaleString()}</p><p className="mt-1 text-[#c2d0c8]">completed bookings</p></div></div>
        </div>
      </section>

      {listingPublic && <section className="rounded-[2rem] border border-[#183126]/10 bg-white p-6 shadow-[0_8px_32px_rgba(24,49,38,.06)] sm:p-8">
        <div className="grid gap-7 md:grid-cols-[auto_1fr] md:items-center">
          <div className="mx-auto rounded-[1.75rem] border border-[#183126]/10 bg-white p-5 shadow-[0_8px_28px_rgba(24,49,38,.08)]">
            <div ref={qrRef} className="h-[220px] w-[220px] bg-white p-1">
              <QRCode value={listingUrl} size={212} level="H" bgColor="#ffffff" fgColor="#183126" aria-label={`QR code for ${selected.title}`} />
            </div>
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-[.14em] text-[#718078]">Ready to print</p>
            <h2 className="mt-2 text-2xl font-bold">Your listing QR code</h2>
            <p className="mt-3 text-sm leading-6 text-[#66776e]">Customers who scan it go directly to <strong className="text-[#183126]">{selected.title}</strong>, where they can review the details and request a booking.</p>
            <button type="button" onClick={downloadQrCode} className="mt-5 w-full rounded-full bg-[#183126] px-6 py-3.5 text-sm font-bold text-white transition hover:bg-[#315846] sm:w-auto">Download print-quality PNG</button>
            {downloadError && <p role="alert" className="mt-3 text-xs font-semibold text-[#9b4934]">{downloadError}</p>}
          </div>
        </div>

        <div className="mt-7 grid gap-3 border-t border-[#183126]/10 pt-6 sm:grid-cols-3">
          <div className="rounded-2xl bg-[#f5f5ef] p-4"><p className="font-bold">Keep the white border</p><p className="mt-1 text-xs leading-5 text-[#718078]">It helps phone cameras scan the code reliably.</p></div>
          <div className="rounded-2xl bg-[#f5f5ef] p-4"><p className="font-bold">Print at 1 inch or larger</p><p className="mt-1 text-xs leading-5 text-[#718078]">Ideal for business cards, flyers, signs, and menus.</p></div>
          <div className="rounded-2xl bg-[#f5f5ef] p-4"><p className="font-bold">Test before ordering</p><p className="mt-1 text-xs leading-5 text-[#718078]">Scan a proof with your phone before a large print run.</p></div>
        </div>
      </section>}
    </div>
    <ProviderCouponManager services={services.map(({id,title})=>({id,title}))} allowed={plan !== "starter"} />
    <ProviderCampaignManager />
    <ProviderRecommendationManager />
  </div>;
}
