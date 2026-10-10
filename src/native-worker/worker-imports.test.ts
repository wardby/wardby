import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Modules a sandbox worker must never load: the database client, the runner
 * (control-plane writes), provider adapters that hold credentials, secret and
 * datastore backends, and process configuration. Type-only imports are erased
 * and do not count.
 */
const FORBIDDEN = [
  "core/db.ts",
  "core/runner.ts",
  "core/dispatch.ts",
  "core/secrets.ts",
  "generated/prisma/",
  "config/",
  "providers/secrets/",
  "providers/datastore/",
  "providers/executor/",
  "providers/jobs/",
  "providers/llm/routing.ts",
  "providers/llm/anthropic.ts",
  "providers/llm/openai.ts",
  "providers/llm/claude-provider.ts",
  // Brokered-secret code runs only on the gateway; it needs zod and @smithy, which the worker image lacks.
  "core/secret-broker-config.ts",
  "sandbox/secret-broker.ts",
  "sandbox/secret-broker-sigv4.ts",
  "sandbox/brokered-fetch.ts",
];

// Runtime (non-type) relative imports and re-exports, including multi-line import lists.
// Bounded by ";" so a match never runs from one statement into the next.
const IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gm;

function runtimeGraph(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(IMPORT)) {
      visit(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  };
  visit(resolve(SRC, entry));
  return [...seen].map((file) => relative(SRC, file));
}

it("the native sandbox worker's runtime import graph has no database, provider credential, or config module", () => {
  // The process entry, so its transports (stdio, HTTP) are covered too.
  const graph = runtimeGraph("native-worker/main.ts");
  expect(graph).toContain("native-worker/http-transport.ts");
  expect(graph).toContain("core/engine-native.ts");
  expect(graph.filter((file) => FORBIDDEN.some((prefix) => file.startsWith(prefix)))).toEqual([]);
});

// Bare (non-relative, non-node:) runtime imports, e.g. "zod" or "@smithy/x/sub".
const BARE_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\sfrom\s+)?["']([^."'][^"']*)["']/gm;

it("every npm package the worker's runtime import graph loads is installed in the worker image", () => {
  const pkg = JSON.parse(readFileSync(resolve(SRC, "native-worker/package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const installed = new Set(Object.keys(pkg.dependencies));
  const missing = new Set<string>();
  for (const file of runtimeGraph("native-worker/main.ts")) {
    for (const [, spec] of readFileSync(resolve(SRC, file), "utf8").matchAll(BARE_IMPORT)) {
      if (spec.startsWith("node:") || builtinModules.includes(spec.split("/")[0])) continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!installed.has(name)) missing.add(`${name} (from ${file})`);
    }
  }
  expect([...missing]).toEqual([]);
});
