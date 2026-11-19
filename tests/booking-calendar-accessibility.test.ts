import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../components/booking-date-picker.tsx',import.meta.url),'utf8');
test('booking calendar has shared focus lifecycle and roving row semantics',()=>{
 assert.match(source,/useModalAccessibility<HTMLDivElement>\(open/);
 assert.match(source,/tabIndex=\{active \? 0 : -1\}/);
 assert.match(source,/role="row"/);
 assert.match(source,/data-modal-autofocus=\{active/);
 assert.match(source,/shiftDateOnlyMonths/);
 assert.doesNotMatch(source,/requestAnimationFrame/);
 assert.match(source,/Preferred date: Select a date/);
 assert.match(source,/if \(controller.signal.aborted\) return;\s+setAvailability/);
 assert.match(source,/\$\{serviceId\}:\$\{availabilityBaseUrl/);
});
test('reschedule parent owns its time portal and error announcement',()=>{
 const s=readFileSync(new URL('../components/booking-details.tsx',import.meta.url),'utf8');
 assert.match(s,/booking && rescheduleOpen && !booking.hourlyProjectId && booking.viewerRole !== "worker"/);
 const line=s.split(/\r?\n/).find(l=>l.includes('aria-labelledby="reschedule-title"'))!;
 assert.match(line,/ref=\{rescheduleDialogRef\}/);
 assert.match(line,/getPortalContainer=\{\(\) => rescheduleDialogRef.current\}/);
 assert.match(line,/role="alert"/);
});
