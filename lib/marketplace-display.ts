type ProviderReview = {
  providerAverageRating?: number | null;
  providerReviewCount?: number;
  providerStatus?: string;
};

export function providerCardReviewDisplay({ providerAverageRating, providerReviewCount = 0, providerStatus }: ProviderReview) {
  if (providerReviewCount > 0 && Number.isFinite(providerReviewCount) &&
      typeof providerAverageRating === "number" && Number.isFinite(providerAverageRating)) {
    return { kind: "rating" as const, rating: providerAverageRating.toFixed(1), count: providerReviewCount };
  }
  // A missing score tells us nothing about the provider's tenure.
  return providerStatus?.trim() ? { kind: "status" as const, status: providerStatus } : null;
}

type MarketplaceSearchFilters = {
  query: string;
  category: string;
  delivery: string;
  maxPrice?: number;
  maxDuration?: number;
};

export function hasMarketplaceSearchFilters({ query, category, delivery, maxPrice, maxDuration }: MarketplaceSearchFilters) {
  // Geographic browsing context and sort order are not active-filter chips.
  return Boolean(query.trim() || (category && category !== "All services") ||
    delivery === "IN_PERSON" || delivery === "REMOTE" || delivery === "BOTH" ||
    (maxPrice && Number.isFinite(maxPrice)) || (maxDuration && Number.isFinite(maxDuration)));
}

export function marketplaceResultsHeading(filtered: boolean, city: string) {
  return `${filtered ? "Search results" : "Explore services"} ${city ? `near ${city}` : "on BubsBookings"}.`;
}
