import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("homepage listing cards show real provider avatars and verified review evidence", () => {
  const homepage = read("components/service-listing-card.tsx");
  const marketplace = read("lib/marketplace.ts");

  assert.match(homepage, /ProfileAvatar name=\{service\.provider\} imageUrl=\{service\.providerProfileImageUrl\}/);
  assert.match(homepage, /providerCardReviewDisplay\(service\)/);
  assert.match(homepage, /providerReview\.count\} verified/);
  assert.doesNotMatch(homepage, /New provider/);
  assert.match(marketplace, /owner\.image AS provider_profile_image_url/);
  assert.match(marketplace, /review\.provider_id = p\.id AND review\.is_hidden = false/);
});
