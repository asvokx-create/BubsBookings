/* eslint-disable @typescript-eslint/no-explicit-any -- Isolated CommonJS harness mocks every external boundary. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import * as api from '../lib/calendly-api.ts';
import * as callApi from '../lib/calendly-call-api.ts';
import {hasCalendlyEventTypeReadScope} from '../lib/calendly-event-availability.ts';
const nativeRequire=createRequire(import.meta.url);
const binding={connectionId:'c',providerId:'p',ownerUri:'https://api.calendly.com/users/owner',connectedAt:'generation'};
function harness(options:{enabled?:boolean,recovery?:boolean,scope?:string,generation?:string,status?:number,fail?:boolean,changedAfterAuth?:boolean}={}){
 const calls:any[]=[];let connections=0,reads=0;
 const row:any={id:'c',provider_id:'p',calendly_user_uri:binding.ownerUri,connected_at:options.generation??'generation',granted_scope:options.scope??'event_types:read scheduled_events:read scheduled_events:write',token_expires_at:new Date(Date.now()+3600000)};
 const database={query:async()=>{reads++;return{rows:[{...row,...(options.changedAfterAuth&&reads>1?{connected_at:'new-generation'}:{})}]};},connect:async()=>{connections++;return{query:async(sql:string)=>({rows:sql.includes('SELECT')?[row]:[]}),release(){}};}};
 const exports:any={};
 const env={CALENDLY_ENCRYPTION_KEY:'synthetic-test-only',CALENDLY_CALL_BOOKINGS_ENABLED:options.enabled===false?'false':'true',CALENDLY_CALL_RECOVERY_ENABLED:options.recovery?'true':'false'};
 const fetch=async(url:URL,init:any)=>{calls.push({url:String(url),init});if(options.fail)throw Error('Synthetic timeout');return new Response(JSON.stringify({resource:{}}),{status:options.status??200});};
 const source=ts.transpileModule(readFileSync('lib/calendly.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','exports','process','fetch',source)((id:string)=>{
  if(id==='server-only')return{};if(id==='node:crypto')return nativeRequire(id);if(id==='@/lib/database')return{database};if(id==='@/lib/calendly-api')return api;if(id==='@/lib/calendly-call-api')return callApi;if(id==='@/lib/calendly-event-availability')return{hasCalendlyEventTypeReadScope};if(id==='@/lib/request-security')return{enforceRateLimit:async()=>true};if(id==='@/lib/calendly-webhook')return{};throw Error('Unexpected import '+id);
 },exports,{env},fetch);
 row.access_token_encrypted=exports.encryptCalendlySecret('synthetic-access-token');
 return{send:(method:string,path:string)=>exports.calendlyCallRequest(binding,method,path),preview:(path:string)=>exports.calendlyPreviewRead(binding.connectionId,binding.ownerUri,path,new Request('https://example.test/preview')),calls,connections:()=>connections};
}
test('disabled call feature blocks before token access or fetch',async()=>{const h=harness({enabled:false});await assert.rejects(h.send('POST','/invitees'));assert.equal(h.connections(),0);assert.equal(h.calls.length,0);});
test('recovery-only mode allows reads and cancellations but cannot create invitees',async()=>{const h=harness({enabled:false,recovery:true});await h.send('GET','/scheduled_events/event');await h.send('POST','/scheduled_events/event/cancellation');await assert.rejects(h.send('POST','/invitees'));assert.equal(h.calls.length,2);});
test('missing grants or mismatched generation block before credential access',async()=>{for(const options of [{scope:'scheduled_events:read'},{generation:'different'}]){const h=harness(options);await assert.rejects(h.send('POST','/invitees'));assert.equal(h.connections(),0);assert.equal(h.calls.length,0);}});
test('generation is rechecked after token acquisition before send',async()=>{const h=harness({changedAfterAuth:true});await assert.rejects(h.send('POST','/invitees'));assert.equal(h.connections(),1);assert.equal(h.calls.length,0);});
test('mutation fetch has no automatic retry, no redirects, and no caching',async()=>{const h=harness({fail:true});await assert.rejects(h.send('POST','/invitees'),(e:unknown)=>e instanceof callApi.CalendlyCallTransportError&&e.dispatched);assert.equal(h.calls.length,1);assert.equal(h.calls[0].init.redirect,'error');assert.equal(h.calls[0].init.cache,'no-store');});
test('unapproved endpoint and wrong-owner list never obtain a token',async()=>{const h=harness();for(const path of ['/users/me','/scheduled_events?user=other','https://attacker.example/invitees'])await assert.rejects(h.send('GET',path));assert.equal(h.connections(),0);assert.equal(h.calls.length,0);});

test('preview transport remains GET-only with read grant and rejects booking endpoints before auth',async()=>{const h=harness({scope:'event_types:read',enabled:false});for(const path of ['/invitees','/scheduled_events/event/cancellation','https://attacker.example/event_types/test'])await assert.rejects(h.preview(path));assert.equal(h.connections(),0);assert.equal(h.calls.length,0);await h.preview('/event_types/test');assert.equal(h.calls.length,1);assert.equal(h.calls[0].init.method,'GET');assert.equal(h.calls[0].init.redirect,'error');});
