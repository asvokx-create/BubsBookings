const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const req=require('node:module').createRequire(__filename), ts=req('typescript');
const root=require('node:path').resolve(__dirname,'..');
const src=p=>fs.readFileSync(require('node:path').join(root,p),'utf8');
function module(file,mods){
 const exports={};vm.runInNewContext(ts.transpileModule(src(file),{compilerOptions:{module:1,target:9}}).outputText,{require:p=>mods[p],exports});return exports;
}
(async()=>{
 const url=new URL(process.env.REMINDER_OCCURRENCE_TEST_DATABASE_URL || 'invalid:');
 // Explicit, dedicated fixture only; never point at normal application DB.
 assert.equal(url.protocol,'postgresql:');
 assert.equal(url.hostname,'127.0.0.1');
 assert.equal(url.port,'55433');
 assert.equal(url.username,'reminder_fixture');
 assert.equal(url.pathname,'/reminder_fixture');
 assert.equal(url.search,'');
 assert.equal(url.hash,'');
 assert.equal(url.password,'reminder_fixture');
 const {Pool}=req('pg');
 const settings={connectionString:url.toString(),connectionTimeoutMillis:5000,statement_timeout:10000,lock_timeout:6000};
 const control=new Pool({...settings,max:1});
 const schema='reminder_synthetic_'+require('node:crypto').randomBytes(8).toString('hex');
 const pool=new Pool({...settings,max:3,options:'-c search_path='+schema});
 let schemaCreated=false,workerClient,movingClient;
 try {
 await control.query('CREATE SCHEMA '+schema);
 schemaCreated=true;
 workerClient=await pool.connect();
 movingClient=await pool.connect();
 const pid=async c=>(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const workerPid=await pid(workerClient);
 assert.notEqual(workerPid,await pid(movingClient));
 for(const client of [workerClient,movingClient]){
   assert.equal((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation,'read committed');
 }
 const db={query:(q,args)=>workerClient.query(q,args),exec:q=>workerClient.query(q)};
 await db.exec(`CREATE TABLE bookings(id uuid PRIMARY KEY,starts_at timestamptz,ends_at timestamptz,status text,reminder_24h_sent_at timestamptz,reminder_1h_sent_at timestamptz,payment_status text,price_cents int,pricing_type_snapshot text,hourly_rate_cents_snapshot int,billable_duration_minutes int,customer_id text,service_id text,provider_id text,reschedule_requested_by text,reschedule_starts_at timestamptz,reschedule_ends_at timestamptz,reschedule_reason text,reschedule_requested_at timestamptz);
 CREATE TABLE services(id text,title text,business_name text); INSERT INTO services VALUES('service','Service','Provider');
 CREATE TABLE provider_profiles(id text,user_id text,plan text); INSERT INTO provider_profiles VALUES('provider','provider-user','pro');
 CREATE TABLE "user"(id text,name text,email text); INSERT INTO "user" VALUES('provider-user','Provider','p@example.invalid'),('customer','Customer','c@example.invalid');
 CREATE TABLE user_settings(user_id text,booking_notifications bool); INSERT INTO user_settings VALUES('customer',true),('provider-user',true);
 CREATE TABLE operations_checks(check_type text,status text,details jsonb);
 INSERT INTO bookings(id,starts_at,ends_at,status,reminder_24h_sent_at,reminder_1h_sent_at,payment_status,customer_id,service_id,provider_id)
 VALUES('00000000-0000-4000-8000-000000000001',now()+'4 days',now()+'4 days 1 hour','confirmed',now(),now(),'paid','customer','service','provider');`);
 await db.exec(src('database/migrations/118_booking_reminder_occurrence.sql'));
 const reschedule=src('app/api/bookings/[bookingId]/reschedule/route.ts').match(/UPDATE bookings SET starts_at=\$2,ends_at=\$3,[^\x60]+/)[0];
 const state=async()=> (await db.query("SELECT starts_at,ends_at,reminder_occurrence::text,reminder_24h_sent_at,reminder_1h_sent_at FROM bookings")).rows[0];
 const first=(await db.query("SELECT (date_trunc('milliseconds',now()) + interval '24h 123 microseconds')::text AS start, (now()+interval '25h')::text AS end")).rows[0];
 const second=(await db.query("SELECT (date_trunc('milliseconds',now()) + interval '24h 15m 456 microseconds')::text AS start, (now()+interval '25h 15m')::text AS end")).rows[0];
 const move=(x, flag)=>movingClient.query(reschedule,['00000000-0000-4000-8000-000000000001',x.start,x.end,flag]);
 await move(first,false); assert.equal((await state()).reminder_occurrence,'0'); assert.ok((await state()).reminder_24h_sent_at);
 await move(second,true); assert.equal((await state()).reminder_occurrence,'1'); assert.equal((await state()).reminder_24h_sent_at,null);
 let dispatched=0, hook;
 const send=async(...args)=>{dispatched++; return hook(...args);};
 let seen=0,beforeFresh;
 const query=async(q,args)=>{if(q.startsWith('SELECT')&&++seen===2&&beforeFresh)await beforeFresh();return db.query(q,args);};
 const worker=module('lib/booking-reminders.ts',{'./database':{database:{query}},'./booking-email':{sendBookingReminder:send},'./email':{isEmailConfigured:()=>true}});
 beforeFresh=()=>move(first,true);
 hook=async()=>true;
 assert.equal((await worker.runBookingReminders()).processed,0);assert.equal(dispatched,0);
 beforeFresh=async()=>movingClient.query("UPDATE user_settings SET booking_notifications=false WHERE user_id='customer'");seen=0;
 hook=async(fresh,hour,revision)=>{assert.equal(fresh.customer_notifications,false);assert.match(fresh.reminder_start_epoch,/\d{6}$/);assert.notEqual(Number(fresh.reminder_start_epoch)*1000,fresh.starts_at.getTime());assert.equal(hour,24);assert.equal(revision,'2');await move(second,true);return true;};
 assert.equal((await worker.runBookingReminders()).processed,0);assert.equal((await state()).reminder_24h_sent_at,null);
 beforeFresh=null;seen=0;
 hook=async(fresh,hour,revision)=>{assert.equal(revision,'3');return true;};
 assert.equal((await worker.runBookingReminders()).processed,1);assert.equal((await worker.runBookingReminders()).processed,0);
 // Cancellation between due selection and fresh read cannot dispatch.
 await move(first,true); seen=0; beforeFresh=()=>movingClient.query("UPDATE bookings SET status='cancelled'");
 const sentBefore=dispatched; assert.equal((await worker.runBookingReminders()).processed,0);assert.equal(dispatched,sentBefore);

 // Hold an actual UPDATE tuple lock through a competing stale marker query.
 // READ COMMITTED EvalPlanQual must recheck the exact identity after release.
 await movingClient.query("UPDATE bookings SET status='confirmed'");
 const lockIdentity=(await workerClient.query(`SELECT id::text, reminder_occurrence::text,
   extract(epoch FROM starts_at)::text AS epoch FROM bookings`)).rows[0];
 const workerSource=src('lib/booking-reminders.ts');
 const exact=workerSource.match(/const exactOccurrence = `([^\x60]+)`/)[1];
 await movingClient.query("BEGIN");
 let stale;
 try {
   await move(second,true);
   stale=workerClient.query(`UPDATE bookings b SET reminder_24h_sent_at=now()
      WHERE ${exact} AND b.status='confirmed' AND b.reminder_24h_sent_at IS NULL`,
      [lockIdentity.id,lockIdentity.reminder_occurrence,lockIdentity.epoch]);
   // Handle a possible bounded DB timeout before the observation finishes.
   void stale.catch(()=>{});
   let observed=false;
   for(let i=0;i<40;i++){
     const activity=await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[workerPid]);
     if(activity.rows[0]?.wait_event_type==='Lock'){observed=true;break;}
     await new Promise(resolve=>setTimeout(resolve,50));
   }
   assert.ok(observed,"stale UPDATE must wait on the held approval row lock");
   await movingClient.query("COMMIT");
 } catch(error) {
   await movingClient.query("ROLLBACK");
   await stale?.catch(()=>{});
   throw error;
 }
 assert.equal((await stale).rowCount,0);
 assert.equal((await state()).reminder_24h_sent_at,null);
 // Both workers are allowed to pass recheck. The same revision and cadence give
 // the same provider key in both captured requests; one DB marker can win.
 let release,reject; const reached=new Promise((r,j)=>{release=r;reject=j;});
 void reached.catch(()=>{});
 const timeout=setTimeout(()=>reject(new Error("Both workers did not reach dispatch")),5000);
 const hits=[];
 const fixedBookingEmail=module('lib/booking-email.ts',{
   './email':{sendTransactionalEmail:async p=>{if(p.emailType.endsWith('_provider'))hits.push(p);return {sent:true};}},
   './service-pricing':{formatDurationMinutes:()=>''},
 });
 let entrants=0;
 const bothSend=async(...args)=>{if(++entrants===2){clearTimeout(timeout);release();}await reached;return fixedBookingEmail.sendBookingReminder(...args);};
 const makeWorker=client=>module('lib/booking-reminders.ts',{
   './database':{database:client},'./booking-email':{sendBookingReminder:bothSend},'./email':{isEmailConfigured:()=>true},
 });
 let jobs;
 try {
   const results=await Promise.allSettled([makeWorker(workerClient).runBookingReminders(),makeWorker(movingClient).runBookingReminders()]);
   jobs=results.map(result=>{if(result.status==='rejected')throw result.reason;return result.value;});
 } finally { clearTimeout(timeout); }
 assert.equal(entrants,2); assert.equal(hits.length,2);
 assert.match(hits[0].idempotencyKey,/^booking-reminder-.*-24h-provider-r[1-9]\d*$/);
 assert.deepEqual(hits[0],hits[1]);
 assert.deepEqual(jobs.map(x=>x.processed).sort(),[0,1]);
 const known=(await state()).reminder_occurrence;
 await move(first,false);
 assert.equal((await state()).reminder_occurrence,known);
 assert.ok((await state()).reminder_24h_sent_at);

 const outgoing=[];
 const email=module('lib/booking-email.ts',{'./email':{sendTransactionalEmail:async p=>{outgoing.push(p);return {sent:true};}},'./service-pricing':{formatDurationMinutes:()=>''}});
 const fixture={id:'fixture',starts_at:new Date(first.start),ends_at:new Date(first.end),payment_status:'paid',price_cents:1000,customer_notifications:true,provider_notifications:true};
 await email.sendBookingReminder(fixture,24,'0');await email.sendBookingReminder(fixture,24,'1');await email.sendBookingReminder(fixture,24,'2');
 assert.ok(!Object.hasOwn(outgoing[0],'idempotencyKey')&&!Object.hasOwn(outgoing[1],'idempotencyKey'));
 assert.equal(outgoing[2].idempotencyKey,'booking-reminder-fixture-24h-customer-r1');
 assert.notEqual(outgoing[2].idempotencyKey,outgoing[3].idempotencyKey);
 assert.notEqual(outgoing[2].idempotencyKey,outgoing[4].idempotencyKey);
 console.log('PASS: actual PostgreSQL separate PIDs, held approval lock with stale mark recheck, two workers use same keys and only one marker, and flag-off retains nonzero revision.');
 } finally {
   workerClient?.release();
   movingClient?.release();
   try {
     await pool.end();
     if(schemaCreated) await control.query("DROP SCHEMA "+schema+" CASCADE");
   } finally { await control.end(); }
 }
})().catch(e=>{console.error(e);process.exitCode=1});
