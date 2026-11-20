import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendlyCallOnce, prepareCalendlyCall, readCalendlyCallOffer, readMappedCalendlyCall, reconcileCalendlyCall, cancelMappedCalendlyCall, CalendlyCallTransportError, CalendlyCallOutcomeError, type CalendlyCallIdentity, type CalendlyCallTransport } from '../lib/calendly-call-api.ts';
const identity: CalendlyCallIdentity = {connectionId:'c',providerId:'p',ownerUri:'https://api.calendly.com/users/owner',connectedAt:'generation',eventTypeUri:'https://api.calendly.com/event_types/type',startTime:'2027-01-10T12:00:00Z',endTime:'2027-01-10T12:30:00Z',operationId:'00000000-0000-4000-8000-000000000001',invitee:{name:'Synthetic Test',email:'test@example.com',timezone:'UTC'}};
const refs={eventUri:'https://api.calendly.com/scheduled_events/event',inviteeUri:'https://api.calendly.com/scheduled_events/event/invitees/invitee'};
const config=()=>({uri:identity.eventTypeUri,name:'Consultation',active:true,secret:false,kind:'solo',pooling_type:null,profile:{type:'User',owner:identity.ownerUri},is_paid:false,duration:30,locations:[{kind:'zoom_conference'}],custom_questions:[],before_buffer:5,after_buffer:10});
const scheduled=()=>({uri:refs.eventUri,event_type:identity.eventTypeUri,start_time:identity.startTime,end_time:identity.endTime,event_memberships:[{user:identity.ownerUri}],invitees_counter:{limit:1,active:1,total:1},status:'active',location:{type:'zoom',status:'pushed',join_url:'https://us02web.zoom.us/j/123456789?pwd=test'}});
const attendee=()=>({uri:refs.inviteeUri,event:refs.eventUri,email:identity.invitee.email,timezone:'UTC',status:'active',tracking:{utm_source:'bubsbookings',utm_content:`bubs-call-${identity.operationId}`}});
function harness(options: {config?:object,event?:object,invitee?:object,slots?:unknown[],postError?:Error,malformed?:boolean,cancelWorks?:boolean,events?:unknown[],invitees?:unknown[]}={}) {
 const calls:{method:string,path:string,body?:unknown}[]=[]; let canceled=false;
 const send:CalendlyCallTransport=async(method,path,body)=>{calls.push({method,path,body});
 if(method==='POST'){if(options.postError)throw options.postError;if(path.endsWith('/cancellation')){canceled=options.cancelWorks??true;return {resource:{}};}return options.malformed?{}:{resource:attendee()};}
 if(path.startsWith('/event_types/'))return{resource:{...config(),...options.config}};
 if(path.startsWith('/event_type_available_times'))return{collection:options.slots??[{start_time:identity.startTime,status:'available',invitees_remaining:1}]};
 if(path.startsWith('/scheduled_events?'))return{collection:options.events??[],pagination:{next_page_token:null}};
 if(path.includes('/invitees?'))return{collection:options.invitees??[attendee()],pagination:{next_page_token:null}};
 if(path===new URL(refs.inviteeUri).pathname)return{resource:{...attendee(),...(canceled?{status:'canceled'}:{}),...options.invitee}};
 if(path===new URL(refs.eventUri).pathname)return{resource:{...scheduled(),...(canceled?{status:'canceled'}:{}),...options.event}};
 throw Error('Unexpected path '+path);};return{send,calls};
}
const outcome=(expected:string)=>(error:unknown)=>error instanceof CalendlyCallOutcomeError&&error.outcome===expected;
test('preflight verifies exact available slot and includes buffers',async()=>{const h=harness();assert.deepEqual(await prepareCalendlyCall(h.send,identity,0),{bufferedStartTime:'2027-01-10T11:55:00.000Z',bufferedEndTime:'2027-01-10T12:40:00.000Z'});assert.equal(h.calls.every(c=>c.method==='GET'),true);});
test('publishing fails closed for paid, group, wrong owner, required questions and missing buffers',async()=>{for(const config of [{is_paid:true},{is_paid:undefined},{kind:'group'},{profile:{type:'User',owner:'other'}},{custom_questions:[{enabled:true,required:true}]},{before_buffer:undefined},{locations:[{kind:'custom'}]},{duration_options:[15,30]}]){const h=harness({config});await assert.rejects(readCalendlyCallOffer(h.send,identity.ownerUri,identity.eventTypeUri));}});
test('changed event or unavailable slot never dispatches a create',async()=>{for(const options of [{config:{is_paid:true}},{slots:[]},{config:{after_buffer:undefined}},{config:{custom_questions:[{enabled:true,name:'Question',position:0}]}}]){const h=harness(options);await assert.rejects(createCalendlyCallOnce(h.send,identity,0),outcome('not_sent'));assert.equal(h.calls.filter(c=>c.method==='POST').length,0);}});
test('one create dispatch carries opaque tracking and verifies authoritative Zoom mapping',async()=>{const h=harness();const mapped=await createCalendlyCallOnce(h.send,identity,0);assert.equal(mapped.meetingStatus,'ready');assert.equal(mapped.ownerUri,identity.ownerUri);const writes=h.calls.filter(c=>c.method==='POST');assert.equal(writes.length,1);assert.deepEqual((writes[0].body as {tracking:unknown}).tracking,{utm_source:'bubsbookings',utm_content:`bubs-call-${identity.operationId}`});});
test('timeout, server error and malformed success remain unknown without retry',async()=>{for(const options of [{postError:new CalendlyCallTransportError(true)},{postError:new CalendlyCallTransportError(true,503)},{malformed:true}]){const h=harness(options);await assert.rejects(createCalendlyCallOnce(h.send,identity,0),outcome('unknown'));assert.equal(h.calls.filter(c=>c.method==='POST').length,1);}});
test('explicit rejection and undispatched transport failure are distinguished',async()=>{for(const [error,result] of [[new CalendlyCallTransportError(true,400),'rejected'],[new CalendlyCallTransportError(false),'not_sent']] as const){await assert.rejects(createCalendlyCallOnce(harness({postError:error}).send,identity,0),outcome(result));}});
test('pending video never becomes a ready meeting',async()=>{const h=harness({event:{location:{type:'zoom',status:'processing'}}});const mapped=await createCalendlyCallOnce(h.send,identity,0);assert.equal(mapped.meetingStatus,'pending');assert.equal(mapped.meetingUrl,null);});
test('full mapping rejects owner, email, marker, time and foreign invitee mismatch',async()=>{for(const options of [{event:{event_memberships:[{user:'other'}]}},{invitee:{email:'other@example.com'}},{invitee:{tracking:{utm_source:'bubsbookings',utm_content:'wrong'}}},{event:{start_time:identity.endTime}}])await assert.rejects(readMappedCalendlyCall(harness(options).send,identity,refs));await assert.rejects(readMappedCalendlyCall(harness().send,identity,{...refs,inviteeUri:'https://api.calendly.com/scheduled_events/other/invitees/invitee'}));});
test('no search result cannot prove absence; exact marker is required',async()=>{assert.deepEqual(await reconcileCalendlyCall(harness().send,identity),{status:'unknown'});assert.deepEqual(await reconcileCalendlyCall(harness({events:[scheduled()],invitees:[{...attendee(),tracking:{utm_content:'other'}}]}).send,identity),{status:'unknown'});assert.equal((await reconcileCalendlyCall(harness({events:[scheduled()]}).send,identity)).status,'found');assert.equal((await reconcileCalendlyCall(harness({events:[scheduled(),scheduled()]}).send,identity)).status,'ambiguous');});
test('cancellation targets only verified mapping and requires authoritative canceled read',async()=>{const h=harness();assert.equal((await cancelMappedCalendlyCall(h.send,identity,refs)).status,'canceled');assert.equal(h.calls.filter(c=>c.method==='POST')[0].path,'/scheduled_events/event/cancellation');const bad=harness({invitee:{email:'other@example.com'}});await assert.rejects(cancelMappedCalendlyCall(bad.send,identity,refs),outcome('not_sent'));assert.equal(bad.calls.filter(c=>c.method==='POST').length,0);await assert.rejects(cancelMappedCalendlyCall(harness({cancelWorks:false}).send,identity,refs),outcome('unknown'));});
test('already canceled mapping has no cancellation write',async()=>{const h=harness({event:{status:'canceled'},invitee:{status:'canceled'}});assert.equal((await cancelMappedCalendlyCall(h.send,identity,refs)).status,'canceled');assert.equal(h.calls.filter(c=>c.method==='POST').length,0);});
test('untrusted meeting links never appear as ready',async()=>{for(const join_url of ['https://zoom.us.attacker.example/j/123','http://zoom.us/j/123','https://user@zoom.us/j/123']){const result=await readMappedCalendlyCall(harness({event:{location:{type:'zoom',status:'pushed',join_url}}}).send,identity,refs);assert.equal(result.meetingUrl,null);assert.notEqual(result.meetingStatus,'ready');}});
test('create rechecks persisted buffer snapshot before dispatch',async()=>{const h=harness();await assert.rejects(createCalendlyCallOnce(h.send,{...identity,expectedBuffers:{beforeMinutes:0,afterMinutes:10}},0),outcome('not_sent'));assert.equal(h.calls.filter(c=>c.method==='POST').length,0);});
test('unsafe reconciliation pagination is unknown, never follows supplied URL',async()=>{const paths:string[]=[];const send:CalendlyCallTransport=async(_method,path)=>{paths.push(path);return{collection:[],pagination:{next_page:'https://attacker.example/credentials'}};};assert.deepEqual(await reconcileCalendlyCall(send,identity),{status:'unknown'});assert.equal(paths.length,1);assert.ok(paths[0].startsWith('/scheduled_events?'));});
test('cancel timeout is unknown and never automatically retries',async()=>{const h=harness({postError:new CalendlyCallTransportError(true)});await assert.rejects(cancelMappedCalendlyCall(h.send,identity,refs),outcome('unknown'));assert.equal(h.calls.filter(c=>c.method==='POST').length,1);});
test('only temporary GET transport failures return unavailable for mapped and discovery reads',async()=>{
 for(const error of [new CalendlyCallTransportError(true),new CalendlyCallTransportError(true,408),new CalendlyCallTransportError(true,429),new CalendlyCallTransportError(false,429),new CalendlyCallTransportError(true,500),new CalendlyCallTransportError(true,503)]){
  const read:CalendlyCallTransport=async()=>{throw error;};
  assert.equal((await reconcileCalendlyCall(read,identity,refs)).status,'unavailable');
  assert.equal((await reconcileCalendlyCall(read,identity)).status,'unavailable');
 }
 for(const error of [new CalendlyCallTransportError(false),new CalendlyCallTransportError(true,200),new CalendlyCallTransportError(true,401),new CalendlyCallTransportError(true,403),new CalendlyCallTransportError(true,404),new Error('Malformed or identity mismatch')]){
  assert.equal((await reconcileCalendlyCall(async()=>{throw error;},identity,refs)).status,'unknown');
 }
 assert.equal((await reconcileCalendlyCall(async()=>({resource:{}}),identity,refs)).status,'unknown');
});
test('temporary candidate GET is unavailable, but invalid candidate identity remains ambiguous',async()=>{
 const h=harness({events:[scheduled()]});
 assert.equal((await reconcileCalendlyCall(async(method,path,body)=>{
  if(path===new URL(refs.eventUri).pathname)throw new CalendlyCallTransportError(true,503);
  return h.send(method,path,body);
 },identity)).status,'unavailable');
 assert.equal((await reconcileCalendlyCall(harness({events:[scheduled()],event:{event_memberships:[{user:'wrong'}]}}).send,identity)).status,'ambiguous');
});
test('only local undispatched 429 supplies localRateLimited metadata',async()=>{
 assert.deepEqual(await reconcileCalendlyCall(async()=>{throw new CalendlyCallTransportError(false,429);},identity,refs),{status:'unavailable',localRateLimited:true});
 for(const error of [new CalendlyCallTransportError(true,429),new CalendlyCallTransportError(true,503),new CalendlyCallTransportError(true)]){
  assert.deepEqual(await reconcileCalendlyCall(async()=>{throw error;},identity,refs),{status:'unavailable'});
 }
});
