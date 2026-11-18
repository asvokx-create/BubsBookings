/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated request-boundary harness mocks all external services. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const id='00000000-0000-4000-8000-000000000001';
function harness(pending:boolean){
 const row={id,provider_user_id:'provider',customer_id:'customer',version:1,billing_mode:'free',state:'confirmed',calendar_check_pending:pending,ends_at:'2020-01-01T00:00:00Z',financial_snapshot:{customerTotalCents:0}};
 const queries:string[]=[];let released=0,slotReleased=0;
 const client={query:async(sql:string)=>{queries.push(sql);if(sql.includes('pg_try_advisory'))return{rows:[{locked:true}]};if(sql.includes('SELECT * FROM calendly_calls')){assert.match(sql,/FOR UPDATE/);return{rows:[{...row}]};}return{rows:[]};},release:()=>{released++;}};
 class CallRequestError extends Error {status:number;constructor(message:string,status=400){super(message);this.status=status;}}
 const exports:any={};
 const code=ts.transpileModule(readFileSync('lib/calendly-call-requests.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','exports',code)((name:string)=>{
  if(name==='@/lib/database')return{database:{connect:async()=>client}};
  if(name==='@/lib/calendly-call-offers')return{CallRequestError,requireCallsEnabled:()=>{},requireExistingCallsEnabled:()=>{}};
  if(name==='@/lib/calendly-call-conflicts')return{releaseCallSlot:async()=>{slotReleased++;}};
  if(['server-only','@/lib/content-safety','@/lib/calendly-call-cancellation','node:crypto','@/lib/booking-financials','@/lib/stripe','@/lib/calendly-call-api'].includes(name))return{};
  throw new Error('Unexpected dependency '+name);
 },exports);
 return {exports,queries,row,released:()=>released,slotReleased:()=>slotReleased};
}
test('pending free call completion fails while locked before any completion write or hold release',async()=>{
 const h=harness(true);
 assert.equal(h.exports.callView(h.row,'provider').canComplete,false);
 await assert.rejects(h.exports.updateCallRequest('provider',id,{action:'complete',version:1}),(error:any)=>error.status===409&&/verification is pending/.test(error.message));
 assert.ok(h.queries.some(sql=>sql.includes('FOR UPDATE')));assert.ok(h.queries.includes('ROLLBACK'));assert.ok(!h.queries.some(sql=>sql.startsWith('UPDATE')));assert.equal(h.slotReleased(),0);assert.equal(h.released(),1);
});
test('recovered free call may complete after its end with row lock and version guard',async()=>{
 const h=harness(false);assert.equal(h.exports.callView(h.row,'provider').canComplete,true);
 await h.exports.updateCallRequest('provider',id,{action:'complete',version:1});
 assert.ok(h.queries.some(sql=>sql.includes("state='completed'")));assert.ok(h.queries.includes('COMMIT'));assert.equal(h.slotReleased(),1);assert.equal(h.released(),1);
});
