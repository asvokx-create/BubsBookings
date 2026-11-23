import type { Metadata } from "next";
import { LegalPage } from "@/app/terms/page";
import { publicPageMetadata } from "@/lib/seo";

export const metadata: Metadata = publicPageMetadata({
  title: "Accessibility Statement",
  description: "Learn about BubsBookings accessibility efforts and how to report a barrier or request help using the marketplace.",
  pathname: "/accessibility",
});

const sections = [
  ["1. Our commitment", "BubsBookings wants customers and providers, including people with disabilities, to be able to use the marketplace. Accessibility is ongoing work, not a one-time certification. We use the Web Content Accessibility Guidelines (WCAG) 2.2 Level AA as a design and testing target while improving keyboard access, visible focus, readable contrast, clear labels and errors, responsive layouts, reduced-motion support, and compatibility with common assistive technologies."],
  ["2. Requesting help or an accommodation", <>If a feature, document, form, or booking flow is difficult to use, email <a href="mailto:christian@bubsbookings.com?subject=BubsBookings%20accessibility%20request" className="font-bold underline">christian@bubsbookings.com</a>. Include the page or feature, what you were trying to do, the barrier you encountered, and a preferred way to contact you. Do not include passwords, full payment-card details, or unnecessary medical information.</>],
  ["3. Response and alternatives", "BubsBookings will review accessibility reports and work to provide a reasonable alternative when practical while a barrier is investigated. Response time can depend on the request, technical complexity, and whether another provider controls the affected feature. Urgent safety or emergency requests should be directed to emergency services."],
  ["4. Third-party services", "Some functions, such as payment and identity flows, are supplied by third parties. BubsBookings cannot directly change every third-party interface, but accessibility reports about those flows can still be sent to BubsBookings so the issue can be documented and raised with the provider."],
  ["5. Feedback and current status", "Specific reports are the most useful. BubsBookings may ask follow-up questions needed to reproduce a problem or identify an effective accommodation. New and changed screens are reviewed for keyboard use, focus visibility, labels, text resizing, mobile reflow, and contrast, but automated and manual checks cannot find every barrier. This statement describes the current accessibility goal and feedback process; it is not a claim that every page or third-party flow has been independently audited or certified."],
] as const;

export default function AccessibilityPage() {
  return <LegalPage eyebrow="Access for everyone" title="Accessibility Statement" intro="How to report an accessibility barrier and request help using BubsBookings." sections={sections} />;
}
