import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const read=(p:string)=>readFileSync(new URL(`../${p}`,import.meta.url),'utf8');
test('booking dialogs have guarded modal lifecycle and errors inside each form',()=>{
 const s=read('components/booking-details.tsx');
 for(const [id,ref] of [['cancel','cancelDialogRef'],['duration-change','durationDialogRef'],['quote','quoteDialogRef']]) {
  const line=s.split(/\r?\n/).find(l=>l.includes(`aria-labelledby="${id}-title"`))!;
  assert.ok(line.includes(`ref={${ref}} tabIndex={-1}`));
  assert.ok(line.includes('<p role="alert"'));
 }
 assert.match(s,/Boolean\(booking && durationChangeOpen && booking.pricing.type === "HOURLY"\)/);
 assert.match(s,/Boolean\(booking && quoteOpen && booking.viewerRole === "provider"\)/);
});
test('onboarding step transitions and availability controls expose focus and state',()=>{
 const s=read('app/providers/join/onboarding-form.tsx');
 assert.match(s,/if \(previousStepRef.current === step\) return/);
 assert.match(s,/ref=\{stepHeadingRef\} tabIndex=\{-1\} aria-describedby=\{stepStatusId\}/);
 assert.match(s,/aria-label="Custom service category"/);
 assert.match(s,/aria-pressed=\{enabled\} aria-label=\{`\$\{day\} availability`\}/);
 assert.match(s,/aria-label=\{`\$\{day\}: Open 24 hours`\}/);
 assert.match(s,/grid-cols-1 items-center gap-2 sm:grid-cols-\[minmax\(0,1fr\)_auto_minmax\(0,1fr\)\]/);
 assert.match(read('app/globals.css'),/\.provider-onboarding label:has\(input\[type="radio"\]:focus-visible\)/);
});
