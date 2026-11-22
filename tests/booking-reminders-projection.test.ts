import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
import { formatDurationMinutes } from "../lib/service-pricing.ts";

type CapturedReminder = {
  bookingId: string;
  to: string;
  emailType: string;
  message: string;
  actionLabel: string;
};

function loadBookingModule<T>(path: string, imports: Record<string, unknown>): T {
  const source = fs.readFileSync(new URL(path, import.meta.url), "utf8");
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports,
    require(name: string) {
      if (name === "server-only") return {};
      if (Object.hasOwn(imports, name)) return imports[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return exports as T;
}

test("scheduled reminders select end time and pricing snapshots for both recipients", async () => {
  const db = new PGlite();
  const captured: CapturedReminder[] = [];
  const email = {
    isEmailConfigured: () => true,
    sendTransactionalEmail: async (payload: CapturedReminder) => {
      captured.push(payload);
      return { sent: true };
    },
  };
  const bookingEmail = loadBookingModule<typeof import("../lib/booking-email")>("../lib/booking-email.ts", {
    "./database": { database: db }, "./email": email, "./service-pricing": { formatDurationMinutes },
  });
  const job = loadBookingModule<typeof import("../lib/booking-reminders")>("../lib/booking-reminders.ts", {
    "./database": { database: db }, "./email": email, "./booking-email": bookingEmail,
  });

  try {
    await db.exec(`
      CREATE TABLE "user" (id text PRIMARY KEY, name text, email text);
      CREATE TABLE user_settings (user_id text PRIMARY KEY, booking_notifications boolean);
      CREATE TABLE services (id text PRIMARY KEY, title text, business_name text);
      CREATE TABLE provider_profiles (id text PRIMARY KEY, user_id text, plan text);
      CREATE TABLE bookings (
        id text PRIMARY KEY, service_id text, provider_id text, customer_id text,
        starts_at timestamptz, ends_at timestamptz, payment_status text, status text,
        price_cents integer, pricing_type_snapshot text, hourly_rate_cents_snapshot integer, billable_duration_minutes integer,
        reminder_24h_sent_at timestamptz, reminder_1h_sent_at timestamptz
      );
      CREATE TABLE operations_checks (check_type text, status text, details jsonb);
      INSERT INTO "user" VALUES ('c', 'Synthetic Customer', 'customer@example.invalid'),
        ('p', 'Synthetic Provider', 'provider@example.invalid');
      INSERT INTO services VALUES ('service', 'Fixture service', 'Fixture business');
      INSERT INTO provider_profiles VALUES ('starter', 'p', 'starter'), ('pro', 'p', 'pro');
      INSERT INTO bookings VALUES
        ('fixed', 'service', 'starter', 'c', now() + interval '24 hours', now() + interval '26 hours', 'paid', 'confirmed', 14999, 'FIXED', NULL, 120, NULL, NULL),
        ('hourly', 'service', 'pro', 'c', now() + interval '1 hour', now() + interval '150 minutes', 'paid', 'confirmed', 12000, 'HOURLY', 8000, 90, NULL, NULL),
        ('quote', 'service', 'starter', 'c', now() + interval '24 hours', now() + interval '25 hours', 'unpaid', 'confirmed', 0, 'QUOTE_ONLY', NULL, 60, NULL, NULL),
        ('starter-soon', 'service', 'starter', 'c', now() + interval '1 hour', now() + interval '2 hours', 'paid', 'confirmed', 5000, 'FIXED', NULL, 60, NULL, NULL);
    `);
    const scheduled = await db.query<{ id: string; starts_at: Date; ends_at: Date }>("SELECT id, starts_at, ends_at FROM bookings");
    const format = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Los_Angeles" });
    const rangeFor = (id: string) => {
      const row = scheduled.rows.find((booking) => booking.id === id);
      assert.ok(row);
      return `from ${format.format(row.starts_at)} to ${format.format(row.ends_at)}.`;
    };
    const outcome = await job.runBookingReminders();
    assert.equal(outcome.configured, true);
    assert.equal(outcome.processed, 3);
    assert.equal(captured.length, 6);
    assert.equal(captured.some(({ bookingId }) => bookingId === "starter-soon"), false);

    for (const [id, hours, expectedPrice] of [
      ["fixed", 24, "Service price $149.99."],
      ["hourly", 1, "1.5 hours at $80.00/hr; service subtotal $120.00."],
    ] as const) {
      for (const recipient of ["customer", "provider"] as const) {
        const reminder = captured.find((email) => email.bookingId === id && email.emailType === `reminder_${hours}h_${recipient}`);
        assert.ok(reminder, `${id} ${recipient} reminder`);
        assert.equal(reminder.to, `${recipient}@example.invalid`);
        assert.ok(reminder.message.includes(rangeFor(id)), reminder.message);
        assert.ok(reminder.message.includes(expectedPrice), reminder.message);
        assert.doesNotMatch(reminder.message, /NaN/);
      }
    }

    const quoteProvider = captured.find((email) => email.bookingId === "quote" && email.emailType === "reminder_24h_provider");
    const quoteCustomer = captured.find((email) => email.bookingId === "quote" && email.emailType === "reminder_24h_customer");
    assert.ok(quoteProvider && quoteCustomer);
    assert.ok(quoteProvider.message.includes(rangeFor("quote")), quoteProvider.message);
    assert.match(quoteProvider.message, /Custom quote pending\. No price has been approved or charged\./);
    assert.match(quoteCustomer.message, /payment is still due/);
    assert.doesNotMatch(quoteCustomer.message, /Custom quote|Service price|NaN/);
    assert.equal(quoteCustomer.actionLabel, "Pay through Stripe");
  } finally {
    await db.close();
  }
});
