import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
function luminance(hex: string) {
  const rgb = [...hex.slice(1).matchAll(/[0-9a-f]{2}/gi)].map(([pair]) => parseInt(pair, 16) / 255);
  assert.equal(rgb.length, 3, hex);
  const [r, g, b] = rgb.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
}
function ratio(a: string, b: string) {
  const levels = [luminance(a), luminance(b)].sort((x,y)=>y-x);
  return (levels[0] + .05) / (levels[1] + .05);
}
const marker = ":is(.premium-featured, .service-detail-page) {";
const textBlocks = css.split(marker);
assert.equal(textBlocks.length, 3);
const light = textBlocks[1].split("}")[0];
const dark = textBlocks[2].split("}")[0];
const darkTheme = css.split('html[data-theme="dark"] {').find((part) => part.includes("--text-primary: #f5f5f6;"))?.split("}")[0] ?? "";
function token(block: string, name: string) {
  const raw = block.match(new RegExp("--" + name + ": ([^;]+);"))?.[1];
  assert.ok(raw, name);
  return raw;
}
function color(block: string, name: string) {
  const raw = token(block, "marketplace-control-" + name);
  const alias = raw.match(/^var\(--([\w-]+)\)$/)?.[1];
  return alias ? token(darkTheme, alias) : raw;
}
test("public marketplace controls maintain text/icon contrast in both themes", () => {
  for (const theme of [light, dark]) {
    const ink = color(theme, "ink");
    assert.ok(ratio(ink, color(theme, "surface")) >= 4.5);
    assert.ok(ratio(ink, color(theme, "hover")) >= 4.5);
  }
});
test("control outlines and borders stand out on their surfaces and adjacent pages", () => {
  for (const [theme, pages] of [[light, ["#faf9f4", "#f8f7f3"]], [dark, ["#0d0d0f", "#0c110e"]]] as const) {
    assert.ok(ratio(color(theme, "border"), color(theme, "surface")) >= 3);
    assert.ok(ratio(color(theme, "hover-border"), color(theme, "hover")) >= 3);
    for (const page of pages) {
      assert.ok(ratio(color(theme, "border"), page) >= 3);
      assert.ok(ratio(color(theme, "focus"), page) >= 3);
    }
  }
});
