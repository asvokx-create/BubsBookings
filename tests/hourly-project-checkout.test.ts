import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { hourlyCheckoutDecision } from "../lib/hourly-checkout-policy.ts";

test("hourly checkout reuses open unpaid sessions and replaces only expired unpaid sessions", () => {
  assert.equal(hourlyCheckoutDecision({status:"open",payment_status:"unpaid",url:"https://checkout.stripe.com/test"}),"reuse");
  assert.equal(hourlyCheckoutDecision({status:"expired",payment_status:"unpaid",url:null}),"replace");
  for (const status of ["complete",null]) assert.equal(hourlyCheckoutDecision({status,payment_status:"unpaid",url:null}),"blocked");
  for (const status of ["open","expired","complete"]) assert.equal(hourlyCheckoutDecision({status,payment_status:"paid",url:null}),"blocked");
});
test("hourly approval persists one settlement and attempt before external payment creation", () => {
  const source = readFileSync(new URL("../lib/hourly-project-checkout.ts", import.meta.url),"utf8");
  assert.match(source,/pg_advisory_xact_lock/);
  assert.match(source,/project.version !== input.version/);
  assert.match(source,/FOR UPDATE OF h/);
  assert.match(source,/if \(!project.payment_booking_id\)/);
  assert.ok(source.indexOf('await client.query("COMMIT")', source.indexOf('INSERT INTO hourly_project_checkout_attempts')) < source.indexOf('stripe.checkout.sessions.create'));
  assert.match(source,/23 \* 60 \* 60 \* 1000/);
  assert.match(source,/idempotencyKey: `hourly-project-checkout-\$\{mode\}-\$\{attempt.id\}`/);
  assert.doesNotMatch(source,/payment_method_types|transfers.create/);
});
test("settlements cannot bypass approval via ordinary booking checkout and events hold payouts", () => {
  const route = readFileSync(new URL("../app/api/stripe/bookings/[bookingId]/checkout/route.ts", import.meta.url),"utf8");
  assert.match(route,/WHERE payment_booking_id::text=\$1/);
  const webhook = readFileSync(new URL("../app/api/stripe/webhook/route.ts", import.meta.url),"utf8");
  assert.match(webhook,/checkout.payment_status !== "paid"/);
  assert.match(webhook,/project.stripe_checkout_session_id !== checkout.id/);
  assert.match(webhook,/status = 'completed' THEN 'awaiting_customer'/);
  assert.match(webhook,/now\(\) \+ interval '48 hours'/);
});
