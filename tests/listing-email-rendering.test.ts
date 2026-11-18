import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createHash } from "node:crypto";

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
function load(file: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const exports: Record<string, (...args: unknown[]) => unknown> = {};
  vm.runInNewContext(ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, URL, console, ...globals, require: (name: string) => {
      if (name in dependencies) return dependencies[name];
      throw Error(`Unexpected dependency: ${name}`);
    } });
  return exports;
}
function fixture() {
  const requests: Array<{ html: string; text?: string; to: string[] }> = [];
  const safe = load("lib/safe-url.ts", {});
  const email = load("lib/email.ts", {
    "server-only": {}, "node:crypto": { createHash }, "./safe-url": safe,
    "./database": { database: { query: async () => ({ rows: [] }) } },
  }, {
    process: { env: { RESEND_API_KEY: "synthetic-only", EMAIL_FROM: "test@example.invalid", NEXT_PUBLIC_APP_URL: "https://example.invalid" } },
    fetch: async (_url: string, init: { body: string }) => {
      requests.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ id: "synthetic-message" }) };
    },
  });
  const listing = load("lib/listing-active-email.ts", { "server-only": {}, "./database": {}, "./email": email });
  return { requests, email, listing };
}

test("listing email renders three independently separated actions with correct escaped destinations", async () => {
  const f = fixture();
  const payload = f.listing.listingActiveEmailPayload({
    service_id: "synthetic-service", service_title: "Care <&> repair", slug: "care repair",
    user_id: "synthetic-owner", business_name: "A & B", email: "owner@example.invalid", name: "Jo",
  });
  await f.email.sendTransactionalEmail(payload);
  assert.equal(f.requests.length, 1);
  const { html, to, text } = f.requests[0];
  assert.match(text!, /View your listing:\nhttps:\/\/example.invalid\/services\/care%20repair\n\nCheck your earnings:/);
  assert.deepEqual(to, ["owner@example.invalid"]);
  assert.equal((html.match(/<tr>/g) || []).length, 3);
  assert.equal((html.match(/<\/a><\/td><\/tr>\n<tr>/g) || []).length, 2);
  assert.doesNotMatch(html, /<\/a><a /);
  assert.match(html, /role="presentation"/);
  assert.match(html, /Care &lt;&amp;&gt; repair/);
  assert.match(html, /href="https:\/\/example.invalid\/services\/care%20repair"/);
  assert.match(html, /href="https:\/\/example.invalid\/provider\/dashboard\/revenue"/);
  assert.match(html, /Get your link &amp; QR code/);
  assert.match(html, /href="https:\/\/example.invalid\/provider\/dashboard\/marketing"/);
});

test("shared renderer retains no-action and single-action messages and caps multi-action inputs", async () => {
  const f = fixture();
  const base = { to: "owner@example.invalid", subject: "Test", heading: "Test", message: "Test", emailType: "test", renderVersion: "stacked-actions-v1" };
  await f.email.sendTransactionalEmail(base);
  assert.doesNotMatch(f.requests[0].html, /<tr>/);
  await f.email.sendTransactionalEmail({ ...base, actionUrl: "/one", actionLabel: "First" });
  assert.equal((f.requests[1].html.match(/<tr>/g) || []).length, 1);
  await f.email.sendTransactionalEmail({ ...base, actions: [1,2,3,4].map(n => ({ label: `Link ${n}`, url: `/link-${n}` })) });
  assert.equal((f.requests[2].html.match(/<tr>/g) || []).length, 3);
  assert.doesNotMatch(f.requests[2].html, /Link 4/);
});

test("authenticated scheduled endpoint runs automatic listing discovery; unauthorized requests do not", async () => {
  let runs = 0;
  const route = load("app/api/cron/provider-welcome-emails/route.ts", {
    "@/lib/listing-active-email": { processListingActiveEmailQueue: async () => { runs++; return { listingActiveSent: 1 }; } },
    "next/server": { NextResponse: { json: (body: unknown, init?: { status: number }) => ({ body, status: init?.status ?? 200 }) } },
    "@/lib/provider-welcome-email": { processProviderWelcomeEmailQueue: async () => ({}), reconcileProviderWelcomeEmailDeliveries: async () => ({}) },
    "@/lib/request-security": { secureSecretMatches: (a: string, b: string) => Boolean(a) && a === b },
  }, { process: { env: { CRON_SECRET: "synthetic-secret" } } });
  const request = (secret: string) => ({ headers: { get: () => `Bearer ${secret}` } });
  assert.equal((await route.POST(request("wrong")) as {status:number}).status, 401);
  assert.equal(runs, 0);
  const result = await route.POST(request("synthetic-secret")) as {status:number;body:{listingActiveSent:number}};
  assert.equal(result.status, 200); assert.equal(result.body.listingActiveSent, 1); assert.equal(runs, 1);
  const trigger = read("lib/payout-cron-trigger.mjs");
  assert.match(trigger, /\["providerWelcomeEmails", PROVIDER_WELCOME_EMAILS_PATH\]/);
});

test("legacy frozen payloads retain original inline HTML and omit text on retries", async () => {
  const f = fixture();
  await f.email.sendTransactionalEmail({
    to: "owner@example.invalid", subject: "Test", heading: "Test", message: "Test", emailType: "listing_active",
    actions: [{ label: "One", url: "/one" }, { label: "Two", url: "/two" }],
  });
  assert.equal(f.requests[0].text, undefined);
  const html = f.requests[0].html;
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /margin:0 10px 0 0/);
  assert.match(html, /margin:10px 10px 0 0/);
  assert.match(html, />One<\/a><a href=/);
});
