import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
class CallRequestError extends Error{status:number;constructor(message:string,status=409){super(message);this.status=status;}}
class CallCancellationError extends Error{status=409;}
type Result={body:unknown;status:number};
function fixture(options:{enabled?:boolean;recovery?:boolean;session?:boolean;age?:boolean;origin?:boolean;rate?:boolean}={}){
 const o={enabled:true,recovery:false,session:true,age:true,origin:true,rate:true,...options};let invoked=0;
 const exports={} as {callRoute:(request:Request,mutating:boolean,action:()=>Promise<unknown>,existing?:boolean)=>Promise<Result>};
 const mocks:Record<string,unknown>={
 'next/headers':{headers:async()=>new Headers()},'next/server':{NextResponse:{json:(body:unknown,init:{status?:number}={})=>({body,status:init.status??200})}},
 '@/lib/auth':{auth:{api:{getSession:async()=>o.session?{user:{id:'synthetic',email:'test@example.com'}}:null}}},
 '@/lib/account-age':{hasConfirmedAge:async()=>o.age},'@/lib/request-origin':{hasTrustedRequestOrigin:()=>o.origin},'@/lib/request-security':{enforceRateLimit:async()=>o.rate},
 '@/lib/calendly-call-cancellation':{CallCancellationError},'@/lib/calendly-call-offers':{CallRequestError,requireCallsEnabled:()=>{if(!o.enabled)throw new CallRequestError('disabled',404);},requireExistingCallsEnabled:()=>{if(!o.enabled&&!o.recovery)throw new CallRequestError('disabled',404);}}};
 vm.runInNewContext(ts.transpileModule(readFileSync('lib/calendly-call-route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:(name:string)=>{if(!(name in mocks))throw Error(name);return mocks[name];}});
 return {run:(mutating=true,existing=false,action?:()=>Promise<unknown>)=>exports.callRoute(new Request('https://example.com/api/calendly-calls'),mutating,action??(async()=>{invoked++;return {ok:true};}),existing),invoked:()=>invoked};
}
test('call API guard blocks disabled, anonymous, underage, cross-origin and rate-limited requests before action',async()=>{
 for(const [options,status] of [[{enabled:false},404],[{session:false},401],[{age:false},403],[{origin:false},403],[{rate:false},429]] as const){const f=fixture(options);assert.equal((await f.run()).status,status);assert.equal(f.invoked(),0);}
});
test('recovery only allows explicitly existing endpoints, still authenticated',async()=>{const f=fixture({enabled:false,recovery:true});assert.equal((await f.run(false,true)).status,200);assert.equal((await f.run(true,false)).status,404);assert.equal((await f.run(true,true)).status,200);assert.equal(f.invoked(),2);const anonymous=fixture({enabled:false,recovery:true,session:false});assert.equal((await anonymous.run(false,true)).status,401);});
test('read does not require mutation origin, mutations do; typed cancellation conflicts preserved without leaking unexpected errors',async()=>{const f=fixture({origin:false});assert.equal((await f.run(false)).status,200);assert.equal((await f.run(true)).status,403);const allowed=fixture();const conflict=await allowed.run(true,true,async()=>{throw new CallCancellationError('Refresh policy.');});assert.equal(conflict.status,409);assert.equal((conflict.body as {error:string}).error,'Refresh policy.');const failure=await allowed.run(true,true,async()=>{throw Error('private upstream payload');});assert.equal(failure.status,400);assert.ok(!JSON.stringify(failure.body).includes('private upstream payload'));});
