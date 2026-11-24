import assert from "node:assert/strict";
import { test } from "node:test";
import { canLeaveCheckoutReview, checkoutReturnNotice, openBookingCheckout } from "../lib/booking-checkout-feedback.ts";

test("canonical settled payment or tip overrides stale return flags", () => {
  for (const kind of ["Payment", "Tip"] as const) {
    for (const status of ["paid", "refunded", "partially_refunded", "disputed"]) {
      assert.equal(checkoutReturnNotice(kind, "cancelled", status), null);
      assert.equal(checkoutReturnNotice(kind, "success", status), null);
    }
    for (const status of ["pending", "unpaid", "failed", "none"]) {
      assert.match(checkoutReturnNotice(kind, "cancelled", status) ?? "", /does not confirm/);
      assert.match(checkoutReturnNotice(kind, "success", status) ?? "", /not available yet/);
    }
    assert.equal(checkoutReturnNotice(kind, "anything-else", "unpaid"), null);
  }
});

test("checkout interruption, bad bodies and navigation errors do not redirect", async () => {
  const requests = [
    async () => { throw new TypeError("offline"); },
    async () => new Response("<h1>Upstream unavailable</h1>", { status: 502 }),
    async () => new Response("<html>Unexpected successful response</html>"),
    async () => Response.json({ url: 42 }),
    async () => Response.json(null),
    async () => Response.json({ url: "javascript:void(0)" }),
    async () => Response.json({ url: "not a URL" }),
  ];
  let navigations = 0;
  for (const request of requests) {
    assert.equal((await openBookingCheckout(request, () => { navigations++; })).redirected, false);
  }
  const hosted = "https://checkout.stripe.com/c/pay/mock";
  assert.equal((await openBookingCheckout(async () => Response.json({ url: hosted }), () => { throw new Error("Navigation unavailable"); })).redirected, false);
  assert.equal(navigations, 0);
});

test("safe server rejection is reported and a later verified checkout can open", async () => {
  const visits: string[] = [];
  const navigate = (url: string) => { visits.push(url); };
  const error = "Your booking changed. Refresh and try again.";
  assert.deepEqual(await openBookingCheckout(async () => Response.json({ error }, { status: 409 }), navigate), { redirected: false, error });
  assert.deepEqual(visits, []);
  const url = "https://checkout.stripe.com/c/pay/mock";
  assert.deepEqual(await openBookingCheckout(async () => Response.json({ url }), navigate), { redirected: true });
  assert.deepEqual(visits, [url]);
});

test("a fresh status permits a safe resume but not a retry after a reported success", () => {
  for (const status of ["unpaid", "pending"] as const) {
    assert.equal(canLeaveCheckoutReview(status, "success"), false);
    assert.equal(canLeaveCheckoutReview(status, "cancelled"), true);
    assert.equal(canLeaveCheckoutReview(status, null), true);
  }
  for (const status of ["paid", "refunded", "failed"] as const) {
    assert.equal(canLeaveCheckoutReview(status, "success"), true);
  }
});
