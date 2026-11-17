import type { SVGProps } from "react";

export type UiIconName =
  | "projects" | "overview" | "bookings" | "opportunities" | "calendar" | "messages" | "revenue"
  | "services" | "profile" | "marketing" | "locations" | "availability" | "reviews"
  | "team" | "customers" | "billing" | "settings" | "close" | "arrow-left" | "arrow-right"
  | "external-link" | "chevron-left" | "chevron-right" | "chevron-down" | "refresh"
  | "menu" | "bell" | "check" | "x-circle" | "star" | "mail" | "lock"
  | "map-pin" | "card" | "flag" | "plus" | "copy" | "share" | "trash"
  | "camera" | "clock" | "search" | "globe" | "shield" | "more" | "sun"
  | "moon" | "monitor" | "upload" | "alert" | "info";

type Props = Omit<SVGProps<SVGSVGElement>, "name"> & {
  name: UiIconName;
  filled?: boolean;
};

export default function UiIcon({ name, className = "h-4 w-4", filled = false, ...props }: Props) {
  let glyph;
  switch (name) {
    case "overview": glyph = <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>; break;
    case "bookings": glyph = <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18M8.5 15.5l2 2 4-4"/></>; break;
    case "opportunities": glyph = <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></>; break;
    case "calendar": glyph = <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18M7 14h2M11 14h2M15 14h2M7 18h2M11 18h2"/></>; break;
    case "messages": glyph = <path d="M21 12a8 8 0 0 1-8 8H6l-4 2 1.5-4A8.5 8.5 0 1 1 21 12Z"/>; break;
    case "revenue": glyph = <><path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/></>; break;
    case "services": glyph = <><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M9 6V4h6v2M3 11h18M10 11v2h4v-2"/></>; break;
    case "profile": glyph = <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="9" r="3"/><path d="M6.8 19a5.5 5.5 0 0 1 10.4 0"/></>; break;
    case "marketing": glyph = <><path d="M4 13v-2l12-5v12L4 13Z"/><path d="M16 10.5a3 3 0 0 1 0 3M7 14l1.5 5h3L10 13"/></>; break;
    case "locations": case "map-pin": glyph = <><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>; break;
    case "projects": case "availability": case "clock": glyph = <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></>; break;
    case "reviews": case "star": glyph = <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/>; break;
    case "team": case "customers": glyph = <><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0M14 15a4.5 4.5 0 0 1 6.5 4"/></>; break;
    case "billing": case "card": glyph = <><rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19M6 15h4"/></>; break;
    case "settings": glyph = <><path d="M4 6h5M13 6h7M4 12h9M17 12h3M4 18h2M10 18h10"/><circle cx="11" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/></>; break;
    case "close": glyph = <path d="m6 6 12 12M18 6 6 18"/>; break;
    case "arrow-left": glyph = <><path d="m15 18-6-6 6-6"/><path d="M9 12h11"/></>; break;
    case "arrow-right": glyph = <><path d="m9 18 6-6-6-6"/><path d="M4 12h11"/></>; break;
    case "external-link": glyph = <><path d="M14 4h6v6M20 4l-9 9"/><path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5"/></>; break;
    case "chevron-left": glyph = <path d="m15 18-6-6 6-6"/>; break;
    case "chevron-right": glyph = <path d="m9 18 6-6-6-6"/>; break;
    case "chevron-down": glyph = <path d="m6 9 6 6 6-6"/>; break;
    case "refresh": glyph = <><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2 5"/></>; break;
    case "menu": glyph = <path d="M4 7h16M4 12h16M4 17h16"/>; break;
    case "bell": glyph = <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>; break;
    case "check": glyph = <path d="m5 12 4 4L19 6"/>; break;
    case "x-circle": glyph = <><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></>; break;
    case "mail": glyph = <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></>; break;
    case "lock": glyph = <><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>; break;
    case "flag": glyph = <><path d="M5 21V4"/><path d="M5 5h11l-2 4 2 4H5"/></>; break;
    case "plus": glyph = <path d="M12 5v14M5 12h14"/>; break;
    case "copy": glyph = <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></>; break;
    case "share": glyph = <><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5"/></>; break;
    case "trash": glyph = <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></>; break;
    case "camera": glyph = <><path d="M4 7h4l2-2h4l2 2h4v12H4Z"/><circle cx="12" cy="13" r="4"/></>; break;
    case "search": glyph = <><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></>; break;
    case "globe": glyph = <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></>; break;
    case "shield": glyph = <><path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6Z"/><path d="m9 12 2 2 4-4"/></>; break;
    case "more": glyph = <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>; break;
    case "sun": glyph = <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>; break;
    case "moon": glyph = <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>; break;
    case "monitor": glyph = <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></>; break;
    case "upload": glyph = <><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 15v5h16v-5"/></>; break;
    case "alert": glyph = <><path d="M12 3 2.5 20h19Z"/><path d="M12 9v5M12 17h.01"/></>; break;
    case "info": glyph = <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>; break;
  }
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} focusable="false" {...props}>{glyph}</svg>;
}
