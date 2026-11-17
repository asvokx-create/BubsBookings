/* eslint-disable @typescript-eslint/no-explicit-any -- Exercise real migration SQL in isolated databases. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

for (const postgres of [false, true]) test(`${postgres ? "PostgreSQL" : "PGlite"} refund operation migration preserves existing bookings`, {
  skip: postgres && process.env.BOOKME_MIGRATION_TEST_DATABASE !== "1",
}, async () => {
  let db: any;
  let cleanup: () => Promise<void>;
  if (postgres) {
    const connectionString = process.env.DATABASE_URL ?? "postgresql://bookme:bookme@127.0.0.1:5432/bookme";
    const url = new URL(connectionString);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.port === "55432") throw new Error("Migration tests require a dedicated local test database, never the QA application database.");
    const schema = "refund_migration_test_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString, ssl: false });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString, ssl: false, options: `-c search_path=${schema}` });
    db = { query: (sql: string, values: unknown[] = []) => pool.query(sql, values), exec: (sql: string) => pool.query(sql) };
    cleanup = async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); };
  } else { db = new PGlite(); cleanup = () => db.close(); }
  try {
    await db.exec(`CREATE TABLE bookings(id uuid PRIMARY KEY, payment_status text, payment_flow text, amount_cents integer, details jsonb);
      CREATE TABLE booking_disputes(id uuid PRIMARY KEY,details jsonb);
      CREATE TABLE historical_audit(id integer PRIMARY KEY, details jsonb);
      INSERT INTO historical_audit VALUES(1,'{"preserve":true}');`);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of ids.entries()) await db.query("INSERT INTO bookings VALUES($1,$2,$3,$4,$5)", [id,
      ["paid", "refunded", "paid"][index], ["destination_charge", "held_transfer_v1", "held_transfer_v1"][index],
      [6000, 399, 700][index], JSON.stringify({ synthetic: true, index })]);
    const before = (await db.query("SELECT row_to_json(b) AS row FROM bookings b ORDER BY id")).rows;
    const disputeId = randomUUID();
    await db.query("INSERT INTO booking_disputes VALUES($1,$2)", [disputeId, JSON.stringify({ historical: true })]);
    const migration = readFileSync("database/migrations/113_booking_refund_operations.sql", "utf8");
    await db.exec(migration);
    await db.exec(migration);
    assert.deepEqual((await db.query("SELECT row_to_json(b) AS row FROM bookings b ORDER BY id")).rows, before);
    assert.deepEqual((await db.query("SELECT * FROM historical_audit")).rows, [{ id: 1, details: { preserve: true } }]);
    assert.deepEqual((await db.query("SELECT * FROM booking_disputes")).rows, [{ id: disputeId, details: { historical: true }, refund_operation_id: null }]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM booking_refund_operations")).rows[0].n, 0,
      "Migration must not invent executable refunds or recoveries from historical totals");
    const insert = async (overrides: Record<string, unknown> = {}) => {
      const values = { id: randomUUID(), booking_id: ids[0], stripe_mode: "test", origin: "provider", payment_intent_id: "pi_synthetic",
        service_amount_cents: 100, fee_amount_cents: 299, baseline_service_cents: 0, baseline_fee_cents: 0,
        price_cents: 100, service_fee_cents: 299, provider_share_cents: 79, adjusted_share_cents: 79,
        baseline_reversed_cents: 0, reversal_target_cents: 79, ...overrides };
      await db.query(`INSERT INTO booking_refund_operations (${Object.keys(values).join(",")}) VALUES (${Object.keys(values).map((_, i) => "$" + (i + 1)).join(",")})`, Object.values(values));
      return values.id;
    };
    const first = await insert();
    await assert.rejects(insert(), { code: "23505" }, "one unresolved operation per booking");
    await db.query("UPDATE booking_refund_operations SET effects_completed_at=now() WHERE id=$1", [first]);
    await assert.rejects(insert(), { code: "23505" }, "refund receipt alone does not release recovery claim");
    await db.query("UPDATE booking_refund_operations SET recovery_completed_at=now(), stripe_refund_id='re_synthetic' WHERE id=$1", [first]);
    await assert.rejects(insert({ booking_id: ids[1], stripe_refund_id: "re_synthetic" }), { code: "23505" });
    await assert.rejects(insert({ service_amount_cents: 101 }), { code: "23514" });
    await assert.rejects(insert({ reversal_target_cents: 80 }), { code: "23514" });
    await assert.rejects(insert({ stripe_mode: "unknown" }), { code: "23514" });
    await insert({ booking_id: ids[1], stripe_mode: "live", stripe_refund_id: "re_synthetic" });
    await insert();
  } finally { await cleanup(); }
});
