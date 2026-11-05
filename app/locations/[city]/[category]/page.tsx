import BrandLockup from "@/components/brand-lockup";
import ServiceListingCard from "@/components/service-listing-card";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getServices } from "@/lib/marketplace";
import ServiceCategoryIcon from "@/components/service-category-icon";
import { getServiceCategoryBySlug, serviceCategorySlug } from "@/lib/service-categories";
import { getServiceAreaBySlug, serviceAreaLabel, serviceAreaSlug } from "@/lib/service-areas";
import { absolutePublicUrl } from "@/lib/seo";

export const dynamic = "force-dynamic";

type LocalCategoryPageProps = {
  params: Promise<{ city: string; category: string }>;
};

async function getPageData(params: LocalCategoryPageProps["params"]) {
  const { city, category: categorySlug } = await params;
  const area = getServiceAreaBySlug(city);
  const category = getServiceCategoryBySlug(categorySlug);
  if (!area || !category) return null;
  const location = serviceAreaLabel(area);
  const services = await getServices({ category, delivery: "IN_PERSON", location, radiusMiles: 25, sort: "nearest", limit: 24 });
  return { area, category, location, services };
}

export async function generateMetadata({ params }: LocalCategoryPageProps): Promise<Metadata> {
  const data = await getPageData(params);
  if (!data) notFound();
  const { area, category, services } = data;
  const canonical = absolutePublicUrl(`/locations/${serviceAreaSlug(area)}/${serviceCategorySlug(category)}`);
  const title = `${category} in ${area.city}, ${area.state}`;
  const description = `Compare ${category.toLowerCase()} providers serving ${area.city}, ${area.state}. View local prices, photos, service details, and availability on BubsBookings.`;
  return {
    title,
    description,
    alternates: { canonical },
    robots: services.length ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: { title, description, url: canonical, type: "website", images: services[0]?.imageUrls[0] ? [services[0].imageUrls[0]] : undefined },
  };
}

export default async function LocalCategoryPage({ params }: LocalCategoryPageProps) {
  const data = await getPageData(params);
  if (!data) notFound();
  const { area, category, location, services } = data;
  const pageUrl = `https://bubsbookings.com/locations/${serviceAreaSlug(area)}/${serviceCategorySlug(category)}`;
  const searchHref = `/?category=${encodeURIComponent(category)}&location=${encodeURIComponent(location)}&radius=25#nearby-listings`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://bubsbookings.com" },
        { "@type": "ListItem", position: 2, name: "Service areas", item: "https://bubsbookings.com/locations" },
        { "@type": "ListItem", position: 3, name: location, item: `https://bubsbookings.com/locations/${serviceAreaSlug(area)}` },
        { "@type": "ListItem", position: 4, name: category, item: pageUrl },
      ] },
      { "@type": "ItemList", name: `${category} providers in ${location}`, numberOfItems: services.length, itemListElement: services.map((service, index) => ({ "@type": "ListItem", position: index + 1, url: `https://bubsbookings.com/services/${service.slug}`, name: service.title })) },
    ],
  };

  return <main className="min-h-screen bg-[#f8f7f3] text-[#183126]">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
    <header className="border-b border-[#183126]/10 bg-white"><div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8"><Link href="/" className="flex items-center gap-2.5 text-xl font-bold"><BrandLockup /></Link><Link href={`/locations/${serviceAreaSlug(area)}`} className="text-sm font-bold hover:underline">Services in {area.city}</Link></div></header>
    <section className="border-b border-[#183126]/10 bg-[radial-gradient(circle_at_85%_15%,rgba(206,225,198,.85),transparent_30%)]"><div className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
      <nav aria-label="Breadcrumb" className="text-sm font-semibold text-[#61736a]"><Link href="/locations" className="hover:underline">Service areas</Link><span aria-hidden="true"> / </span><Link href={`/locations/${serviceAreaSlug(area)}`} className="hover:underline">{location}</Link><span aria-hidden="true"> / </span><span>{category}</span></nav>
      <div className="mt-8 grid items-center gap-8 md:grid-cols-[1fr_auto]"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-[#687b70]">Local {category.toLowerCase()}</p><h1 className="mt-3 text-4xl font-bold tracking-[-.05em] sm:text-6xl">{category} in {area.city}, {area.state}</h1><p className="mt-5 max-w-3xl text-lg leading-8 text-[#5d7066]">Compare local {category.toLowerCase()} providers serving {area.city} and nearby communities. Review photos, starting prices, service details, and availability before requesting a booking.</p></div><ServiceCategoryIcon category={category} className="h-28 min-h-28 w-28 min-w-28 rounded-[2rem] [&_svg]:h-20 [&_svg]:w-20" /></div>
    </div></section>
    <section className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm text-[#6d7c75]">{services.length} local {services.length === 1 ? "listing" : "listings"}</p><h2 className="mt-1 text-3xl font-bold">Compare providers near {area.city}</h2></div><Link href={searchHref} className="rounded-full bg-[#eee25a] px-5 py-3 text-sm font-bold transition hover:bg-[#e2d43f]">See search filters</Link></div>
      {services.length ? <div className="premium-listing-grid mt-8">{services.map((service) => <ServiceListingCard key={service.id} service={service} />)}</div> : <div className="mt-8 rounded-[2rem] border border-[#183126]/10 bg-white p-10 text-center"><h2 className="text-xl font-bold">No matching providers yet</h2><p className="mt-2 text-sm text-[#6b7b73]">Try a wider search or check back as BubsBookings adds providers near {area.city}.</p><Link href={searchHref} className="mt-6 inline-block rounded-full bg-[#183126] px-5 py-3 text-sm font-bold text-white">Search nearby</Link></div>}
    </section>
    <section className="border-t border-[#183126]/10 bg-white"><div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 sm:px-8 md:grid-cols-2"><div><h2 className="text-2xl font-bold">Finding the right {category.toLowerCase()} provider</h2><p className="mt-4 leading-7 text-[#5d7066]">Compare what each listing includes, check the provider’s working radius and availability, and review the starting price. If the scope can vary, the provider may send a revised quote for you to approve before the booking is confirmed.</p></div><div><h2 className="text-2xl font-bold">Serving {area.city} and nearby areas</h2><p className="mt-4 leading-7 text-[#5d7066]">Results are based on providers whose listed working area reaches within 25 miles of {area.city}. Exact travel availability may vary by provider and appointment.</p></div></div></section>
  </main>;
}
