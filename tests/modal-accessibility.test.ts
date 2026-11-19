import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const source=(path: string)=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
test("shared modal excludes hidden and roving controls and owns only topmost keyboard events",()=>{
 const text=source("components/use-modal-accessibility.ts");
 assert.match(text,/modalStack.at\(-1\) === token/);
 assert.match(text,/event.defaultPrevented/);
 assert.match(text,/item.tabIndex >= 0/);
 assert.match(text,/getClientRects\(\).length > 0/);
 assert.match(text,/event.target instanceof HTMLElement \? event.target/);
 assert.match(text,/useLayoutEffect\(\(\) =>/);
 assert.match(text,/previousFocus\?\.isConnected/);
 assert.match(text,/observer.disconnect\(\)/);
});
