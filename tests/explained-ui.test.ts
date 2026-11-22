import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read=(...parts:string[])=>readFileSync(new URL(`../${parts.join("/")}`,import.meta.url),"utf8");

test("shared explanations appear on hover, keyboard focus, and focus within links",()=>{
  const tooltip=read("components","explained-ui.tsx");
  assert.match(tooltip,/role="tooltip"/);
  assert.match(tooltip,/aria-describedby/);
  assert.match(tooltip,/group-hover:visible/);
  assert.match(tooltip,/group-focus:visible/);
  assert.match(tooltip,/group-focus-within:visible/);
});

test("affiliate compensation summary explains the revenue basis in plain language",()=>{
  const summary=read("components","partner-compensation-summary.tsx");
  assert.match(summary,/id="dashboard-revenue-share-help"/);
  assert.match(summary,/not the provider's service price/);
  assert.match(summary,/Per qualified referred provider/);
  assert.match(summary,/Fixed campaign payment/);
});

test("service details explain delivery, location, provider, and verification labels",()=>{
  const service=read("app","services","[slug]","page.tsx");
  for(const id of ["delivery-type-help","service-map-help","service-provider-help","profile-screened-help","email-verified-help","business-checked-help"]){
    assert.match(service,new RegExp(`id="${id}"`));
  }
  assert.match(service, /id="service-provider-help" interactive explanation="This is the business responsible for delivering the service/);
  assert.doesNotMatch(service,/<span title="The provider/);
});
