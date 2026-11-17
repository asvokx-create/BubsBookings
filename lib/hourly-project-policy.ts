/** New hourly work is tracked; existing booking snapshots are never converted. */
export function requiresHourlyProject(pricingType: unknown): boolean {
  return pricingType === "HOURLY";
}
