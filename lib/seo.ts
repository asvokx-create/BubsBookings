import type { Metadata } from "next";

export const SITE_ORIGIN = "https://bubsbookings.com";
const DEFAULT_SOCIAL_IMAGE = "/brand-logo.jpg";

export function absolutePublicUrl(pathname: string) {
  const normalizedPathname = pathname === "/" ? "/" : `/${pathname.replace(/^\/+|\/+$/g, "")}`;
  return normalizedPathname === "/" ? SITE_ORIGIN : new URL(normalizedPathname, SITE_ORIGIN).toString();
}

export function metadataDescription(parts: Array<string | null | undefined>, maxLength = 160) {
  const value = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (value.length <= maxLength) return value;
  const shortened = value.slice(0, Math.max(1, maxLength - 1));
  const wordBoundary = shortened.lastIndexOf(" ");
  return `${(wordBoundary >= Math.floor(maxLength * 0.7) ? shortened.slice(0, wordBoundary) : shortened).replace(/[,:;.!?\s]+$/g, "")}…`;
}

export function publicPageMetadata({
  title,
  description,
  pathname,
  image = DEFAULT_SOCIAL_IMAGE,
}: {
  title: string;
  description: string;
  pathname: string;
  image?: string;
}): Metadata {
  const canonical = absolutePublicUrl(pathname);
  const socialTitle = `${title} | BubsBookings`;

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      type: "website",
      siteName: "BubsBookings",
      url: canonical,
      title: socialTitle,
      description,
      images: [{ url: image, width: 1200, height: 1200, alt: socialTitle }],
    },
    twitter: { card: "summary", title: socialTitle, description, images: [image] },
  };
}
