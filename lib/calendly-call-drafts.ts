/** Private configuration only. No booking, payment, reservation, or activation. */
export type CalendlyCallBillingDraft =
  | { billingMode: "free"; servicePriceCents: 0 }
  | { billingMode: "paid"; servicePriceCents: number };

// Match the marketplace's price ceiling; use integer USD cents throughout.
export const MAX_CALL_SERVICE_PRICE_CENTS = 100_000_000;

export function parseCalendlyCallBillingDraft(value: unknown): CalendlyCallBillingDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.billingMode === "free" && input.servicePriceCents === 0) return { billingMode: "free", servicePriceCents: 0 };
  if (input.billingMode === "paid" && typeof input.servicePriceCents === "number"
    && Number.isSafeInteger(input.servicePriceCents) && input.servicePriceCents >= 50
    && input.servicePriceCents <= MAX_CALL_SERVICE_PRICE_CENTS) {
    return { billingMode: "paid", servicePriceCents: input.servicePriceCents };
  }
  return null;
}

/** Do not coerce blank/exponent/rounded amounts into valid payment preferences. */
export function parseCallPriceDollars(value: string): number | null {
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(value)) return null;
  const [dollars, cents = ""] = value.split(".");
  const amount = Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
  return amount >= 50 && amount <= MAX_CALL_SERVICE_PRICE_CENTS ? amount : null;
}

export function hasVerifiedNoCalendlyPayment(event: { collectsPayment: boolean | null }) {
  // Missing/unknown is not evidence of a free Calendly event. Never change the
  // provider's Calendly configuration automatically to make a draft eligible.
  return event.collectsPayment === false;
}
