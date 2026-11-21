import test from "node:test";
import assert from "node:assert/strict";
import { isRelatedListingDeparture, listingSlugFromReturnHash, marketplaceReturnPath, readListingReturn, returnViewportTop } from "../lib/listing-return.ts";

test("scoped return supports published local and remote filters", () => {
  const local="/?category=Car+detailing&location=Issaquah%2C+WA&radius=25&showFilters=1#nearby-listings";
  assert.equal(marketplaceReturnPath(local,"full-car-detail"), local.replace("&showFilters=1#nearby-listings","#return-to-listing-full-car-detail"));
  assert.equal(marketplaceReturnPath("/services?delivery=REMOTE&sort=rating&maxPrice=100&maxDuration=120&showFilters=1&showFilters=0#nearby-listings","call-a"),"/?delivery=REMOTE&sort=rating&maxPrice=100&maxDuration=120#return-to-listing-call-a");
  assert.equal(marketplaceReturnPath("/?q=a%20b&category=A&category=B","thing"),"/?q=a%20b&category=A&category=B#return-to-listing-thing");
});

test("unrelated, malformed and external return paths are rejected", () => {
  for (const url of [undefined,"//evil.test","/\\evil.test","https://evil.test","/providers","/services/private","/services-malicious","/services//","/./services","/%2f/","/\t/evil.test"]) {
    assert.equal(marketplaceReturnPath(url,"sample"), null, String(url));
  }
});

test("invalid or ordinary fragments cannot target a listing", () => {
  assert.equal(listingSlugFromReturnHash("#nearby-listings"),null);
  assert.equal(listingSlugFromReturnHash("#return-to-listing-/bad"),null);
  assert.equal(listingSlugFromReturnHash("#return-to-listing-selected-1"),"selected-1");
  assert.equal(marketplaceReturnPath("/?delivery=REMOTE", "#anything"),"/?delivery=REMOTE#nearby-listings");
});

test("history state is scoped to the exact source query and valid geometry", () => {
  const path="/?category=A&sort=rating#nearby-listings";
  const saved={path,kind:"title",slug:"selected-1",top:300,width:390,height:780} as const;
  assert.deepEqual(readListingReturn(saved,path),saved);
  assert.equal(readListingReturn(saved,"/?category=B"),null);
  assert.equal(readListingReturn(saved,"/?category=A&sort=rating#return-to-listing-other"),null);
  assert.equal(readListingReturn({...saved,kind:"provider"},path),null);
  assert.equal(readListingReturn({...saved,top:Infinity},path),null);
});

test("restore real visible offset when safe, clamp a clipped link, center after reflow", () => {
  assert.equal(returnViewportTop({top:385,width:390,height:780},390,780,30),385);
  assert.equal(returnViewportTop({top:-40,width:390,height:780},390,780,260),16);
  assert.equal(returnViewportTop({top:800,width:390,height:780},390,780,30),734);
  assert.equal(returnViewportTop({top:300,width:390,height:780},650,780,30),260);
  assert.equal(returnViewportTop(null,390,780,30),260);
});

test("visible Back trusts only the actual preceding same-origin result entry", () => {
  const from="/?delivery=REMOTE";
  const to="/services/card-1?from=abc";
  const entry={index:0,key:"original",url:"https://marketplace.invalid"+from};
  const currentEntry={index:1,key:"detail",url:"https://marketplace.invalid"+to};
  const nav={currentEntry,entries:()=>[entry,currentEntry]};
  const fake={location:{pathname:"/services/card-1",search:"?from=abc",origin:"https://marketplace.invalid"},sessionStorage:{getItem:()=>JSON.stringify({from,to,sourceKey:"original"})},navigation:nav as typeof nav | undefined};
  const previousWindow=Object.getOwnPropertyDescriptor(globalThis,"window");
  Object.defineProperty(globalThis,"window",{configurable:true,value:fake});
  try {
    assert.equal(isRelatedListingDeparture(from),true);
    nav.entries=()=>[{...entry,key:"unrelated"},currentEntry];
    assert.equal(isRelatedListingDeparture(from),false);
    nav.entries=()=>[{...entry,url:"https://external.invalid"+from},currentEntry];
    assert.equal(isRelatedListingDeparture(from),false);
    nav.entries=()=>[currentEntry];
    assert.equal(isRelatedListingDeparture(from),false);
    fake.navigation=undefined;
    assert.equal(isRelatedListingDeparture(from),false);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis,"window",previousWindow);
    else Reflect.deleteProperty(globalThis,"window");
  }
});
