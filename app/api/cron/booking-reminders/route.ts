import { NextResponse } from "next/server";
import { runBookingReminders } from "@/lib/booking-reminders";
import { releaseDuePayouts } from "@/lib/payment-release";
import { secureSecretMatches } from "@/lib/request-security";
import { generateDueRecurringBookings } from "@/lib/recurring-bookings";
import { expireRescheduleRequests } from "@/lib/booking-rescheduling";

export async function POST(request: Request) {
  const configuredSecret = process.env.CRON_SECRET;
  const suppliedSecret = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secureSecretMatches(configuredSecret, suppliedSecret)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const [reminders, payouts, recurring, reschedules] = await Promise.all([runBookingReminders(), releaseDuePayouts(), generateDueRecurringBookings(), expireRescheduleRequests()]);
  return NextResponse.json({ ok: true, reminders, payouts, recurring, reschedules });
}
