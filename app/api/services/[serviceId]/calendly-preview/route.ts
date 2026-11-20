import { NextResponse } from "next/server";
import { calendlyAvailabilityPreviewEnabled, getPublicCalendlyPreview } from "@/lib/calendly-service-preview";
import { enforceRateLimit, publicRequestRateLimitKey } from "@/lib/request-security";

const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request, context: RouteContext<"/api/services/[serviceId]/calendly-preview">) {
  if (!calendlyAvailabilityPreviewEnabled()) return NextResponse.json({ error: "Preview unavailable." }, { status: 404, headers });
  if (!await enforceRateLimit({ request, userId: publicRequestRateLimitKey(request), bucket: "public_calendly_preview", limit: 10 })) {
    return NextResponse.json({ error: "Please wait a minute before checking times again." }, { status: 429, headers });
  }
  const { serviceId } = await context.params;
  try {
    const preview = await getPublicCalendlyPreview(serviceId, request);
    return preview ? NextResponse.json(preview, { headers }) : NextResponse.json({ error: "Preview unavailable." }, { status: 404, headers });
  } catch {
    // Do not leak credentials, account details, event details, or upstream diagnostics.
    // An upstream outage is not an empty calendar and must not show stale slots.
    return NextResponse.json({ error: "Calendly availability could not be verified. Please try again later. No meeting has been reserved." }, { status: 503, headers });
  }
}
