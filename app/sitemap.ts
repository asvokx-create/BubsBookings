import type { MetadataRoute } from "next";
import { getPublicSeoInventory } from "@/lib/public-seo-inventory";
import { SERVICE_AREAS, serviceAreaSlug } from "@/lib/service-areas";
import { serviceCategorySlug } from "@/lib/service-categories";
import { GUIDES } from "@/lib/guides";

const baseUrl = "https://bubsbookings.com";

// Public listing, company, provider, and location URLs change with marketplace
// inventory, so the sitemap must not be frozen during a deployment build.
export const dynamic = "force-dynamic";

function laterDate(current: Date | undefined, candidate: Date) {
  return !current || candidate > current ? candidate : current;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const listings = await getPublicSeoInventory().catch(() => []);
  const providerPages = new Map<string, Date>();
  const companyPages = new Map<string, Date>();
  const locationPages = new Map<string, Date>();
  const localCategoryPages = new Map<string, Date>();

  for (const listing of listings) {
    companyPages.set(listing.companySlug, laterDate(companyPages.get(listing.companySlug), laterDate(listing.companyUpdatedAt, listing.serviceUpdatedAt)));
    if (listing.providerProfileVisible && listing.providerSlug) providerPages.set(listing.providerSlug, laterDate(providerPages.get(listing.providerSlug), laterDate(listing.providerUpdatedAt, listing.serviceUpdatedAt)));
    const area = SERVICE_AREAS.find((candidate) => candidate.city.toLowerCase() === listing.city.toLowerCase() && candidate.state.toLowerCase() === listing.state.toLowerCase());
    if (!area || listing.deliveryType === "REMOTE") continue;
    const locationUrl = `${baseUrl}/locations/${serviceAreaSlug(area)}`;
    const categoryUrl = `${locationUrl}/${serviceCategorySlug(listing.category)}`;
    locationPages.set(locationUrl, laterDate(locationPages.get(locationUrl), listing.serviceUpdatedAt));
    localCategoryPages.set(categoryUrl, laterDate(localCategoryPages.get(categoryUrl), listing.serviceUpdatedAt));
  }
  const staticPages = ["", "/requests", "/pricing", "/providers/join", "/partners", "/about", "/locations", "/guides", "/promise", "/support", "/disputes", "/terms", "/privacy", "/cancellations-refunds", "/payment-billing", "/provider-agreement", "/provider-safety", "/partner-agreement", "/marketing-communications", "/ai-transparency", "/cookies", "/content-removal", "/dmca", "/accessibility"];

  return [
    ...staticPages.map((path) => ({ url: `${baseUrl}${path}`, changeFrequency: path === "" ? "daily" as const : "monthly" as const, priority: path === "" ? 1 : 0.5 })),
    ...[...locationPages].map(([url, lastModified]) => ({ url, lastModified, changeFrequency: "daily" as const, priority: 0.7 })),
    ...[...localCategoryPages].map(([url, lastModified]) => ({ url, lastModified, changeFrequency: "daily" as const, priority: 0.85 })),
    ...GUIDES.map((guide) => ({ url: `${baseUrl}/guides/${guide.slug}`, lastModified: guide.updatedAt, changeFrequency: "monthly" as const, priority: 0.6 })),
    ...listings.map((listing) => ({ url: `${baseUrl}/services/${listing.serviceSlug}`, lastModified: listing.serviceUpdatedAt, changeFrequency: "weekly" as const, priority: 0.8, ...(listing.imageUrls.length ? { images: listing.imageUrls } : {}) })),
    ...[...companyPages].map(([slug, lastModified]) => ({ url: `${baseUrl}/companies/${slug}`, lastModified, changeFrequency: "weekly" as const, priority: 0.75 })),
    ...[...providerPages].map(([slug, lastModified]) => ({ url: `${baseUrl}/providers/${slug}`, lastModified, changeFrequency: "weekly" as const, priority: 0.7 })),
  ];
}
