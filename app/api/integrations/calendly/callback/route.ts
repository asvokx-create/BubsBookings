import { NextResponse } from "next/server";
import { completeCalendlyAuthorization } from "@/lib/calendly";
import { getProviderAccess } from "@/lib/provider-access";
import { recordActivity } from "@/lib/request-security";
import { publicRequestOrigin } from "@/lib/request-origin";

export async function GET(request: Request) {
  const access = await getProviderAccess();
  const publicOrigin = publicRequestOrigin(request);
  const destination = new URL("/provider/dashboard/calendar", publicOrigin);
  if (!access?.isOwner) return NextResponse.redirect(new URL("/login?redirect=/provider/dashboard/calendar", publicOrigin));
  const parameters = new URL(request.url).searchParams;
  const code = parameters.get("code") ?? "";
  const state = parameters.get("state") ?? "";
  if (parameters.get("error") || !code || !state) {
    destination.searchParams.set("calendly", "denied");
    return NextResponse.redirect(destination);
  }
  try {
    const result = await completeCalendlyAuthorization({ providerId: access.providerId, state, code });
    await recordActivity({ userId: access.session.user.id, action: "calendly_connected", targetType: "provider", targetId: access.providerId });
    destination.searchParams.set("calendly", result.syncSucceeded ? "connected" : "connected_sync_failed");
  } catch (error) {
    console.error("Calendly OAuth callback failed", { providerId: access.providerId, error });
    destination.searchParams.set("calendly", "failed");
  }
  return NextResponse.redirect(destination);
}
