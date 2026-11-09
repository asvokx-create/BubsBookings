import "server-only";

import Stripe from "stripe";
import { stripeKeyMode } from "./stripe-mode";
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
