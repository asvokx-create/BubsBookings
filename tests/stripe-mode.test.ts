import test from "node:test";
import assert from "node:assert/strict";
import { stripeKeyMode } from "../lib/stripe-mode.ts";
test("Stripe mode recognizes restricted and standard live keys",()=>{
  for(const key of ["sk_live_example","rk_live_example"]) assert.equal(stripeKeyMode(key),"live");
  for(const key of ["sk_test_example","rk_test_example",undefined,""]) assert.equal(stripeKeyMode(key),"test");
});
