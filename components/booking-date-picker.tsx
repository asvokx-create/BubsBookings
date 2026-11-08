"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { addDateOnlyDays, calendarGrid, formatDateOnly, monthForDate, shiftCalendarMonth, todayDateOnly, type CalendarMonth } from "@/lib/calendar-date";
import UiIcon from "@/components/ui-icon";

type BookingDatePickerProps = {
  serviceId: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  durationMinutes?: number;
  additionalMinutes?: number;
  availabilityBaseUrl?: string;
};

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const noDates = new Set<string>();

type CalendarDayProps = {
  date: string;
  disabled: boolean;
  selected: boolean;
  today: boolean;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, date: string) => void;
  onSelect: (date: string) => void;
};

function CalendarDay({ date, disabled, selected, today, onKeyDown, onSelect }: CalendarDayProps) {
  const label = `${formatDateOnly(date)}${today ? ", today" : ""}${disabled ? ", unavailable" : ", available"}${selected ? ", selected" : ""}`;
  return (
    <button data-date={date} type="button" role="gridcell" tabIndex={-1} aria-label={label} aria-selected={selected} aria-current={today ? "date" : undefined} aria-disabled={disabled} onKeyDown={(event) => onKeyDown(event, date)} onClick={() => { if (!disabled) onSelect(date); }} className={`booking-calendar-day relative grid aspect-square min-h-10 place-items-center rounded-xl text-sm font-bold transition focus-visible:z-10 ${selected ? "booking-calendar-day--selected bg-[#183126] text-white shadow-md" : today ? "booking-calendar-day--today border border-[#c8bc43] bg-[#fff9c7]" : disabled ? "booking-calendar-day--disabled cursor-not-allowed text-[#aab2ad] opacity-55" : "booking-calendar-day--available bg-white hover:bg-[#e5efdf] hover:text-[#123d2d]"}`}>
      {Number(date.slice(-2))}
      {today && !selected && <span aria-hidden="true" className="absolute bottom-1 h-1 w-1 rounded-full bg-[#8f8421]" />}
    </button>
  );
}

export default function BookingDatePicker({ serviceId, value, onChange, disabled = false, durationMinutes, additionalMinutes = 0, availabilityBaseUrl }: BookingDatePickerProps) {
  const today = todayDateOnly();
  const currentMonth = monthForDate(today);
  const [open, setOpen] = useState(false);
  const [displayedMonth, setDisplayedMonth] = useState<CalendarMonth>(() => monthForDate(value));
  const [retryKey, setRetryKey] = useState(0);
  const [availability, setAvailability] = useState<{ requestKey: string; dates: Set<string>; error: string }>({ requestKey: "", dates: noDates, error: "" });
  const [mobile, setMobile] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 360, maxHeight: 520 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pendingFocusDate = useRef("");
  const monthKey = `${displayedMonth.year}-${String(displayedMonth.month).padStart(2, "0")}`;
  const requestKey = `${monthKey}:${durationMinutes ?? "default"}:${additionalMinutes}:${retryKey}`;
  const loading = open && availability.requestKey !== requestKey;
  const availableDates = loading ? noDates : availability.dates;
  const availabilityError = loading ? "" : availability.error;
  const monthLabel = useMemo(() => new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date(displayedMonth.year, displayedMonth.month - 1, 1, 12)), [displayedMonth]);
  const dates = useMemo(() => calendarGrid(displayedMonth), [displayedMonth]);

  function closeCalendar() {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function focusDate(date: string) {
    const button = panelRef.current?.querySelector<HTMLButtonElement>(`button[data-date="${date}"]`);
    if (button && !button.disabled) button.focus();
  }

  function moveFocus(from: string, amount: number) {
    const next = addDateOnlyDays(from, amount);
    const nextMonth = monthForDate(next);
    if (nextMonth.year < currentMonth.year || (nextMonth.year === currentMonth.year && nextMonth.month < currentMonth.month)) return;
    if (nextMonth.year !== displayedMonth.year || nextMonth.month !== displayedMonth.month) {
      pendingFocusDate.current = next;
      setDisplayedMonth(nextMonth);
      return;
    }
    focusDate(next);
  }

  function handleDateKeyDown(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in moves) {
      event.preventDefault();
      moveFocus(date, moves[event.key]);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveFocus(date, -new Date(`${date}T12:00:00`).getDay());
    } else if (event.key === "End") {
      event.preventDefault();
      moveFocus(date, 6 - new Date(`${date}T12:00:00`).getDay());
    }
  }

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const baseUrl = availabilityBaseUrl ?? `/api/services/${serviceId}/availability`;
    fetch(`${baseUrl}?month=${encodeURIComponent(monthKey)}${durationMinutes ? `&durationMinutes=${durationMinutes}` : ""}${additionalMinutes ? `&additionalMinutes=${additionalMinutes}` : ""}`, { signal: controller.signal })
      .then(async (response) => {
        let data: { dates?: string[]; error?: string } = {};
        try {
          data = await response.json() as { dates?: string[]; error?: string };
        } catch {
          if (response.ok) throw new Error("Availability could not be loaded.");
        }
        if (!response.ok) throw new Error(data.error ?? "Availability could not be loaded.");
        setAvailability({ requestKey, dates: new Set(data.dates ?? []), error: "" });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setAvailability({ requestKey, dates: noDates, error: "We couldn't load availability. Please try again." });
      })
    return () => controller.abort();
  }, [additionalMinutes, availabilityBaseUrl, durationMinutes, monthKey, open, requestKey, serviceId]);

  useLayoutEffect(() => {
    if (!open) return;
    function updatePosition() {
      const isMobile = window.matchMedia("(max-width: 640px)").matches;
      setMobile(isMobile);
      if (isMobile || !triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 24);
      const maxHeight = Math.min(520, window.innerHeight - 24);
      const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
      const top = rect.bottom + 8 + maxHeight > window.innerHeight && rect.top > maxHeight + 20
        ? Math.max(12, rect.top - maxHeight - 8)
        : Math.min(rect.bottom + 8, window.innerHeight - maxHeight - 12);
      setPosition({ top: Math.max(12, top), left, width, maxHeight });
    }
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleDocumentPointer(event: PointerEvent) {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) closeCalendar();
    }
    function handleDocumentKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeCalendar();
      }
      if (event.key === "Tab" && panelRef.current) {
        const focusable = [...panelRef.current.querySelectorAll<HTMLElement>("button:not(:disabled)")];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("pointerdown", handleDocumentPointer);
    document.addEventListener("keydown", handleDocumentKey);
    requestAnimationFrame(() => {
      const preferred = value && availableDates.has(value) ? value : [...availableDates].sort()[0];
      if (preferred) focusDate(preferred);
      else panelRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointer);
      document.removeEventListener("keydown", handleDocumentKey);
    };
  }, [availableDates, open, value]);

  useEffect(() => {
    if (!pendingFocusDate.current || loading) return;
    const target = pendingFocusDate.current;
    pendingFocusDate.current = "";
    requestAnimationFrame(() => focusDate(target));
  }, [availableDates, loading]);

  const previousDisabled = displayedMonth.year < currentMonth.year || (displayedMonth.year === currentMonth.year && displayedMonth.month <= currentMonth.month);
  const calendar = open ? (
    <div
      className={mobile ? "fixed inset-0 z-[250] flex items-end bg-[#071b12]/40 p-3 pb-[max(.75rem,env(safe-area-inset-bottom))]" : "fixed z-[250]"}
      style={mobile ? undefined : position}
      onPointerDown={(event) => { if (mobile && event.target === event.currentTarget) closeCalendar(); }}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Choose a preferred date" className="booking-calendar w-full overflow-y-auto rounded-[1.75rem] border border-[#183126]/12 bg-[#fffefa] p-4 text-[#183126] shadow-[0_26px_80px_rgba(10,39,27,.24)] sm:p-5" style={{ maxHeight: mobile ? "min(86dvh, 580px)" : position.maxHeight }}>
        <div className="booking-calendar-header flex items-center justify-between gap-3">
          <button type="button" aria-label="Previous month" disabled={previousDisabled} onClick={() => setDisplayedMonth((month) => shiftCalendarMonth(month, -1))} className="grid h-11 w-11 place-items-center rounded-full border border-[#183126]/12 bg-white transition hover:border-[#476a56] hover:bg-[#eef3ea] disabled:cursor-not-allowed disabled:opacity-35"><UiIcon name="chevron-left" className="h-5 w-5" /></button>
          <h3 aria-live="polite" className="text-center text-lg font-bold tracking-tight">{monthLabel}</h3>
          <button type="button" aria-label="Next month" onClick={() => setDisplayedMonth((month) => shiftCalendarMonth(month, 1))} className="grid h-11 w-11 place-items-center rounded-full border border-[#183126]/12 bg-white transition hover:border-[#476a56] hover:bg-[#eef3ea]"><UiIcon name="chevron-right" className="h-5 w-5" /></button>
        </div>
        <div role="grid" aria-label={monthLabel} className="mt-4 grid grid-cols-7 gap-1 text-center">
          {weekdays.map((weekday) => <div key={weekday} role="columnheader" aria-label={weekday} className="py-1 text-[11px] font-bold uppercase tracking-wide text-[#77867e]">{weekday.slice(0, 1)}</div>)}
          {dates.map((date, index) => {
            if (!date) return <span key={`empty-${index}`} role="gridcell" aria-hidden="true" />;
            const isPast = date < today;
            const isAvailable = availableDates.has(date);
            const isSelected = date === value;
            const isToday = date === today;
            const disabledDate = isPast || loading || Boolean(availabilityError) || !isAvailable;
            return <CalendarDay key={date} date={date} disabled={disabledDate} selected={isSelected} today={isToday} onKeyDown={handleDateKeyDown} onSelect={(selectedDate) => { onChange(selectedDate); closeCalendar(); }} />;
          })}
        </div>
        <div aria-live="polite" className="mt-4 min-h-10 break-words text-center text-xs leading-5 text-[#687970]">
          {loading ? "Checking provider availability…" : availabilityError ? <><span className="block font-semibold text-[#9a4e25]">{availabilityError}</span><button type="button" onClick={() => setRetryKey((key) => key + 1)} className="mt-2 rounded-full bg-[#183126] px-4 py-2 font-bold text-white">Try again</button></> : availableDates.size === 0 ? "No available dates in this month. Try the next month." : "Unavailable dates are dimmed."}
        </div>
        <button type="button" onClick={closeCalendar} className="mt-2 w-full rounded-full border border-[#183126]/12 bg-white px-4 py-3 text-sm font-bold sm:hidden">Close calendar</button>
      </div>
    </div>
  ) : null;

  return (
    <div>
      <button ref={triggerRef} type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setDisplayedMonth(monthForDate(value)); setOpen((current) => !current); }} className="flex min-h-12 w-full items-center justify-between gap-3 rounded-2xl border border-[#183126]/15 bg-[#faf9f5] px-4 py-3.5 text-left text-base outline-none transition hover:border-[#4d725d] hover:bg-white focus-visible:border-[#4d725d] disabled:cursor-not-allowed disabled:opacity-55">
        <span className={value ? "font-semibold" : "text-[#75837c]"}>{value ? formatDateOnly(value) : "Select a date"}</span>
            <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[#e5eddf]"><UiIcon name="calendar" className="h-4 w-4" /></span>
      </button>
      {typeof document !== "undefined" && calendar ? createPortal(calendar, document.body) : null}
    </div>
  );
}
