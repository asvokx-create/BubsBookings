/** Round the aggregate once, never each individual time entry. */
export function calculateHourlyProjectPrice(totalSeconds: number, hourlyRateCents: number) {
  if (!Number.isSafeInteger(totalSeconds) || totalSeconds < 0 || totalSeconds > 31536000) throw new RangeError("Invalid tracked seconds.");
  if (!Number.isSafeInteger(hourlyRateCents) || hourlyRateCents < 1 || hourlyRateCents > 10000000) throw new RangeError("Invalid hourly rate.");
  const billableMinutes = Math.ceil(totalSeconds / 60);
  const subtotalCents = Number((BigInt(billableMinutes) * BigInt(hourlyRateCents) + BigInt(30)) / BigInt(60));
  if (subtotalCents + 299 > 99999999) throw new RangeError("Project exceeds the supported payment limit.");
  return { totalSeconds, billableMinutes, subtotalCents, customerServiceFeeCents: 299, customerTotalCents: subtotalCents + 299 };
}
export function cappedTimerSeconds(startedAt: Date | string, now: Date, limitSeconds: number) {
  return Math.min(limitSeconds, Math.max(0, Math.floor((now.getTime() - new Date(startedAt).getTime()) / 1000)));
}
