import { processListingActiveEmailQueue } from "@/lib/listing-active-email";
import { NextResponse } from "next/server";
import { processProviderWelcomeEmailQueue, reconcileProviderWelcomeEmailDeliveries } from "@/lib/provider-welcome-email";
import { secureSecretMatches } from "@/lib/request-security";

export async function POST(request: Request) {
  const configuredSecret = process.env.CRON_SECRET;
  const suppliedSecret = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secureSecretMatches(configuredSecret, suppliedSecret)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const result = await processProviderWelcomeEmailQueue();
  const listingActive = await processListingActiveEmailQueue();
  const reconciliation = await reconcileProviderWelcomeEmailDeliveries();
  return NextResponse.json({ ok: true, ...result, ...reconciliation, ...listingActive });
}
