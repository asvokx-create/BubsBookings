import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import Stripe from "stripe";
import { detectSupportedImageFormat } from "../lib/image-format.ts";
import { IMPORT_MAX_BYTES, readSheet, safeCsv, safeImportSourceName } from "../lib/customer-import.ts";
import { safeHttpUrl } from "../lib/safe-url.ts";
import {
  canApplyBookingPaymentTransition,
  parseVerifiedStripeEvent,
  stripeEventMatchesMode,
  stripeTransferMatches,
} from "../lib/stripe-webhook-security.ts";

async function source(path: string) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("image inspection accepts a real image and rejects extension or prefix spoofing", async () => {
  const image = await readFile(new URL("../public/brand-icon.png", import.meta.url));
  assert.deepEqual(detectSupportedImageFormat(image), { contentType: "image/png", extension: "png" });
  assert.equal(detectSupportedImageFormat(Buffer.from("<svg><script>alert(1)</script></svg>")), null);
  assert.equal(detectSupportedImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), null);
  assert.equal(detectSupportedImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9])), null);
});

test("every image endpoint enforces byte limits, content inspection, generated keys, and ownership", async () => {
  const [profile, listing, portfolio, storage, proxy] = await Promise.all([
    source("app/api/account/profile-photo/route.ts"),
    source("app/api/providers/services/[serviceId]/images/route.ts"),
    source("app/api/providers/profile/portfolio/route.ts"),
    source("lib/spaces.ts"),
    source("proxy.ts"),
  ]);
  for (const route of [profile, listing, portfolio]) {
    assert.match(route, /image\.size === 0|image\.size === 0|image\.size > LISTING_IMAGE_MAX_BYTES/);
    assert.match(route, /detectSupportedImageFormat/);
    assert.match(route, /randomUUID\(\)/);
  }
  assert.match(listing, /p\.user_id = \$2/);
  assert.match(portfolio, /Only the business owner can manage the portfolio/);
  assert.match(storage, /publicImageKey\.test\(input\.key\)/);
  assert.match(storage, /detected\.contentType !== input\.contentType/);
  assert.match(storage, /ContentDisposition/);
  assert.match(proxy, /\/api\/providers\/profile\/portfolio/);
});

test("customer imports reject oversized, unsafe, and formula-bearing data without public storage", async () => {
  const [parser, route] = await Promise.all([
    source("lib/customer-import.ts"),
    source("app/api/providers/customer-imports/route.ts"),
  ]);
  assert.match(parser, /IMPORT_MAX_BYTES=2\*1024\*1024/);
  assert.match(parser, /IMPORT_MAX_ROWS=5000/);
  assert.match(parser, /maxOutputLength:IMPORT_MAX_BYTES\+1/);
  assert.match(parser, /\(flags&1\)!==0/);
  assert.match(parser, /xl\/externalLinks/);
  assert.match(parser, /Formula, external-link, or XML-entity workbooks cannot be imported/);
  assert.match(parser, /\^\[=\+\\-@\]/);
  assert.match(route, /WHERE provider_id::text=\$1/);
  assert.match(route, /WHERE id::text=\$1 AND provider_id::text=\$2/);
  assert.doesNotMatch(route, /uploadPublicImage|PutObjectCommand/);
  assert.equal((await stat(new URL("../lib/customer-import.ts", import.meta.url))).isFile(), true);
  const valid = await readSheet(new File(["Full Name,Email\nPat Example,pat@example.com"], "customers.csv", { type: "text/csv" }));
  assert.deepEqual(valid.headers, ["Full Name", "Email"]);
  assert.equal(valid.rows.length, 1);
  await assert.rejects(readSheet(new File([new Uint8Array(IMPORT_MAX_BYTES + 1)], "large.csv")), /under 2 MB/);
  await assert.rejects(readSheet(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "broken.xlsx")), /workbook|valid/);
  await assert.rejects(readSheet(new File(["Name\u0000,Email\nPat,pat@example.com"], "binary.csv")), /valid text CSV/);
  assert.equal(safeCsv("=HYPERLINK(\"https://evil.example\")"), "'=HYPERLINK(\"https://evil.example\")");
  assert.equal(safeCsv("@SUM(1+1)"), "'@SUM(1+1)");
  assert.equal(safeImportSourceName("../../<script>.csv"), "script .csv");
});

test("Stripe webhook signatures and environment mode are verified", () => {
  const stripe = new Stripe("sk_test_synthetic");
  const secret = "whsec_synthetic_test_secret";
  const payload = JSON.stringify({
    id: "evt_security_test",
    object: "event",
    api_version: "2026-09-30.clover",
    created: 1_700_000_000,
    data: { object: { id: "cs_test_security", object: "checkout.session" } },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "checkout.session.completed",
  });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  const event = parseVerifiedStripeEvent(stripe, payload, signature, secret);
  assert.equal(event.id, "evt_security_test");
  assert.equal(stripeEventMatchesMode(event, "test"), true);
  assert.equal(stripeEventMatchesMode(event, "live"), false);
  assert.throws(() => parseVerifiedStripeEvent(stripe, payload, `${signature}bad`, secret));
});

test("out-of-order booking events cannot regress final payment states", () => {
  assert.equal(canApplyBookingPaymentTransition("pending", "paid"), true);
  assert.equal(canApplyBookingPaymentTransition("failed", "paid"), true);
  assert.equal(canApplyBookingPaymentTransition("paid", "failed"), false);
  assert.equal(canApplyBookingPaymentTransition("refunded", "paid"), false);
  assert.equal(canApplyBookingPaymentTransition("refunded", "failed"), false);
});

test("transfer reconciliation requires the expected amount and connected account", () => {
  const transfer = { amount: 9_000, destination: "acct_provider" };
  assert.equal(stripeTransferMatches(transfer, { amountCents: 9_000, connectedAccountId: "acct_provider" }), true);
  assert.equal(stripeTransferMatches(transfer, { amountCents: 9_001, connectedAccountId: "acct_provider" }), false);
  assert.equal(stripeTransferMatches(transfer, { amountCents: 9_000, connectedAccountId: "acct_attacker" }), false);
});

test("webhook and payout routes enforce idempotency and authorization", async () => {
  const [webhook, cron] = await Promise.all([
    source("app/api/stripe/webhook/route.ts"),
    source("app/api/cron/payment-releases/route.ts"),
  ]);
  assert.match(webhook, /request\.text\(\)/);
  assert.match(webhook, /parseVerifiedStripeEvent/);
  assert.match(webhook, /stripeEventMatchesMode/);
  assert.match(webhook, /stripe_webhook_events/);
  assert.match(webhook, /created_at < now\(\) - interval '5 minutes'/);
  assert.match(webhook, /payment_status IN \('unpaid', 'pending', 'failed'\)/);
  assert.match(webhook, /paymentIntent\.amount_received !== checkout\.amount_total/);
  assert.match(webhook, /paymentIntent\?\.metadata\.kind === "booking_payment"/);
  assert.match(webhook, /recordBookingChargeRefund/);
  assert.match(await source("lib/booking-refund-reconciliation.ts"), /customer_total_cents=\$6/);
  assert.match(webhook, /provider\.stripe_account_id=\$5/);
  assert.match(cron, /secureSecretMatches/);
  assert.match(cron, /status: 401/);
});

test("unsafe URLs and user HTML payloads are not treated as executable content", async () => {
  assert.equal(safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpUrl("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(safeHttpUrl("https://user:password@example.com"), null);
  assert.equal(safeHttpUrl("/account", "https://bubsbookings.com", "https://bubsbookings.com"), "https://bubsbookings.com/account");
  assert.equal(safeHttpUrl("https://evil.example/account", "https://bubsbookings.com", "https://bubsbookings.com"), null);

  const [email, config, layout, providers, messages] = await Promise.all([
    source("lib/email.ts"),
    source("next.config.ts"),
    source("app/layout.tsx"),
    source("app/providers/[slug]/page.tsx"),
    source("components/messaging-center.tsx"),
  ]);
  assert.match(email, /safeHttpUrl\(value, appUrl, appUrl\)/);
  assert.match(email, /escapeHtml\(input\.message\)/);
  assert.match(config, /script-src-attr 'none'/);
  assert.match(config, /object-src 'none'/);
  assert.match(config, /frame-ancestors 'none'/);
  assert.match(layout, /JSON\.stringify\(organizationJsonLd\)\.replace\(\/<\/g/);
  assert.match(providers, /JSON\.stringify\(structuredData\)\.replace\(\/<\/g/);
  assert.doesNotMatch(messages, /dangerouslySetInnerHTML|innerHTML/);
});
