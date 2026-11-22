import type { ReactNode } from "react";
import { HomeAnalyticsChoicesSlot as PricingAnalyticsChoicesSlot } from "@/components/analytics-consent";

export default function PricingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <div className="site-container-wide px-4 sm:px-8">
        <PricingAnalyticsChoicesSlot />
      </div>
    </>
  );
}
