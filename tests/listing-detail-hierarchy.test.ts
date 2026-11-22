import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const listing = readFileSync(new URL("../app/services/[slug]/page.tsx", import.meta.url), "utf8");
const bookingJump = readFileSync(new URL("../app/services/[slug]/booking-jump-link.tsx", import.meta.url), "utf8");

test("listing title, delivery, starting price and booking jump precede the gallery", () => {
  const content = listing.slice(listing.indexOf('return (\n    <main'));
  const positions = ["{service.title}</h1>", "{deliveryLabel(service.deliveryType)}", '"From " + startingPrice',
    "<BookingJumpLink quoteOnly=", "<ListingPhotoGallery", 'id="listing-booking"'].map((fragment) => content.indexOf(fragment));
  assert.ok(positions.every((pos, i) => pos !== -1 && (i === 0 || pos > positions[i - 1])));
  assert.match(content, /<aside id="listing-booking" aria-label="Booking options" tabIndex=\{-1\}[^>]*>\s*<StationaryBookingPanel/);
  assert.equal((content.match(/<BookingCard /g) ?? []).length, 1);
  assert.match(bookingJump, /href=\{"#" \+ targetId\}/);
  assert.match(bookingJump, /event\.preventDefault\(\);[\s\S]*booking\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(bookingJump, /router\.|history\.|location\.hash/);
});

test("listing detail avoids inferring tenure while preserving listing content and genuine review evidence", () => {
  assert.doesNotMatch(listing, /New listing|averageRating === null \? "New"|business-location-help|Listing \{service\.imageUrls/);
  assert.match(listing, /<ListingPhotoGallery images=\{service\.imageUrls\} title=\{service\.title\}/);
  assert.match(listing, /<FavoriteButton serviceId=\{service\.id\}/);
  assert.match(listing, /\{service\.description\}<\/p>/);
  assert.match(listing, /service\.remoteDeliveryDetails \|\|/);
  assert.match(listing, /No verified reviews yet/);
  assert.match(listing, /\{service\.averageRating\.toFixed\(1\)\}.*out of 5 stars/);
  assert.match(listing, /\{service\.reviewCount\} verified/);
  assert.match(listing, /\{service\.cancellationPolicy\}/);
  assert.match(listing, /\{service\.noShowPolicy\}/);
});
