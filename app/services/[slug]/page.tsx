import BrandLockup from "@/components/brand-lockup";
import Link from "next/link";
import ExplainedUi from "@/components/explained-ui";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { auth, isAuthConfigured } from "@/lib/auth";
import { formatDuration, getServiceBySlug, getServiceVisual } from "@/lib/marketplace";
import BookingCard from "./booking-card";
import StationaryBookingPanel from "@/components/stationary-booking-panel";
import AccountNav from "@/components/account-nav";
import FavoriteButton from "@/components/favorite-button";
import ContactProviderLink from "@/components/contact-provider-link";
import { serviceCategorySlug } from "@/lib/service-categories";
import { getServiceAreaCoordinates, serviceAreaSlug } from "@/lib/service-areas";
import ListingPhotoGallery from "@/components/listing-photo-gallery";
import MobileSiteNav from "@/components/mobile-site-nav";
import BackButton from "@/components/back-button";
import ListingShareButton from "@/components/listing-share-button";
import { deliveryLabel } from "@/lib/service-delivery";
import UiIcon from "@/components/ui-icon";
import { formatHourlyRate } from "@/lib/service-pricing";
import { absolutePublicUrl, metadataDescription } from "@/lib/seo";
import { getOwnerPrivateListingStatus } from "@/lib/private-listing-status";
import UnavailableListing from "./unavailable-listing";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/services/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const service = await getServiceBySlug(slug);
  if (!service) return { title: "Listing unavailable", description: "This listing is not currently available.", robots: { index: false, follow: false } };
  const placeDescription = service.deliveryType === "REMOTE" ? "Available remotely across the United States." : `Available in ${service.city}, ${service.state}.`;
  const priceLabel = service.pricingType === "QUOTE_ONLY" ? "Personalized quote available" : service.pricingType === "HOURLY" && service.hourlyRateCents !== null ? formatHourlyRate(service.hourlyRateCents) : `starting at $${service.price}`;
  const description = metadataDescription([`Explore ${service.title} from ${service.provider}.`, placeDescription, `${priceLabel}.`, service.description]);
  const socialTitle = `${service.title} | BubsBookings`;
  const fallbackImage = `/services/${service.slug}/opengraph-image`;
  const socialImage = service.imageUrls[0] ? { url: service.imageUrls[0], alt: `${service.title} by ${service.provider}` } : { url: fallbackImage, width: 1200, height: 630, alt: `${service.title} on BubsBookings` };
  const canonical = absolutePublicUrl(`/services/${service.slug}`);
  return {
    title: service.deliveryType === "REMOTE" ? service.title : `${service.title} in ${service.city}, ${service.state}`,
    description,
    alternates: { canonical },
    robots: { index: true, follow: true },
    openGraph: { type: "website", siteName: "BubsBookings", title: socialTitle, description, url: canonical, images: [socialImage] },
    twitter: { card: "summary_large_image", title: socialTitle, description, images: [service.imageUrls[0] ?? fallbackImage] },
  };
}

export default async function ServicePage({ params, searchParams }: PageProps<"/services/[slug]">) {
  const { slug } = await params;
  const query = await searchParams;
  const requestedReturnPath = query.from;
  const returnPathValue = Array.isArray(requestedReturnPath) ? requestedReturnPath[0] : requestedReturnPath;
  const validMarketplaceReturn = returnPathValue && !returnPathValue.startsWith("//") && (returnPathValue === "/" || returnPathValue.startsWith("/?") || returnPathValue.startsWith("/#") || returnPathValue.startsWith("/services"));
  const servicesReturnPath = validMarketplaceReturn ? returnPathValue : "/#nearby-listings";
  const parentBookingId = typeof query.repeatOf === "string" ? query.repeatOf : "";
  const service = await getServiceBySlug(slug);
  const session = isAuthConfigured() ? await auth.api.getSession({ headers: await headers() }) : null;
  if (!service) {
    const ownerStatus = session?.user?.id ? await getOwnerPrivateListingStatus(slug, session.user.id) : null;
    if (ownerStatus) return <UnavailableListing ownerStatus={ownerStatus} />;
    notFound();
  }

  const visual = getServiceVisual(service.category);
  const duration = formatDuration(service.durationMinutes);
  const priceLabel = service.pricingType === "QUOTE_ONLY" ? "Request a Quote" : service.pricingType === "HOURLY" && service.hourlyRateCents !== null ? formatHourlyRate(service.hourlyRateCents) : `$${service.price}`;
  const serviceArea = service.deliveryType === "REMOTE" ? undefined : getServiceAreaCoordinates(`${service.city}, ${service.state}`);
  const localCategoryHref = serviceArea ? `/locations/${serviceAreaSlug(serviceArea)}/${serviceCategorySlug(service.category)}` : null;
  const canonical = absolutePublicUrl(`/services/${service.slug}`);
  const providerUrl = service.companySlug
    ? absolutePublicUrl(`/companies/${service.companySlug}`)
    : service.providerProfileVisible && service.providerSlug
      ? absolutePublicUrl(`/providers/${service.providerSlug}`)
      : undefined;
  const serviceJsonLd = {
    "@type": "Service",
    "@id": `${canonical}#service`,
    name: service.title,
    description: service.description,
    url: canonical,
    ...(service.imageUrls.length ? { image: service.imageUrls } : {}),
    areaServed: service.deliveryType === "REMOTE" ? { "@type": "Country", name: "United States" } : { "@type": "City", name: `${service.city}, ${service.state}` },
    provider: { "@type": "Organization", name: service.provider, ...(providerUrl ? { url: providerUrl } : {}) },
    ...(service.pricingType === "QUOTE_ONLY" ? {} : { offers: { "@type": "Offer", priceCurrency: "USD", price: service.price,
      priceSpecification: service.pricingType === "HOURLY" ? { "@type": "UnitPriceSpecification", price: service.price, priceCurrency: "USD", unitText: "HOUR" } : undefined,
      description: service.pricingType === "HOURLY" ? `Hourly rate. Minimum booking ${service.minimumDurationMinutes} minutes.` : "Starting price; the provider may send a revised quote before confirmation." },
    }),
  };
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      serviceJsonLd,
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "BubsBookings", item: absolutePublicUrl("/") },
        { "@type": "ListItem", position: 2, name: service.title, item: canonical },
      ] },
    ],
  };

  return (
    <main className="service-detail-page min-h-screen bg-[#f8f7f3] text-[#183126]">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <header className="relative z-50 border-b border-[#183126]/10 bg-[#f8f7f3]/90 backdrop-blur">
        <div className="site-container flex items-center justify-between gap-2 px-4 py-4 sm:px-6 sm:py-5">
          <Link href="/" className="flex min-w-0 items-center gap-2 text-xl font-bold tracking-tight sm:gap-2.5 sm:text-2xl"><BrandLockup /></Link>
          <div className="flex items-center gap-1 sm:gap-3"><Link href="/pricing" className="hidden rounded-full px-2 py-2 text-xs font-semibold hover:bg-[#183126]/5 sm:inline-flex sm:px-4 sm:text-sm"><span className="sm:hidden">Pricing</span><span className="hidden sm:inline">Provider pricing</span></Link><Link href="/providers/join" className="hidden rounded-full px-4 py-2 text-sm font-semibold hover:bg-[#183126]/5 md:block">List your service</Link><MobileSiteNav /><div className="service-detail-account"><AccountNav /></div></div>
        </div>
      </header>

      <div className="service-detail-container site-container px-4 py-7 sm:px-6 sm:py-12">
        <div className="service-detail-actions flex items-center justify-between gap-3"><BackButton label={returnPathValue ? "Back to results" : "Back to services"} fallbackHref={servicesReturnPath} /><ListingShareButton serviceId={service.id} slug={service.slug} title={service.title} description={`Check out ${service.title} by ${service.provider} on BubsBookings.`} /></div>
        <div className="service-detail-layout mt-7 grid gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,25rem)] lg:gap-10">
          <div className="min-w-0">
            <ListingPhotoGallery images={service.imageUrls} title={service.title} fallbackGradient={visual.gradient} fallbackCategory={service.category}><span className="absolute left-6 top-6 z-20 rounded-full bg-white/90 px-4 py-2 text-xs font-bold shadow-sm backdrop-blur">{service.pricingType === "QUOTE_ONLY" ? "Custom Quote" : "New listing"}</span><FavoriteButton serviceId={service.id} serviceTitle={service.title} className="absolute right-6 top-6 z-20 grid h-12 w-12 place-items-center rounded-full bg-white/90 text-2xl shadow-sm backdrop-blur" /></ListingPhotoGallery>
            <div className="service-detail-summary py-8">
              <p className="text-sm font-bold uppercase tracking-[.15em] text-[#6c7d74]">{localCategoryHref ? <Link href={localCategoryHref} className="hover:underline">{service.category} in {service.city}</Link> : service.category}</p>
              <h1 className="service-detail-title mt-3 text-4xl font-bold tracking-[-.045em] sm:text-5xl">{service.title}</h1>
              <div className="service-detail-meta mt-5 text-sm">
                <div className="service-detail-meta-primary">
                  <ExplainedUi id="delivery-type-help" align="start" explanation={service.deliveryType === "BOTH" ? "This service can be delivered either in person or remotely. You choose the delivery method when booking." : service.deliveryType === "REMOTE" ? "This service is delivered online or remotely and does not require an in-person appointment." : "This service is delivered in person at a physical location; it is not a remote or online appointment."}><span className="rounded-full bg-[#e7efe3] px-3 py-1.5 font-bold text-[#3e6650]">{deliveryLabel(service.deliveryType)}</span></ExplainedUi>
                  {service.deliveryType !== "REMOTE" && <ExplainedUi id="service-map-help" interactive explanation="Opens Google Maps for the city and state where this service is offered. The exact booking address may be shared later."><a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${service.city}, ${service.state}`)}`} target="_blank" rel="noreferrer" className="service-detail-map-link rounded-full px-2 py-1 text-[#718078] transition hover:bg-[#e5eddf] hover:text-[#183126]"><UiIcon name="map-pin" className="h-4 w-4 shrink-0" /> <span>{service.city}, {service.state} · View map</span></a></ExplainedUi>}
                </div>
                <div className="service-detail-provider">
                  <span className="text-[#718078]">Offered by {service.companySlug ? <ExplainedUi id="service-provider-help" interactive explanation="This is the business responsible for delivering the service. Open the business name to see its public page and related services."><Link href={`/companies/${service.companySlug}`} className="font-bold text-[#183126] underline decoration-[#c7bb41] decoration-2 underline-offset-4">{service.provider}</Link></ExplainedUi> : service.providerProfileVisible ? <ExplainedUi id="service-provider-help" interactive explanation="This is the provider responsible for delivering the service. Open the provider name to see their public profile and other services."><Link href={`/providers/${service.providerSlug}`} className="font-bold text-[#183126] underline decoration-[#c7bb41] decoration-2 underline-offset-4">{service.provider}</Link></ExplainedUi> : <ExplainedUi id="service-provider-help" explanation="This is the provider responsible for delivering the service. Their public provider profile is not currently available."><strong className="text-[#183126]">{service.provider}</strong></ExplainedUi>}</span>
                  {service.companySlug && service.deliveryType !== "REMOTE" && <ExplainedUi id="business-location-help" interactive explanation="Opens the provider's public business-location page with the services offered from that location."><Link href={`/companies/${service.companySlug}`} className="font-bold text-[#4f6d5a] underline underline-offset-4">View business location</Link></ExplainedUi>}
                  {service.companySlug && service.providerProfileVisible && service.providerSlug && <Link href={`/providers/${service.providerSlug}`} className="font-bold text-[#4f6d5a] underline underline-offset-4">View provider profile</Link>}
                </div>
                {(service.profileScreened || service.emailVerified || service.businessVerified) && <div className="service-detail-trust">
                  {service.profileScreened && <ExplainedUi id="profile-screened-help" explanation="The provider's required profile fields and active listings passed BubsBookings' automated completeness and safety checks. This is not a background check."><span className="trust-badge--verified rounded-full bg-[#edf2e9] px-3 py-1 text-xs font-bold text-[#4f6d5a]">✓ Profile screened</span></ExplainedUi>}
                  {service.emailVerified && <ExplainedUi id="email-verified-help" explanation="The provider confirmed access to the email address on their BubsBookings account."><span className="trust-badge--verified rounded-full bg-[#e5f1e5] px-3 py-1 text-xs font-bold text-[#376447]">✓ Email verified</span></ExplainedUi>}
                  {service.businessVerified && <ExplainedUi id="business-checked-help" align="end" explanation="The business profile has the required company, location, pricing, and listing details. This does not verify licensing or insurance."><span className="trust-badge--warning rounded-full bg-[#fff3b0] px-3 py-1 text-xs font-bold text-[#735f16]">✓ Business profile checked</span></ExplainedUi>}
                </div>}
                <ContactProviderLink providerId={service.providerId} serviceId={service.id} className="service-detail-contact rounded-full border border-[#183126]/15 bg-white px-4 py-2 font-bold text-[#183126] transition hover:border-[#597563] hover:bg-[#e5eddf]" />
              </div>
              {(service.profileScreened || service.emailVerified || service.businessVerified) && <p className="mt-3 text-xs leading-5 text-[#718078]">Hover or press a trust label to see what it means. Material profile, listing, location, and account edits trigger a new automated check. These checks are not an endorsement, background check, license check, or insurance verification.</p>}
              <section className="mt-7 max-w-2xl"><h2 className="text-sm font-bold uppercase tracking-[.14em] text-[#718078]">What&apos;s included</h2><p className="mt-2 text-lg leading-8 text-[#5b6d64]">{service.description}</p></section>
              {service.deliveryType !== "IN_PERSON" && <section className="mt-5 max-w-2xl rounded-2xl border border-[#183126]/10 bg-white p-5"><h2 className="text-sm font-bold">How remote delivery works</h2><p className="mt-2 text-sm leading-6 text-[#5b6d64]">{service.remoteDeliveryDetails || "The provider will coordinate the approved online meeting or digital delivery method through BubsBookings messages after your request is confirmed."}</p><p className="mt-2 text-xs text-[#718078]">You do not need to share a home or business address for remote bookings.</p></section>}
              <div className="mt-6 flex max-w-2xl flex-wrap gap-3">
                {service.imageUrls.length > 0 && <div className="min-w-44 flex-1 rounded-2xl border border-[#183126]/10 bg-white p-4"><p className="text-lg font-bold">{service.imageUrls.length}</p><p className="mt-1 text-xs text-[#718078]">Listing {service.imageUrls.length === 1 ? "photo" : "photos"}</p></div>}
                {service.completedJobCount > 0 && <div className="min-w-44 flex-1 rounded-2xl border border-[#183126]/10 bg-white p-4"><p className="text-lg font-bold">{service.completedJobCount}</p><p className="mt-1 text-xs text-[#718078]">{service.completedJobCount === 1 ? "Completed booking" : "Completed bookings"}</p></div>}
                <div className="min-w-44 flex-1 rounded-2xl border border-[#183126]/10 bg-white p-4"><p className="text-lg font-bold">{service.averageRating === null ? "New" : `${service.averageRating.toFixed(1)} ★`}</p><p className="mt-1 text-xs text-[#718078]">{service.reviewCount === 0 ? "No verified reviews yet" : `${service.reviewCount} verified ${service.reviewCount === 1 ? "review" : "reviews"}`}</p></div>
              </div>
              <div className="mt-10 border-t border-[#183126]/10 pt-9"><h2 className="text-2xl font-bold tracking-tight">Service details</h2><div className="mt-6 grid gap-4 sm:grid-cols-2"><div className="rounded-2xl bg-white p-5 shadow-[0_4px_18px_rgba(24,49,38,.04)]"><p className="text-xs font-bold uppercase tracking-wider text-[#718078]">{service.pricingType === "HOURLY" ? "Default booking duration" : "Estimated duration"}</p><p className="mt-2 font-bold">{service.pricingType === "HOURLY" ? duration : `About ${duration}`}</p><p className="mt-1 text-xs leading-5 text-[#718078]">Actual service time and approved billable duration are kept separate.</p></div><div className="rounded-2xl bg-white p-5 shadow-[0_4px_18px_rgba(24,49,38,.04)]"><p className="text-xs font-bold uppercase tracking-wider text-[#718078]">{service.pricingType === "QUOTE_ONLY" ? "Pricing" : service.pricingType === "HOURLY" ? "Hourly rate" : "Starting price"}</p><p className="mt-2 font-bold">{priceLabel}</p><p className="mt-1 text-xs leading-5 text-[#718078]">{service.pricingType === "QUOTE_ONLY" ? "Tell the provider what you need. No payment is requested until you accept a personalized quote." : service.pricingType === "HOURLY" ? `${formatDuration(service.minimumDurationMinutes ?? service.durationMinutes)} minimum. Choose the duration before requesting a time.` : "Covers the service described in “What's included.” Any revised quote must be shown before confirmation."}</p></div></div><div className="mt-4 rounded-2xl border border-[#183126]/10 bg-white p-5"><p className="text-xs font-bold uppercase tracking-wider text-[#718078]">Cancellation policy</p><p className="mt-2 text-sm leading-6 text-[#5f7067]">{service.cancellationPolicy}</p><p className="mt-2 text-xs font-semibold text-[#718078]">Standard notice window: {service.cancellationWindowHours} hours</p><p className="mt-5 text-xs font-bold uppercase tracking-wider text-[#718078]">No-show policy</p><p className="mt-2 text-sm leading-6 text-[#5f7067]">{service.noShowPolicy}</p></div></div>
            </div>
          </div>
          <aside className="service-booking-column min-w-0">
            <StationaryBookingPanel><BookingCard serviceId={service.id} price={service.pricingType === "QUOTE_ONLY" ? 0 : service.price} duration={duration} pricingType={service.pricingType} hourlyRateCents={service.hourlyRateCents} minimumDurationMinutes={service.minimumDurationMinutes} maximumDurationMinutes={service.maximumDurationMinutes} billingIncrementMinutes={service.billingIncrementMinutes} defaultDurationMinutes={service.defaultDurationMinutes} serviceTitle={service.title} provider={service.provider} serviceCity={service.city} serviceState={service.state} deliveryType={service.deliveryType} bookingQuestions={service.bookingQuestions} isSignedIn={Boolean(session)} returnPath={`/services/${service.slug}`} cancellationPolicy={service.cancellationPolicy} cancellationWindowHours={service.cancellationWindowHours} noShowPolicy={service.noShowPolicy} parentBookingId={parentBookingId} requestAnotherTimeHref={`/requests?category=${encodeURIComponent(service.category)}&title=${encodeURIComponent(service.title)}&delivery=${service.deliveryType === "REMOTE" ? "REMOTE" : "IN_PERSON"}`} packages={service.pricingType === "QUOTE_ONLY" ? [] : service.packages} addOns={service.pricingType === "QUOTE_ONLY" ? [] : service.addOns} recurrenceOptions={service.pricingType === "QUOTE_ONLY" ? ["one_time"] : service.recurrenceOptions} serviceKind={service.serviceKind} preparationNotes={service.preparationNotes} /></StationaryBookingPanel>
          </aside>
        </div>
      </div>
    </main>
  );
}
