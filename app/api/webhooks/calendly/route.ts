import { NextResponse } from "next/server";
import { processCalendlyWebhook, verifyCalendlyWebhook } from "@/lib/calendly";

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (!verifyCalendlyWebhook(rawBody, request.headers.get("calendly-webhook-signature"))) {
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 401 });
  }
  try {
    const result = await processCalendlyWebhook(rawBody);
    if (process.env.CALENDLY_CALL_BOOKINGS_ENABLED === "true" || process.env.CALENDLY_CALL_RECOVERY_ENABLED === "true") await (await import("@/lib/calendly-call-runtime")).wakeCallsForCalendlyEvent(rawBody);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("Calendly webhook processing failed", error);
    return NextResponse.json({ error: "Webhook processing failed." }, { status: 500 });
  }
}
