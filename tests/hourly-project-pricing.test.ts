import test from "node:test";
import assert from "node:assert/strict";
import { calculateHourlyProjectPrice, cappedTimerSeconds } from "../lib/hourly-project-pricing.ts";
test("aggregate seconds round up once to a minute without legacy increments",()=>{
 assert.equal(calculateHourlyProjectPrice(1,6000).subtotalCents,100);
 assert.equal(calculateHourlyProjectPrice(60,6000).billableMinutes,1);
 assert.equal(calculateHourlyProjectPrice(61,6000).subtotalCents,200);
 assert.equal(calculateHourlyProjectPrice(30+30,6000).subtotalCents,100);
 assert.equal(calculateHourlyProjectPrice(3600,6001).subtotalCents,6001);
 assert.equal(calculateHourlyProjectPrice(1,30).subtotalCents,1);
 assert.equal(calculateHourlyProjectPrice(3600,6000).customerTotalCents,6299);
});
test("timer is bounded by original cap even if unattended",()=>{
 const start=new Date("2026-01-01T00:00:00Z");
 assert.equal(cappedTimerSeconds(start,new Date("2026-01-02T00:00:00Z"),120),120);
 assert.equal(cappedTimerSeconds(start,new Date("2026-01-01T00:00:01.999Z"),120),1);
 assert.equal(cappedTimerSeconds(start,new Date("2025-01-01T00:00:00Z"),120),0);
});
test("pricing rejects unsafe inputs and payment totals",()=>{
 for(const seconds of [-1,0.1,NaN,Infinity,31536001])assert.throws(()=>calculateHourlyProjectPrice(seconds,6000));
 for(const rate of [0,-1,0.1,NaN,Infinity,10000001])assert.throws(()=>calculateHourlyProjectPrice(60,rate));
 assert.throws(()=>calculateHourlyProjectPrice(31536000,10000000));
 assert.equal(calculateHourlyProjectPrice(499998*60,12000).customerTotalCents,99999899);
 assert.throws(()=>calculateHourlyProjectPrice(499999*60,12000),"payment limit includes the service fee");
});
