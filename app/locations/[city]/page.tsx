import BrandLockup from "@/components/brand-lockup";
import ServiceListingCard from "@/components/service-listing-card";
import ServiceCategoryIcon from "@/components/service-category-icon";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getServices } from "@/lib/marketplace";
import { FEATURED_SERVICE_CATEGORIES, serviceCategorySlug } from "@/lib/service-categories";
import { getServiceAreaBySlug, SERVICE_AREAS, serviceAreaLabel, serviceAreaSlug } from "@/lib/service-areas";
import { absolutePublicUrl } from "@/lib/seo";

export const dynamic = "force-dynamic";

export function generateStaticParams() { return SERVICE_AREAS.map((area) => ({ city: serviceAreaSlug(area) })); }

export async function generateMetadata({ params }: PageProps<"/locations/[city]">): Promise<Metadata> {
  const { city } = await params;
  const area = getServiceAreaBySlug(city);
  if (!area) notFound();
  const title = `Local services in ${area.city}, ${area.state}`;
  const description = `Find and compare local service providers near ${area.city}, ${area.state} on BubsBookings.`;
  const services = await getServices({ delivery: "IN_PERSON", location: serviceAreaLabel(area), radiusMiles: 25, limit: 1 }).catch(() => []);
  const canonical = absolutePublicUrl(`/locations/${serviceAreaSlug(area)}`);
  return { title, description, alternates: { canonical }, robots: services.length ? { index: true, follow: true } : { index: false, follow: true }, openGraph: { title, description, url: canonical } };
}

export default async function LocationPage({ params }: PageProps<"/locations/[city]">) {
  const { city } = await params;
  const area = getServiceAreaBySlug(city);
  if (!area) notFound();
  const location = serviceAreaLabel(area);
  const services = await getServices({ delivery: "IN_PERSON", location, radiusMiles: 25, sort: "nearest", limit: 12 });
  const searchHref = `/?location=${encodeURIComponent(location)}&radius=25#nearby-listings`;
  const jsonLd = { "@context": "https://schema.org", "@type": "ItemList", name: `Local services near ${location}`, numberOfItems: services.length, itemListElement: services.map((service, index) => ({ "@type": "ListItem", position: index + 1, url: `https://bubsbookings.com/services/${service.slug}`, name: service.title })) };

  return <main className="min-h-screen bg-[#f8f7f3] text-[#183126]">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
    <header className="border-b border-[#183126]/10 bg-white"><div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8"><Link href="/" className="flex items-center gap-2.5 text-xl font-bold"><BrandLockup /></Link><Link href="/locations" className="text-sm font-bold">All service areas</Link></div></header>
    <section className="border-b border-[#183126]/10 bg-[radial-gradient(circle_at_85%_15%,rgba(206,225,198,.8),transparent_28%)]"><div className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16"><p className="text-xs font-bold uppercase tracking-[.16em] text-[#687b70]">Local marketplace</p><h1 className="mt-3 text-4xl font-bold tracking-[-.05em] sm:text-6xl">Services in {area.city}, {area.state}</h1><p className="mt-5 max-w-2xl text-lg leading-8 text-[#5d7066]">Compare active local listings within 25 miles of {area.city}. Review service details, availability, and clear prices before requesting a booking.</p><div className="mt-7 flex flex-wrap gap-2">{FEATURED_SERVICE_CATEGORIES.map((category) => <Link key={category} href={`/locations/${serviceAreaSlug(area)}/${serviceCategorySlug(category)}`} className="inline-flex items-center gap-2 rounded-full border border-[#183126]/12 bg-white px-3 py-2 text-sm font-bold transition hover:bg-[#eee25a]"><ServiceCategoryIcon category={category} compact className="h-7 min-h-7 w-7 min-w-7 rounded-md [&_svg]:h-5 [&_svg]:w-5" />{category}</Link>)}</div></div></section>
    <section className="mx-auto max-w-6xl px-5 py-12 sm:px-8"><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm text-[#6d7c75]">{services.length} nearby {services.length === 1 ? "listing" : "listings"}</p><h2 className="mt-1 text-3xl font-bold">Available near {area.city}</h2></div><Link href={searchHref} className="rounded-full bg-[#eee25a] px-5 py-3 text-sm font-bold">Search all nearby</Link></div>{services.length ? <div className="premium-listing-grid mt-8">{services.map((service) => <ServiceListingCard key={service.id} service={service} />)}</div> : <div className="mt-8 rounded-[2rem] border border-[#183126]/10 bg-white p-10 text-center"><h2 className="text-xl font-bold">No nearby listings yet</h2><p className="mt-2 text-sm text-[#6b7b73]">BubsBookings is growing in {area.city}. Explore a wider area or become one of the first local providers.</p><div className="mt-6 flex flex-wrap justify-center gap-3"><Link href={searchHref} className="rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white">Widen your search</Link><Link href="/providers/join" className="rounded-full bg-[#eee25a] px-5 py-3 text-sm font-bold">List a service</Link></div></div>}</section>
  </main>;
}
