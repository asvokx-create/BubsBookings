import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { auth, isAuthConfigured } from "@/lib/auth";
import { isOwnerEmail } from "@/lib/admin";
import { database } from "@/lib/database";
import { PLAN_ENTITLEMENTS, type ProviderPlan } from "@/lib/plans";
import { getStripeMode } from "@/lib/stripe";
import PublicSiteHeader from "@/components/public-site-header";
import { calculateBookingFinancialSnapshot, DEFAULT_CUSTOMER_SERVICE_FEE_CENTS, providerFeeBasisPoints, providerFeeCapCents } from "@/lib/booking-financials";
import { publicPageMetadata } from "@/lib/seo";
import { reconcileExpiredComplimentaryProGrants } from "@/lib/complimentary-pro";

export const metadata: Metadata = publicPageMetadata({
  title: "Provider pricing",
  description: "Choose the BubsBookings plan that fits your service business.",
  pathname: "/pricing",
});

const plans = [
  {
    id: "starter",
    description: "A free monthly plan for solo providers getting started.",
    listings: "2 services, up to 5 photos across all listings",
    team: "1 owner seat",
    tools: "Booking calendar, messaging, and shared client tools",
    extras: "24-hour reminders, basic analytics, and booking links and QR codes",
  },
  {
    id: "pro",
    description: "A lower booking fee and more tools for teams and repeat customers.",
    listings: "Unlimited services, photos, and locations",
    team: "3 seats included; extra seats cost $0.50 each per month",
    tools: "Starter tools plus custom booking questions. Coupon promotions & repeat-customer offers",
    extras: "Advanced reminders and analytics, priority support, and browse placement",
  },
] as const;

const sharedClientTools = [
  "Customer records, booking history, private tags & notes",
  "Email campaigns with audience segments, branded templates & reporting",
  "Unsubscribe and suppression handling",
];

const billingHref = "/provider/dashboard/billing";
const money = (cents: number) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
}).format(cents / 100);
const proPrice = money(Math.round(PLAN_ENTITLEMENTS.pro.monthlyPrice * 100));

// An illustration for the same two bookings, not a guarantee about monthly volume.
const exampleBookingCents = 15_000;
const exampleStarterCents = 2 * calculateBookingFinancialSnapshot(exampleBookingCents, "starter").providerFeeCents;
const exampleProCents = 2 * calculateBookingFinancialSnapshot(exampleBookingCents, "pro").providerFeeCents
  + Math.round(PLAN_ENTITLEMENTS.pro.monthlyPrice * 100);

function getParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

type CurrentProviderPlan = { plan: ProviderPlan; trialEligible: boolean };

async function getCurrentProviderPlan(): Promise<CurrentProviderPlan | null> {
  if (!isAuthConfigured()) return null;

  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return null;
    if (isOwnerEmail(session.user.email)) return { plan: "owner", trialEligible: false };
    await reconcileExpiredComplimentaryProGrants();
    const result = await database.query<{ plan: ProviderPlan; pro_trial_used_at_test: Date | null; pro_trial_used_at_live: Date | null }>(
      `SELECT plan, pro_trial_used_at_test, pro_trial_used_at_live
       FROM provider_profiles WHERE user_id = $1 AND is_active = true LIMIT 1`,
      [session.user.id],
    );
    const provider = result.rows[0];
    if (!provider) return null;
    const mode = getStripeMode();
    return { plan: provider.plan, trialEligible: mode === "live" ? !provider.pro_trial_used_at_live : !provider.pro_trial_used_at_test };
  } catch {
    return null;
  }
}

export default async function PricingPage({ searchParams }: PageProps<"/pricing">) {
  const selected = getParam((await searchParams).plan).toLowerCase();
  const selectedPlan = plans.find((plan) => plan.id === selected);
  const currentProvider = await getCurrentProviderPlan();
  const currentPlan = currentProvider?.plan ?? null;
  const canStartTrial = currentPlan === "starter" && currentProvider?.trialEligible === true;
  const showPublicTrialTerms = currentPlan === null || canStartTrial;

  return (
    <main className="pricing-page min-h-screen bg-[#f8f7f3] text-[#183126]">
      <PublicSiteHeader />

      <section className="pricing-hero border-b border-[#183126]/10">
        <div className="site-container px-5 py-10 sm:px-8 sm:py-14">
          <p className="text-xs font-bold uppercase tracking-[.18em] text-[#d2dfd7]">Provider pricing</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight text-white sm:text-5xl">Compare provider plans</h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-[#d1ddd6]">Neither plan charges for leads, inquiries, messages, or quotes. Starter has no monthly charge.</p>
        </div>
      </section>

      <section id="plans" aria-labelledby="plans-heading" className="site-container-wide scroll-mt-20 px-4 py-9 sm:px-8 sm:py-14">
        <div className="mx-auto max-w-4xl">
          <h2 id="plans-heading" className="mb-6 text-2xl font-bold">Starter and Pro</h2>
          {currentPlan && (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#183126]/10 bg-[#183126] px-5 py-4 text-white">
              <div><p className="text-sm text-[#d8e5dd]">Your current plan</p><p className="font-bold">{PLAN_ENTITLEMENTS[currentPlan].name}</p></div>
              <Link href={billingHref} className="inline-flex min-h-11 items-center rounded-full bg-[#eee25a] px-5 py-2 text-sm font-bold text-[#183126] hover:bg-[#f5ea6b]">Manage billing</Link>
            </div>
          )}
          {selectedPlan && <p className="mb-5 text-sm font-semibold text-[var(--bb-text-muted)]">{PLAN_ENTITLEMENTS[selectedPlan.id].name} selected. Review the plan details below.</p>}

          <div className="grid gap-5 md:grid-cols-2">
            {plans.map((plan) => {
              const isPro = plan.id === "pro";
              const isCurrent = currentPlan === plan.id;
              const details = PLAN_ENTITLEMENTS[plan.id];
              const feeCap = providerFeeCapCents(plan.id);
              return (
                <article key={plan.id} aria-labelledby={"pricing-" + plan.id} className="pricing-plan-card flex min-w-0 flex-col rounded-xl border border-[#183126]/15 bg-white p-6 sm:p-7">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <h3 id={"pricing-" + plan.id} className="text-2xl font-bold">{details.name}</h3>
                    {isCurrent && <span className="rounded-md border border-current px-2 py-1 text-xs font-bold">Current plan</span>}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-[var(--bb-text-muted)]">{plan.description}</p>
                  <p className="mt-4 text-3xl font-bold tracking-tight">
                    {money(Math.round(details.monthlyPrice * 100))} <span className="text-sm font-normal text-[var(--bb-text-muted)]">per month</span>
                  </p>

                  <dl className="my-5 flex-1 space-y-3 border-y border-[var(--bb-border)] py-4 text-sm leading-6">
                    <div><dt className="font-semibold">Booking fee</dt><dd>{providerFeeBasisPoints(plan.id) / 100}% on completed paid bookings{feeCap !== null && ", capped at " + money(feeCap) + " per booking"}</dd></div>
                    <div><dt className="font-semibold">Listings</dt><dd>{plan.listings}</dd></div>
                    <div><dt className="font-semibold">Team access</dt><dd>{plan.team}</dd></div>
                    <div><dt className="font-semibold">Booking and client tools</dt><dd>{plan.tools}</dd></div>
                    <div><dt className="font-semibold">Reminders and insights</dt><dd>{plan.extras}</dd></div>
                  </dl>

                  {isCurrent ? (
                    <p className="text-sm font-semibold">You are on this plan.</p>
                  ) : !isPro ? (
                    currentPlan === null
                      ? <Link href="/providers/join?plan=starter" className="inline-flex min-h-11 items-center justify-center rounded-full bg-[#183126] px-5 py-3 text-center text-sm font-bold text-white hover:bg-[#294b3c]">Choose Starter</Link>
                      : null
                  ) : currentPlan === "owner" || currentPlan === "business" ? (
                    <p className="text-sm font-semibold">Your current plan already includes Pro tools.</p>
                  ) : (
                    <div>
                      <Link href={currentPlan === null ? "/providers/join?plan=pro" : billingHref} aria-describedby="pro-payment-terms" className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-[#eee25a] px-5 py-3 text-center text-sm font-bold text-[#183126] hover:bg-[#f5ea6b]">
                        {currentPlan === null ? "Create a provider profile for Pro" : canStartTrial ? "Continue to billing for trial" : "Choose Pro"}
                      </Link>
                      <p id="pro-payment-terms" className="mt-3 text-sm leading-6 text-[var(--bb-text-muted)]">
                        {showPublicTrialTerms
                          ? <>Eligible providers get one 30-day trial. A card is required. The plan renews at {proPrice}/month unless you cancel in Billing before the trial ends. The Pro booking fee still applies during the trial.</>
                          : <>Pro costs {proPrice}/month and renews monthly. Cancel renewal in Billing; access continues through the current billing period.</>}
                      </p>
                    </div>
                  )}
                </article>
              );
            })}
          </div>

          <section className="mt-6">
            <h3 className="font-bold">Client tools included in both plans</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-[var(--bb-text-muted)]">
              {sharedClientTools.map((tool) => <li key={tool}>{tool}</li>)}
            </ul>
          </section>

          <div className="mt-6 rounded-xl border border-[var(--bb-border)] bg-[var(--bb-surface)] p-5 sm:p-6">
            <h3 className="font-bold">What does it cost for the same bookings?</h3>
            <p className="mt-2 text-sm leading-6 text-[var(--bb-text-muted)]">For two {money(exampleBookingCents)} completed paid bookings in one month, Starter costs {money(exampleStarterCents)}. Pro costs {money(exampleProCents)}, including its monthly subscription. This example excludes Stripe processing and any extra seats.</p>
            <p className="mt-3 text-sm leading-6 text-[var(--bb-text-muted)]">Stripe processing costs are separate from the BubsBookings platform fee. The Stripe processing cost allocated to the service is deducted from provider earnings, varies by transaction, and is not covered by the booking fee cap. Customers pay a separate {money(DEFAULT_CUSTOMER_SERVICE_FEE_CENTS)} BubsBookings service fee at checkout, with no separate card-processing surcharge.</p>
            <Link href="/payment-billing" className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold underline underline-offset-4">See payment and billing details</Link>
          </div>
        </div>
      </section>
    </main>
  );
}
