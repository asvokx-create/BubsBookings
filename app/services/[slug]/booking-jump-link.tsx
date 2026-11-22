"use client";

import type { MouseEvent } from "react";

const targetId = "listing-booking";

export default function BookingJumpLink({ quoteOnly }: { quoteOnly: boolean }) {
  function goToBooking(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const booking = document.getElementById(targetId);
    if (!booking) return;

    // Keep the listing's Back to results history intact when jumping within the page.
    event.preventDefault();
    booking.focus({ preventScroll: true });
    booking.scrollIntoView({ block: "start", behavior: "instant" });
  }

  return <a href={"#" + targetId} onClick={goToBooking} className="inline-flex min-h-11 items-center justify-center rounded-full bg-[#eee25a] px-4 py-2 font-bold text-[#183126] hover:bg-[#f5ea6b] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--marketplace-control-focus)] lg:hidden">{quoteOnly ? "Go to quote request" : "Go to booking"}</a>;
}
