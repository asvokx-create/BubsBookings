import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { notFound, permanentRedirect } from "next/navigation";
import AccountNav from "@/components/account-nav";
import BackButton from "@/components/back-button";
import BrandLockup from "@/components/brand-lockup";
import ContactProviderLink from "@/components/contact-provider-link";
import ListingShareButton from "@/components/listing-share-button";
import MobileSiteNav from "@/components/mobile-site-nav";
import ProfileAvatar from "@/components/profile-avatar";
import ServiceCategoryIcon from "@/components/service-category-icon";
import ServiceListingCard from "@/components/service-listing-card";
import UiIcon from "@/components/ui-icon";
import { getProviderBySlug, getServiceVisual } from "@/lib/marketplace";
import { getProviderAccess } from "@/lib/provider-access";
import { absolutePublicUrl, metadataDescription } from "@/lib/seo";

export const dynamic = "force-dynamic";
const dayNames = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

export async function generateMetadata({ params, searchParams }: PageProps<"/providers/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const provider = await getProviderBySlug(slug);
  if (!provider) {
    const query = await searchParams;
    if (query.preview === "owner") return { title: "Private provider preview", robots: { index: false, follow: false } };
    notFound();
  }
  const title = provider.hasInPersonServices ? `${provider.businessName} in ${provider.city}, ${provider.state}` : `${provider.businessName} online services`;
  const serviceSummary = provider.services.slice(0, 2).map((service) => service.title).join(" and ");
  const availability = provider.hasRemoteServices && provider.hasInPersonServices
    ? `Available online and near ${provider.city}, ${provider.state}.`
    : provider.hasRemoteServices ? "Available online across the United States." : `Serving ${provider.city}, ${provider.state}.`;
  const description = metadataDescription([`Explore ${serviceSummary || "services"} from ${provider.businessName}.`, availability, provider.bio]);
  const image = provider.portfolio[0]?.url || provider.profileImageUrl || provider.services[0]?.imageUrls[0];
  const canonical = absolutePublicUrl(`/providers/${provider.publicSlug}`);
  return { title, description, alternates: { canonical }, robots: { index: true, follow: true }, openGraph: { siteName: "BubsBookings", title, description, url: canonical, type: "website", images: image ? [{ url: image, alt: `${provider.businessName} services` }] : undefined }, twitter: { card: image ? "summary_large_image" : "summary", title, description, images: image ? [image] : undefined } };
}

export default async function ProviderProfilePage({ params, searchParams }: PageProps<"/providers/[slug]">) {
  const { slug } = await params;
  const query = await searchParams;
  let provider = await getProviderBySlug(slug);
  let isOwnerPreview = false;
  if (!provider && query.preview === "owner") {
    const access = await getProviderAccess();
    if (access?.isOwner) {
      provider = await getProviderBySlug(slug, { ownerProviderId: access.providerId });
      isOwnerPreview = provider !== null;
    }
  }
  if (!provider) notFound();
  if (slug !== provider.publicSlug) permanentRedirect(`/providers/${provider.publicSlug}${isOwnerPreview ? "?preview=owner" : ""}`);
  const featured = provider.services[0];
  const heroImage = provider.portfolio[0]?.url || featured?.imageUrls[0];
  const visual = getServiceVisual(featured?.category ?? "service");
  const averageRating = provider.reviews.length ? provider.reviews.reduce((sum, review) => sum + review.rating, 0) / provider.reviews.length : null;
  const serviceAreas = provider.serviceAreas.length ? provider.serviceAreas : provider.hasInPersonServices ? [`${provider.city}, ${provider.state}`] : [];
  const canonical = absolutePublicUrl(`/providers/${provider.publicSlug}`);
  const structuredData = { "@context": "https://schema.org", "@graph": [
    { "@type": "Organization", "@id": `${canonical}#provider`, name: provider.businessName, description: provider.bio || undefined, url: canonical, image: heroImage || provider.profileImageUrl || undefined, areaServed: provider.hasRemoteServices ? [{ "@type": "Country", name: "United States" }, ...serviceAreas.map((area) => ({ "@type": "City", name: area }))] : serviceAreas.map((area) => ({ "@type": "City", name: area })), aggregateRating: averageRating ? { "@type": "AggregateRating", ratingValue: Number(averageRating.toFixed(1)), reviewCount: provider.reviews.length } : undefined, makesOffer: provider.services.map((service) => ({ "@type": "Offer", ...(service.pricingType === "QUOTE_ONLY" ? {} : { priceCurrency: "USD", price: service.price, priceSpecification: service.pricingType === "HOURLY" ? { "@type": "UnitPriceSpecification", price: service.price, priceCurrency: "USD", unitText: "HOUR" } : undefined }), url: absolutePublicUrl(`/services/${service.slug}`), itemOffered: { "@type": "Service", name: service.title, areaServed: service.deliveryType === "REMOTE" ? "United States" : service.deliveryType === "BOTH" ? ["United States", `${service.city}, ${service.state}`] : `${service.city}, ${service.state}` } })) },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "BubsBookings", item: absolutePublicUrl("/") },
      { "@type": "ListItem", position: 2, name: provider.businessName, item: canonical },
    ] },
  ] };
  const availabilityLabel = provider.hasRemoteServices && !provider.hasInPersonServices
    ? "Available online across the United States"
    : provider.hasRemoteServices
      ? `Available online and in person near ${provider.city}, ${provider.state}`
      : `Serving ${provider.city}, ${provider.state}${provider.serviceAreas.length > 1 ? ` and ${provider.serviceAreas.length - 1} more area${provider.serviceAreas.length > 2 ? "s" : ""}` : ""}`;

  return <main className="provider-profile-page min-h-screen bg-[#f8f7f3] text-[#183126]">
    {!isOwnerPreview && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, "\\u003c") }} />}
    <header className="relative z-50 border-b border-[#183126]/10 bg-white"><div className="site-container flex items-center justify-between gap-2 px-4 py-4 sm:px-8"><Link href="/" aria-label="BubsBookings home"><BrandLockup compact /></Link><div className="flex items-center gap-2"><MobileSiteNav /><AccountNav /></div></div></header>
    <div className="site-container px-4 py-7 sm:px-8 sm:py-11">
      <BackButton label="Back to services" fallbackHref="/services" />
      {isOwnerPreview && <aside className="mt-5 flex flex-col justify-between gap-3 rounded-2xl border border-[#c7bb41]/40 bg-[#fff9d8] px-5 py-4 sm:flex-row sm:items-center" aria-label="Private profile preview"><div><p className="text-sm font-bold">Private preview</p><p className="mt-1 text-sm text-[#65736b]">Only you can see this version. Your profile needs to be visible and have an active service before customers can open it.</p></div><Link href="/provider/dashboard/profile" className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-full bg-[#183126] px-4 py-2 text-sm font-bold text-white">Return to editor</Link></aside>}
      <section className="mt-6 overflow-hidden rounded-[2rem] border border-[#183126]/10 bg-white shadow-[0_12px_40px_rgba(24,49,38,.08)] sm:rounded-[2.5rem]">
        {heroImage ? <div className="relative h-40 overflow-hidden bg-[#e5e8e2] sm:h-56"><Image src={heroImage} alt={`${provider.businessName} portfolio`} fill preload unoptimized sizes="(max-width: 1280px) 100vw, 1200px" className="object-cover" /></div> : <div role="img" aria-label={`${provider.businessName} service artwork`} className={`relative h-40 bg-gradient-to-br sm:h-56 ${visual.gradient}`}><ServiceCategoryIcon category={featured?.category ?? ""} className="!absolute bottom-5 right-7 h-24 min-h-24 w-24 min-w-24 opacity-90 [&_svg]:h-16 [&_svg]:w-16" /></div>}
        <div className="relative px-5 pb-7 sm:px-9 sm:pb-9">
          <ProfileAvatar name={provider.businessName} imageUrl={provider.profileImageUrl} className="-mt-11 h-[5.5rem] w-[5.5rem] rounded-[1.5rem] border-4 border-white text-2xl shadow-lg sm:h-24 sm:w-24" />
          <div className="mt-5 flex flex-col justify-between gap-5 lg:flex-row lg:items-end"><div className="min-w-0"><div className="flex flex-wrap items-center gap-3"><h1 className="break-words text-3xl font-bold tracking-[-.04em] sm:text-4xl">{provider.businessName}</h1>{provider.isVerified && <span className="rounded-full bg-[#edf2e9] px-3 py-1 text-xs font-bold text-[#4f6d5a]">✓ Profile screened</span>}</div><p className="mt-2 text-[#6b7b73]">{availabilityLabel}</p><div className="mt-3 flex flex-wrap gap-2">{averageRating && <span className="rounded-full bg-[#fff8d2] px-3 py-1 text-xs font-bold">★ {averageRating.toFixed(1)} · {provider.reviews.length} verified {provider.reviews.length === 1 ? "review" : "reviews"}</span>}{provider.completedBookingCount > 0 && <span className="rounded-full bg-[#e5f1e5] px-3 py-1 text-xs font-bold">{provider.completedBookingCount} completed {provider.completedBookingCount === 1 ? "booking" : "bookings"}</span>}{provider.emailVerified && <span className="rounded-full bg-[#e5f1e5] px-3 py-1 text-xs font-bold">✓ Email verified</span>}{provider.businessVerified && <span className="rounded-full bg-[#fff3b0] px-3 py-1 text-xs font-bold">✓ Business profile checked</span>}</div></div><div className="flex flex-wrap gap-2"><ContactProviderLink providerId={provider.id} serviceId={featured?.id} className="inline-flex min-h-12 items-center rounded-full border border-[#183126]/15 bg-white px-5 py-3 text-sm font-bold transition hover:bg-[#e5eddf]" /><ListingShareButton providerSlug={provider.publicSlug} title={provider.businessName} description={`Explore ${provider.businessName} on BubsBookings.`} />{featured && <Link href={`/services/${featured.slug}`} className="inline-flex min-h-12 items-center rounded-full bg-[#eee25a] px-5 py-3 text-sm font-bold">View services</Link>}</div></div>
        </div>
      </section>

      <div className="mt-7 grid gap-6 lg:grid-cols-[1.15fr_.85fr]"><div className="space-y-6">
        {(provider.bio || provider.experienceSummary || provider.yearsExperience !== null || provider.specialties.length > 0 || provider.languages.length > 0 || provider.highlights.length > 0) && <section className="rounded-[2rem] border border-[#183126]/10 bg-white p-6 sm:p-8"><h2 className="text-2xl font-bold">About</h2>{provider.bio && <p className="mt-4 whitespace-pre-line leading-7 text-[#62736a]">{provider.bio}</p>}{(provider.yearsExperience !== null || provider.experienceSummary) && <div className="mt-6 border-t border-[#183126]/10 pt-6"><h3 className="font-bold">Experience</h3>{provider.yearsExperience !== null && <p className="mt-2 text-sm font-semibold">{provider.yearsExperience} {provider.yearsExperience === 1 ? "year" : "years"} of provider-supplied experience</p>}{provider.experienceSummary && <p className="mt-2 whitespace-pre-line text-sm leading-6 text-[#62736a]">{provider.experienceSummary}</p>}</div>}{provider.specialties.length > 0 && <TagGroup title="Specialties" values={provider.specialties} />}{provider.languages.length > 0 && <TagGroup title="Languages" values={provider.languages} />}{provider.highlights.length > 0 && <TagGroup title="Highlights" values={provider.highlights} />}</section>}
        {provider.portfolio.length > 0 && <section className="rounded-[2rem] border border-[#183126]/10 bg-white p-6 sm:p-8"><p className="text-xs font-bold uppercase tracking-[.14em] text-[#708078]">Work gallery</p><h2 className="mt-2 text-2xl font-bold">Portfolio</h2><div className="mt-5 grid gap-4 sm:grid-cols-2">{provider.portfolio.map((item) => <figure key={item.id} className="overflow-hidden rounded-2xl border border-[#183126]/10 bg-[#f5f5ef]"><Image src={item.url} alt={item.altText || item.caption || `${provider.businessName} portfolio work`} width={800} height={600} unoptimized className="aspect-[4/3] w-full object-cover" />{(item.caption || item.serviceTitle) && <figcaption className="p-4 text-sm"><span className="font-semibold">{item.caption}</span>{item.serviceTitle && <span className="mt-1 block text-xs text-[#718078]">Related service: {item.serviceTitle}</span>}</figcaption>}</figure>)}</div></section>}
        <section className="rounded-[2rem] border border-[#183126]/10 bg-white p-6 sm:p-8"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[.14em] text-[#708078]">Book with this provider</p><h2 className="mt-2 text-2xl font-bold">Services</h2></div><span className="text-sm text-[#718078]">{provider.services.length} active {provider.services.length === 1 ? "listing" : "listings"}</span></div><div className="mt-6 grid gap-4 sm:grid-cols-2">{provider.services.map((service) => <ServiceListingCard key={service.id} service={{ ...service, provider: provider.businessName, providerProfileImageUrl: provider.profileImageUrl, providerAverageRating: averageRating, providerReviewCount: provider.reviews.length, providerSlug: provider.publicSlug, providerProfileVisible: true }} />)}</div></section>
        {provider.reviews.length > 0 && <section className="rounded-[2rem] border border-[#183126]/10 bg-white p-6 sm:p-8"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[.14em] text-[#708078]">Completed bookings only</p><h2 className="mt-2 text-2xl font-bold">Verified reviews</h2></div><span className="rounded-full bg-[#fff8d2] px-4 py-2 text-sm font-bold">★ {averageRating?.toFixed(1)} · {provider.reviews.length}</span></div><div className="mt-5 grid gap-3">{provider.reviews.map((review) => <article key={review.id} className="rounded-2xl bg-[#f5f5ef] p-5"><div className="flex flex-wrap justify-between gap-2"><p className="font-bold">{review.customerName}</p><span className="text-[#c69d18]" aria-label={`${review.rating} out of 5 stars`}>{"★".repeat(review.rating)}</span></div><p className="mt-1 text-xs text-[#718078]">{review.serviceTitle} · {review.createdAt.toLocaleDateString("en-US", { month: "short", year: "numeric" })}</p><p className="mt-3 text-sm leading-6 text-[#52665b]">{review.body}</p></article>)}</div></section>}
        {provider.recommendations.length > 0 && <section className="rounded-[2rem] border border-[#183126]/10 bg-white p-6 sm:p-8"><p className="text-xs font-bold uppercase tracking-[.14em] text-[#708078]">Outside-client feedback · moderated</p><h2 className="mt-2 text-2xl font-bold">Client Recommendations</h2><p className="mt-2 text-sm leading-6 text-[#687970]">These recommendations come from clients outside BubsBookings. They are not verified booking reviews and do not affect the provider rating.</p><div className="mt-5 grid gap-3">{provider.recommendations.map(item=><article key={item.id} className="rounded-2xl bg-[#f5f5ef] p-5"><p className="font-bold">{item.displayName}</p><p className="mt-1 text-xs text-[#718078]">{item.relationship} · {item.createdAt.toLocaleDateString("en-US",{month:"short",year:"numeric"})}</p><p className="mt-3 text-sm leading-6 text-[#52665b]">{item.body}</p></article>)}</div></section>}
      </div><aside className="space-y-6 lg:sticky lg:top-6 lg:self-start"><section className="rounded-[2rem] border border-[#183126]/10 bg-white p-6"><h2 className="text-xl font-bold">Service availability</h2>{provider.hasRemoteServices && <p className="mt-4 flex gap-2 text-sm font-bold text-[#4f695a]"><UiIcon name="globe" className="mt-0.5 h-4 w-4 shrink-0" />Remote services available across the supported U.S. marketplace</p>}{provider.hasInPersonServices && <><p className="mt-4 text-xs font-bold uppercase tracking-[.12em] text-[#718078]">In-person service area</p><ul className="mt-2 space-y-2 text-sm text-[#62736a]">{serviceAreas.map((area) => <li key={area} className="flex gap-2"><UiIcon name="map-pin" className="mt-0.5 h-4 w-4 shrink-0" />{area}</li>)}</ul></>}</section>{provider.availableWeekdays.length > 0 && <section className="rounded-[2rem] border border-[#183126]/10 bg-white p-6"><h2 className="text-xl font-bold">General availability</h2><p className="mt-3 text-sm leading-6 text-[#62736a]">Usually available {provider.availableWeekdays.map((day) => dayNames[day]).join(", ")}. Exact times and openings appear during booking.</p></section>}<section className="rounded-[2rem] bg-[#183126] p-6 text-white"><h2 className="text-xl font-bold">Ready to ask a question?</h2><p className="mt-2 text-sm leading-6 text-[#c5d2cb]">Messages stay in BubsBookings so booking details and support remain together.</p><ContactProviderLink providerId={provider.id} serviceId={featured?.id} className="mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-[#eee25a] px-5 py-3 text-sm font-bold text-[#183126]" /></section></aside></div>
    </div>
  </main>;
}

function TagGroup({ title, values }: { title: string; values: string[] }) {
  return <div className="mt-6 border-t border-[#183126]/10 pt-6"><h3 className="font-bold">{title}</h3><div className="mt-3 flex flex-wrap gap-2">{values.map((value) => <span key={value} className="rounded-full bg-[#edf2e9] px-3 py-2 text-xs font-bold text-[#4f6d5a]">{value}</span>)}</div></div>;
}
