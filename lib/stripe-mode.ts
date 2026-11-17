/** Restricted keys use the same environment marker as standard secret keys. */
export function stripeKeyMode(key: string | undefined): "test" | "live" {
  return /^(sk|rk)_live_/.test(key ?? "") ? "live" : "test";
}
