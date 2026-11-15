#!/usr/bin/env node
// Copies the hand-written ES modules that compiled code imports into dist/,
// next to the JavaScript tsc emits (tsc compiles only src/**/*.ts). Run by
// `npm run build` after tsc. copy-build-modules.test.mjs fails when a non-test
// TypeScript file imports a relative .mjs that is not listed here.
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Paths under src/ (each copied with its .d.mts when one exists). */
export const BUILD_MODULES = Object.freeze(["coding-worker/dependency-cache.mjs", "coding-worker/result-bundle.mjs"]);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function copyBuildModules({ sourceRoot = join(repoRoot, "src"), outDir = join(repoRoot, "dist") } = {}) {
  const copied = [];
  for (const module of BUILD_MODULES) {
    for (const file of [module, module.replace(/\.mjs$/, ".d.mts")]) {
      const target = join(outDir, file);
      await mkdir(dirname(target), { recursive: true });
      try {
        await copyFile(join(sourceRoot, file), target);
        copied.push(file);
      } catch (error) {
        // A module must exist; its declaration file is optional.
        if (file === module || error?.code !== "ENOENT") throw error;
      }
    }
  }
  return copied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await copyBuildModules();
