/** A complete Checkout may have a delayed payment in flight. Never replace it. */
export function hourlyCheckoutDecision(session: { status: string | null; payment_status: string; url: string | null }) {
  if (session.payment_status !== "unpaid") return "blocked" as const;
  if (session.status === "expired") return "replace" as const;
  if (session.status === "open" && session.url) return "reuse" as const;
  return "blocked" as const;
}
