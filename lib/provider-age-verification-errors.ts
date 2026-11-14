import { IDENTITY_RESULTS_UNAVAILABLE } from "./stripe-identity-config.ts";

export const STRIPE_IDENTITY_SETUP_REQUIRED = "identity_api_invalid_application";

export function providerAgeVerificationError(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;

  if (code === IDENTITY_RESULTS_UNAVAILABLE) {
    return { code, status: 503, message: "BubsBookings could not finish reading your age-verification result. Please contact support; you do not need to upload your ID again right now." };
  }

  if (code === STRIPE_IDENTITY_SETUP_REQUIRED) {
    return {
      code,
      status: 503,
      message: "Stripe Identity could not start for this deployment. BubsBookings has been notified. Please try again later.",
    };
  }

  return {
    code,
    status: 502,
    message: "We could not open Stripe age verification. Please try again in a moment.",
  };
}
