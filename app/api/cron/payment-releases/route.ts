import { NextResponse } from "next/server";
import { releaseDuePayouts } from "@/lib/payment-release";
import { secureSecretMatches } from "@/lib/request-security";
import { advanceAffiliateCommissions } from "@/lib/affiliates";
import { runAutomatedAffiliatePayouts, runProtectedOwnerPayout } from "@/lib/affiliate-payouts";
import { processAffiliateMilestoneEmails, reconcileAffiliateMilestones } from "@/lib/affiliate-milestones";
import { expireStaleJobRequests, processJobRequestNotificationQueue } from "@/lib/job-request-operations";
import { reconcileExpiredComplimentaryProGrants } from "@/lib/complimentary-pro";

export async function POST(request: Request) {
  const configuredSecret = process.env.CRON_SECRET;
  const suppliedSecret = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secureSecretMatches(configuredSecret, suppliedSecret)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const calendlyCalls = process.env.CALENDLY_CALL_BOOKINGS_ENABLED === "true" || process.env.CALENDLY_CALL_RECOVERY_ENABLED === "true"
    ? await (await import("@/lib/calendly-call-runtime")).processDueCalendlyCalls() : undefined;
  const releases = await releaseDuePayouts();
  const affiliateCommissionsAdvanced = await advanceAffiliateCommissions();
  const affiliateMilestones = await reconcileAffiliateMilestones();
  const affiliateMilestoneEmails = await processAffiliateMilestoneEmails();
  const affiliatePayouts = await runAutomatedAffiliatePayouts();
  const ownerPayout = await runProtectedOwnerPayout();
  const expiredRequests = await expireStaleJobRequests();
  const requestNotifications = await processJobRequestNotificationQueue();
  const complimentaryPro = await reconcileExpiredComplimentaryProGrants();
  return NextResponse.json({ ok: true, calendlyCalls, ...releases, affiliateCommissionsAdvanced, affiliateMilestones, affiliateMilestoneEmails, affiliatePayouts, ownerPayout, ...expiredRequests, ...requestNotifications, ...complimentaryPro });
}
