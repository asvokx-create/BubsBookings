import type { Metadata } from "next";
import SkipToContent from "@/components/skip-to-content";
import SiteFooter from "@/components/site-footer";
import AnalyticsTracker from "@/components/analytics-tracker";
import GoogleAnalytics from "@/components/google-analytics";
import { Suspense } from "react";
import type { CSSProperties } from "react";
import Script from "next/script";
import { PreferencesProvider } from "@/components/preferences-provider";
import InternalNavigationHistory from "@/components/internal-navigation-history";
import AffiliateAttributionTracker from "@/components/affiliate-attribution-tracker";
import GrowthAttributionTracker from "@/components/growth-attribution-tracker";
import { AnalyticsConsentManager, AnalyticsConsentPlacement } from "@/components/analytics-consent";
import "./globals.css";

const googleSiteVerification = process.env.GOOGLE_SITE_VERIFICATION?.trim();
const localFontVariable = { "--font-manrope": '"Manrope", "Segoe UI", Arial, sans-serif' } as CSSProperties;

export const metadata: Metadata = {
  metadataBase: new URL("https://bubsbookings.com"),
  title: { default: "BubsBookings | Find and book local or remote services", template: "%s | BubsBookings" },
  description: "Search local and remote service providers, compare listings, message businesses, and request bookings with clear payment and support tools.",
  applicationName: "BubsBookings",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "BubsBookings",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "/icon.png", type: "image/png", sizes: "512x512" },
    ],
    shortcut: "/favicon.ico",
    apple: [{ url: "/apple-icon.png", type: "image/png", sizes: "180x180" }],
  },
  openGraph: {
    type: "website",
    siteName: "BubsBookings",
    url: "https://bubsbookings.com",
    title: "BubsBookings | Find and book local or remote services",
    description: "Search local and remote providers, compare listings, and request bookings in one place.",
    images: [{ url: "/brand-logo.jpg", width: 1200, height: 1200, alt: "BubsBookings : Local services. Real people." }],
  },
  twitter: { card: "summary", title: "BubsBookings", description: "Find and book local or remote service providers.", images: ["/brand-logo.jpg"] },
  ...(googleSiteVerification ? { verification: { google: googleSiteVerification } } : {}),
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const organizationJsonLd = { "@context": "https://schema.org", "@graph": [
    { "@type": "Organization", "@id": "https://bubsbookings.com/#organization", name: "BubsBookings", url: "https://bubsbookings.com", logo: { "@type": "ImageObject", url: "https://bubsbookings.com/brand-logo.png" }, description: "A marketplace for finding and booking local and remote service providers.", founder: { "@type": "Person", name: "Christian Talluto", jobTitle: "Founder of BubsBookings" } },
    { "@type": "WebSite", "@id": "https://bubsbookings.com/#website", name: "BubsBookings", url: "https://bubsbookings.com", publisher: { "@id": "https://bubsbookings.com/#organization" }, potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: "https://bubsbookings.com/services?q={search_term_string}" }, "query-input": "required name=search_term_string" } },
  ] };
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className="h-full antialiased"
      style={localFontVariable}
    >
      <body className="min-h-full flex flex-col">
        <SkipToContent />
        <Script id="bubsbookings-theme" strategy="beforeInteractive">{`try{const p=localStorage.getItem("bubsbookings-theme")||"light";const t=p==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p;document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t}catch{}`}</Script>
        <Script id="privatus-analytics" src="https://privatusanalytics.com/js/pa.js" data-site="pa_QBY99J7UCK" data-modules="engage,auto,vitals,clicks,ask" strategy="beforeInteractive" defer />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd).replace(/</g, "\\u003c") }} />
        <PreferencesProvider>
          <Suspense fallback={null}><AnalyticsTracker /><InternalNavigationHistory /><AffiliateAttributionTracker /><GrowthAttributionTracker /></Suspense>
          <AnalyticsConsentPlacement>
            <div id="site-content" tabIndex={-1} className="contents">{children}</div>
            <SiteFooter />
            <AnalyticsConsentManager />
          </AnalyticsConsentPlacement>
        </PreferencesProvider>
        <GoogleAnalytics />
      </body>
    </html>
  );
}
