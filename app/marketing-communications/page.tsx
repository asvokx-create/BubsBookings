import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/app/terms/page";
import { publicPageMetadata } from "@/lib/seo";

export const metadata: Metadata = publicPageMetadata({
  title: "Marketing Communications Policy",
  description: "Learn how BubsBookings separates transactional messages from provider marketing emails and honors unsubscribe preferences.",
  pathname: "/marketing-communications",
});

const sections = [
  ["1. Types of messages", "BubsBookings sends account, security, booking, payment, refund, dispute, and other service messages needed to operate an account or booking. Those messages are different from promotional messages. Provider marketing tools are for promotional emails to people connected to that provider through legitimate BubsBookings activity."],
  ["2. Provider marketing emails", "Campaign tools identify the provider and BubsBookings, use the provider’s account email as the reply-to address, and include an unsubscribe link for that provider’s marketing emails. When promotional email delivery is enabled, messages also include the configured postal address. Before a campaign is sent, the platform checks provider-specific unsubscribe preferences and suppression records; it checks them again immediately before delivery. An unsubscribe does not stop required service messages."],
  ["3. Provider responsibilities", "Providers must use campaign tools only for legitimate client relationships and must not upload, buy, rent, scrape, or use unrelated lists. Providers are responsible for accurate sender information, truthful subject lines and content, required advertising disclosures, and every other legal requirement that applies to their promotion. Providers may not evade a suppression preference, send spam, use deceptive content, or portray a marketing email as a required transaction notice."],
  ["4. Your choices", "Use the unsubscribe link in a provider campaign to stop that provider’s promotional emails. You may receive marketing from more than one provider, so an unsubscribe applies to the identified provider rather than every provider on BubsBookings. You can also contact the provider or BubsBookings support if a preference is not honored."],
  ["5. SMS and affiliate promotions", "BubsBookings does not currently provide an SMS marketing campaign feature. Any future SMS feature will require its own consent, opt-out, and disclosure design before launch. Partners who promote BubsBookings must make clear, conspicuous affiliate disclosures under the Partner Agreement and applicable law."],
  ["6. Questions and reports", <><p>For a marketing complaint, use the unsubscribe link when available and then <Link href="/support" className="font-bold underline">contact support</Link> with the sender, subject, approximate time, and concern. Do not send passwords, card information, or other sensitive information.</p></>],
] as const;

export default function MarketingCommunicationsPage() {
  return <LegalPage eyebrow="Communications" title="Marketing Communications Policy" intro="How promotional emails differ from required marketplace messages, and how unsubscribe preferences work." sections={sections} />;
}
