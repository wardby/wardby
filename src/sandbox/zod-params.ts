/**
 * Zod-in-sandbox: the tool author's Zod schema is *source text*, compiled
 * and evaluated inside the QuickJS sandbox — never `new Function`/`eval` in
 * the host process. Two operations, both reusing eval-core.ts's isolated
 * eval (pure computation, no host I/O — `installExtras` is a no-op):
 *
 *  - `deriveJsonSchema`: registration-time. Compiles the schema and derives
 *    its JSON Schema — what's sent to the model as the tool's `parameters`.
 *    A malformed schema fails here, not at call time.
 *  - `validateParams`: call-time. Compiles the same schema (again, inside
 *    the sandbox) and parses the model-supplied arguments against it.
 *    Zod's own validation error (a real thrown `ZodError`, whose `.message`
 *    is already a readable issue list) becomes the sandbox failure the
 *    engine feeds back to the model as a tool-result error — not a run
 *    failure.
 *
 * Zod 3 compatibility window (this release only): wardby itself runs Zod 4,
 * but a custom tool's paramsZod is still compiled with Zod 4's built-in Zod 3
 * API (`zod/v3`) first, so a schema written for Zod 3 keeps working exactly as
 * before, and its JSON Schema comes from zod-to-json-schema (the converter it
 * was derived with before). Source Zod 3 can't compile (a schema written for
 * Zod 4, such as one using `z.email()`) falls back to Zod 4, whose JSON Schema
 * is `z.toJSONSchema` rewritten in zod-to-json-schema's spelling
 * (core/zod-json-schema.ts). `zod4Compatibility` finds the schemas the next
 * release, which compiles with Zod 4 only, would break; zod3-window.ts warns
 * about them. To close the window: set PARAMS_ZOD_APIS to ["v4"], and drop the
 * Zod 3 bundle (scripts/build-sandbox-vendor.mjs) and the window's warnings.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evalToJson, type SandboxResult } from "./eval-core.js";
import { legacyJsonSchema } from "../core/zod-json-schema.js";

const GENERATED_DIR = fileURLToPath(new URL("./generated/", import.meta.url));

/** A Zod API a tool's paramsZod can compile against. */
export type ZodApi = "v3" | "v4";

/** The APIs a tool's paramsZod is compiled with, in order: the first that compiles it is used. */
export const PARAMS_ZOD_APIS: readonly ZodApi[] = ["v3", "v4"];

const BUNDLES: Record<ZodApi, { file: string; prelude: string }> = {
  v4: { file: "zod.bundle.js", prelude: "const z = __zodModule.default.z;" },
  v3: {
    file: "zod3.bundle.js",
    prelude: "const z = __zod3Module.default.z;\nconst zodToJsonSchema = __zod3Module.default.zodToJsonSchema;",
  },
};

const vendorPreludeCache = new Map<ZodApi, string>();

function getVendorPrelude(api: ZodApi): string {
  const cached = vendorPreludeCache.get(api);
  if (cached) return cached;
  let bundle: string;
  try {
    bundle = readFileSync(path.join(GENERATED_DIR, BUNDLES[api].file), "utf8");
  } catch (err) {
    throw new Error(
      `Sandbox vendor bundles missing (run "npm run build:vendor" first): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  const prelude = `${bundle}\n${BUNDLES[api].prelude}\n`;
  vendorPreludeCache.set(api, prelude);
  return prelude;
}

/**
 * Prefixed to the message of an error thrown while compiling the schema
 * source (as opposed to parsing arguments with it), so the host can tell "this
 * API can't compile it" from a validation failure. Never shown: stripped below.
 */
const COMPILE_FAILED = "__wardby_zod_compile_failed__:";

/**
 * Compiles the source into `schema`. A sandbox limit (QuickJS's uncatchable
 * interrupt, or an out-of-memory InternalError) is rethrown as is: only an
 * ordinary compile error is marked.
 */
function compileStatement(paramsZodSource: string): string {
  return `let schema;
  try {
    schema = (${paramsZodSource});
    if (schema === null || typeof schema !== "object" || typeof schema.safeParse !== "function") {
      throw new TypeError("paramsZod did not evaluate to a Zod schema");
    }
  } catch (e) {
    if (e instanceof InternalError) throw e;
    const marked = new Error(${JSON.stringify(COMPILE_FAILED)} + (e && e.message !== undefined ? e.message : String(e)));
    marked.name = e && typeof e.name === "string" ? e.name : "Error";
    throw marked;
  }`;
}

function isCompileFailure(result: SandboxResult): boolean {
  return !result.ok && result.errorKind === "thrown" && result.errorMessage.includes(COMPILE_FAILED);
}

function unmark(result: SandboxResult): SandboxResult {
  return result.ok ? result : { ...result, errorMessage: result.errorMessage.replace(COMPILE_FAILED, "") };
}

/** Runs `attempt` with each API in turn until one compiles the source; the first API's failure otherwise. */
async function withFirstCompilingApi(
  apis: readonly ZodApi[],
  attempt: (api: ZodApi) => Promise<SandboxResult>,
): Promise<SandboxResult> {
  let first: SandboxResult | undefined;
  for (const api of apis) {
    const result = await attempt(api);
    if (!isCompileFailure(result)) return unmark(result);
    first ??= result;
  }
  if (!first) throw new Error("withFirstCompilingApi needs at least one API");
  return unmark(first);
}

async function deriveWith(paramsZodSource: string, api: ZodApi): Promise<SandboxResult> {
  const toJson =
    api === "v4"
      ? `z.toJSONSchema(schema, { target: "draft-07", io: "input", unrepresentable: "any" })`
      : `zodToJsonSchema(schema)`;
  const code = `${getVendorPrelude(api)}
(async () => {
  ${compileStatement(paramsZodSource)}
  return JSON.stringify(${toJson});
})()`;
  const result = await evalToJson(code, undefined, () => {});
  if (!result.ok || api === "v3") return result;
  return { ...result, value: legacyJsonSchema(result.value, { closeObjects: true }) };
}

async function validateWith(paramsZodSource: string, rawArgs: unknown, api: ZodApi): Promise<SandboxResult> {
  const code = `${getVendorPrelude(api)}
(async () => {
  ${compileStatement(paramsZodSource)}
  const args = ${JSON.stringify(rawArgs)};
  return JSON.stringify(schema.parse(args));
})()`;
  return evalToJson(code, undefined, () => {});
}

/** Registration-time: compiles the schema source and derives its JSON Schema. */
export async function deriveJsonSchema(
  paramsZodSource: string,
  apis: readonly ZodApi[] = PARAMS_ZOD_APIS,
): Promise<SandboxResult> {
  return withFirstCompilingApi(apis, (api) => deriveWith(paramsZodSource, api));
}

/** Call-time: compiles the schema source and validates the model-supplied args against it. */
export async function validateParams(
  paramsZodSource: string,
  rawArgs: unknown,
  apis: readonly ZodApi[] = PARAMS_ZOD_APIS,
): Promise<SandboxResult> {
  return withFirstCompilingApi(apis, (api) => validateWith(paramsZodSource, rawArgs, api));
}

/** Zod 3 schema methods Zod 4 removed. */
const REMOVED_METHODS = [
  "nonstrict",
  "deepPartial",
  "augment",
  "setKey",
  "ip",
  "cidr",
  "refinement",
  "promise",
  "args",
  "returns",
];

/** Zod 3 `z.*` functions Zod 4 removed, each with a stand-in that keeps the probe compiling. */
const REMOVED_FUNCTIONS: Record<string, string> = {
  ostring: "() => real.string().optional()",
  onumber: "() => real.number().optional()",
  oboolean: "() => real.boolean().optional()",
  effect: "(s) => s",
  transformer: "(s) => s",
  pipeline: "(a, b) => a.pipe(b)",
};

/** A label the probe may report: one of the fixed names above, never the schema's own text. */
const LABEL = /^(z)?\.[A-Za-z]+\(\)$/;

/**
 * Compiles the source with Zod 4, with a recording stand-in for each removed
 * Zod 3 method or function (so one run finds all of them, not only the
 * first), then derives its JSON Schema as registration would.
 */
function zod4ProbeCode(paramsZodSource: string): string {
  const shimEntries = Object.entries(REMOVED_FUNCTIONS)
    .map(([name, fn]) => `${name}: (...a) => (hit("z.${name}()"), (${fn})(...a))`)
    .join(", ");
  return `${getVendorPrelude("v4")}
(async () => {
  const real = z;
  const hits = [];
  const hit = (label) => { if (!hits.includes(label)) hits.push(label); };
  for (const value of Object.values(real)) {
    if (typeof value !== "function" || !value.prototype || !/^Zod/.test(value.name)) continue;
    for (const name of ${JSON.stringify(REMOVED_METHODS)}) {
      if (name in value.prototype) continue;
      Object.defineProperty(value.prototype, name, {
        configurable: true,
        value: function () { hit("." + name + "()"); return this; },
      });
    }
  }
  const shim = { ...real, ${shimEntries} };
  let compiled = true;
  try {
    const schema = ((z) => (${paramsZodSource}))(shim);
    if (schema === null || typeof schema !== "object" || typeof schema.safeParse !== "function") throw new TypeError();
    real.toJSONSchema(schema, { target: "draft-07", io: "input", unrepresentable: "any" });
  } catch (e) {
    if (e instanceof InternalError) throw e;
    compiled = false;
  }
  return JSON.stringify({ compiled: compiled && hits.length === 0, removed: hits });
})()`;
}

export type Zod4Compatibility =
  | { compatible: true }
  /** `removed` lists the removed Zod 3 API it uses (fixed labels); empty when it fails some other way. */
  | { compatible: false; removed: string[] }
  /** The probe hit a sandbox limit, or the source compiles under neither API: nothing to report. */
  | { compatible: "unknown" };

/**
 * Whether the source compiles with Zod 4 alone, as it must from the next
 * release on. Only meaningful for source the current release accepts.
 */
export async function zod4Compatibility(paramsZodSource: string): Promise<Zod4Compatibility> {
  const probe = await evalToJson(zod4ProbeCode(paramsZodSource), undefined, () => {});
  if (!probe.ok) return { compatible: "unknown" };
  const { compiled, removed } = probe.value as { compiled: boolean; removed: string[] };
  if (compiled) return { compatible: true };
  const labels = removed.filter((label) => LABEL.test(label));
  if (labels.length === 0) {
    // Zod 4 can't compile it and it uses none of the known removed API: does Zod 3 compile it?
    const v3 = await deriveJsonSchema(paramsZodSource, ["v3"]);
    if (!v3.ok) return { compatible: "unknown" };
  }
  return { compatible: false, removed: labels };
}
