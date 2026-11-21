"use client";

import { useEffect } from "react";
import { LISTING_RETURN_HANDLED, LISTING_RETURN_STATE, listingSlugFromReturnHash, readListingReturn, returnViewportTop } from "@/lib/listing-return";

function visible(element: HTMLElement | null | undefined): element is HTMLElement {
  return Boolean(element && element.getClientRects().length && !element.closest("[hidden],[inert],[aria-hidden=true]") &&
    (element.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? getComputedStyle(element).visibility === "visible"));
}

export default function ListingResultsReturn({ resultsPath }: { resultsPath: string }) {
  useEffect(() => {
    let beforePaint = 0;
    let afterPaint = 0;

    function restore() {
      const path = window.location.pathname + window.location.search;
      const hash = window.location.hash;
      const state = window.history.state;
      const saved = readListingReturn(state?.[LISTING_RETURN_STATE], path + hash);
      const fallbackSlug = state?.[LISTING_RETURN_HANDLED] !== hash && listingSlugFromReturnHash(hash);
      if (!saved && !fallbackSlug) return;

      cancelAnimationFrame(beforePaint);
      cancelAnimationFrame(afterPaint);
      // Run after the result list and router/browser scroll management have committed.
      beforePaint = requestAnimationFrame(() => {
        afterPaint = requestAnimationFrame(() => {
          if (window.location.pathname + window.location.search !== path || window.location.hash !== hash) return;
          const section = document.getElementById("nearby-listings");
          const heading = document.getElementById("featured-services-heading");
          if (!section || !heading) return;
          const card = Array.from(section.querySelectorAll<HTMLElement>("[data-listing-return-card]"))
            .find((item) => item.dataset.listingReturnCard === (saved?.slug ?? fallbackSlug));
          const link = card?.querySelector<HTMLElement>(`[data-listing-return-link="${saved?.kind ?? "title"}"]`);
          const active = document.activeElement;

          try {
            const next: Record<string, unknown> = { ...window.history.state, [LISTING_RETURN_HANDLED]: hash };
            delete next[LISTING_RETURN_STATE];
            window.history.replaceState(next, "");
          } catch {
            // Scroll and focus for this one return still work without history writes.
          }
          // Never pull focus away if the person has already focused a different control.
          if (active && active !== document.body && active !== document.documentElement && active !== link && active !== heading) return;

          // The site starts this section at opacity 0 with a delayed, moving
          // entrance. Finish only that decorative animation on a listing return.
          for (const animation of section.getAnimations?.() ?? []) {
            if ("animationName" in animation && animation.animationName === "page-enter" && animation.playState !== "finished") {
              animation.finish();
            }
          }
          if (!visible(heading)) return;
          const target = visible(link) ? link : heading;
          // Browser Back retains the original URL; a stale showFilters=1 can
          // replay the fixed filter sheet even though it was closed before leaving.
          const filters = section.querySelector<HTMLDetailsElement>("details[data-marketplace-filters]");
          if (filters?.open) filters.open = false;
          const rect = target.getBoundingClientRect();
          const top = target === heading ? 24 : returnViewportTop(saved, window.innerWidth, window.innerHeight, rect.height);
          target.focus({ preventScroll: true });
          window.scrollBy({ top: rect.top - top, behavior: "instant" });
        });
      });
    }

    restore();
    window.addEventListener("pageshow", restore);
    return () => {
      window.removeEventListener("pageshow", restore);
      cancelAnimationFrame(beforePaint);
      cancelAnimationFrame(afterPaint);
    };
  }, [resultsPath]);
  return null;
}
