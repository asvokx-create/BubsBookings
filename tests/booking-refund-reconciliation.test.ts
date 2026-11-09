/* eslint-disable @typescript-eslint/no-explicit-any -- Runtime SQL harness replaces external Stripe with a stateful fake. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

test("external partial refunds freeze actual payout SQL; reconciled refunds remain releasable",async()=>{
  const db=new PGlite();
  let transfers=0;
  let refundDuringFeeFetch=false;
  const charge={id:"ch_test",livemode:false,payment_intent:"pi_test",currency:"usd",amount:10299,amount_refunded:0,refunded:false,balance_transaction:{fee:300}};
  const query=async(sql:string,values:unknown[]=[])=>{if(sql.includes("pg_advisory_xact_lock"))return {rows:[],rowCount:1};const result=await db.query(sql,values);return {...result,rowCount:result.affectedRows||result.rows.length};};
  const database={query,connect:async()=>({query,release(){}})};
  const load=(file:string):any=>{
    const output=ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const mod={exports:{}};
    new Function("require","module","exports",output)((name:string)=>{
      if(name==="server-only")return {};
      if(name==="./database")return {database};
      if(name==="./stripe")return {isStripeReady:()=>true,getStripeMode:()=>"test",getStripe:()=>({charges:{retrieve:async()=>{if(refundDuringFeeFetch){refundDuringFeeFetch=false;await db.exec("UPDATE bookings SET refunded_amount_cents=2500,provider_payout_cents=6750,refund_status='refunded'");}return charge;}},transfers:{create:async()=>{transfers++;return {id:"tr_test"};}}})};
      if(name==="./booking-processing-fees")return {reconcileBookingProcessingFee:async()=>({status:"final"})};
      if(name==="./affiliates")return {syncAffiliateCommissionForBooking:async()=>{}};
      if(name==="./booking-financials")return load("lib/booking-financials.ts");
      if(name==="./booking-refund-operations")return load("lib/booking-refund-operations.ts");
      if(name==="./booking-payout-finalization")return load("lib/booking-payout-finalization.ts");
      if(name==="./booking-payout-reconciliation")return load("lib/booking-payout-reconciliation.ts");
      throw new Error(`Unexpected import ${name}`);
    },mod,mod.exports);return mod.exports;
  };
  try {
    await db.exec(`
      CREATE TABLE provider_profiles(id uuid,user_id text,age_verification_status text,stripe_connect_mode text,stripe_payouts_enabled boolean,stripe_account_id text);
      CREATE TABLE services(id uuid,business_name text,title text);
      CREATE TABLE bookings(id uuid PRIMARY KEY,customer_id text,provider_id uuid,service_id uuid,payment_status text,stripe_mode text,payment_release_status text,payout_failure_reason text,payout_frozen_at timestamptz,payout_freeze_reason text,status text,refund_status text,stripe_transfer_id text,stripe_charge_id text,stripe_payment_intent_id text,provider_payout_cents integer,payment_flow text,price_cents integer,customer_service_fee_cents integer,customer_total_cents integer,refunded_amount_cents integer,customer_service_fee_refunded_cents integer,refunded_at timestamptz,payout_released_at timestamptz);
      ALTER TABLE bookings ADD stripe_dispute_id text, ADD stripe_dispute_status text, ADD stripe_dispute_closed_at timestamptz;
      ALTER TABLE bookings ADD platform_fee_cents integer DEFAULT 1000,ADD stripe_processing_fee_cents integer,ADD provider_processing_fee_cents integer DEFAULT 0,ADD processing_fee_status text DEFAULT 'pending',ADD refund_failure_reason text,ADD stripe_transfer_reversed_cents integer DEFAULT 0;
      CREATE TABLE booking_disputes(booking_id uuid,status text);
      CREATE TABLE booking_events(booking_id uuid,event_type text,message text,metadata jsonb);
      CREATE TABLE notifications(user_id text,booking_id uuid,type text,title text,message text,href text,dedupe_key text UNIQUE);
      INSERT INTO provider_profiles VALUES('00000000-0000-4000-8000-000000000001','provider','verified','test',true,'acct_test');
      INSERT INTO services VALUES('00000000-0000-4000-8000-000000000002','Company','Work');
    `);
    await db.exec(readFileSync("database/migrations/112_booking_payout_finalizations.sql", "utf8"));
    const id="00000000-0000-4000-8000-000000000003";
    const reset=async()=>{await db.exec("DELETE FROM bookings");await db.query(`INSERT INTO bookings(id,customer_id,provider_id,service_id,payment_status,stripe_mode,payment_release_status,status,refund_status,stripe_charge_id,stripe_payment_intent_id,provider_payout_cents,payment_flow,price_cents,customer_service_fee_cents,customer_total_cents,refunded_amount_cents,customer_service_fee_refunded_cents)
      VALUES($1,'customer','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','paid','test','awaiting_customer','completed','none','ch_test','pi_test',9000,'held_transfer_v1',10000,299,10299,0,0)`,[id]);charge.amount_refunded=0;charge.refunded=false;};
    const {recordBookingChargeRefund}=load("lib/booking-refund-reconciliation.ts");
    const {releaseBookingPayout}=load("lib/payment-release.ts");
    const {reconcileBookingProcessingFee}=load("lib/booking-processing-fees.ts");
    const event=(amount:number,full=false)=>recordBookingChargeRefund({paymentIntentId:"pi_test",bookingId:id,mode:"test",fullyRefunded:full,amountRefunded:amount,chargeAmount:10299});
    await reset();await event(2500);
    let row=(await db.query<any>("SELECT * FROM bookings")).rows[0];
    assert.equal(row.payment_status,"paid");assert.equal(row.payment_release_status,"frozen");assert.ok(row.payout_frozen_at);
    assert.equal((await releaseBookingPayout(id,"automatic")).ok,false);assert.equal(transfers,0);
    await event(1000);row=(await db.query<any>("SELECT * FROM bookings")).rows[0];assert.equal(row.refunded_amount_cents,2500,"out-of-order cumulative refund cannot decrease recorded refunds");
    await reset();charge.amount_refunded=2500;
    assert.equal((await releaseBookingPayout(id,"customer")).ok,false,"charge preflight freezes before refund webhook arrives");assert.equal(transfers,0);
    assert.equal((await db.query<any>("SELECT payment_release_status FROM bookings")).rows[0].payment_release_status,"frozen");
    await reset();charge.amount_refunded=2500;
    await db.exec("UPDATE bookings SET refunded_amount_cents=2500,provider_payout_cents=6750,refund_status='refunded'");
    await event(2500);
    row=(await db.query<any>("SELECT * FROM bookings")).rows[0];assert.equal(row.payout_frozen_at,null);assert.equal(row.provider_payout_cents,6750);
    assert.equal((await releaseBookingPayout(id,"customer")).ok,true);assert.equal(transfers,1,"known adjusted partial refund remains eligible");
    await reset();await event(10299,true);
    row=(await db.query<any>("SELECT * FROM bookings")).rows[0];assert.equal(row.payment_status,"refunded");assert.equal(row.provider_payout_cents,0);assert.equal(row.payment_release_status,"reversed");
    assert.equal((await releaseBookingPayout(id,"automatic")).ok,false);assert.equal(transfers,1);
    await reset();await db.exec("UPDATE bookings SET refunded_amount_cents=2500,provider_payout_cents=6750,refund_status='refunded'");
    assert.equal((await reconcileBookingProcessingFee(id)).status,"pending");
    row=(await db.query<any>("SELECT * FROM bookings")).rows[0];assert.equal(row.provider_payout_cents,6750);assert.equal(row.payment_release_status,"frozen");assert.equal(row.processing_fee_status,"pending");
    await reset();refundDuringFeeFetch=true;
    assert.equal((await reconcileBookingProcessingFee(id)).status,"pending","refund during Stripe lookup must prevent finalization overwrite");
    row=(await db.query<any>("SELECT * FROM bookings")).rows[0];assert.equal(row.provider_payout_cents,6750);assert.equal(row.payment_release_status,"frozen");assert.equal(row.processing_fee_status,"pending");
    await reset();assert.equal((await reconcileBookingProcessingFee(id)).status,"final","unrefunded payment still finalizes fees");
    row=(await db.query<any>("SELECT * FROM bookings")).rows[0];assert.ok(row.provider_payout_cents<9000);assert.equal(row.processing_fee_status,"final");
  } finally {await db.close();}
});
