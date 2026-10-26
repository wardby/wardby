// Bundles zod (which carries its own JSON Schema converter) into self-contained IIFE scripts
// that the WASM sandbox can `evalCode` directly — QuickJS has no module
// loader, so the tool-registration-time schema compile and the per-call
// param validation both need it as a plain global-exposing script, not
// Node-resolved imports. Generated, not hand-written; output is gitignored
// and rebuilt by `npm run build:vendor` (wired into `prepare`).
//
// Written to both src/sandbox/generated/ (tsx/vitest run straight from
// source) and dist/sandbox/generated/ (the compiled output — tsc only
// handles .ts files, so it never copies these on its own; zod-params.ts
// resolves this directory relative to its own compiled location).

import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const outDirs = [
  fileURLToPath(new URL("../src/sandbox/generated/", import.meta.url)),
  fileURLToPath(new URL("../dist/sandbox/generated/", import.meta.url)),
];
for (const dir of outDirs) {
  await mkdir(dir, { recursive: true });
}

async function bundleGlobal(entryContents, globalName, outfile) {
  const result = await build({
    stdin: {
      contents: entryContents,
      resolveDir: process.cwd(),
      loader: "js",
    },
    bundle: true,
    format: "iife",
    globalName,
    target: "es2020",
    platform: "neutral",
    write: false,
    minify: true,
  });
  const code = result.outputFiles[0].text;
  await Promise.all(outDirs.map((dir) => writeFile(path.join(dir, outfile), code, "utf8")));
  console.log(`wrote ${outfile} (${(code.length / 1024).toFixed(1)} KiB) to ${outDirs.length} location(s)`);
}

await bundleGlobal(`import * as zod from "zod"; export default zod;`, "__zodModule", "zod.bundle.js");

// Zod 3 compatibility window (one release): a custom tool's paramsZod still
// compiles with Zod 4's built-in Zod 3 API (`zod/v3`), and its JSON Schema
// comes from zod-to-json-schema, which reads that API. Remove this bundle, and
// the zod-to-json-schema dev dependency, when the window closes
// (sandbox/zod-params.ts, PARAMS_ZOD_APIS).
await bundleGlobal(
  `import { z } from "zod/v3"; import { zodToJsonSchema } from "zod-to-json-schema"; export default { z, zodToJsonSchema };`,
  "__zod3Module",
  "zod3.bundle.js",
);
