export const MANUAL_JOB_PREFIX = "External job: ";
export function parseManualJob(value: unknown, now = new Date()) {
  if (!value || typeof value !== "object") throw new Error("Enter a job title and time range.");
  const body = value as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title.length < 2 || title.length > 180 || /[\u0000-\u001f<>]/.test(title)) throw new Error("Enter a title between 2 and 180 characters without HTML.");
  const parse = (value: unknown) => typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? new Date(value) : new Date(NaN);
  const startsAt = parse(body.startsAt), endsAt = parse(body.endsAt);
  if (!Number.isFinite(+startsAt) || !Number.isFinite(+endsAt) || endsAt <= startsAt) throw new Error("Choose a valid start and end time.");
  if (+endsAt - +startsAt > 31 * 86400000) throw new Error("A job can span at most 31 days.");
  const shiftMonths = (count: number) => {
    const shifted = new Date(now), day = shifted.getUTCDate();
    shifted.setUTCDate(1); shifted.setUTCMonth(shifted.getUTCMonth() + count);
    const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
    shifted.setUTCDate(Math.min(day, lastDay)); return shifted;
  };
  const earliest = shiftMonths(-6), latest = shiftMonths(18);
  if (startsAt < earliest || startsAt >= latest) throw new Error("Choose a job starting within the past 6 months or next 18 months so it stays visible in your calendar.");
  return { title, startsAt, endsAt, reason: MANUAL_JOB_PREFIX + title };
}
