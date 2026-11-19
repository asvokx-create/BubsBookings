import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('../app/api/bookings/route.ts',import.meta.url),'utf8');
const body={serviceId:'fixture',date:'2099-12-01',time:'10:00',deliveryMethod:'IN_PERSON',addressLine1:'1 Fixture St',city:'Test',state:'WA',postalCode:'98001',answers:{Required:'Yes'}};
async function run(changes={},serviceChanges={}) {
 const calls:string[]=[];
 const service={id:'fixture',provider_id:'provider',pricing_type:'FIXED',price_cents:8500,duration_minutes:60,delivery_type:'BOTH',recurrence_options:['one_time'],booking_questions:['Required'],plan:'pro',...serviceChanges};
 const context=vm.createContext({Request,Response,Date,console,headers:async()=>({}),auth:{api:{getSession:async()=>({user:{id:'fixture-user'}})}},hasConfirmedAge:async()=>true,readMarketingToken:()=>null,enforceRateLimit:async()=>true,getStripeMode:()=> 'test',requiresHourlyProject:(t:string)=>t==='HOURLY',isRecurrenceOption:()=>false,isServiceDeliveryType:()=>true,serviceSupportsMethod:()=>true,calculateCommerceSelection:()=>({serviceSubtotalCents:8500,selectedAddOns:[]}),calculateBookingFinancialSnapshot:()=>({}),checkAndRecordContent:async()=>{calls.push('safety');return {allowed:false,message:'SAFE FIXTURE STOP'};},database:{query:async(sql:string)=>{assert.match(sql,/SELECT s.id::text/);calls.push('read-service');return {rows:[service]};},connect:()=>{throw Error('FORBIDDEN database write connection');}},NextResponse:{json:(data:unknown,init:{status:number})=>({data,status:init?.status??200})}});
 const clean=source.replace(/^import .*;\r?\n/gm,'').replace(/export async function/g,'async function');
 vm.runInContext(ts.transpile(clean,{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}),context);
 const result=await context.POST(new Request('http://localhost/api/bookings',{method:'POST',body:JSON.stringify({...body,...changes})}));return {result,calls};
}
test('actual server route rejects each missing or invalid in-person address field',async()=>{for(const change of [{addressLine1:''},{city:''},{state:'XX'},{postalCode:'bad'}]){const {result,calls}=await run(change);assert.equal(result.status,400);assert.match(result.data.error,/US service address/);assert.deepEqual(calls,['read-service']);}});
test('actual route preserves required provider-question validation',async()=>{for(const answers of [{},{Required:' '},{Required:'x'.repeat(501)}]){const {result,calls}=await run({answers});assert.equal(result.status,400);assert.match(result.data.error,/Answer every provider question/);assert.deepEqual(calls,['read-service']);}});
test('actual route preserves quote description and hourly-project routing',async()=>{const quote=await run({notes:''},{pricing_type:'QUOTE_ONLY'});assert.equal(quote.result.status,400);assert.match(quote.result.data.error,/Describe/);const hourly=await run({},{pricing_type:'HOURLY'});assert.equal(hourly.result.status,409);assert.equal(hourly.result.data.code,'HOURLY_PROJECT_REQUIRED');});
test('valid corrected and remote-no-address submissions reach safety gate, never write',async()=>{for(const changes of [{},{deliveryMethod:'REMOTE',addressLine1:'',city:'',state:'',postalCode:''}]){const {result,calls}=await run(changes);assert.equal(result.status,422);assert.equal(result.data.error,'SAFE FIXTURE STOP');assert.deepEqual(calls,['read-service','safety']);}});
