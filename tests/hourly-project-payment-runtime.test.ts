/* eslint-disable @typescript-eslint/no-explicit-any -- Stateful fake Stripe and PostgreSQL runtime module harness. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
import pg from "pg";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);

for (const postgres of [false,true]) test(`${postgres ? "PostgreSQL" : "PGlite"} hourly checkout: durable retries, ownership, snapshots and concurrency`, {skip:postgres && process.env.BOOKME_MIGRATION_TEST_DATABASE!=="1"}, async () => {
  let db:any;
  let cleanup:()=>Promise<void>;
  if(postgres) {
    const connectionString=process.env.DATABASE_URL ?? "postgresql://bookme:bookme@127.0.0.1:5432/bookme";
    const url=new URL(connectionString);
    if(!["localhost","127.0.0.1","[::1]"].includes(url.hostname)) throw new Error("Payment tests require an explicitly opted-in localhost PostgreSQL database.");
    const schema="hourly_payment_test_"+randomUUID().replaceAll("-","");
    const admin=new pg.Pool({connectionString,ssl:false});
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool=new pg.Pool({connectionString,ssl:false,options:`-c search_path=${schema}`,max:8});
    db={query:(sql:string,values:unknown[]=[])=>pool.query(sql,values),exec:(sql:string)=>pool.query(sql),connect:()=>pool.connect()};
    cleanup=async()=>{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();};
  } else {db=new PGlite();cleanup=()=>db.close();}
  const sessions = new Map<string, any>();
  const intents = new Map<string, any>();
  const keys: string[] = [];
  let lostResponse = false;
  let failPersist = false;
  let failApproval = false;
  let createCalls = 0;
  const stripe = {
    accounts: { retrieve: async () => ({charges_enabled:true,payouts_enabled:true}) },
    paymentIntents: { retrieve: async (id:string) => intents.get(id), cancel: async (id:string) => { const p=intents.get(id); p.status="canceled"; return p; } },
    checkout: { sessions: {
      retrieve: async (id:string) => [...sessions.values()].find(s=>s.id===id),
      create: async (params:any, options:{idempotencyKey:string}) => {
        createCalls++; keys.push(options.idempotencyKey);
        let s=sessions.get(options.idempotencyKey);
        if(!s) {s={id:`cs_${sessions.size+1}`,status:"open",payment_status:"unpaid",url:`https://checkout.stripe.com/${sessions.size+1}`,params};sessions.set(options.idempotencyKey,s);}
        if(lostResponse) {lostResponse=false;throw new Error("simulated lost Stripe response");}
        return s;
      },
    } },
  };
  try {
    await db.exec(`
      CREATE TABLE "user" (id text PRIMARY KEY,name text);
      INSERT INTO "user" VALUES ('customer','Customer'),('provider','Provider'),('stranger','Other');
    `);
    await db.exec(readFileSync("database/migrations/001_bookme_marketplace.sql","utf8").replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""));
    await db.exec(`
      ALTER TABLE provider_profiles ADD plan text DEFAULT 'starter',ADD stripe_account_id text DEFAULT 'acct_test',ADD stripe_connect_mode text DEFAULT 'test',ADD age_verification_status text DEFAULT 'verified',ADD stripe_subscription_id text,ADD stripe_billing_mode text,ADD stripe_subscription_status text;
      CREATE TABLE complimentary_pro_grants(provider_id uuid,revoked_at timestamptz,starts_at timestamptz,expires_at timestamptz);
      CREATE TABLE account_restrictions(user_id text,status text,expires_at timestamptz);
      ALTER TABLE bookings ADD completed_at timestamptz,ADD delivery_method text,ADD base_price_cents integer,ADD pricing_type_snapshot text,ADD billable_duration_minutes integer,ADD provider_plan_snapshot text,ADD provider_fee_basis_points integer,ADD provider_fee_cap_cents integer,ADD platform_fee_cents integer,ADD provider_payout_cents integer,ADD customer_service_fee_cents integer,ADD customer_total_cents integer,ADD payment_flow text,ADD payment_release_status text,ADD stripe_mode text,ADD payment_status text DEFAULT 'unpaid',ADD stripe_checkout_session_id text,ADD processing_fee_status text;
      CREATE TABLE booking_events(id uuid DEFAULT gen_random_uuid(),booking_id uuid,actor_user_id text,event_type text,message text,metadata jsonb);
      INSERT INTO provider_profiles(id,user_id,business_name,city,state) VALUES ('00000000-0000-4000-8000-000000000001','provider','Company','City','ST');
      INSERT INTO services(id,provider_id,slug,category,title,description,price_cents,duration_minutes) VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','repair','repair','Repair','Repair service',6000,60);
    `);
    await db.exec(readFileSync("database/migrations/111_hourly_projects.sql","utf8"));
    const query=async(sql:string,values:unknown[]=[],executor:any=db)=>{
      if(!postgres && sql.includes("pg_advisory_xact_lock")) return {rows:[],rowCount:1};
      if(failPersist && sql.startsWith("UPDATE hourly_project_checkout_attempts SET")){failPersist=false;throw new Error("simulated DB response persistence failure");}
      if(failApproval && sql.startsWith("UPDATE hourly_projects SET")){failApproval=false;throw new Error("simulated approval failure");}
      const result=await executor.query(sql,values);return {...result,rowCount:result.rowCount??(result.affectedRows||result.rows.length)};
    };
    const database={query,connect:async()=>{if(!postgres)return {query,release(){}};const client=await db.connect();return {query:(sql:string,values:unknown[]=[])=>query(sql,values,client),release:()=>client.release()};}};
    const cache=new Map<string,unknown>();
    const load=(name:string):any=>{
      if(name==="server-only")return {};
      if(name==="@/lib/database")return {database};
      if(name==="@/lib/stripe")return {getStripe:()=>stripe,getStripeMode:()=>"test"};
      if(name==="@/lib/customer-stripe")return {getOrCreateConsumerStripeCustomer:async()=>"cus_test"};
      if(name==="@/lib/complimentary-pro")return {reconcileExpiredComplimentaryProGrants:async()=>{}};
      if(!name.startsWith("@/"))return require(name);
      if(cache.has(name))return cache.get(name);
      const output=ts.transpileModule(readFileSync(resolve(name.replace("@/","")+".ts"),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
      const mod={exports:{}};new Function("require","module","exports",output)(load,mod,mod.exports);cache.set(name,mod.exports);return mod.exports;
    };
    const {checkoutHourlyProject}=load("@/lib/hourly-project-checkout");
    const newProject=async()=> (await db.query(`INSERT INTO hourly_projects(customer_id,provider_id,service_id,title,description,hourly_rate_cents,cap_minutes,delivery_method,service_address,status,version,submitted_seconds,submitted_minutes,submitted_subtotal_cents)
      VALUES('customer','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Project','Work',6000,120,'REMOTE','','submitted',5,3600,60,6000) RETURNING id`)).rows[0].id;
    const pay=(projectId:string,version=5,user="customer")=>checkoutHourlyProject({projectId,version,user:{id:user,email:"test@example.com",name:"Customer"},origin:"https://example.com"});
    const project=await newProject();
    await assert.rejects(pay(project,4),/changed/);
    await assert.rejects(pay(project,5,"stranger"),/not found/);
    await db.exec("INSERT INTO account_restrictions VALUES('provider','suspended',NULL)");
    await assert.rejects(pay(project),/restricted/);
    await db.exec("DELETE FROM account_restrictions");
    failApproval=true;
    await assert.rejects(pay(project),/approval failure/);
    assert.equal((await db.query("SELECT * FROM bookings")).rows.length,0,"approval failure rolls back invoice");
    assert.equal(createCalls,0);
    lostResponse=true;
    await assert.rejects(pay(project),/lost Stripe/);
    assert.equal((await db.query("SELECT * FROM bookings")).rows.length,1);
    assert.equal((await db.query("SELECT status FROM hourly_projects WHERE id=$1",[project])).rows[0].status,"approved");
    const paid=await pay(project);
    assert.equal(keys[0],keys[1],"lost response reuses durable Stripe idempotency key");
    assert.equal(sessions.size,1);
    assert.equal((await pay(project)).url,paid.url);
    const invoice=(await db.query("SELECT * FROM bookings WHERE id=$1",[paid.bookingId])).rows[0];
    assert.equal(invoice.price_cents,6000);assert.equal(invoice.base_price_cents,6000);assert.equal(invoice.customer_total_cents,6299);assert.equal(invoice.platform_fee_cents,600);assert.equal(invoice.status,"completed");assert.equal(invoice.payment_release_status,"awaiting_payment");
    assert.equal((await db.query("SELECT * FROM booking_events")).rows.length,1);
    const first=[...sessions.values()][0];first.status="complete";
    await assert.rejects(pay(project),/processing or already completed/);
    assert.equal(sessions.size,1,"asynchronous in-flight payment must not open a second checkout");
    first.status="expired";
    await pay(project);
    assert.equal(sessions.size,2,"only expired unpaid checkout gets a new attempt");
    const second=[...sessions.values()][1];second.status="complete";second.payment_intent="pi_fail";intents.set("pi_fail",{status:"requires_payment_method"});
    await db.query("UPDATE bookings SET payment_status='failed' WHERE id=$1",[paid.bookingId]);
    await pay(project);
    assert.equal(intents.get("pi_fail").status,"canceled");assert.equal(sessions.size,3);
    for(const status of ["paid","refunded"]){await db.query("UPDATE bookings SET payment_status=$2 WHERE id=$1",[paid.bookingId,status]);await assert.rejects(pay(project),/already been paid or refunded/);}
    const crashProject=await newProject();failPersist=true;
    await assert.rejects(pay(crashProject),/persistence failure/);
    const callsBefore=createCalls;
    await pay(crashProject);assert.equal(keys[callsBefore-1],keys[callsBefore]);assert.equal((await db.query("SELECT * FROM bookings")).rows.length,2);
    const staleProject=await newProject();lostResponse=true;
    await assert.rejects(pay(staleProject),/lost Stripe/);
    await db.query("UPDATE hourly_project_checkout_attempts SET created_at=now()-interval '24 hours' WHERE project_id=$1",[staleProject]);
    const before=createCalls;await assert.rejects(pay(staleProject),/support review/);assert.equal(createCalls,before);
    // Stale stored plan cannot accidentally grant discounted fees; current grants can.
    await db.exec("UPDATE provider_profiles SET plan='pro'");
    const stalePlan=await newProject();const stalePaid=await pay(stalePlan);
    assert.equal((await db.query("SELECT provider_plan_snapshot FROM bookings WHERE id=$1",[stalePaid.bookingId])).rows[0].provider_plan_snapshot,"starter");
    await db.exec("INSERT INTO complimentary_pro_grants VALUES ('00000000-0000-4000-8000-000000000001',NULL,now()-interval '1 day',NULL)");
    const grantProject=await newProject();const grantPaid=await pay(grantProject);
    assert.equal((await db.query("SELECT platform_fee_cents FROM bookings WHERE id=$1",[grantPaid.bookingId])).rows[0].platform_fee_cents,360);
    const shortProject=await newProject();
    await db.query("UPDATE hourly_projects SET submitted_seconds=1,submitted_minutes=1,submitted_subtotal_cents=1,hourly_rate_cents=50 WHERE id=$1",[shortProject]);
    const shortPaid=await pay(shortProject);
    assert.equal((await db.query("SELECT customer_total_cents FROM bookings WHERE id=$1",[shortPaid.bookingId])).rows[0].customer_total_cents,300,"Stripe minimum applies to whole charge including service fee");
    await db.query("UPDATE bookings SET stripe_mode='live' WHERE id=$1",[shortPaid.bookingId]);
    await assert.rejects(pay(shortProject),/different Stripe environment/);
    if(postgres) {
      const concurrent=await newProject();
      const countBefore=(await db.query("SELECT * FROM bookings")).rows.length;
      const sessionCount=sessions.size;
      const results=await Promise.all(Array.from({length:5},()=>pay(concurrent)));
      assert.equal(new Set(results.map(r=>r.bookingId)).size,1,"real row/advisory locks yield one settlement");
      assert.equal(new Set(results.map(r=>r.url)).size,1,"concurrent calls return identical checkout");
      assert.equal((await db.query("SELECT * FROM bookings")).rows.length,countBefore+1);
      assert.equal(sessions.size,sessionCount+1);
    }
  } finally {await cleanup();}
});
