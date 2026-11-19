"use client";

import { KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { lockModalBackground } from "@/lib/modal-environment";
import CustomSelect from "@/components/custom-select";
import UiIcon from "@/components/ui-icon";
import { addDateOnlyDays, calendarGrid, formatDateOnly, monthForDate, parseDateOnly, shiftCalendarMonth, todayDateOnly, clampDateOnly, shiftDateOnlyMonths, type CalendarMonth } from "@/lib/calendar-date";

type DatePickerProps = {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  min?: string;
  max?: string;
  disabledDates?: readonly string[];
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  buttonClassName?: string;
  description?: string;
  error?: string;
  clearable?: boolean;
};

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const focusableSelector = "a[href], button:not([disabled]), input:not([disabled]), [tabindex]";

function localMonthLabel(month: CalendarMonth) {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date(month.year, month.month - 1, 1, 12));
}

export default function DatePicker({
  value,
  defaultValue = "",
  onChange,
  name,
  required = false,
  disabled = false,
  min,
  max,
  disabledDates = [],
  ariaLabel,
  placeholder = "Select a date",
  className = "",
  buttonClassName = "",
  description,
  error,
  clearable = false,
}: DatePickerProps) {
  const controlled = value !== undefined;
  const [internalValue, setInternalValue] = useState(defaultValue);
  const selectedValue = controlled ? value ?? "" : internalValue;
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [activeDate, setActiveDate] = useState("");
  const pendingFocusRef = useRef<string | null>(null);
  const [displayedMonth, setDisplayedMonth] = useState<CalendarMonth>(() => monthForDate(selectedValue || min || todayDateOnly()));
  const [position, setPosition] = useState({ top: 12, left: 12, width: 352, maxHeight: 520, mobile: false });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef(false);
  const fieldId = useId();
  const helpId = `${fieldId}-help`;
  const disabledSet = useMemo(() => new Set(disabledDates), [disabledDates]);
  const dates = useMemo(() => calendarGrid(displayedMonth), [displayedMonth]);
  const selectedMonth = String(displayedMonth.month);
  const tabDate = dates.includes(activeDate) ? activeDate : dates.includes(selectedValue) ? selectedValue : dates.find((date) => date && !isUnavailable(date)) ?? dates.find(Boolean) ?? "";
  const earliestYear = parseDateOnly(min ?? "")?.year ?? Math.min(2000, new Date().getFullYear() - 100);
  const latestYear = parseDateOnly(max ?? "")?.year ?? Math.max(2100, new Date().getFullYear() + 20);
  const yearOptions = useMemo(() => Array.from({ length: Math.max(1, latestYear - earliestYear + 1) }, (_, index) => String(earliestYear + index)), [earliestYear, latestYear]);

  function isUnavailable(date: string) {
    return Boolean((min && date < min) || (max && date > max) || disabledSet.has(date));
  }

  function initialDate() {
    return clampDateOnly(selectedValue || todayDateOnly(), min, max);
  }

  function setDate(next: string) {
    if (isUnavailable(next)) return;
    if (!controlled) setInternalValue(next);
    setInvalid(false);
    onChange?.(next);
    close(true);
  }

  function close(restoreFocus = false) {
    setOpen(false);
    returnFocusRef.current = restoreFocus;
  }

  function focusDate(date: string) {
    panelRef.current?.querySelector<HTMLButtonElement>(`button[data-date="${date}"]`)?.focus();
  }

  function moveTo(date: string) {
    setActiveDate(date);
    pendingFocusRef.current = date;
    setDisplayedMonth(monthForDate(date));
  }

  function handleDateKeyDown(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let next = date;
    if (event.key in moves) next = addDateOnlyDays(date, moves[event.key]);
    else if (event.key === "Home") next = addDateOnlyDays(date, -new Date(`${date}T12:00:00`).getDay());
    else if (event.key === "End") next = addDateOnlyDays(date, 6 - new Date(`${date}T12:00:00`).getDay());
    else if (event.key === "PageUp" || event.key === "PageDown") {
      const shift = (event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1);
      next = shiftDateOnlyMonths(date, shift);
    } else return;
    event.preventDefault();
    moveTo(next);
  }

  function handlePanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key !== "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector))
      .filter((item) => item.tabIndex >= 0 && !item.closest("[inert]") && !item.closest(".custom-select-menu") && item.getClientRects().length > 0);
    // A searchable combobox input is portaled at the end of the panel. Tab from
    // it follows the owning trigger's logical position, not portal DOM order.
    const focused = document.activeElement as HTMLElement | null;
    const controls = focused?.closest(".custom-select-menu") ? focused.getAttribute("aria-controls") : null;
    const owner = controls ? items.find((item) => item.getAttribute("aria-controls") === controls) : focused;
    const index = items.indexOf(owner as HTMLElement);
    const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length;
    (items[next] ?? panel).focus();
  }

  useLayoutEffect(() => {
    if (!open || !pendingFocusRef.current) return;
    const date = pendingFocusRef.current;
    pendingFocusRef.current = null;
    focusDate(date);
  }, [open, displayedMonth, activeDate]);

  useLayoutEffect(() => {
    if (!open) return;
    function updatePosition() {
      const mobile = window.matchMedia("(max-width: 640px)").matches;
      if (mobile || !triggerRef.current) {
        setPosition({ top: 0, left: 0, width: 0, maxHeight: Math.min(600, window.innerHeight - 24), mobile: true });
        return;
      }
      const rect = triggerRef.current.getBoundingClientRect();
      const width = Math.min(352, window.innerWidth - 24);
      const maxHeight = Math.min(540, window.innerHeight - 24);
      const above = rect.top > maxHeight + 20 && window.innerHeight - rect.bottom < 300;
      setPosition({
        top: above ? Math.max(12, rect.top - maxHeight - 8) : Math.min(rect.bottom + 8, window.innerHeight - maxHeight - 12),
        left: Math.min(Math.max(12, rect.left), window.innerWidth - width - 12),
        width,
        maxHeight,
        mobile: false,
      });
    }
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("orientationchange", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("orientationchange", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Element;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close(true);
    }

    document.addEventListener("pointerdown", onPointerDown);
    const panel = panelRef.current;
    const unlock = panel ? lockModalBackground(panel) : () => {};
    const firstDate = panel?.querySelector<HTMLButtonElement>('button[data-date][tabindex="0"]');
    const frame = requestAnimationFrame(() => (firstDate ?? panel)?.focus());
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      cancelAnimationFrame(frame);
      unlock();
    };
  }, [open]);

  useEffect(() => {
    if (open || !returnFocusRef.current) return;
    returnFocusRef.current = false;
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, [open]);

  useEffect(() => {
    const form = triggerRef.current?.closest("form");
    if (!form) return;
    function validate(event: SubmitEvent) {
      if (event.defaultPrevented) return;
      if (!required || selectedValue) return;
      event.preventDefault();
      event.stopPropagation();
      setInvalid(true);
      const initial = clampDateOnly(todayDateOnly(), min, max);
      setActiveDate(initial);
      setDisplayedMonth(monthForDate(initial));
      setOpen(true);
    }
    function reset() {
      if (!controlled) setInternalValue(defaultValue);
      setInvalid(false);
      close(false);
    }
    form.addEventListener("submit", validate, true);
    form.addEventListener("reset", reset);
    return () => { form.removeEventListener("submit", validate, true); form.removeEventListener("reset", reset); };
  }, [controlled, defaultValue, min, max, required, selectedValue]);

  const calendar = open ? (
    <div className={position.mobile ? "fixed inset-0 z-[350] flex items-end bg-[#071b12]/45 p-3 pb-[max(.75rem,env(safe-area-inset-bottom))]" : "fixed z-[350]"} style={position.mobile ? undefined : { top: position.top, left: position.left, width: position.width }} onPointerDown={(event) => { if (position.mobile && event.target === event.currentTarget) close(true); }}>
      <div ref={panelRef} tabIndex={-1} onKeyDown={handlePanelKeyDown} className="date-picker-panel w-full overflow-y-auto rounded-[1.75rem] border border-[#183126]/12 bg-[#fffefa] p-4 text-[#183126] shadow-[0_26px_80px_rgba(10,39,27,.24)] sm:p-5" role="dialog" aria-modal="true" aria-label={`Choose ${ariaLabel.toLocaleLowerCase()}`} style={{ maxHeight: position.mobile ? "min(86dvh, 600px)" : position.maxHeight }}>
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
          <button type="button" aria-label="Previous month" onClick={() => setDisplayedMonth((month) => shiftCalendarMonth(month, -1))} className="grid h-10 w-10 place-items-center rounded-full border border-[#183126]/12 bg-white transition hover:bg-[#eef3ea]"><UiIcon name="chevron-left" className="h-5 w-5" /></button>
          <div className="grid min-w-0 grid-cols-2 gap-2">
            <CustomSelect ariaLabel="Calendar month" getPortalContainer={() => panelRef.current} value={selectedMonth} onChange={(month) => setDisplayedMonth((current) => ({ ...current, month: Number(month) }))} options={Array.from({ length: 12 }, (_, index) => ({ value: String(index + 1), label: new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(2026, index, 1)) }))} buttonClassName="min-h-10 rounded-xl bg-white px-3 py-2 text-xs font-bold" menuClassName="date-picker-select-menu z-[360]" />
            <CustomSelect ariaLabel="Calendar year" getPortalContainer={() => panelRef.current} searchable={yearOptions.length > 18} value={String(displayedMonth.year)} onChange={(year) => setDisplayedMonth((current) => ({ ...current, year: Number(year) }))} options={yearOptions.map((year) => ({ value: year, label: year }))} buttonClassName="min-h-10 rounded-xl bg-white px-3 py-2 text-xs font-bold" menuClassName="date-picker-select-menu z-[360]" />
          </div>
          <button type="button" aria-label="Next month" onClick={() => setDisplayedMonth((month) => shiftCalendarMonth(month, 1))} className="grid h-10 w-10 place-items-center rounded-full border border-[#183126]/12 bg-white transition hover:bg-[#eef3ea]"><UiIcon name="chevron-right" className="h-5 w-5" /></button>
        </div>
        <p aria-live="polite" className="sr-only">{localMonthLabel(displayedMonth)}</p>
        <div role="grid" aria-label={localMonthLabel(displayedMonth)} className="mt-4 text-center">
          <div role="row" className="grid grid-cols-7 gap-1">
          {weekdays.map((weekday) => <div key={weekday} role="columnheader" aria-label={weekday} className="py-1 text-[11px] font-bold uppercase tracking-wide text-[#77867e]">{weekday.slice(0, 1)}</div>)}
          </div>
          {Array.from({ length: dates.length / 7 }, (_, week) => <div role="row" key={week} className="grid grid-cols-7 gap-1">{dates.slice(week * 7, week * 7 + 7).map((date, index) => {
            if (!date) return <span key={`empty-${index}`} role="gridcell" aria-hidden="true" />;
            const unavailable = isUnavailable(date);
            const today = date === todayDateOnly();
            const selected = date === selectedValue;
            return <button key={date} data-date={date} type="button" role="gridcell" tabIndex={date === tabDate ? 0 : -1} onFocus={() => setActiveDate(date)} aria-label={`${formatDateOnly(date)}${today ? ", today" : ""}${unavailable ? ", unavailable" : ""}${selected ? ", selected" : ""}`} aria-current={today ? "date" : undefined} aria-selected={selected} aria-disabled={unavailable || undefined} onKeyDown={(event) => handleDateKeyDown(event, date)} onClick={() => setDate(date)} className={`relative grid aspect-square min-h-10 place-items-center rounded-xl text-sm font-bold transition focus-visible:z-10 ${selected ? "bg-[#183126] text-white shadow-md" : today ? "border border-[#c8bc43] bg-[#fff9c7]" : unavailable ? "cursor-not-allowed text-[#aab2ad] opacity-55" : "bg-white hover:bg-[#e5efdf] hover:text-[#123d2d]"}`}>{Number(date.slice(-2))}{today && !selected && <span aria-hidden="true" className="absolute bottom-1 h-1 w-1 rounded-full bg-[#8f8421]" />}</button>;
          })}</div>)}
        </div>
        <div className="mt-4 flex items-center justify-between gap-3 text-xs text-[#687970]">{clearable && selectedValue ? <button type="button" onClick={() => { if (!controlled) setInternalValue(""); onChange?.(""); close(true); }} className="font-bold text-[#315846] underline underline-offset-2">Clear date</button> : <span>Use arrow keys to move between days. Unavailable dates cannot be selected.</span>}<button type="button" onClick={() => { setDisplayedMonth(monthForDate(todayDateOnly())); }} className="font-bold text-[#315846] underline underline-offset-2">Today</button></div>
        <button type="button" onClick={() => close(true)} className="mt-4 w-full rounded-full border border-[#183126]/12 bg-white px-4 py-3 text-sm font-bold sm:hidden">Close calendar</button>
      </div>
    </div>
  ) : null;

  return <div className={`date-picker min-w-0 ${className}`}>
    {name && <input type="hidden" name={name} value={selectedValue} />}
    <button ref={triggerRef} id={fieldId} type="button" aria-label={`${ariaLabel}: ${selectedValue ? formatDateOnly(selectedValue) : placeholder}`} disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-describedby={description || error || invalid ? helpId : undefined} onClick={() => { setActiveDate(initialDate()); setDisplayedMonth(monthForDate(initialDate())); setOpen((current) => !current); }} className={`date-picker-trigger flex min-h-12 w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-[#183126]/15 bg-[#faf9f5] px-4 py-3 text-left text-sm outline-none transition hover:border-[#4d725d] hover:bg-white focus-visible:border-[#4d725d] disabled:cursor-not-allowed disabled:opacity-55 ${error || invalid ? "border-[#a85543] ring-2 ring-[#a85543]/15" : ""} ${buttonClassName}`}><span className={selectedValue ? "min-w-0 truncate font-semibold" : "min-w-0 truncate text-[#718078]"}>{selectedValue ? formatDateOnly(selectedValue) : placeholder}</span><span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[#e5eddf]"><UiIcon name="calendar" className="h-4 w-4" /></span></button>
    {(description || error || invalid) && <p id={helpId} className={`mt-1.5 text-xs ${error || invalid ? "font-semibold text-[#9a4e3c]" : "text-[#718078]"}`}>{error || (invalid ? `${ariaLabel} is required.` : description)}</p>}
    {typeof document !== "undefined" && calendar ? createPortal(calendar, document.body) : null}
  </div>;
}
