import Image from "next/image";
import Link from "next/link";
import ListingResultLink from "@/components/listing-result-link";
import FavoriteButton from "@/components/favorite-button";
import ProfileAvatar from "@/components/profile-avatar";
import ServiceCategoryIcon from "@/components/service-category-icon";
import UiIcon from "@/components/ui-icon";
import { providerCardReviewDisplay } from "@/lib/marketplace-display";
import { getServiceCategoryIconConfig } from "@/lib/service-category-icons";
import { formatServicePrice, type PricingType } from "@/lib/service-pricing";

type CompactService = {
  id: string;
  slug: string;
  title: string;
  category: string;
  provider: string;
  price: number;
  pricingType: PricingType;
  hourlyRateCents: number | null;
  minimumDurationMinutes?: number | null;
  durationMinutes?: number;
  deliveryType: "IN_PERSON" | "REMOTE" | "BOTH";
  city?: string;
  state?: string;
  distanceMiles?: number;
  imageUrls?: string[];
  imageUrl?: string;
  providerProfileImageUrl?: string;
  providerAverageRating?: number | null;
  providerReviewCount?: number;
  providerStatus?: string;
  providerSlug?: string;
  providerProfileVisible?: boolean;
  companySlug?: string;
};

function cardHref(service: CompactService, returnPath?: string) {
  const href = `/services/${service.slug}`;
  return returnPath ? `${href}?from=${encodeURIComponent(returnPath)}` : href;
}

function providerHref(service: CompactService) {
  if (service.companySlug) return `/companies/${service.companySlug}`;
  if (service.providerProfileVisible && service.providerSlug) return `/providers/${service.providerSlug}`;
  return null;
}

export default function ServiceListingCard({
  service,
  returnPath,
  locationLabel,
  showCategoryCover = false,
  favoriteOnChange,
}: {
  service: CompactService;
  returnPath?: string;
  locationLabel?: string;
  showCategoryCover?: boolean;
  favoriteOnChange?: (saved: boolean) => void;
}) {
  const imageUrl = service.imageUrls?.[0] || service.imageUrl || "";
  const visual = getServiceCategoryIconConfig(service.category);
  const categoryCover = !imageUrl && showCategoryCover;
  const href = cardHref(service, returnPath);
  const businessHref = providerHref(service);
  const delivery = service.deliveryType === "REMOTE" ? "Online" : service.deliveryType === "BOTH" ? "Local + online" : "In person";
  const location = locationLabel || (service.deliveryType === "REMOTE" ? "Available online" : `${service.city || ""}${service.city && service.state ? ", " : ""}${service.state || ""}${typeof service.distanceMiles === "number" ? ` · ${service.distanceMiles < 0.1 ? "Nearby" : `${service.distanceMiles.toFixed(1)} mi`}` : ""}`);
  const providerReview = providerCardReviewDisplay(service);
  const priceNote = service.pricingType === "QUOTE_ONLY"
    ? "custom pricing"
    : service.pricingType === "HOURLY"
      ? "tracked project"
      : "starting";

  return (
    <article className="premium-service-card compact-service-card" data-listing-return-card={returnPath ? service.slug : undefined}>
      <ListingResultLink href={href} listing={returnPath ? service.slug : undefined} kind="image" className="premium-service-image" aria-label={`View ${service.title}`}>
        <div role={imageUrl || categoryCover ? undefined : "img"} aria-label={imageUrl || categoryCover ? undefined : `${service.title} cover`} className={imageUrl ? "" : categoryCover ? "marketplace-cover-fallback" : `bg-gradient-to-br ${visual.background}`}>
          {imageUrl ? <Image src={imageUrl} alt={`${service.title} cover`} fill loading="lazy" unoptimized sizes="(max-width: 639px) calc(100vw - 32px), (max-width: 899px) 50vw, (max-width: 1199px) 33vw, 25vw" className="object-cover" /> : categoryCover ? <div className="marketplace-cover-symbol" aria-hidden="true"><ServiceCategoryIcon category={service.category} compact /><span>{service.category}</span></div> : <ServiceCategoryIcon category={service.category} />}
          <span className="premium-listing-delivery">{delivery}</span>
        </div>
      </ListingResultLink>
      <div className="premium-service-content">
        <p className="premium-service-category">{service.category}</p>
        <ListingResultLink href={href} listing={returnPath ? service.slug : undefined} kind="title"><h3>{service.title}</h3></ListingResultLink>
        <div className="premium-provider-row">
          <ProfileAvatar name={service.provider} imageUrl={service.providerProfileImageUrl} className="premium-provider-avatar" />
          <div className="min-w-0">
            {businessHref ? <Link href={businessHref}>{service.provider}</Link> : <p>{service.provider}</p>}
            {providerReview?.kind === "rating" ? (
              <p className="premium-service-rating" aria-label={`${providerReview.rating} out of 5 stars from ${providerReview.count} verified ${providerReview.count === 1 ? "review" : "reviews"}`}><span aria-hidden="true">★</span> {providerReview.rating} <small>({providerReview.count})</small></p>
            ) : providerReview?.kind === "status" ? <p className="premium-service-rating is-new">{providerReview.status}</p> : null}
          </div>
        </div>
        <div className="premium-service-meta">
          <p className="premium-service-location"><UiIcon name={service.deliveryType === "REMOTE" ? "globe" : "map-pin"} />{location}</p>
          <div className="premium-service-price"><strong>{formatServicePrice(service)}</strong><span>{priceNote}</span></div>
        </div>
      </div>
      <FavoriteButton serviceId={service.id} serviceTitle={service.title} onChange={favoriteOnChange} className="premium-service-favorite" />
    </article>
  );
}
