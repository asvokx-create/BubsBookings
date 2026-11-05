import BrandLockup from "@/components/brand-lockup";
import BackButton from "@/components/back-button";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import AccountNav from "@/components/account-nav";
import ServiceListingCard from "@/components/service-listing-card";
import { getCompanyBySlug } from "@/lib/companies";
import MobileSiteNav from "@/components/mobile-site-nav";
import ExplainedUi from "@/components/explained-ui";
import { absolutePublicUrl, metadataDescription } from "@/lib/seo";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const company = await getCompanyBySlug((await params).slug);
  if (!company) notFound();
  const serviceAvailability = company.services.some((service) => service.deliveryType !== "IN_PERSON") ? "including remote options" : `across ${company.locations.map((location) => `${location.city}, ${location.state}`).join(", ")}`;
  const serviceSummary = company.services.slice(0, 2).map((service) => service.title).join(" and ");
  const description = metadataDescription([`Explore ${serviceSummary || "services"} from ${company.name},`, `${serviceAvailability}.`, company.bio]);
  const canonical = absolutePublicUrl(`/companies/${company.slug}`);
  const image = company.services.find((service) => service.imageUrl)?.imageUrl;
  return {
    title: `${company.name} services`,
    description,
    alternates: { canonical },
    robots: company.services.length ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: { type: "website", siteName: "BubsBookings", title: `${company.name} services`, description, url: canonical, images: image ? [{ url: image, alt: `${company.name} services` }] : undefined },
    twitter: { card: image ? "summary_large_image" : "summary", title: `${company.name} services`, description, images: image ? [image] : undefined },
  };
}

export default async function CompanyPage({ params }: { params: Promise<{ slug: string }> }) {
  const company = await getCompanyBySlug((await params).slug);
  if (!company) notFound();
  const hasRemoteServices = company.services.some((service) => service.deliveryType !== "IN_PERSON");
  const hasInPersonServices = company.services.some((service) => service.deliveryType !== "REMOTE");
  const availabilitySummary = hasRemoteServices && hasInPersonServices
    ? `Available online and across ${company.locations.length} ${company.locations.length === 1 ? "local service area" : "local service areas"}`
    : hasRemoteServices
      ? "Available online"
      : `Serving ${company.locations.length} ${company.locations.length === 1 ? "local service area" : "local service areas"}`;
  const canonical = absolutePublicUrl(`/companies/${company.slug}`);
  const structuredData = { "@context": "https://schema.org", "@graph": [
    { "@type": "Organization", "@id": `${canonical}#business`, name: company.name, description: company.bio || undefined, url: canonical,
      areaServed: [
        ...(hasRemoteServices ? [{ "@type": "Country", name: "United States" }] : []),
        ...company.locations.map((location) => ({ "@type": "City", name: `${location.city}, ${location.state}` })),
      ],
      makesOffer: company.services.map((service) => ({ "@type": "Offer", ...(service.pricingType === "QUOTE_ONLY" ? {} : { priceCurrency: "USD", price: service.pricingType === "HOURLY" && service.hourlyRateCents !== null ? service.hourlyRateCents / 100 : service.price }), url: absolutePublicUrl(`/services/${service.slug}`), itemOffered: { "@type": "Service", name: service.title } })),
    },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "BubsBookings", item: absolutePublicUrl("/") },
      { "@type": "ListItem", position: 2, name: company.name, item: canonical },
    ] },
  ] };
  return <main className="min-h-screen bg-[#f5f4ef] text-[#183126]">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, "\\u003c") }} />
    <header className="sticky top-0 z-50 border-b border-[#183126]/10 bg-white/95 backdrop-blur-xl"><div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-4 sm:px-8"><Link href="/" className="flex min-w-0 items-center gap-2.5 text-xl font-bold"><BrandLockup compact /></Link><div className="flex items-center gap-2"><MobileSiteNav /><AccountNav /></div></div></header>
    <section className="bg-[#183126] text-white"><div className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16"><BackButton label="Back to services" fallbackHref="/services" /><div className="mt-7 flex flex-col justify-between gap-6 sm:flex-row sm:items-end"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-[#eee25a]">Company page</p><h1 className="mt-3 text-4xl font-bold tracking-[-.05em] sm:text-5xl">{company.name}</h1><p className="mt-4 text-[#c1d0c8]">{company.publicOwnerName && <>Owned by {company.publicOwnerName} · </>}{availabilitySummary}</p></div>{company.verified && <ExplainedUi id="company-profile-screened-help" explanation="The provider's required profile fields and active listings passed BubsBookings' current automated completeness and safety checks. This is not a background check, license check, insurance verification, endorsement, or guarantee."><span className="inline-flex w-fit rounded-full bg-[#e4f1e5] px-4 py-2 text-xs font-bold text-[#34704a]">✓ Profile screened</span></ExplainedUi>}</div>{company.bio && <p className="mt-7 max-w-3xl text-base leading-7 text-[#d2ddd7]">{company.bio}</p>}<div className="mt-6 flex flex-wrap gap-2">{hasRemoteServices && <span className="rounded-full bg-white/10 px-3 py-2 text-xs font-semibold">↔ Available online</span>}{hasInPersonServices && company.locations.map((location) => { const cityState = `${location.city}, ${location.state}`; const locationLabel = location.name.trim().toLowerCase() === cityState.toLowerCase() ? cityState : `${location.name} · ${cityState}`; return <span key={location.id} className="rounded-full bg-white/10 px-3 py-2 text-xs font-semibold">⌖ {locationLabel} · {location.serviceRadiusMiles} mi</span>; })}{company.providerProfileVisible && company.providerSlug && <Link href={`/providers/${company.providerSlug}`} className="rounded-full bg-white/10 px-3 py-2 text-xs font-bold underline underline-offset-4">View full provider profile</Link>}</div></div></section>
    <section className="mx-auto max-w-6xl px-5 py-12 sm:px-8"><div className="flex items-end justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.14em] text-[#718078]">Services by {company.name}</p><h2 className="mt-2 text-3xl font-bold">Choose a service</h2></div><span className="text-sm font-bold text-[#718078]">{company.services.length} {company.services.length === 1 ? "listing" : "listings"}</span></div>
      {company.services.length ? <div className="premium-listing-grid mt-7">{company.services.map((service) => <ServiceListingCard key={service.id} service={{ ...service, provider: company.name, companySlug: company.slug, providerStatus: company.verified ? "Profile screened" : "New provider" }} locationLabel={service.location} />)}</div> : <div className="mt-7 rounded-[2rem] bg-white p-10 text-center"><p className="font-bold">No active services right now</p><p className="mt-2 text-sm text-[#718078]">Check back after {company.name} publishes its next listing.</p></div>}
    </section>
  </main>;
}
