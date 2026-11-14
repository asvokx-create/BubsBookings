import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import AccountNav from "@/components/account-nav";
import BrandLockup from "@/components/brand-lockup";
import CustomSelect from "@/components/custom-select";
import HomeProviderShowcase from "@/components/home-provider-showcase";
import HomeServiceSearch from "@/components/home-service-search";
import MobileSiteNav from "@/components/mobile-site-nav";
import ServiceListingCard from "@/components/service-listing-card";
import SearchResultsAnalytics from "@/components/search-results-analytics";
import ServiceDemandCapture from "@/components/service-demand-capture";
import ServiceCategoryIcon from "@/components/service-category-icon";
import ServiceFiltersMenu from "@/components/service-filters-menu";
import SortSelect from "@/components/sort-select";
import UiIcon from "@/components/ui-icon";
import { getServices } from "@/lib/marketplace";
import { getContextualLocation } from "@/lib/request-location";
import { publicPageMetadata } from "@/lib/seo";
import { normalizeSearchRadius } from "@/lib/search-radius";
import { SERVICE_CATEGORIES } from "@/lib/service-categories";
import { deliveryLabel, type ServiceDeliveryType } from "@/lib/service-delivery";

export const dynamic = "force-dynamic";

export const metadata: Metadata = publicPageMetadata({
  title: "Find and book local or remote services",
  description: "Compare in-person and remote service listings, message providers, and request bookings across the United States.",
  pathname: "/",
});

const HOME_CATEGORIES = [
  { label: "Home repair", category: "Home repair" },
  { label: "Car detailing", category: "Car detailing" },
  { label: "Tech help", category: "Tech help" },
  { label: "Photography", category: "Photography" },
  { label: "Personal training", category: "Personal training" },
  { label: "Pet care", category: "Pet care" },
  { label: "Tutoring", category: "Tutoring" },
] as const;

function getParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function loadHomepageServices(input: { query: string; category: string; delivery: "ALL" | ServiceDeliveryType; location: string; radius: number; maxPrice?: number; maxDuration?: number; sort: string }) {
  try {
    const services = await getServices({
      query: input.query,
      category: input.category,
      delivery: input.delivery,
      ...(input.delivery !== "REMOTE" && input.location ? { location: input.location, radiusMiles: input.radius } : {}),
      maxPrice: input.maxPrice,
      maxDuration: input.maxDuration,
      sort: input.sort,
      limit: 50,
    });
    if (input.sort === "price-low") services.sort((left, right) => left.price - right.price);
    else if (input.sort === "price-high") services.sort((left, right) => right.price - left.price);
    else if (input.sort === "nearest") services.sort((left, right) => Number(left.distanceMiles === undefined) - Number(right.distanceMiles === undefined) || (left.distanceMiles ?? 0) - (right.distanceMiles ?? 0));
    return services;
  } catch (error) {
    console.error("Homepage service loading failed", error);
    return [];
  }
}

export default async function Home({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const query = getParam(params.q).trim();
  const selectedCategory = getParam(params.category) || "All services";
  const showFilters = getParam(params.showFilters) === "1";
  const requestedLocation = getParam(params.location);
  const requestedDelivery = getParam(params.delivery).toUpperCase();
  const initialDelivery = requestedDelivery === "REMOTE" || requestedDelivery === "IN_PERSON" ? requestedDelivery : "ALL";
  const location = await getContextualLocation(requestedLocation);
  const requestedRadius = Number(getParam(params.radius));
  const radius = normalizeSearchRadius(requestedRadius);
  const maxPrice = Number(getParam(params.maxPrice)) || undefined;
  const maxDuration = Number(getParam(params.maxDuration)) || undefined;
  const requestedSort = getParam(params.sort);
  const sort = initialDelivery === "REMOTE" && requestedSort === "nearest" ? "newest" : requestedSort || (initialDelivery === "REMOTE" ? "newest" : "nearest");
  const city = location.split(",")[0]?.trim() || "";
  const servicesWithinRange = await loadHomepageServices({ query, category: selectedCategory, delivery: initialDelivery, location, radius, maxPrice, maxDuration, sort });
  const nearbyParams = new URLSearchParams({ radius: String(radius) });
  if (location) nearbyParams.set("location", location);
  const nearbyServicesHref = `/?${nearbyParams.toString()}#nearby-listings`;

  function marketplaceHref(overrides: Partial<{ query: string; category: string; delivery: "ALL" | ServiceDeliveryType; radius: number; maxPrice?: number; maxDuration?: number; sort: string }> = {}) {
    const next = new URLSearchParams();
    const nextQuery = Object.hasOwn(overrides, "query") ? overrides.query : query;
    const nextCategory = overrides.category ?? selectedCategory;
    const nextDelivery = overrides.delivery ?? initialDelivery;
    const nextRadius = overrides.radius ?? radius;
    const nextMaxPrice = Object.hasOwn(overrides, "maxPrice") ? overrides.maxPrice : maxPrice;
    const nextMaxDuration = Object.hasOwn(overrides, "maxDuration") ? overrides.maxDuration : maxDuration;
    const nextSort = overrides.sort ?? sort;
    if (nextQuery) next.set("q", nextQuery);
    if (nextCategory !== "All services") next.set("category", nextCategory);
    if (nextDelivery !== "ALL") next.set("delivery", nextDelivery);
    if (location && nextDelivery !== "REMOTE") next.set("location", location);
    if (nextDelivery !== "REMOTE") next.set("radius", String(nextRadius));
    if (nextMaxPrice) next.set("maxPrice", String(nextMaxPrice));
    if (nextMaxDuration) next.set("maxDuration", String(nextMaxDuration));
    if (nextSort !== (nextDelivery === "REMOTE" ? "newest" : "nearest")) next.set("sort", nextSort);
    return `/?${next.toString()}#nearby-listings`;
  }
  const currentResultsPath = marketplaceHref();

  return (
    <main className="premium-home min-h-screen overflow-x-clip bg-[#faf9f4] text-[#102d22]">
      <SearchResultsAnalytics query={query} category={selectedCategory} delivery={initialDelivery} location={location} radiusMiles={radius} resultCount={servicesWithinRange.length} />
      <section className="premium-hero" aria-labelledby="premium-home-heading">
        <Image src="/images/home-premium-hero.webp" alt="Modern lakeside home overlooking a mountain landscape" fill priority sizes="100vw" className="premium-hero-image object-cover" />
        <div className="premium-hero-shade" aria-hidden="true" />

        <header className="premium-home-header">
          <div className="narrow-mobile-header site-container flex items-center justify-between gap-3 px-4 py-4 sm:px-6">
            <Link href="/" aria-label="BubsBookings home" className="premium-header-logo flex min-w-0 items-center gap-2.5"><BrandLockup priority /></Link>
            <nav aria-label="Primary navigation" className="premium-desktop-nav hidden items-center lg:flex">
              <Link href="/#nearby-listings">Find a Service</Link>
              <Link href="/providers/join">For Providers</Link>
              <Link href="/#how-it-works">How It Works</Link>
              <Link href="/guides">Resources</Link>
            </nav>
            <div className="premium-header-actions flex items-center gap-2">
              <MobileSiteNav />
              <div className="home-header-account"><AccountNav /></div>
            </div>
          </div>
        </header>

        <div className="premium-hero-content site-container px-4 sm:px-6">
          <div className="premium-hero-copy">
            <h1 id="premium-home-heading">Get things <span>done.</span></h1>
            <p className="premium-hero-description">Book local and online service providers for anything you need.</p>
            <Link href="/providers/join" className="premium-hero-provider-cta">
              List your business free <UiIcon name="arrow-right" className="h-4 w-4 shrink-0" />
            </Link>
          </div>
        </div>

        <div className="premium-search-dock site-container px-4 sm:px-6">
          <HomeServiceSearch initialDelivery={initialDelivery} initialQuery={query} initialLocation={location} initialRadius={radius} restoreRemembered={!requestedLocation} />
        </div>
      </section>

      <section aria-labelledby="category-heading" className="premium-categories site-container px-4 sm:px-6">
        <h2 id="category-heading" className="sr-only">Browse service categories</h2>
        <div className="premium-category-row">
          {HOME_CATEGORIES.map(({ label, category }) => {
            const categoryParams = new URLSearchParams({ category, radius: String(radius) });
            if (location) categoryParams.set("location", location);
            return (
              <Link key={category} href={`/?${categoryParams.toString()}#nearby-listings`} className="premium-category-link">
                <span className="premium-category-icon"><ServiceCategoryIcon category={category} /></span>
                <span>{label}</span>
              </Link>
            );
          })}
          <Link href="/?showFilters=1#nearby-listings" className="premium-category-link">
            <span className="premium-category-icon"><UiIcon name="more" className="h-7 w-7" /></span>
            <span>More</span>
          </Link>
        </div>
      </section>

      <section id="nearby-listings" className="premium-featured site-container scroll-mt-6 px-4 sm:px-6" aria-labelledby="featured-services-heading">
        <div className="premium-section-heading">
          <div><p>Featured services</p><h2 id="featured-services-heading">Explore services {city ? `near ${city}` : "on BubsBookings"}.</h2></div>
          <Link href={nearbyServicesHref}>Browse all services <UiIcon name="arrow-right" /></Link>
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-2" role="group" aria-label="Service delivery filter">
          {(["ALL", "IN_PERSON", "REMOTE"] as const).map((value) => <Link key={value} href={marketplaceHref({ delivery: value })} aria-current={initialDelivery === value ? "page" : undefined} className={`min-h-11 rounded-full border px-5 py-3 text-sm font-bold ${initialDelivery === value ? "border-[#183126] bg-[#183126] text-white" : "border-[#183126]/12 bg-white"}`}>{value === "ALL" ? "All services" : deliveryLabel(value)}</Link>)}
          <ServiceFiltersMenu initiallyOpen={showFilters}>
            <summary className="list-none rounded-full border border-[#183126]/12 bg-white px-5 py-3 text-sm font-bold transition hover:border-[#496958] hover:bg-[#edf3e7] [&::-webkit-details-marker]:hidden">More filters <span className="inline-block transition group-open:rotate-180">⌄</span></summary>
            <div className="fixed inset-x-3 bottom-3 z-[80] max-h-[calc(100dvh-1.5rem)] overflow-y-auto rounded-[1.75rem] border border-[#183126]/10 bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-[0_20px_55px_rgba(24,49,38,.15)] sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:mt-3 sm:max-h-[min(40rem,calc(100dvh-7rem))] sm:w-[620px] sm:p-6">
              <p className="text-xs font-bold uppercase tracking-[.15em] text-[#718078]">All categories</p>
              <div className="mt-4 grid grid-cols-1 gap-2 min-[400px]:grid-cols-2 sm:grid-cols-3">{SERVICE_CATEGORIES.map((category) => <Link key={category} href={marketplaceHref({ category })} className={`flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-semibold transition hover:bg-[#edf3e7] ${selectedCategory === category ? "border-[#183126] bg-[#edf3e7]" : "border-[#183126]/10"}`}><ServiceCategoryIcon category={category} compact /><span className="min-w-0 break-words">{category}</span></Link>)}</div>
              <form action="/#nearby-listings" className="mt-6 grid gap-4 border-t border-[#183126]/10 pt-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                {query && <input type="hidden" name="q" value={query} />}{location && initialDelivery !== "REMOTE" && <input type="hidden" name="location" value={location} />}{initialDelivery !== "REMOTE" && <input type="hidden" name="radius" value={radius} />}{initialDelivery !== "ALL" && <input type="hidden" name="delivery" value={initialDelivery} />}{selectedCategory !== "All services" && <input type="hidden" name="category" value={selectedCategory} />}{sort !== (initialDelivery === "REMOTE" ? "newest" : "nearest") && <input type="hidden" name="sort" value={sort} />}
                <label><span className="mb-2 block text-xs font-bold">Maximum displayed price or hourly rate</span><CustomSelect ariaLabel="Maximum displayed price or hourly rate" name="maxPrice" defaultValue={maxPrice ?? ""} buttonClassName="w-full rounded-xl border border-[#183126]/15 bg-[#faf9f5] px-3 py-3 text-sm outline-none"><option value="">Any price or rate</option><option value="50">Up to $50</option><option value="100">Up to $100</option><option value="250">Up to $250</option><option value="500">Up to $500</option></CustomSelect></label>
                <label><span className="mb-2 block text-xs font-bold">Maximum estimated time</span><CustomSelect ariaLabel="Maximum estimated time" name="maxDuration" defaultValue={maxDuration ?? ""} buttonClassName="w-full rounded-xl border border-[#183126]/15 bg-[#faf9f5] px-3 py-3 text-sm outline-none"><option value="">Any estimated time</option><option value="60">Up to 1 hour</option><option value="120">Up to 2 hours</option><option value="240">Up to half day</option><option value="480">Up to full day</option></CustomSelect></label>
                <button type="submit" className="rounded-xl bg-[#eee25a] px-5 py-3 text-sm font-bold transition hover:bg-[#f5ea6b]">Apply filters</button>
              </form>
            </div>
          </ServiceFiltersMenu>
          <div className="ml-auto"><SortSelect value={sort} remote={initialDelivery === "REMOTE"} pathname="/" anchor="nearby-listings" /></div>
        </div>
        {(query || selectedCategory !== "All services" || initialDelivery !== "ALL" || maxPrice || maxDuration) && <div className="mt-4 flex flex-wrap items-center gap-2 text-xs font-bold"><span className="text-[#718078]">Active filters</span>{query && <span className="rounded-full bg-[#edf3e7] px-3 py-2">{query}</span>}{selectedCategory !== "All services" && <Link href={marketplaceHref({ category: "All services" })} className="rounded-full bg-[#fff5b8] px-3 py-2">{selectedCategory} ×</Link>}{initialDelivery !== "ALL" && <Link href={marketplaceHref({ delivery: "ALL" })} className="rounded-full bg-[#fff5b8] px-3 py-2">{deliveryLabel(initialDelivery)} ×</Link>}{maxPrice && <Link href={marketplaceHref({ maxPrice: undefined })} className="rounded-full bg-[#fff5b8] px-3 py-2">Up to ${maxPrice} ×</Link>}{maxDuration && <Link href={marketplaceHref({ maxDuration: undefined })} className="rounded-full bg-[#fff5b8] px-3 py-2">Est. up to {maxDuration >= 240 ? maxDuration === 480 ? "full day" : "half day" : `${maxDuration / 60} hr`} ×</Link>}</div>}
        {servicesWithinRange.length > 0 ? (
          <div className="premium-listing-grid">{servicesWithinRange.map((service) => <ServiceListingCard key={service.id} service={service} returnPath={currentResultsPath} />)}</div>
        ) : (
          <div className="premium-empty-state">
            <ServiceCategoryIcon category="Home repair" />
            <h3>Listings are coming soon</h3>
            <p>Browse all service categories or list your business as an early provider.</p>
            <div className="mt-5 flex flex-wrap justify-center gap-3">
              <Link href={`/requests?${new URLSearchParams({ ...(selectedCategory !== "All services" ? { category: selectedCategory } : {}), title: query || (selectedCategory !== "All services" ? selectedCategory : initialDelivery === "REMOTE" ? "Remote service request" : "Local service request"), delivery: initialDelivery === "REMOTE" ? "REMOTE" : "IN_PERSON", ...(location && initialDelivery !== "REMOTE" ? { location } : {}), radius: String(radius) }).toString()}`}>Request this service</Link>
              {location && radius < 50 && <Link href={marketplaceHref({ radius: 50 })}>Expand to 50 miles</Link>}
              {selectedCategory !== "All services" && <Link href={marketplaceHref({ category: "All services" })}>Remove category</Link>}
              {query && <Link href={marketplaceHref({ query: "" })}>Clear search</Link>}
            </div>
            {initialDelivery !== "REMOTE" && location ? <ServiceDemandCapture query={query} category={selectedCategory} location={location} radiusMiles={radius} /> : null}
          </div>
        )}
      </section>

      <section id="how-it-works" className="premium-how site-container scroll-mt-24 px-4 sm:px-6" aria-labelledby="how-heading">
        <div className="premium-how-heading"><p>How it works</p><h2 id="how-heading">From search to booked <span>in minutes.</span></h2></div>
        <ol className="premium-steps">
          <li><span className="premium-step-number">1</span><UiIcon name="search" /><div><h3>Find a Service</h3><p>Search and browse available providers.</p></div></li>
          <li><span className="premium-step-number">2</span><UiIcon name="messages" /><div><h3>Message or Book</h3><p>Ask questions, request a custom quote, or book directly.</p></div></li>
          <li><span className="premium-step-number">3</span><UiIcon name="card" /><div><h3>Pay Securely</h3><p>Complete your booking through Stripe.</p></div></li>
        </ol>
      </section>

      <section className="premium-provider site-container px-4 sm:px-6" aria-labelledby="provider-promo-heading">
        <div className="premium-provider-inner">
          <div className="premium-provider-copy">
            <p>For providers</p>
            <h2 id="provider-promo-heading">Your business. <span>All in one place.</span></h2>
            <p>Create a free business page, accept bookings, manage clients, and grow your business without paying for leads.</p>
            <Link href="/providers/join">Create a Free Listing <UiIcon name="arrow-right" /></Link>
          </div>
          <HomeProviderShowcase />
        </div>
      </section>
    </main>
  );
}
