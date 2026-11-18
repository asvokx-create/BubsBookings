import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const mode of ["production", "development"] as const) {
  test(`Privatus exact origins and existing protections remain in ${mode} headers`, () => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", 'import config from "./next.config.ts"; console.log(JSON.stringify(await config.headers()));'], {
      cwd: process.cwd(), env: { ...process.env, NODE_ENV: mode }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const rules = JSON.parse(result.stdout) as { source: string; headers: { key: string; value: string }[] }[];
    const protectedRules = rules.filter(rule => rule.headers.some(header => header.key === "Content-Security-Policy"));
    assert.equal(protectedRules.length, 2);
    for (const rule of protectedRules) {
      const csp = rule.headers.find(header => header.key === "Content-Security-Policy")!.value;
      const directives = new Map(csp.split("; ").map(part => { const [name, ...sources] = part.split(" "); return [name, sources]; }));
      for (const directive of ["script-src", "connect-src"]) {
        const sources = directives.get(directive)!;
        assert(sources.includes("https://privatusanalytics.com"));
        assert(sources.includes("https://privatusstats.com"));
        assert(!sources.includes("*") && !sources.includes("https:"));
        assert(!sources.some(source => source.includes("*.privatus")));
      }
      assert.deepEqual(directives.get("script-src-attr"), ["'none'"]);
      assert.deepEqual(directives.get("object-src"), ["'none'"]);
      assert.deepEqual(directives.get("frame-ancestors"), ["'none'"]);
      assert.equal(directives.get("script-src")!.includes("'unsafe-eval'"), mode === "development");
      assert.equal(directives.has("upgrade-insecure-requests"), mode === "production");
      assert.equal(rule.headers.some(header => header.key === "Strict-Transport-Security"), mode === "production");
    }
  });
}
