const RETURN_HASH_PREFIX = "#return-to-listing-";
export const LISTING_RETURN_STATE = "bubsListingReturn";
export const LISTING_RETURN_HANDLED = "bubsListingReturnHandled";
const LISTING_DEPARTURE_KEY = "bubs-listing-return-visit-v1";
const URL_BASE = "https://marketplace.invalid";

type BrowserEntry = { key: string; index: number; url: string | null };
type BrowserNavigation = { currentEntry: BrowserEntry | null; entries(): BrowserEntry[] };

function browserNavigation() {
  return (window as Window & { navigation?: BrowserNavigation }).navigation;
}

export type ListingLinkKind = "title" | "image";
type ListingReturn = { slug: string; kind: ListingLinkKind; top: number; path: string; width: number; height: number };

function validSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9-]{1,180}$/.test(value);
}

export function marketplaceReturnPath(value: string | undefined, slug: string) {
  // Allow only the results routes, not arbitrary internal or external destinations.
  if (!value || !/^\/(?:services\/?(?=$|[?#])|(?=$|[?#]))/.test(value) || /[\\\x00-\x20\x7f]/.test(value)) return null;
  const url = new URL(value, URL_BASE);
  if (url.origin !== URL_BASE || !["/", "/services", "/services/"].includes(url.pathname)) return null;
  // showFilters opens a panel; it is not an applied filter and may be stale.
  if (url.searchParams.has("showFilters")) url.searchParams.delete("showFilters");
  return `/${url.search}${validSlug(slug) ? RETURN_HASH_PREFIX + slug : "#nearby-listings"}`;
}

export function listingSlugFromReturnHash(hash: string) {
  const slug = hash.startsWith(RETURN_HASH_PREFIX) ? hash.slice(RETURN_HASH_PREFIX.length) : null;
  return validSlug(slug) ? slug : null;
}

export function readListingReturn(value: unknown, path: string): ListingReturn | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ListingReturn>;
  return candidate.path === path && validSlug(candidate.slug) &&
    (candidate.kind === "title" || candidate.kind === "image") &&
    typeof candidate.top === "number" && Number.isFinite(candidate.top) &&
    typeof candidate.width === "number" && Number.isFinite(candidate.width) && candidate.width > 0 &&
    typeof candidate.height === "number" && Number.isFinite(candidate.height) && candidate.height > 0
    ? candidate as ListingReturn : null;
}

export function returnViewportTop(saved: { top: number; width: number; height: number } | null, width: number, height: number, linkHeight: number) {
  const minimum = 16;
  const maximum = Math.max(minimum, height - linkHeight - minimum);
  const preferred = saved && saved.width === width && saved.height === height ? saved.top : height / 3;
  return Math.min(maximum, Math.max(minimum, preferred));
}

function currentPath() {
  const { pathname, search } = window.location;
  return pathname + search;
}

export function recordListingDeparture(link: HTMLAnchorElement, slug: string, kind: ListingLinkKind) {
  if (window.location.pathname !== "/" || !validSlug(slug)) return;
  const path = currentPath();
  const departure: ListingReturn = {
    slug, kind, top: link.getBoundingClientRect().top, path: path + window.location.hash,
    width: window.innerWidth, height: window.innerHeight,
  };
  try {
    window.history.replaceState({ ...window.history.state, [LISTING_RETURN_STATE]: departure }, "");
  } catch {
    // The listing still opens when browser history state is unavailable.
  }
  try {
    const sourceKey = browserNavigation()?.currentEntry?.key;
    if (sourceKey) window.sessionStorage.setItem(LISTING_DEPARTURE_KEY, JSON.stringify({ from: path, to: link.pathname + link.search, sourceKey }));
  } catch {
    // The visible Back button can use its safe contextual fallback without storage.
  }
}

export function isRelatedListingDeparture(previous: string) {
  try {
    const visit = JSON.parse(window.sessionStorage.getItem(LISTING_DEPARTURE_KEY) ?? "null");
    if (visit?.from !== previous || visit?.to !== currentPath() || !visit?.sourceKey) return false;
    // The in-app path stack alone cannot prove what the browser will actually open.
    const navigation = browserNavigation();
    const index = navigation?.currentEntry?.index;
    if (!navigation || typeof index !== "number" || index < 1) return false;
    const entry = navigation.entries().find((candidate) => candidate.index === index - 1);
    if (!entry?.url || entry.key !== visit.sourceKey) return false;
    const prior = new URL(entry.url);
    return prior.origin === window.location.origin && prior.pathname + prior.search === previous;
  } catch {
    return false;
  }
}
