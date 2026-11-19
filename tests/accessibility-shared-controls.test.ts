import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("date trigger announces its field and selected value, and retains its error description", () => {
  const trigger = source("components/date-picker.tsx").split("<button ref={triggerRef}")[1].split("</button>")[0];
  assert.match(trigger, /aria-label=\{`\$\{ariaLabel\}: \$\{selectedValue \? formatDateOnly\(selectedValue\) : placeholder\}`\}/);
  assert.match(trigger, /aria-describedby=\{description \|\| error \|\| invalid \? helpId : undefined\}/);
});

test("focused search input owns combobox list and active-option semantics", () => {
  const input = source("components/custom-select.tsx").split("<input ref={searchRef}")[1].split("/>")[0];
  for (const attr of ['role="combobox"', 'aria-autocomplete="list"', 'aria-controls={listboxId}', 'aria-expanded={open}', 'aria-activedescendant={activeOptionId}']) assert.ok(input.includes(attr), attr);
});

test("skip link bypasses navigation nested inside the content wrapper", () => {
  const skip = source("components/skip-to-content.tsx");
  assert.match(skip, /querySelector<HTMLElement>\("#site-content main, #site-content \[role='main'\]"\)/);
  assert.match(skip, /main\?\.querySelector<HTMLElement>\("h1"\) \?\? main/);
  assert.match(skip, /target\.setAttribute\("tabindex", "-1"\)/);
  assert.match(skip, /target\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source("app/layout.tsx"), /<SkipToContent \/>/);
});
