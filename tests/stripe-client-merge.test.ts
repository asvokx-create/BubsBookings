import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { stripeKeyMode } from "../lib/stripe-mode.ts";
import { identityResultsKey } from "../lib/stripe-identity-config.ts";

function clients(paymentKey: string, identityKey: string) {
  const created: string[] = [];
  class Stripe {
    constructor(key: string) { created.push(key); }
  }
  const modules: Record<string, unknown> = {
    "server-only": {}, stripe: Stripe,
    "./stripe-mode": { stripeKeyMode },
    "./stripe-identity-config": { identityResultsKey },
  };
  const output = ts.transpileModule(readFileSync("lib/stripe.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const context = {
    exports: {} as Record<string, () => unknown>,
    require: (id: string) => { if (!(id in modules)) throw Error(id); return modules[id]; },
    process: { env: { STRIPE_SECRET_KEY: paymentKey, STRIPE_IDENTITY_RESTRICTED_KEY: identityKey } },
  };
  vm.runInNewContext(output, context);
  return { api: context.exports, created };
}

test("combined Stripe clients keep restricted payment mode and dedicated identity access separate", () => {
  for (const mode of ["test", "live"]) {
    const h = clients(`rk_${mode}_synthetic_payments`, `rk_${mode}_synthetic_identity`);
    assert.equal(h.api.getStripeMode(), mode);
    h.api.getStripe();
    h.api.getStripeIdentityResults();
    assert.deepEqual(h.created, [`rk_${mode}_synthetic_payments`, `rk_${mode}_synthetic_identity`]);
  }
});

test("combined Stripe clients reject cross-mode identity keys without changing the payments client", () => {
  const h = clients("rk_test_synthetic_payments", "rk_live_synthetic_identity");
  assert.throws(() => h.api.getStripeIdentityResults(), /temporarily unavailable/);
  assert.deepEqual(h.created, []);
  h.api.getStripe();
  assert.deepEqual(h.created, ["rk_test_synthetic_payments"]);
});
