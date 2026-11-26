// Listing estimates are informational only; never use them as booking bounds,
// project caps, billing increments, or approved payment amounts.
export const MAX_HOURLY_ESTIMATE_MINUTES = 60_000;
export const HOURLY_ESTIMATE_ERROR = "Enter both estimated durations in whole minutes (1–60,000), with the shorter duration first, or leave both blank.";

export type HourlyListingEstimate = { estimatedMinMinutes: number | null; estimatedMaxMinutes: number | null };

export function parseHourlyListingEstimate(min: unknown, max: unknown): HourlyListingEstimate {
  if ((min === null || min === undefined) && (max === null || max === undefined)) {
    return { estimatedMinMinutes: null, estimatedMaxMinutes: null };
  }
  if (typeof min !== "number" || typeof max !== "number" || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min || max > MAX_HOURLY_ESTIMATE_MINUTES) {
    throw new RangeError(HOURLY_ESTIMATE_ERROR);
  }
  return { estimatedMinMinutes: min, estimatedMaxMinutes: max };
}

export function parseHourlyEstimateInputs(shorter: string, longer: string) {
  return parseHourlyListingEstimate(shorter.trim() ? Number(shorter) : null, longer.trim() ? Number(longer) : null);
}

// Keep old clients' unrelated PATCHes from silently erasing a provider's estimate.
export function resolveHourlyListingEstimate(body: Record<string, unknown>, isHourly: boolean): HourlyListingEstimate | undefined {
  if (!isHourly) return parseHourlyListingEstimate(null, null);
  if (!Object.hasOwn(body, "estimatedMinMinutes") && !Object.hasOwn(body, "estimatedMaxMinutes")) return undefined;
  return parseHourlyListingEstimate(body.estimatedMinMinutes, body.estimatedMaxMinutes);
}

function displayDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return [hours ? `${hours}h` : "", remaining ? `${remaining}m` : ""].filter(Boolean).join(" ");
}

export function describeHourlyListingEstimate(estimate: HourlyListingEstimate, rateCents: number | null) {
  const { estimatedMinMinutes: min, estimatedMaxMinutes: max } = estimate;
  if (min === null || max === null || rateCents === null || !Number.isSafeInteger(rateCents) || rateCents < 1) return null;
  try { parseHourlyListingEstimate(min, max); } catch { return null; }
  const approximateCents = (minutes: number) => Number((BigInt(minutes) * BigInt(rateCents) + BigInt(30)) / BigInt(60));
  const currency = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
  const duration = min === max ? displayDuration(min) : `${displayDuration(min)}–${displayDuration(max)}`;
  const labor = min === max ? currency(approximateCents(min)) : `${currency(approximateCents(min))}–${currency(approximateCents(max))}`;
  return { duration, labor };
}
