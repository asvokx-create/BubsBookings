import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { AGE_CONFIRMATION_REQUIRED_MESSAGE, hasConfirmedAge } from "@/lib/account-age";
import { isStripeReady } from "@/lib/stripe";
import { enforceRateLimit } from "@/lib/request-security";
import { hasTrustedRequestOrigin, publicRequestOrigin } from "@/lib/request-origin";
import { checkoutHourlyProject, HourlyPaymentError } from "@/lib/hourly-project-checkout";

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Log in to approve and pay." }, { status: 401 });
  if (!hasTrustedRequestOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  if (!await hasConfirmedAge(session.user.id)) return NextResponse.json({ error: AGE_CONFIRMATION_REQUIRED_MESSAGE }, { status: 403 });
  if (!isStripeReady()) return NextResponse.json({ error: "Stripe payments are not available yet." }, { status: 503 });
  if (!await enforceRateLimit({ request, userId: session.user.id, bucket: "hourly-project-checkout", limit: 8 })) return NextResponse.json({ error: "Too many attempts. Please wait." }, { status: 429 });
  const body = await request.json().catch(() => null);
  if (!Number.isSafeInteger(body?.version) || body.version < 1) return NextResponse.json({ error: "A reviewed timesheet version is required." }, { status: 400 });
  try {
    const { projectId } = await context.params;
    return NextResponse.json(await checkoutHourlyProject({ projectId, version: body.version, user: session.user, origin: publicRequestOrigin(request) }));
  } catch (error) {
    if (error instanceof HourlyPaymentError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("Hourly project checkout failed", error);
    return NextResponse.json({ error: "Unable to open checkout. Retry safely from this project." }, { status: 503 });
  }
}
