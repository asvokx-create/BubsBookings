import BrandLockup from "@/components/brand-lockup";
import BackButton from "@/components/back-button";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { database } from "@/lib/database";
import { formatDuration, getServiceVisual } from "@/lib/marketplace";
import ServiceCategoryIcon from "@/components/service-category-icon";
import { getAdminSession } from "@/lib/admin";
import { formatHourlyRate } from "@/lib/service-pricing";
import { listingInactiveReasons, type ProviderAgeVerificationStatus } from "@/lib/provider-activation";

export const dynamic = "force-dynamic";

type ListingPreview = {
  id: string; title: string; category: string; description: string; price_cents: number;
  duration_minutes: number; is_active: boolean; business_name: string; city: string;
  state: string; service_radius_miles: number; image_urls: string[] | null;
  delivery_type: "IN_PERSON" | "REMOTE" | "BOTH"; remote_delivery_details: string;
  pricing_type: "FIXED" | "HOURLY" | "QUOTE_ONLY"; hourly_rate_cents: number | null;
  minimum_duration_minutes: number | null; maximum_duration_minutes: number | null;
  billing_increment_minutes: number | null; default_duration_minutes: number | null;
  age_verification_status: ProviderAgeVerificationStatus; publicly_available: boolean;
  age_verification_blocked: boolean; provider_is_active: boolean; company_is_active: boolean;
  stripe_connected: boolean; stripe_payouts_enabled: boolean; screening_status: string;
  screening_checked_at: Date | null; safety_review_status: string; safety_reviewed_at: Date | null;
  last_status_update: Date;
};

export default async function AdminListingPreviewPage({ params }: PageProps<"/admin/listings/[serviceId]">) {
  const session = await getAdminSession();
  if (!session) redirect("/login?redirect=/admin");
  const { serviceId } = await params;
  const result = await database.query<ListingPreview>(
    `SELECT s.id::text, s.title, s.category, s.description, s.price_cents, s.duration_minutes,
            s.pricing_type, s.hourly_rate_cents, s.minimum_duration_minutes, s.maximum_duration_minutes,
            s.billing_increment_minutes, s.default_duration_minutes,
            s.is_active, s.age_verification_blocked, s.business_name, p.city, p.state, p.service_radius_miles, s.delivery_type, s.remote_delivery_details,
            p.age_verification_status, p.is_active AS provider_is_active, company.is_active AS company_is_active,
            (p.stripe_account_id IS NOT NULL) AS stripe_connected, p.stripe_payouts_enabled,
            p.screening_status, p.screening_checked_at,
            CASE WHEN safety.created_at IS NULL THEN 'not_reviewed'
                 WHEN COALESCE((safety.details->>'allowed')::boolean, false) THEN 'passed'
                 ELSE 'action_required' END AS safety_review_status,
            safety.created_at AS safety_reviewed_at,
            GREATEST(s.updated_at, p.updated_at, company.updated_at, COALESCE(safety.created_at, s.created_at)) AS last_status_update,
            (s.is_active = true AND p.is_active = true AND p.age_verification_status = 'verified' AND company.is_active = true) AS publicly_available,
            COALESCE((SELECT array_agg(si.public_url ORDER BY si.sort_order, si.created_at)
              FROM service_images si WHERE si.service_id = s.id), ARRAY[]::text[]) AS image_urls
     FROM services s
     JOIN provider_profiles p ON p.id = s.provider_id
     JOIN provider_companies company ON company.id = s.company_id
     LEFT JOIN LATERAL (
       SELECT details, created_at FROM admin_audit_log
       WHERE action='listing_safety_scanned' AND target_type='listing' AND target_id=s.id::text
       ORDER BY created_at DESC LIMIT 1
     ) safety ON true
     WHERE s.id::text = $1 AND s.provider_deleted_at IS NULL
     LIMIT 1`,
    [serviceId],
  );
  const listing = result.rows[0];
  if (!listing) notFound();
  const visual = getServiceVisual(listing.category);
  const images = listing.image_urls ?? [];
  const deliveryLabel = listing.delivery_type === "REMOTE" ? "🌐 Available online" : listing.delivery_type === "BOTH" ? `🌐 Online or in person near ${listing.city}, ${listing.state}` : `📍 ${listing.city}, ${listing.state}`;
  const serviceAreaLabel = listing.delivery_type === "REMOTE" ? "Available online across the United States" : listing.delivery_type === "BOTH" ? `Online nationwide or within ${listing.service_radius_miles} miles of ${listing.city}` : `Within ${listing.service_radius_miles} miles of ${listing.city}`;
  const hourly = listing.pricing_type === "HOURLY" && listing.hourly_rate_cents !== null;
  const quoteOnly = listing.pricing_type === "QUOTE_ONLY";
  const inactiveReasons = listingInactiveReasons({
    isActive: listing.is_active,
    ageVerificationBlocked: listing.age_verification_blocked,
    providerIsActive: listing.provider_is_active,
    companyIsActive: listing.company_is_active,
    ageVerificationStatus: listing.age_verification_status,
  });

  return <main className="min-h-screen bg-[#f8f7f3] text-[#183126]">
    <header className="border-b border-[#183126]/10 bg-white"><div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6"><Link href="/admin" className="flex items-center gap-2 text-xl font-bold"><BrandLockup /></Link><span className="rounded-full bg-[#eee25a] px-3 py-1 text-xs font-extrabold uppercase tracking-wider">Admin preview</span></div></header>
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <BackButton label="Back to listings" fallbackHref="/admin" />
      <div className="mt-6 rounded-2xl border border-[#d9ca55] bg-[#fff8cf] p-4 text-sm"><strong>This is an admin-only preview.</strong> {listing.publicly_available ? " The listing is currently visible in the marketplace." : " The listing is not public."}{inactiveReasons.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5">{inactiveReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}</div>
      <div className="mt-7 grid gap-7 lg:grid-cols-[1.25fr_.75fr]">
        <section>
          <div role="img" aria-label={`${listing.title} cover`} style={images[0] ? { backgroundImage: `url("${images[0]}")` } : undefined} className={`relative h-72 overflow-hidden rounded-[2.5rem] bg-cover bg-center sm:h-[420px] ${images[0] ? "bg-[#e5e8e2]" : `bg-gradient-to-br ${visual.gradient}`}`}>
            {!images[0] && <ServiceCategoryIcon category={listing.category} className="!absolute bottom-8 right-10 h-28 min-h-28 w-28 min-w-28 opacity-90 sm:h-32 sm:min-h-32 sm:w-32 sm:min-w-32 [&_svg]:h-20 [&_svg]:w-20" />}
            <span className="absolute left-6 top-6 z-10 rounded-full bg-white/90 px-4 py-2 text-xs font-bold">{listing.publicly_available ? "Public listing" : listing.is_active ? "Verification required" : "Removed listing"}</span>
          </div>
          {images.length > 1 && <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">{images.slice(1).map((url, index) => <div key={url} role="img" aria-label={`${listing.title} photo ${index + 2}`} style={{ backgroundImage: `url("${url}")` }} className="aspect-[4/3] rounded-2xl bg-cover bg-center" />)}</div>}
          <p className="mt-8 text-sm font-bold uppercase tracking-[.15em] text-[#6c7d74]">{listing.category}</p>
          <h1 className="mt-3 text-4xl font-bold tracking-[-.045em] sm:text-5xl">{listing.title}</h1>
          <p className="mt-5 text-sm text-[#718078]">{deliveryLabel} · Served by <strong className="text-[#183126]">{listing.business_name}</strong></p>
          <p className="mt-7 max-w-2xl text-lg leading-8 text-[#5b6d64]">{listing.description}</p>
        </section>
        <aside className="h-fit rounded-[2rem] border border-[#183126]/10 bg-white p-7 shadow-[0_20px_50px_rgba(24,49,38,.10)]">
          <div className="mb-6 rounded-2xl bg-[#f5f5ef] p-4 text-sm"><p className="font-bold">Activation details</p><dl className="mt-3 space-y-2 text-[#687970]"><div className="flex justify-between gap-4"><dt>Age verification</dt><dd className="font-semibold text-[#183126]">{listing.age_verification_status.replaceAll("_", " ")}</dd></div><div className="flex justify-between gap-4"><dt>Stripe payouts, last known</dt><dd className="font-semibold text-[#183126]">{!listing.stripe_connected ? "Not connected" : listing.stripe_payouts_enabled ? "Ready" : "Incomplete or under review"}</dd></div><div className="flex justify-between gap-4"><dt>Safety review</dt><dd className="font-semibold text-[#183126]">{listing.safety_review_status.replaceAll("_", " ")}</dd></div><div className="flex justify-between gap-4"><dt>Last status update</dt><dd className="text-right font-semibold text-[#183126]">{new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(listing.last_status_update))}</dd></div></dl><p className="mt-3 text-xs leading-5">Stripe payout setup is required to receive earnings, but it does not control listing publication.</p></div>
          <p className="text-xs font-bold uppercase tracking-wider text-[#718078]">{quoteOnly ? "Pricing" : hourly ? "Hourly rate" : "Starting price"}</p>
          <p className="mt-2 text-4xl font-bold">{quoteOnly ? "Custom Quote" : hourly ? formatHourlyRate(listing.hourly_rate_cents!) : `$${(listing.price_cents / 100).toFixed(2)}`}</p>
          <div className="mt-6 space-y-3 text-sm">
            <p className="rounded-2xl bg-[#f5f5ef] p-4"><strong>{hourly ? "Project billing" : "Typical duration"}</strong><span className="mt-1 block text-[#687970]">{hourly ? "Tracked hourly project, no minimum duration" : formatDuration(listing.duration_minutes)}</span></p>
            <p className="rounded-2xl bg-[#f5f5ef] p-4"><strong>Service availability</strong><span className="mt-1 block text-[#687970]">{serviceAreaLabel}</span></p>
            {listing.remote_delivery_details && <p className="rounded-2xl bg-[#f5f5ef] p-4"><strong>Remote delivery details</strong><span className="mt-1 block text-[#687970]">{listing.remote_delivery_details}</span></p>}
          </div>
        </aside>
      </div>
    </div>
  </main>;
}
