/**
 * Zod-in-sandbox: the tool author's Zod schema is *source text*, compiled
 * and evaluated inside the QuickJS sandbox — never `new Function`/`eval` in
 * the host process. Two operations, both reusing eval-core.ts's isolated
 * eval (pure computation, no host I/O — `installExtras` is a no-op):
 *
 *  - `deriveJsonSchema`: registration-time. Compiles the schema and derives
 *    its JSON Schema (via the vendored `zod-to-json-schema`) — what's sent
 *    to the model as the tool's `parameters`. A malformed schema fails here,
 *    not at call time.
 *  - `validateParams`: call-time. Compiles the same schema (again, inside
 *    the sandbox) and parses the model-supplied arguments against it.
 *    Zod's own validation error (a real thrown `ZodError`, whose `.message`
 *    is already a readable issue list) becomes the sandbox failure the
 *    engine feeds back to the model as a tool-result error — not a run
 *    failure.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evalToJson, type SandboxResult } from "./eval-core.js";

const GENERATED_DIR = fileURLToPath(new URL("./generated/", import.meta.url));

let vendorPreludeCache: string | undefined;

function getVendorPrelude(): string {
  if (vendorPreludeCache) return vendorPreludeCache;
  let zodBundle: string;
  let zodToJsonSchemaBundle: string;
  try {
    zodBundle = readFileSync(path.join(GENERATED_DIR, "zod.bundle.js"), "utf8");
    zodToJsonSchemaBundle = readFileSync(path.join(GENERATED_DIR, "zod-to-json-schema.bundle.js"), "utf8");
  } catch (err) {
    throw new Error(
      `Sandbox vendor bundles missing (run "npm run build:vendor" first): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  vendorPreludeCache =
    `${zodBundle}\n${zodToJsonSchemaBundle}\n` +
    `const z = __zodModule.default.z;\n` +
    `const zodToJsonSchema = __zodToJsonSchemaModule.default.zodToJsonSchema;\n`;
  return vendorPreludeCache;
}

/** Registration-time: compiles the schema source and derives its JSON Schema. */
export async function deriveJsonSchema(paramsZodSource: string): Promise<SandboxResult> {
  const code = `${getVendorPrelude()}
(async () => {
  const schema = (${paramsZodSource});
  return JSON.stringify(zodToJsonSchema(schema));
})()`;
  return evalToJson(code, undefined, () => {});
}

/** Call-time: compiles the schema source and validates the model-supplied args against it. */
export async function validateParams(paramsZodSource: string, rawArgs: unknown): Promise<SandboxResult> {
  const code = `${getVendorPrelude()}
(async () => {
  const schema = (${paramsZodSource});
  const args = ${JSON.stringify(rawArgs)};
  return JSON.stringify(schema.parse(args));
})()`;
  return evalToJson(code, undefined, () => {});
}
