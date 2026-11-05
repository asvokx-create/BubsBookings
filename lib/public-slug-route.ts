export type PublicSlugRouteKind = "services" | "providers" | "companies";

export function publicSlugRoute(pathname: string): { kind: PublicSlugRouteKind; slug: string } | null {
  const match = /^\/(services|providers|companies)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;

  const kind = match[1] as PublicSlugRouteKind;
  const slug = match[2];
  if (kind === "providers" && slug === "join") return null;
  return { kind, slug };
}
