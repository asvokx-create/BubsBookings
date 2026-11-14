export const IDENTITY_RESULTS_UNAVAILABLE = "identity_results_unavailable";

export function identityResultsError() {
  return Object.assign(new Error("Stripe Identity age results are temporarily unavailable."), { code: IDENTITY_RESULTS_UNAVAILABLE });
}

export function identityResultsKey(key: string | undefined, mode: "test" | "live") {
  if (!key || !key.startsWith(`rk_${mode}_`)) throw identityResultsError();
  return key;
}
