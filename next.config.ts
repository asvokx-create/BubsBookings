import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV === "development";
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""} https://www.googletagmanager.com https://privatusanalytics.com https://privatusstats.com`,
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://privatusanalytics.com https://privatusstats.com",
  "frame-src https://js.stripe.com https://hooks.stripe.com https://accounts.google.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDevelopment ? [] : ["upgrade-insecure-requests"]),
].join("; ");

function securityHeaders(microphone: "()" | "(self)") {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    { key: "Permissions-Policy", value: `camera=(), microphone=${microphone}, geolocation=${microphone === "(self)" ? "()" : "(self)"}, payment=${microphone === "(self)" ? "()" : "(self)"}, browsing-topics=()` },
    ...(isDevelopment ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]),
  ];
}

const nextConfig: NextConfig = {
  // A separate output directory lets CI and local verification builds run while
  // a development server is using the default .next directory.
  distDir: process.env.NEXT_DIST_DIR?.trim() || ".next",
  poweredByHeader: false,
  // Dynamic public pages obtain metadata from the marketplace at request time.
  // Disable metadata streaming so every crawler receives title, canonical, and
  // description elements in the document head rather than after the body starts.
  htmlLimitedBots: /.*/,
  async redirects() {
    return [{
      source: "/:path*",
      has: [{ type: "host", value: "www.bubsbookings.com" }],
      destination: "https://bubsbookings.com/:path*",
      permanent: true,
    }];
  },
  async headers() {
    return [
      {
        source: "/:path((?!admin/jarvis).*)",
        headers: securityHeaders("()"),
      },
      {
        source: "/admin/jarvis",
        headers: securityHeaders("(self)"),
      },
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
    ];
  },
};

export default nextConfig;
