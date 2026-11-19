"use client";

import {
  Children,
  CSSProperties,
  KeyboardEvent,
  ReactElement,
  ReactNode,
  isValidElement,
  useEffect,
  useId,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { edgeEnabledIndex, filterSelectOptions, nextEnabledIndex } from "@/lib/custom-select-logic";

export type CustomSelectOption = {
  value: string;
  label: ReactNode;
  textValue?: string;
  description?: string;
  disabled?: boolean;
  group?: string;
  icon?: ReactNode;
};

type OptionElementProps = { value?: string | number; disabled?: boolean; children?: ReactNode };
type OptgroupElementProps = { label?: string; children?: ReactNode };

type CustomSelectProps = {
  value?: string | number;
  defaultValue?: string | number;
  options?: readonly CustomSelectOption[];
  children?: ReactNode;
  onChange?: (value: string) => void;
  ariaLabel: string;
  ariaDescribedBy?: string;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  searchable?: boolean;
  clearable?: boolean;
  loading?: boolean;
  placeholder?: string;
  description?: string;
  error?: string;
  className?: string;
  buttonClassName?: string;
  menuClassName?: string;
  getPortalContainer?: () => HTMLElement | null;
  renderValue?: (option: CustomSelectOption) => ReactNode;
};

type MenuPosition = { left: number; top: number; minWidth: number; maxWidth: number; maxHeight: number; above: boolean };
const DEFAULT_POSITION: MenuPosition = { left: 12, top: 12, minWidth: 180, maxWidth: 320, maxHeight: 320, above: false };

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (isValidElement(node)) return textFromNode((node.props as { children?: ReactNode }).children);
  return "";
}

function optionsFromChildren(children: ReactNode, inheritedGroup?: string): CustomSelectOption[] {
  const parsed: CustomSelectOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === "option") {
      const props = child.props as OptionElementProps;
      const label = props.children;
      const textValue = textFromNode(label).trim();
      parsed.push({ value: String(props.value ?? textValue), label, textValue, disabled: props.disabled, group: inheritedGroup });
      return;
    }
    if (child.type === "optgroup") {
      const props = child.props as OptgroupElementProps;
      parsed.push(...optionsFromChildren(props.children, props.label));
      return;
    }
    const nested = (child as ReactElement<{ children?: ReactNode }>).props.children;
    if (nested) parsed.push(...optionsFromChildren(nested, inheritedGroup));
  });
  return parsed;
}

export default function CustomSelect({
  value,
  defaultValue,
  options,
  children,
  onChange,
  ariaLabel,
  ariaDescribedBy,
  name,
  required = false,
  disabled = false,
  searchable = false,
  clearable = false,
  loading = false,
  placeholder = "Choose an option",
  description,
  error,
  className = "",
  buttonClassName = "",
  menuClassName = "",
  getPortalContainer,
  renderValue,
}: CustomSelectProps) {
  const childOptions = useMemo(() => optionsFromChildren(children), [children]);
  const resolvedOptions = useMemo(() => (options?.length ? [...options] : childOptions).map((option) => ({ ...option, value: String(option.value), textValue: option.textValue ?? textFromNode(option.label).trim() })), [childOptions, options]);
  const controlled = value !== undefined;
  const initialValue = String(defaultValue ?? resolvedOptions[0]?.value ?? "");
  const [internalValue, setInternalValue] = useState(initialValue);
  const currentValue = controlled ? String(value) : internalValue;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition>(DEFAULT_POSITION);
  const [invalid, setInvalid] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typeaheadRef = useRef("");
  const typeaheadTimerRef = useRef<number | null>(null);
  const valueRef = useRef(currentValue);
  const initializedRef = useRef(Boolean(resolvedOptions.length));
  const listboxId = useId();
  const helpId = `${listboxId}-help`;

  const filteredOptions = useMemo(() => {
    if (!searchable) return resolvedOptions;
    return filterSelectOptions(resolvedOptions, query);
  }, [query, resolvedOptions, searchable]);
  const selected = resolvedOptions.find((option) => option.value === currentValue);
  const activeOptionId = open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;
  const describedBy = [ariaDescribedBy, description || error || invalid ? helpId : ""].filter(Boolean).join(" ") || undefined;

  useEffect(() => { valueRef.current = currentValue; }, [currentValue]);
  useEffect(() => {
    if (controlled || initializedRef.current || !resolvedOptions.length) return;
    initializedRef.current = true;
    setInternalValue(String(defaultValue ?? resolvedOptions[0].value));
  }, [controlled, defaultValue, resolvedOptions]);
  useEffect(() => {
    if (!open || !searchable) return;
    searchRef.current?.focus({ preventScroll: true });
  }, [open, searchable]);
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${listboxId}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listboxId, open]);

  const updatePosition = useCallback(() => {
    const trigger = buttonRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 12;
    const gap = 8;
    const below = viewportHeight - rect.bottom - margin - gap;
    const above = rect.top - margin - gap;
    const openAbove = below < 220 && above > below;
    const availableHeight = Math.max(72, Math.min(360, openAbove ? above : below));
    const measuredWidth = menuRef.current?.getBoundingClientRect().width ?? rect.width;
    const maxWidth = Math.max(180, viewportWidth - margin * 2);
    const menuWidth = Math.min(Math.max(rect.width, measuredWidth), maxWidth);
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, viewportWidth - margin - menuWidth));
    setPosition({ left, top: openAbove ? rect.top - gap : rect.bottom + gap, minWidth: rect.width, maxWidth, maxHeight: availableHeight, above: openAbove });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    const handleViewportChange = () => updatePosition();
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("orientationchange", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("orientationchange", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
      setQuery("");
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, []);

  useEffect(() => {
    const form = buttonRef.current?.closest("form");
    if (!form) return;
    function validate(event: SubmitEvent) {
      if (event.defaultPrevented) return;
      if (!required || valueRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      setInvalid(true);
      const selectedIndex = filteredOptions.findIndex((option) => option.value === valueRef.current && !option.disabled);
      setActiveIndex(selectedIndex >= 0 ? selectedIndex : edgeEnabledIndex(filteredOptions));
      setOpen(true);
      buttonRef.current?.focus();
    }
    function reset() {
      if (!controlled) setInternalValue(String(defaultValue ?? resolvedOptions[0]?.value ?? ""));
      setInvalid(false);
      setOpen(false);
      setQuery("");
    }
    form.addEventListener("submit", validate, true);
    form.addEventListener("reset", reset);
    return () => {
      form.removeEventListener("submit", validate, true);
      form.removeEventListener("reset", reset);
    };
  }, [controlled, defaultValue, filteredOptions, required, resolvedOptions]);

  function openMenu() {
    if (disabled) return;
    updatePosition();
    const selectedIndex = filteredOptions.findIndex((option) => option.value === currentValue && !option.disabled);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : edgeEnabledIndex(filteredOptions));
    setOpen(true);
  }

  function closeMenu(restoreFocus = false) {
    setOpen(false);
    setQuery("");
    if (restoreFocus) window.requestAnimationFrame(() => buttonRef.current?.focus());
  }

  function choose(option: CustomSelectOption) {
    if (option.disabled) return;
    if (!controlled) setInternalValue(option.value);
    setInvalid(false);
    onChange?.(option.value);
    closeMenu(true);
  }

  function clearSelection() {
    if (disabled) return;
    if (!controlled) setInternalValue("");
    setInvalid(required);
    onChange?.("");
    buttonRef.current?.focus();
  }

  function handleNavigation(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
      }
      return;
    }
    if (event.key === "Tab") {
      closeMenu(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      if (!open) openMenu();
      if (event.key === "Home") setActiveIndex(edgeEnabledIndex(filteredOptions));
      else if (event.key === "End") setActiveIndex(edgeEnabledIndex(filteredOptions, true));
      else setActiveIndex((current) => nextEnabledIndex(filteredOptions, current < 0 ? (event.key === "ArrowDown" ? -1 : 0) : current, event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Enter" || (event.key === " " && !searchable)) {
      event.preventDefault();
      if (!open) openMenu();
      else if (activeIndex >= 0) choose(filteredOptions[activeIndex]);
      return;
    }
    if (!searchable && event.key.length === 1 && /\S/.test(event.key)) {
      typeaheadRef.current += event.key.toLocaleLowerCase();
      if (typeaheadTimerRef.current) window.clearTimeout(typeaheadTimerRef.current);
      typeaheadTimerRef.current = window.setTimeout(() => { typeaheadRef.current = ""; }, 650);
      const match = filteredOptions.findIndex((option) => !option.disabled && (option.textValue ?? "").toLocaleLowerCase().startsWith(typeaheadRef.current));
      if (match >= 0) {
        event.preventDefault();
        if (!open) openMenu();
        setActiveIndex(match);
      }
    }
  }

  const menuStyle: CSSProperties = {
    left: position.left,
    top: position.top,
    minWidth: position.minWidth,
    maxWidth: position.maxWidth,
    transform: position.above ? "translateY(-100%)" : undefined,
  };

  const menu = open ? createPortal(
    <div ref={menuRef} className={`custom-select-menu fixed overflow-hidden rounded-2xl border border-[#183126]/12 bg-white p-1.5 shadow-[0_18px_45px_rgba(24,49,38,.2)] ${menuClassName}`} style={menuStyle}>
      {searchable && <div className="border-b border-[#183126]/10 p-1.5 pb-2"><input ref={searchRef} type="search" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listboxId} aria-activedescendant={activeOptionId} value={query} onChange={(event) => { const nextQuery = event.target.value; setQuery(nextQuery); setActiveIndex(edgeEnabledIndex(filterSelectOptions(resolvedOptions, nextQuery))); }} onKeyDown={handleNavigation} aria-label={`Search ${ariaLabel.toLocaleLowerCase()} options`} placeholder="Search options…" className="custom-select-search min-h-11 w-full rounded-xl border border-[#183126]/12 bg-[#fafaf6] px-3 text-sm outline-none focus:border-[#4d725d] focus:ring-2 focus:ring-[#4d725d]/15" /></div>}
      <div id={listboxId} role="listbox" aria-label={ariaLabel} aria-busy={loading || undefined} className="custom-select-options overscroll-contain overflow-y-auto py-0.5" style={{ maxHeight: position.maxHeight }}>
        {loading ? <p className="px-3 py-6 text-center text-sm text-[#718078]">Loading options…</p> : filteredOptions.length ? filteredOptions.map((option, index) => {
          const previousGroup = index > 0 ? filteredOptions[index - 1]?.group : undefined;
          return <div key={`${option.value}-${index}`}>{option.group && option.group !== previousGroup && <p className="px-3 pb-1 pt-3 text-[10px] font-bold uppercase tracking-[.12em] text-[#718078]">{option.group}</p>}<div id={`${listboxId}-option-${index}`} role="option" aria-selected={option.value === currentValue} aria-disabled={option.disabled || undefined} onPointerMove={() => { if (!option.disabled) setActiveIndex(index); }} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option)} className={`custom-select-option flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-semibold transition ${option.disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer"} ${option.value === currentValue ? "bg-[#e5efe3] text-[#173d2e]" : activeIndex === index && !option.disabled ? "bg-[#f2f5ef]" : option.disabled ? "" : "hover:bg-[#f2f5ef]"}`}>
            {option.icon && <span className="grid h-5 w-5 shrink-0 place-items-center" aria-hidden="true">{option.icon}</span>}
            <span className="min-w-0 flex-1 break-words"><span className="block">{option.label}</span>{option.description && <span className="mt-0.5 block text-xs font-normal leading-4 text-[#718078]">{option.description}</span>}</span>
            {option.value === currentValue && <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 shrink-0"><path strokeLinecap="round" strokeLinejoin="round" d="m5 10 3 3 7-7" /></svg>}
          </div></div>;
        }) : <p className="px-3 py-6 text-center text-sm text-[#718078]">No matching options</p>}
      </div>
    </div>,
    getPortalContainer?.() ?? document.body,
  ) : null;

  return <div ref={rootRef} className={`custom-select relative min-w-0 ${className}`}>
    {name && <input type="hidden" name={name} value={currentValue} />}
    <div className="relative flex min-w-0 items-center">
      <button ref={buttonRef} type="button" role="combobox" disabled={disabled} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={listboxId} aria-activedescendant={searchable ? undefined : activeOptionId} aria-required={required || undefined} aria-invalid={Boolean(error || invalid) || undefined} aria-describedby={describedBy} onClick={() => { if (open) closeMenu(false); else openMenu(); }} onKeyDown={handleNavigation} className={`custom-select-trigger flex min-h-12 w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-[#183126]/15 bg-[#faf9f5] px-4 py-3 text-left text-sm outline-none transition hover:border-[#4d725d] hover:bg-white focus-visible:border-[#4d725d] disabled:cursor-not-allowed disabled:opacity-55 ${error || invalid ? "border-[#a85543] ring-2 ring-[#a85543]/15" : ""} ${buttonClassName}`}>
        <span className={`min-w-0 flex-1 truncate ${selected ? "" : "text-[#718078]"}`}>{selected ? (renderValue ? renderValue(selected) : selected.label) : placeholder}</span>
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className={`h-4 w-4 shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}><path strokeLinecap="round" strokeLinejoin="round" d="m6 8 4 4 4-4" /></svg>
      </button>
      {clearable && currentValue && !disabled && <button type="button" onClick={clearSelection} aria-label={`Clear ${ariaLabel.toLocaleLowerCase()}`} className="absolute right-9 grid h-8 w-8 place-items-center rounded-full text-lg text-[#718078] hover:bg-[#e8eee7]">×</button>}
    </div>
    {(description || error || invalid) && <p id={helpId} className={`mt-1.5 text-xs ${error || invalid ? "font-semibold text-[#9a4e3c]" : "text-[#718078]"}`}>{error || (invalid ? `${ariaLabel} is required.` : description)}</p>}
    {menu}
  </div>;
}
