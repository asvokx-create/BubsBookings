import "server-only";

import Stripe from "stripe";
import { stripeKeyMode } from "./stripe-mode";
import { identityResultsKey } from "./stripe-identity-config";
let stripeClient: Stripe | null = null;

export function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not configured.");
  stripeClient ??= new Stripe(secretKey, { timeout: 15_000, maxNetworkRetries: 1 });
  return stripeClient;
}

export function getStripeMode(): "test" | "live" {
  return stripeKeyMode(process.env.STRIPE_SECRET_KEY);
}

export function stripeConfiguration() {
  return {
    secretKey: Boolean(process.env.STRIPE_SECRET_KEY),
    webhookSecret: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
  };
}

export function isStripeReady() {
  return Object.values(stripeConfiguration()).every(Boolean);
}

// Only this dedicated, least-privilege reader may request sensitive age results.
// Do not replace the payments key or log this key or returned identity data.
export function getStripeIdentityResults() {
  const key = identityResultsKey(process.env.STRIPE_IDENTITY_RESTRICTED_KEY, getStripeMode());
  return new Stripe(key, { timeout: 15_000, maxNetworkRetries: 1 });
}
