export function checkoutReturnNotice(kind: "Payment" | "Tip", signal: string | null | undefined, status: string) {
  if (["paid", "refunded", "partially_refunded", "disputed"].includes(status)) return null;
  if (signal === "success") return `${kind} confirmation is not available yet. Check the latest status before making another payment.`;
  if (signal === "cancelled") return `You returned from ${kind.toLowerCase()} checkout. This does not confirm whether a payment was completed.`;
  return null;
}

export function canLeaveCheckoutReview(status: "unpaid" | "pending" | "paid" | "refunded" | "failed", returnSignal: string | null | undefined) {
  if (status === "failed" || status === "paid" || status === "refunded") return true;
  // For pending without a success hint, continuing uses the protected checkout
  // endpoint, which resumes an open session or refuses an unresolved payment.
  return returnSignal !== "success" && (status === "unpaid" || status === "pending");
}

export async function openBookingCheckout(request: () => Promise<Response>, navigate: (url: string) => void): Promise<{ redirected: boolean; error?: string }> {
  try {
    const response = await request();
    const result = await response.json() as { url?: unknown; error?: unknown } | null;
    if (!response.ok || typeof result?.url !== "string" || !result.url) {
      return { redirected: false, error: !response.ok && typeof result?.error === "string" ? result.error : undefined };
    }
    if (new URL(result.url).protocol !== "https:") return { redirected: false };
    navigate(result.url);
    return { redirected: true };
  } catch {
    return { redirected: false };
  }
}
