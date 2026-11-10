import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
const nativeRequire = createRequire(import.meta.url);
/** Load the production server module with only external boundary dependencies replaced. */
export function loadHourlyBackend<T>(database: unknown, overrides: Record<string, unknown> = {}, entry = "@/lib/hourly-projects"): T {
  const cache = new Map<string, unknown>();
  const replacements: Record<string, unknown> = {
    "server-only": {}, "@/lib/database": { database },
    "@/lib/content-safety": { checkAndRecordContent: async () => ({ allowed: true }) },
    ...overrides,
  };
  const load = (name: string): unknown => {
    if (Object.hasOwn(replacements, name)) return replacements[name];
    if (!name.startsWith("@/")) return nativeRequire(name);
    if (cache.has(name)) return cache.get(name);
    const source = readFileSync(resolve(name.replace("@/", "") + ".ts"), "utf8");
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const loadedModule = { exports: {} };
    new Function("require", "module", "exports", output)(load, loadedModule, loadedModule.exports);
    cache.set(name, loadedModule.exports);
    return loadedModule.exports;
  };
  return load(entry) as T;
}
