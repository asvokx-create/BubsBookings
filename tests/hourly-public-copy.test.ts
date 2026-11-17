import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const card=readFileSync("components/service-listing-card.tsx","utf8");
const page=readFileSync("app/services/[slug]/page.tsx","utf8");
test("shared public hourly cards describe tracked projects without legacy minimums",()=>{
 assert.match(card,/service\.pricingType === "HOURLY"\s*\? "tracked project"/);
 assert.doesNotMatch(card,/formatDurationMinutes|\} minimum/);
 assert.match(readFileSync("app/page.tsx","utf8"),/ServiceListingCard/);
 assert.match(readFileSync("app/services/page.tsx","utf8"),/#nearby-listings/);
});
test("hourly detail uses project corrections and one final payment instead of appointment terms",()=>{
 assert.match(page,/service\.pricingType === "HOURLY" \? <div[^>]*><p[^>]*>Project hours and corrections/);
 assert.match(page,/rounded up once to the next whole minute, with no minimum hours purchase/);
 assert.match(page,/request any corrections before approving/);
 assert.match(page,/no timer is running and no tracked time remains/);
 assert.match(page,/single \$2\.99 customer service fee/);
 assert.match(page,/: <div[^>]*><p[^>]*>Cancellation policy/);
 assert.match(page,/\{service\.cancellationPolicy\}/);
 assert.match(page,/\{service\.noShowPolicy\}/);
});
test("legacy booking details retain their historical hourly duration terms",()=>{
 const legacy=readFileSync("components/booking-details.tsx","utf8");
 assert.match(legacy,/booking\.pricing\.minimumDurationMinutes/);
 assert.match(legacy,/booking\.pricing\.billingIncrementMinutes/);
});
