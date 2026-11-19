export type CalendarMonth = { year: number; month: number };

export function daysInMonth(year: number, month: number) {
  return new Date(year, month, 0, 12).getDate();
}

export function parseDateOnly(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function toDateOnly(year: number, month: number, day: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function todayDateOnly(now = new Date()) {
  return toDateOnly(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function monthForDate(value: string, fallback = new Date()): CalendarMonth {
  const parsed = parseDateOnly(value);
  return parsed ? { year: parsed.year, month: parsed.month } : { year: fallback.getFullYear(), month: fallback.getMonth() + 1 };
}

export function shiftCalendarMonth(value: CalendarMonth, amount: number): CalendarMonth {
  const shifted = new Date(value.year, value.month - 1 + amount, 1, 12);
  return { year: shifted.getFullYear(), month: shifted.getMonth() + 1 };
}

export function addDateOnlyDays(value: string, amount: number) {
  const parsed = parseDateOnly(value);
  if (!parsed) return value;
  const shifted = new Date(parsed.year, parsed.month - 1, parsed.day + amount, 12);
  return toDateOnly(shifted.getFullYear(), shifted.getMonth() + 1, shifted.getDate());
}

export function calendarGrid(value: CalendarMonth) {
  const leadingDays = new Date(value.year, value.month - 1, 1, 12).getDay();
  const dates: Array<string | null> = Array.from({ length: leadingDays }, () => null);
  for (let day = 1; day <= daysInMonth(value.year, value.month); day += 1) dates.push(toDateOnly(value.year, value.month, day));
  while (dates.length % 7 !== 0) dates.push(null);
  return dates;
}

export function formatDateOnly(value: string, locale = "en-US") {
  const parsed = parseDateOnly(value);
  if (!parsed) return "";
  return new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", year: "numeric" })
    .format(new Date(parsed.year, parsed.month - 1, parsed.day, 12));
}

/** Keep the initial keyboard target inside the supplied date-only bounds. */
export function clampDateOnly(value: string, min?: string, max?: string) {
  if (min && value < min) return min;
  if (max && value > max) return max;
  return value;
}

/** Preserve day of month when paging, clamping short months (including leap years). */
export function shiftDateOnlyMonths(value: string, amount: number) {
  const parsed = parseDateOnly(value);
  if (!parsed) return value;
  const shifted = shiftCalendarMonth(parsed, amount);
  return toDateOnly(shifted.year, shifted.month, Math.min(parsed.day, daysInMonth(shifted.year, shifted.month)));
}
