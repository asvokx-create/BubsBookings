import { NextResponse, type NextRequest } from "next/server";
import { AFFILIATE_COOKIE } from "@/lib/affiliates";
import { cookieValue, recordAffiliateRawClick, storeAffiliateAttribution } from "@/lib/affiliate-attribution-store";
import { shouldRecordAffiliateLanding } from "@/lib/affiliate-request";
import { enforceRateLimit, publicRequestRateLimitKey } from "@/lib/request-security";
import { publicSlugExists } from "@/lib/public-route-existence";
import { publicSlugRoute } from "@/lib/public-slug-route";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const JSON_BODY_LIMIT = 1024 * 1024;
const UPLOAD_BODY_LIMIT = 12 * 1024 * 1024;

function trustedOrigins(request: NextRequest) {
  const values = [
    request.nextUrl.origin,
    process.env.BETTER_AUTH_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    "https://bubsbookings.com",
    "https://www.bubsbookings.com",
    ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:3000", "http://localhost:3001"]),
  ];
  return new Set(values.filter((value): value is string => Boolean(value)).map((value) => {
    try { return new URL(value).origin; } catch { return ""; }
  }).filter(Boolean));
}

function isUploadPath(pathname: string) {
  return pathname === "/api/account/profile-photo"
    || pathname === "/api/providers/customer-imports"
    || pathname === "/api/providers/profile/portfolio"
    || /^\/api\/providers\/services\/[^/]+\/images$/.test(pathname);
}

export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/404") return NextResponse.next({ status: 404 });

  if (!SAFE_METHODS.has(request.method)) {
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite === "cross-site") {
      return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
    }

    const origin = request.headers.get("origin");
    if (origin) {
      let normalizedOrigin = "";
      try { normalizedOrigin = new URL(origin).origin; } catch { /* Invalid origins are rejected below. */ }
      if (!normalizedOrigin || !trustedOrigins(request).has(normalizedOrigin)) {
        return NextResponse.json({ error: "This request did not come from BubsBookings." }, { status: 403 });
      }
    }

    const contentLengthHeader = request.headers.get("content-length");
    if (contentLengthHeader) {
      const contentLength = Number(contentLengthHeader);
      const maximumBytes = isUploadPath(request.nextUrl.pathname) ? UPLOAD_BODY_LIMIT : JSON_BODY_LIMIT;
      if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maximumBytes) {
        return NextResponse.json({ error: "The request is too large." }, { status: 413 });
      }
    }
  }

  if (request.method === "GET" || request.method === "HEAD") {
    const publicRoute = publicSlugRoute(request.nextUrl.pathname);
    const isOwnerPreview = publicRoute?.kind === "providers" && request.nextUrl.searchParams.get("preview") === "owner";
    if (publicRoute && !isOwnerPreview && await publicSlugExists(publicRoute.kind, publicRoute.slug) === false) {
      const notFoundUrl = request.nextUrl.clone();
      notFoundUrl.pathname = "/404";
      notFoundUrl.search = "";
      const response = NextResponse.rewrite(notFoundUrl, { status: 404 });
      response.headers.set("Cache-Control", "private, no-store, max-age=0");
      return response;
    }
  }

  if (shouldRecordAffiliateLanding(request)) {
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "private, no-store");
    try {
      const allowed = await enforceRateLimit({
        request,
        userId: publicRequestRateLimitKey(request),
        bucket: "affiliate-landing",
        limit: 60,
      });
      if (!allowed) return response;

      try {
        await recordAffiliateRawClick({
          code: request.nextUrl.searchParams.get("ref"),
          landingPath: `${request.nextUrl.pathname}${request.nextUrl.search}`,
          utmSource: request.nextUrl.searchParams.get("utm_source"),
          utmMedium: request.nextUrl.searchParams.get("utm_medium"),
          utmCampaign: request.nextUrl.searchParams.get("utm_campaign"),
          utmContent: request.nextUrl.searchParams.get("utm_content"),
          utmTerm: request.nextUrl.searchParams.get("utm_term"),
          userAgent: request.headers.get("user-agent"),
        });
      } catch (error) {
        console.error("Affiliate raw click recording failed", error instanceof Error ? error.message : "Unknown error");
      }

      const result = await storeAffiliateAttribution({
        code: request.nextUrl.searchParams.get("ref"),
        landingPath: `${request.nextUrl.pathname}${request.nextUrl.search}`,
        utmSource: request.nextUrl.searchParams.get("utm_source"),
        utmMedium: request.nextUrl.searchParams.get("utm_medium"),
        utmCampaign: request.nextUrl.searchParams.get("utm_campaign"),
        utmContent: request.nextUrl.searchParams.get("utm_content"),
        utmTerm: request.nextUrl.searchParams.get("utm_term"),
        userAgent: request.headers.get("user-agent"),
        savedToken: cookieValue(request.headers.get("cookie"), AFFILIATE_COOKIE),
      });
      if (result.status === "created") {
        response.cookies.set(AFFILIATE_COOKIE, result.token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: result.maxAge,
        });
      }
    } catch (error) {
      console.error("Affiliate landing attribution failed", error instanceof Error ? error.message : "Unknown error");
    }
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/404", "/api/:path*", "/providers/:path*", "/services/:path*", "/companies/:path*"],
};
