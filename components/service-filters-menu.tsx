"use client";

import { useEffect, useRef, type ReactNode } from "react";
import UiIcon from "@/components/ui-icon";

export default function ServiceFiltersMenu({
  initiallyOpen,
  children,
}: {
  initiallyOpen: boolean;
  children: ReactNode;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function closeWhenClickingOutside(event: PointerEvent) {
      const details = detailsRef.current;
      if (!details?.open || details.contains(event.target as Node)) return;
      details.open = false;
    }

    function closeWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || !detailsRef.current?.open) return;
      detailsRef.current.open = false;
      detailsRef.current.querySelector("summary")?.focus();
    }

    document.addEventListener("pointerdown", closeWhenClickingOutside);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenClickingOutside);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, []);

  return (
    <details ref={detailsRef} data-marketplace-filters open={initiallyOpen} className="group shrink-0">
      {children}
      <button type="button" aria-label="Close filters" onClick={() => { if (detailsRef.current) detailsRef.current.open = false; }} className="fixed right-6 top-6 z-[130] hidden h-11 w-11 place-items-center rounded-full border border-[#183126]/15 bg-white shadow-lg group-open:grid sm:group-open:hidden"><UiIcon name="close" className="h-5 w-5" /></button>
    </details>
  );
}
