import { ADMIN_AGE_POLICY_EFFECTIVE_DATE } from "@/lib/policy-consent";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/app/terms/page";
import { publicPageMetadata } from "@/lib/seo";

export const metadata: Metadata = publicPageMetadata({
  title: "Provider Verification and Safety",
  description: "Understand the limited provider checks BubsBookings performs, what Stripe handles, and what customers should confirm independently.",
  pathname: "/provider-safety",
});

const sections = [
  ["1. Marketplace role", "BubsBookings is a marketplace that helps customers find and book independent providers. It does not employ providers, perform their work, guarantee a provider’s identity, qualifications, safety, availability, legality, or results, or replace a customer’s own judgment."],
  ["2. What BubsBookings checks", "BubsBookings uses account-email verification, agreement acceptance, profile and listing completeness, location and pricing fields, and automated content screening. These checks can help identify incomplete or suspicious submissions, but they are not a criminal background check, professional-license verification, insurance verification, business-registration verification, or endorsement."],
  ["3. What Stripe handles", "Providers must complete BubsBookings’ Stripe-hosted document check or obtain a documented admin age-eligibility pass before a listing can be public, a booking can be accepted, or a payout can be sent, as well as required Stripe payout onboarding. BubsBookings receives eligibility and readiness statuses and transiently processes the date of birth returned by Stripe to determine adult eligibility. It does not store the full date of birth or receive or store identity documents. An administrator may grant a documented age-eligibility pass after independently confirming that a provider is at least 18; that exception is not a Stripe Identity result or a broader safety guarantee. Stripe Connect payout onboarding and the separate age check have different purposes."],
  ["4. What providers remain responsible for", "Providers are responsible for all required licenses, permits, registrations, insurance, bonds, training, vehicles, workers, tax obligations, and safe lawful performance of their services. Providers must accurately describe their experience, availability, price, service area, cancellation terms, and any credentials they choose to state."],
  ["5. What customers should confirm", "Before booking, review the provider’s listing, price, cancellation terms, and communication. For a service where credentials, insurance, permits, references, or special safety precautions matter, ask the provider for appropriate evidence and make an independent decision. Do not share passwords, alarm codes, full card numbers, government identifiers, or unnecessary health information."],
  ["6. Reports and urgent safety concerns", <><p>Report suspicious, unsafe, fraudulent, or abusive conduct through the booking, conversation, or <Link href="/support" className="font-bold underline">support</Link> process. BubsBookings can investigate, restrict content or accounts, and preserve relevant records. For an immediate threat or emergency, contact 911 or the appropriate emergency service first.</p></>],
] as const;

export default function ProviderSafetyPage() {
  return <LegalPage effectiveDate={ADMIN_AGE_POLICY_EFFECTIVE_DATE} eyebrow="Trust and safety" title="Provider Verification & Safety" intro="The limited checks BubsBookings performs, Stripe’s separate role, and what both providers and customers remain responsible for." sections={sections} />;
}
