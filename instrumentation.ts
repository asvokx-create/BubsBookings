const schedulerState = globalThis as typeof globalThis & {
  __bubsBookingsReminderTimer?: NodeJS.Timeout;
  __bubsBookingsMarketingTimer?: NodeJS.Timeout;
  __bubsBookingsCallTimer?: NodeJS.Timeout;
  __bubsBookingsCallRun?: boolean;
};

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;

  const requiredVariables = ["DATABASE_URL", "DATABASE_CA_CERT", "RESEND_API_KEY", "EMAIL_FROM"] as const;
  const missingVariables: string[] = requiredVariables.filter((key) => !process.env[key]?.trim());
  const authSecret = process.env.BETTER_AUTH_SECRET?.trim();
  if (!authSecret || authSecret.length < 32) missingVariables.push("BETTER_AUTH_SECRET");
  if (missingVariables.length > 0) {
    throw new Error(`Missing or invalid production configuration: ${missingVariables.join(", ")}`);
  }

  if (!process.env.DATABASE_URL || !process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return;

  if (!schedulerState.__bubsBookingsReminderTimer) {
    const { runBookingReminders } = await import("./lib/booking-reminders");
    const runReminders = () => {
      void runBookingReminders().catch((error) => console.error("Scheduled booking reminders failed", error));
    };
    const initialReminderRun = setTimeout(runReminders, 60_000);
    initialReminderRun.unref();
    schedulerState.__bubsBookingsReminderTimer = setInterval(runReminders, 10 * 60_000);
    schedulerState.__bubsBookingsReminderTimer.unref();
  }

  // New scheduling can be switched off without stopping cancellation/refund recovery.
  // Durable due-claims and per-call locks also protect multi-instance deployments.
  if ((process.env.CALENDLY_CALL_BOOKINGS_ENABLED === "true" || process.env.CALENDLY_CALL_RECOVERY_ENABLED === "true") && !schedulerState.__bubsBookingsCallTimer) {
    const { processDueCalendlyCalls } = await import("./lib/calendly-call-runtime");
    const runCalls = () => {
      if (schedulerState.__bubsBookingsCallRun) return;
      schedulerState.__bubsBookingsCallRun = true;
      void processDueCalendlyCalls().catch((error) => console.error("Scheduled call recovery failed", error))
        .finally(() => { schedulerState.__bubsBookingsCallRun = false; });
    };
    const initialCallRun = setTimeout(runCalls, 10_000);
    initialCallRun.unref();
    schedulerState.__bubsBookingsCallTimer = setInterval(runCalls, 30_000);
    schedulerState.__bubsBookingsCallTimer.unref();
  }

  if (!schedulerState.__bubsBookingsMarketingTimer) {
    const { runMarketingCampaignBatch } = await import("./lib/marketing-jobs");
    const runMarketing = () => {
      void runMarketingCampaignBatch().catch((error) => console.error("Scheduled marketing campaign delivery failed", error));
    };
    const initialMarketingRun = setTimeout(runMarketing, 90_000);
    initialMarketingRun.unref();
    schedulerState.__bubsBookingsMarketingTimer = setInterval(runMarketing, 5 * 60_000);
    schedulerState.__bubsBookingsMarketingTimer.unref();
  }
}
