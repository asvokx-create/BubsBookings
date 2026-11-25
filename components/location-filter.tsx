"use client";

import UiIcon from "@/components/ui-icon";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import RadiusSelector from "@/components/radius-selector";
import { isValidSearchRadius, MAX_SEARCH_RADIUS_MILES } from "@/lib/search-radius";

type LocationFilterProps = {
  initialLocation?: string;
  initialRadius?: number;
  restoreRemembered?: boolean;
  autoSubmitRadius?: boolean;
  autoSubmitLocation?: boolean;
  requestLocationOnFirstVisit?: boolean;
};

const STORAGE_KEY = "bookme-service-area";
const LOCATION_PROMPTED_KEY = "bookme-location-permission-asked";
const PHONE_PICKER_QUERY = "(max-width: 639px)";

function subscribeToPhonePicker(callback: () => void) {
  const media = window.matchMedia(PHONE_PICKER_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

function getPhonePickerSnapshot() {
  return window.matchMedia(PHONE_PICKER_QUERY).matches
    && typeof HTMLDialogElement !== "undefined"
    && typeof HTMLDialogElement.prototype.showModal === "function";
}

const serverPhonePickerSnapshot = () => false;
type CityChoice = { city: string; state: string; label: string; distance?: number };

export default function LocationFilter({ initialLocation = "", initialRadius = 25, restoreRemembered = false, autoSubmitRadius = false, autoSubmitLocation = false, requestLocationOnFirstVisit = false }: LocationFilterProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [location, setLocation] = useState(initialLocation);
  const [radius, setRadius] = useState(initialRadius);
  const [locating, setLocating] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [message, setMessage] = useState("");
  const [nearby, setNearby] = useState<CityChoice[]>([]);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const pickerId = useId();
  const [pickerOpen, setPickerOpen] = useState(false);
  const phonePicker = useSyncExternalStore(subscribeToPhonePicker, getPhonePickerSnapshot, serverPhonePickerSnapshot);
  const backdropPressRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const radiusUpdateRef = useRef<number | null>(null);
  const currentSearch = searchParams.toString();

  useEffect(() => {
    if (!location.trim()) {
      return;
    }
    const controller = new AbortController();
    fetch(`/api/locations/cities?near=${encodeURIComponent(location)}&limit=8`, { signal: controller.signal })
      .then((response) => response.json())
      .then((data: { cities?: CityChoice[] }) => setNearby(data.cities ?? []))
      .catch((error: Error) => { if (error.name !== "AbortError") setNearby([]); });
    return () => controller.abort();
  }, [location]);

  const navigateToLocation = useCallback((nextLocation: string, nextRadius: number, replace = false, reload = false) => {
    if (!autoSubmitLocation && !autoSubmitRadius) return;
    const params = new URLSearchParams(currentSearch);
    if (nextLocation) params.set("location", nextLocation);
    else params.delete("location");
    params.set("radius", String(nextRadius));
    params.delete("showFilters");
    const anchor = pathname === "/" ? "#nearby-listings" : pathname === "/services" ? "#service-listings" : "";
    const href = `${pathname}?${params.toString()}${replace ? "" : anchor}`;
    if (reload) {
      window.location.replace(href);
      return;
    }
    if (replace) router.replace(href, { scroll: false });
    else router.push(href);
  }, [autoSubmitLocation, autoSubmitRadius, currentSearch, pathname, router]);

  const requestCurrentLocation = useCallback((replace = false, reload = false) => {
    if (!navigator.geolocation) {
      setMessage("Current location is not available in this browser.");
      return;
    }
    setLocating(true);
    setMessage("");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        fetch(`/api/locations/cities?lat=${coords.latitude}&lng=${coords.longitude}&limit=1`)
          .then((response) => response.json())
          .then((data: { cities?: CityChoice[] }) => {
            const closest = data.cities?.[0];
            if (!closest) throw new Error("No city found");
            setLocation(closest.label);
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ location: closest.label, radius }));
            setMessage(`Using your nearest city: ${closest.label}.`);
            navigateToLocation(closest.label, radius, replace, reload);
          })
          .catch(() => setMessage("We found your location but could not match it to a city. Search for your city instead."))
          .finally(() => setLocating(false));
      },
      () => {
        setLocating(false);
        setMessage("We could not access your location. Search for your city instead.");
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
    );
  }, [navigateToLocation, radius]);

  useEffect(() => {
    if (!restoreRemembered && !requestLocationOnFirstVisit) return;
    const timer = window.setTimeout(() => {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as { location?: string; radius?: number } | null;
        const hasLocationParameter = new URLSearchParams(currentSearch).has("location");
        if (saved?.location) {
          const savedRadius = isValidSearchRadius(saved.radius ?? Number.NaN) ? saved.radius! : initialRadius;
          setLocation(saved.location);
          setRadius(savedRadius);
          if (!hasLocationParameter) navigateToLocation(saved.location, savedRadius, true);
          return;
        }
        if (!hasLocationParameter && requestLocationOnFirstVisit && !localStorage.getItem(LOCATION_PROMPTED_KEY)) {
          localStorage.setItem(LOCATION_PROMPTED_KEY, "true");
          requestCurrentLocation(true, true);
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [currentSearch, initialRadius, navigateToLocation, requestCurrentLocation, requestLocationOnFirstVisit, restoreRemembered]);

  useEffect(() => () => {
    if (radiusUpdateRef.current) window.clearTimeout(radiusUpdateRef.current);
  }, []);

  const closePicker = useCallback((restoreFocus = true) => {
    if (dialogRef.current?.open) dialogRef.current.close();
    if (detailsRef.current) detailsRef.current.open = false;
    setPickerOpen(false);
    backdropPressRef.current = null;
    if (restoreFocus) detailsRef.current?.querySelector("summary")?.focus({ preventScroll: true });
  }, []);

  // A native modal lives in the browser top layer, outside the hero's
  // backdrop-filter and the sticky header's stacking context.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!phonePicker || !pickerOpen || !dialog || !detailsRef.current?.open) return;
    const viewport = window.visualViewport;
    const syncViewport = () => {
      dialog.style.setProperty("--location-viewport-top", `${viewport?.offsetTop ?? 0}px`);
      dialog.style.setProperty("--location-viewport-left", `${viewport?.offsetLeft ?? 0}px`);
      dialog.style.setProperty("--location-viewport-width", `${viewport?.width ?? document.documentElement.clientWidth}px`);
      dialog.style.setProperty("--location-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
    };

    syncViewport();
    viewport?.addEventListener("resize", syncViewport);
    viewport?.addEventListener("scroll", syncViewport);
    window.addEventListener("resize", syncViewport);
    if (!dialog.open) dialog.showModal();
    // Do not autofocus the city input: that would raise the software keyboard
    // before the user can see the current area and nearby choices.
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      viewport?.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("resize", syncViewport);
      if (dialog.open) dialog.close();
      backdropPressRef.current = null;
    };
  }, [phonePicker, pickerOpen]);

  useEffect(() => {
    function closeWhenClickingOutside(event: PointerEvent) {
      const details = detailsRef.current;
      if (dialogRef.current?.open || !details?.open || details.contains(event.target as Node)) return;
      closePicker(false);
    }

    function closeWithEscape(event: KeyboardEvent) {
      if (dialogRef.current?.open || event.key !== "Escape" || !detailsRef.current?.open) return;
      closePicker();
    }

    document.addEventListener("pointerdown", closeWhenClickingOutside);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenClickingOutside);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [closePicker]);

  function remember(nextLocation: string, nextRadius: number) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ location: nextLocation, radius: nextRadius }));
  }

  function changeRadius(nextRadius: number) {
    setRadius(nextRadius);
    if (!isValidSearchRadius(nextRadius)) return;
    remember(location, nextRadius);
    if (!autoSubmitRadius) return;
    if (radiusUpdateRef.current) window.clearTimeout(radiusUpdateRef.current);
    radiusUpdateRef.current = window.setTimeout(() => {
      navigateToLocation(location, nextRadius);
    }, 350);
  }

  function chooseLocation(nextLocation: string) {
    setLocation(nextLocation);
    remember(nextLocation, radius);
    setMessage("");
    closePicker();
    navigateToLocation(nextLocation, radius);
  }

  async function applyTypedLocation() {
    const typedLocation = location.trim();
    if (!typedLocation) return;
    if (!/^\d{5}(?:-\d{4})?$/.test(typedLocation)) {
      chooseLocation(typedLocation);
      return;
    }

    setResolving(true);
    setMessage("");
    try {
      const response = await fetch(`/api/locations/cities?q=${encodeURIComponent(typedLocation)}&limit=1`);
      const data = await response.json() as { resolvedLocation?: string };
      if (!response.ok || !data.resolvedLocation) {
        setMessage("We could not find that ZIP code. Check it and try again.");
        return;
      }
      chooseLocation(data.resolvedLocation);
      setMessage(`ZIP ${typedLocation.slice(0, 5)} matched to ${data.resolvedLocation}.`);
    } catch {
      setMessage("ZIP code lookup is temporarily unavailable. Try entering your city and state.");
    } finally {
      setResolving(false);
    }
  }

  function useCurrentLocation() {
    localStorage.setItem(LOCATION_PROMPTED_KEY, "true");
    requestCurrentLocation();
  }

  const pickerContents = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p id={`${pickerId}-title`} className="text-xs font-bold uppercase tracking-[.14em] text-[#718078]">Choose your area</p>
        {phonePicker && <button ref={closeButtonRef} type="button" aria-label="Close location picker" onClick={() => closePicker()} className="min-h-11 shrink-0 rounded-full border border-[#183126]/15 px-3 text-sm font-bold hover:bg-[#edf3e7]">Close</button>}
      </div>
      <label className="mt-4 block"><span className="sr-only">Enter city, state, or ZIP code</span><input value={location} onChange={(event) => { setLocation(event.target.value); setMessage(""); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void applyTypedLocation(); } }} placeholder="City, state, or ZIP code" inputMode="text" autoComplete="postal-code" className="w-full rounded-xl border border-[#183126]/15 bg-[#faf9f5] px-4 py-3 text-sm outline-none focus:border-[#4d725d]" /></label>
      <button type="button" onClick={useCurrentLocation} disabled={locating} className="mt-3 flex w-full items-center gap-2 rounded-xl border border-[#183126]/12 px-4 py-2.5 text-left text-sm font-bold transition hover:bg-[#edf3e7] disabled:opacity-60"><UiIcon name="locations" className="h-4 w-4" />{locating ? "Finding your city…" : "Use my current location"}</button>
      {message && <p className="mt-2 text-xs leading-5 text-[#6c7d74]">{message}</p>}
      <p className="mt-5 text-xs font-bold text-[#718078]">Nearby cities</p>
      <div className="mt-2 grid grid-cols-2 gap-2">{location.trim() && nearby.map((area) => <button key={area.label} type="button" onClick={() => chooseLocation(area.label)} className="rounded-xl px-3 py-2 text-left text-sm transition hover:bg-[#edf3e7]"><span className="block font-semibold">{area.city}</span><span className="text-[11px] text-[#7a8881]">{typeof area.distance === "number" ? `${Math.round(area.distance)} mi away` : area.state}</span></button>)}</div>
      <button type="button" disabled={!location.trim() || resolving} onClick={() => void applyTypedLocation()} className="location-apply-button mt-4 w-full rounded-xl bg-[#183126] px-4 py-3 text-sm font-bold text-white transition hover:bg-[#294b3c]">{resolving ? "Finding your area…" : "Use this area"}</button>
    </>
  );

  return (
    <div className="location-filter relative flex min-w-0 flex-col gap-2 sm:flex-row">
      <input type="hidden" name="location" value={location} />
      <details ref={detailsRef} onToggle={(event) => setPickerOpen(event.currentTarget.open)} className="location-filter-city group relative min-w-0 flex-1">
        <summary aria-haspopup={phonePicker ? "dialog" : undefined} aria-controls={phonePicker && !pickerOpen ? undefined : pickerId} className="flex min-h-12 list-none items-center gap-2 rounded-full px-4 text-left text-sm font-semibold transition hover:bg-[#edf3e7] [&::-webkit-details-marker]:hidden">
          <UiIcon name="map-pin" className="h-4 w-4 shrink-0 text-[#d64d78]" /><span className="min-w-0 flex-1 truncate">{location || "Choose your city"}</span><UiIcon name="chevron-down" className="h-4 w-4 shrink-0 text-[#76857d] transition group-open:rotate-180" />
        </summary>
        {phonePicker ? pickerOpen && <dialog
          id={pickerId}
          ref={dialogRef}
          aria-labelledby={`${pickerId}-title`}
          className="location-picker-sheet"
          onCancel={(event) => { event.preventDefault(); closePicker(); }}
          onPointerDown={(event) => {
            backdropPressRef.current = event.target === event.currentTarget ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
          }}
          onPointerMove={(event) => {
            const press = backdropPressRef.current;
            if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) backdropPressRef.current = null;
          }}
          onPointerCancel={() => { backdropPressRef.current = null; }}
          onPointerUp={(event) => {
            const press = backdropPressRef.current;
            if (event.target !== event.currentTarget || press?.id !== event.pointerId || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) backdropPressRef.current = null;
          }}
          onClick={(event) => {
            const wasBackdropTap = backdropPressRef.current !== null;
            backdropPressRef.current = null;
            if (wasBackdropTap && event.target === event.currentTarget) closePicker();
          }}
        >
          <div className="location-picker-scroll rounded-[1.5rem] border border-[#183126]/10 bg-white p-5 shadow-[0_20px_55px_rgba(24,49,38,.18)]">
            {pickerContents}
          </div>
        </dialog> : <div id={pickerId} className="relative mt-3 max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain rounded-[1.5rem] border border-[#183126]/10 bg-white p-5 shadow-[0_20px_55px_rgba(24,49,38,.18)] sm:absolute sm:inset-x-auto sm:left-0 sm:top-full sm:z-[80] sm:max-h-[min(38rem,calc(100dvh-7rem))] sm:w-[min(360px,calc(100vw-2.5rem))]">
          {pickerContents}
        </div>}
      </details>
      <div className="location-filter-radius flex min-h-12 items-center gap-2 rounded-full border border-[#183126]/10 px-4 text-sm"><span className="whitespace-nowrap text-xs font-bold text-[#6e7f76]">Within</span><RadiusSelector name="radius" value={radius} onChange={changeRadius} compact max={MAX_SEARCH_RADIUS_MILES} /></div>
    </div>
  );
}
