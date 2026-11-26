export const MAX_PROJECT_CAP_MINUTES = 60000;

export function projectCapMinutes(hours: string, minutes: string): number | null {
  if (!hours && !minutes) return null;
  if ((hours && !/^\d+$/.test(hours)) || (minutes && !/^\d+$/.test(minutes))) return null;
  const h = Number(hours);
  const m = Number(minutes);
  const total = h * 60 + m;
  return Number.isSafeInteger(total) && h >= 0 && m >= 0 && m < 60 && total >= 1 && total <= MAX_PROJECT_CAP_MINUTES ? total : null;
}
