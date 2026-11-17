export const PRICING_TYPES = ["FIXED", "HOURLY", "QUOTE_ONLY"] as const;
export type PricingType = (typeof PRICING_TYPES)[number];
export const HOURLY_BILLING_INCREMENTS = [15, 30, 60] as const;

// New tracked projects do not use prepaid-duration rules. Keep valid legacy
// service metadata when a fixed listing converts; existing booking snapshots
// remain untouched and retain their original terms.
export const TRACKED_HOURLY_LEGACY_DEFAULTS = {
  minimumDurationMinutes: 60,
  maximumDurationMinutes: null,
  billingIncrementMinutes: 30,
  defaultDurationMinutes: 60,
} as const;

export type HourlyPricingConfig = {
  pricingType: "HOURLY";
  hourlyRateCents: number;
  minimumDurationMinutes: number;
  maximumDurationMinutes: number | null;
  billingIncrementMinutes: 15 | 30 | 60;
  defaultDurationMinutes: number;
};

export type FixedPricingConfig = {
  pricingType: "FIXED";
  priceCents: number;
  durationMinutes: number;
};

export type ServicePricingConfig = FixedPricingConfig | HourlyPricingConfig;

function requireSafeInteger(value: number, label: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${label} is invalid.`);
}

export function isPricingType(value: unknown): value is PricingType {
  return value === "FIXED" || value === "HOURLY" || value === "QUOTE_ONLY";
}

export function isHourlyBillingIncrement(value: unknown): value is 15 | 30 | 60 {
  return typeof value === "number" && HOURLY_BILLING_INCREMENTS.includes(value as 15 | 30 | 60);
}

export function validateHourlyPricing(config: HourlyPricingConfig) {
  requireSafeInteger(config.hourlyRateCents, "Hourly rate", 50);
  requireSafeInteger(config.minimumDurationMinutes, "Minimum duration", 15);
  requireSafeInteger(config.defaultDurationMinutes, "Default duration", 15);
  if (!isHourlyBillingIncrement(config.billingIncrementMinutes)) throw new RangeError("Choose a 15, 30, or 60 minute billing increment.");
  if (config.minimumDurationMinutes < config.billingIncrementMinutes || config.minimumDurationMinutes % config.billingIncrementMinutes !== 0) throw new RangeError("Minimum duration must align with the billing increment.");
  if (config.defaultDurationMinutes < config.minimumDurationMinutes || config.defaultDurationMinutes % config.billingIncrementMinutes !== 0) throw new RangeError("Default duration must align with the increment and be at least the minimum.");
  if (config.maximumDurationMinutes !== null) {
    requireSafeInteger(config.maximumDurationMinutes, "Maximum duration", 15);
    if (config.maximumDurationMinutes < config.defaultDurationMinutes || config.maximumDurationMinutes % config.billingIncrementMinutes !== 0) throw new RangeError("Maximum duration must align with the increment and be at least the default.");
  }
  return config;
}

export function validateHourlyDuration(config: HourlyPricingConfig, durationMinutes: number) {
  validateHourlyPricing(config);
  requireSafeInteger(durationMinutes, "Booking duration", 1);
  if (durationMinutes < config.minimumDurationMinutes) throw new RangeError(`Choose at least ${config.minimumDurationMinutes} minutes.`);
  if (config.maximumDurationMinutes !== null && durationMinutes > config.maximumDurationMinutes) throw new RangeError(`Choose no more than ${config.maximumDurationMinutes} minutes.`);
  if (durationMinutes % config.billingIncrementMinutes !== 0) throw new RangeError(`Duration must use ${config.billingIncrementMinutes}-minute increments.`);
  return durationMinutes;
}

/** Exact integer arithmetic with half-cent values rounded to the nearest cent, half up. */
export function calculateHourlyBasePriceCents(hourlyRateCents: number, durationMinutes: number) {
  requireSafeInteger(hourlyRateCents, "Hourly rate", 0);
  requireSafeInteger(durationMinutes, "Booking duration", 0);
  const numerator = BigInt(hourlyRateCents) * BigInt(durationMinutes);
  const rounded = (numerator + BigInt(30)) / BigInt(60);
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) throw new RangeError("Hourly subtotal is too large.");
  return result;
}

/** Draft form values are incomplete while typing; never throw from a render preview. */
export function previewHourlyBasePriceCents(hourlyRateCents: number, durationMinutes: number): number | null {
  if (!Number.isSafeInteger(hourlyRateCents) || hourlyRateCents < 50 || hourlyRateCents > 100_000_000
    || !Number.isSafeInteger(durationMinutes) || durationMinutes <= 0) return null;
  try {
    return calculateHourlyBasePriceCents(hourlyRateCents, durationMinutes);
  } catch {
    return null;
  }
}

export function calculateServiceBasePriceCents(config: ServicePricingConfig, durationMinutes?: number) {
  if (config.pricingType === "FIXED") {
    requireSafeInteger(config.priceCents, "Service price", 0);
    return config.priceCents;
  }
  const selectedDuration = validateHourlyDuration(config, durationMinutes ?? config.defaultDurationMinutes);
  return calculateHourlyBasePriceCents(config.hourlyRateCents, selectedDuration);
}

export function hourlyDurationOptions(config: HourlyPricingConfig) {
  validateHourlyPricing(config);
  const maximum = config.maximumDurationMinutes ?? Math.max(config.minimumDurationMinutes + config.billingIncrementMinutes * 12, config.defaultDurationMinutes);
  const values: number[] = [];
  for (let duration = config.minimumDurationMinutes; duration <= maximum; duration += config.billingIncrementMinutes) values.push(duration);
  return values;
}

export function formatHourlyRate(rateCents: number) {
  return `$${(rateCents / 100).toFixed(rateCents % 100 === 0 ? 0 : 2)}/hr`;
}

export function formatServicePrice(input: { pricingType: PricingType; price: number; hourlyRateCents: number | null }) {
  if (input.pricingType === "QUOTE_ONLY") return "Request a Quote";
  return input.pricingType === "HOURLY" && input.hourlyRateCents !== null ? formatHourlyRate(input.hourlyRateCents) : `$${input.price}`;
}

export function formatDurationMinutes(minutes: number) {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return `${hours.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${hours === 1 ? "hour" : "hours"}`;
}
