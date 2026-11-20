import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

// Execute the actual production UPDATE, rather than a copied interval formula.
const source=readFileSync('lib/calendly-call-store.ts','utf8');
const sql=source.match(/`(UPDATE calendly_calls SET last_checked_at=now\(\),next_check_at=now\(\)\+\(GREATEST[^`]+)`/)?.[1];
test('normal polling interval scales with owner workload and excludes terminal/unaccepted calls',async()=>{
 assert.ok(sql);
 const db=new PGlite();
 try{
  await db.exec(`CREATE TABLE calendly_calls(id text PRIMARY KEY,owner_uri text,state text,provider_accepted_at timestamptz,last_checked_at timestamptz,next_check_at timestamptz);`);
  for(const count of [11,30,70,150,400]){
   await db.exec('TRUNCATE calendly_calls');
   await db.query(`INSERT INTO calendly_calls SELECT n::text,'owner','confirmed',now(),NULL,NULL FROM generate_series(1,$1::int) n`,[count]);
   await db.exec(`INSERT INTO calendly_calls VALUES('other','other-owner','confirmed',now(),NULL,NULL),('closed','owner','completed',now(),NULL,NULL),('cancelled','owner','cancelled',now(),NULL,NULL),('failed','owner','failed',now(),NULL,NULL),('unaccepted','owner','requested',NULL,NULL,NULL);`);
   await db.query(sql,['1','owner']);
   const interval=(await db.query<{seconds:number}>('SELECT extract(epoch FROM next_check_at-last_checked_at)::int seconds FROM calendly_calls WHERE id=$1',['1'])).rows[0].seconds;
   assert.equal(interval,Math.max(300,count*12));
   // Worst initial burst: all calls due together. Each successful mapping uses
   // two GETs against the shared20/min budget; rejected attempts retry in60s.
   const queue=Array.from({length:count},(_,id)=>({id,due:0,checked:0}));
   let window=-1,requests=0;
   for(let now=0;now<=interval*4;now+=30){
    const current=Math.floor(now/60);if(current!==window){window=current;requests=0;}
    const due=queue.filter(c=>c.due<=now).sort((a,b)=>a.due-b.due||a.id-b.id).slice(0,20);
    for(const call of due){
     if(requests+2<=20){requests+=2;call.checked++;call.due=now+interval;}
     else call.due=now+60;
    }
   }
   assert.ok(queue.every(c=>c.checked>=2),`every one of ${count} calls must recover and get routine rechecks`);
  }
 }finally{await db.close();}
});

test('review retries back off and due claims prioritize older attempts over repeated failures',async()=>{
 const schedule=source.match(/`(UPDATE calendly_calls target SET last_checked_at=CASE[^`]+)`/)?.[1];
 const claim=readFileSync('lib/calendly-call-runtime.ts','utf8').match(/`(WITH due AS[^`]+)`/)?.[1];
 const defer=source.match(/`(UPDATE calendly_calls SET calendar_check_pending=true[^`]+)`/)?.[1];
 assert.ok(schedule);assert.ok(claim);assert.ok(defer);
 const db=new PGlite();
 try{
  await db.exec(`CREATE TABLE calendly_calls(id text PRIMARY KEY,owner_uri text,state text,provider_accepted_at timestamptz,last_checked_at timestamptz,next_check_at timestamptz,created_at timestamptz DEFAULT now(),calendar_check_pending boolean DEFAULT false);
   INSERT INTO calendly_calls(id,owner_uri,state,provider_accepted_at,last_checked_at,next_check_at) SELECT n::text,'owner',CASE WHEN n<=10 THEN 'review' ELSE 'confirmed' END,now(),now()-interval '1 minute',now()-interval '1 minute' FROM generate_series(1,30) n;`);
  await db.query(schedule,['1',60]);
  const delay=(await db.query<{seconds:number}>(`SELECT extract(epoch FROM next_check_at-last_checked_at)::int seconds FROM calendly_calls WHERE id='1'`)).rows[0].seconds;
  assert.equal(delay,360,'review calls must not consume the owner budget every minute');
  await db.query(defer,['20','owner']);
  assert.equal((await db.query<{seconds:number}>(`SELECT extract(epoch FROM next_check_at-last_checked_at)::int seconds FROM calendly_calls WHERE id='20'`)).rows[0].seconds,360,'transient retry interval must scale under heavy owner load');
  const localDefer=source.match(/"(UPDATE calendly_calls SET calendar_check_pending=true[^"]+)"/)?.[1];
  assert.ok(localDefer);
  await db.exec(`UPDATE calendly_calls SET last_checked_at='2026-01-01T00:00Z' WHERE id='20'`);
  await db.query(localDefer,['20']);
  const local=(await db.query<{preserved:boolean;aligned:boolean;delay:number}>(`SELECT last_checked_at='2026-01-01T00:00Z'::timestamptz preserved,next_check_at=date_trunc('minute',next_check_at) aligned,extract(epoch FROM next_check_at-now()) delay FROM calendly_calls WHERE id='20'`)).rows[0];
  assert.equal(local.preserved,true);assert.equal(local.aligned,true);assert.ok(local.delay>0&&local.delay<=60);
  // Recently attempted transient calls have an earlier due deadline, but must
  // not precede older never-checked appointments that have also become due.
  await db.exec(`UPDATE calendly_calls SET next_check_at=now()-interval '5 minutes',last_checked_at=now()-interval '1 minute'; UPDATE calendly_calls SET last_checked_at=NULL,next_check_at=now()-interval '1 second' WHERE id::int>10;`);
  const claimed=await db.query<{id:string}>(claim);
  assert.equal(claimed.rows.length,20);
  assert.ok(claimed.rows.every(r=>Number(r.id)>10));
 }finally{await db.close();}
 // Model repeated two-GET failures plus review traffic, not only all-success.
 for(const count of [30,70,150]){
  const interval=Math.max(300,count*12);
  const queue=Array.from({length:count},(_,id)=>({id,due:0,last:-1,checked:0}));
  let window=-1,requests=0;
  for(let now=0;now<=interval*6;now+=30){
   const current=Math.floor(now/60);if(current!==window){window=current;requests=0;}
   for(const call of queue.filter(c=>c.due<=now).sort((a,b)=>a.last-b.last||a.due-b.due||a.id-b.id).slice(0,20)){
    if(requests+2<=20){requests+=2;call.last=now;call.checked++;call.due=now+(call.id>=10&&call.id<20?Math.max(60,count*12):interval);}
    else if(call.id<10){call.last=now;call.due=now+interval;}
    else call.due=(Math.floor(now/60)+1)*60;
   }
  }
  assert.ok(queue.filter(c=>c.id>=20).every(c=>c.checked>=2),`healthy calls recover despite review and transient traffic at ${count} calls`);
 }
});
