"use client";

import Link from "next/link";

type SignupMethod = "email" | "google" | "unknown";
export type SignupFailureCategory = "age_eligibility" | "agreement" | "location" | "validation" | "account_exists" | "rate_limited" | "oauth" | "network" | "authentication" | "unknown";

async function record(eventName: "signup_clicked" | "signup_started" | "signup_submitted" | "signup_failed", details: { authMethod?: SignupMethod; failureCategory?: SignupFailureCategory } = {}) {
  const send = () => fetch("/api/affiliates/funnel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    keepalive: true,
    body: JSON.stringify({ eventName, ...details }),
  });
  try {
    const response = await send();
    const result = await response.json().catch(() => null) as { ignored?: boolean } | null;
    if (result?.ignored && eventName === "signup_started") {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await send().catch(() => undefined);
    }
  } catch {
    // Funnel diagnostics must never block account creation.
  }
}

export function ProviderSignupButton({ href, compact = false }: { href: string; compact?: boolean }) {
  return <Link href={href} onClick={() => { void record("signup_clicked"); }}
    className={compact
      ? "inline-flex min-h-11 items-center justify-center rounded-full bg-[#eee25a] px-5 py-3 text-sm font-bold text-[#183126]"
      : "mt-7 flex min-h-12 w-full items-center justify-center rounded-full bg-[#eee25a] px-6 py-3.5 font-bold text-[#183126]"}>
    Create provider account
  </Link>;
}

export function recordProviderSignupStarted() {
  void record("signup_started");
}

export async function recordProviderSignupSubmitted(authMethod: Exclude<SignupMethod, "unknown">) {
  await Promise.race([
    record("signup_submitted", { authMethod }),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

export function recordProviderSignupFailed(authMethod: SignupMethod, failureCategory: SignupFailureCategory) {
  void record("signup_failed", { authMethod, failureCategory });
}

export function signupFailureCategory(error: unknown): SignupFailureCategory {
  const value = typeof error === "string" ? error : error && typeof error === "object" && "message" in error ? String(error.message) : "";
  const lower = value.toLowerCase();
  if (/already|exists|registered/.test(lower)) return "account_exists";
  if (/rate|too many|limit/.test(lower)) return "rate_limited";
  if (/oauth|google|provider/.test(lower)) return "oauth";
  return "authentication";
}

export function recordProviderOnboardingStarted() {
  void fetch("/api/affiliates/funnel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    keepalive: true,
    body: JSON.stringify({ eventName: "onboarding_started" }),
  }).catch(() => undefined);
}
