/**
 * The Zod 3 compatibility window's warnings (one release; see
 * sandbox/zod-params.ts). A custom tool whose paramsZod Zod 4 can't compile
 * still works this release, compiled with Zod 3, and stops working in the
 * next. The operator hears about it in create_tool, update_tool,
 * dry_run_tool, list_tools and get_agent results (on tools the caller owns),
 * in import results, from `wardby tool create`, and once per tool in the
 * server log at startup.
 *
 * A warning names only the tool and the removed Zod 3 API it uses (fixed
 * labels from zod-params.ts): never the schema's text or anything else from
 * the tool.
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "#prisma";
import { zod4Compatibility, type Zod4Compatibility } from "../sandbox/zod-params.js";
import type { SandboxResult } from "../sandbox/eval-core.js";

export const ZOD3_WINDOW_ENDS = "Zod 3 schemas stop working in the next release";

/** The warning for one paramsZod, or undefined when Zod 4 compiles it (or there is nothing to say). */
export function zod3WindowWarning(subject: string, compatibility: Zod4Compatibility): string | undefined {
  if (compatibility.compatible !== false) return undefined;
  const what = compatibility.removed.length
    ? `uses Zod 3 API that Zod 4 removed: ${compatibility.removed.join(", ")}`
    : "does not compile with Zod 4";
  return (
    `${subject} ${what}. Wardby still compiles it with Zod 3 in this release, but ${ZOD3_WINDOW_ENDS}: ` +
    "rewrite it with the Zod 4 API and check it with dry_run_tool."
  );
}

/** How a warning names a tool. */
export function toolSubject(name: string): string {
  return `Tool ${JSON.stringify(name)}'s paramsZod`;
}

/**
 * Compatibility depends on the paramsZod text alone, so results are cached in
 * memory keyed by a SHA-256 of that text: a changed paramsZod is a different
 * key and is always probed afresh, so the cache can never hide a warning for
 * it. The tool's name is not part of the result (the warning text is built
 * from the current name each time). The startup scan fills the cache, so
 * list_tools usually probes nothing. Bounded; the oldest entry goes first.
 * An "unknown" result (a probe that hit a sandbox limit) is not cached.
 */
const COMPATIBILITY_CACHE_LIMIT = 2000;
const compatibilityCache = new Map<string, Promise<Zod4Compatibility>>();

export function cachedZod4Compatibility(paramsZod: string): Promise<Zod4Compatibility> {
  const key = createHash("sha256").update(paramsZod).digest("hex");
  const hit = compatibilityCache.get(key);
  if (hit) return hit;
  const pending = zod4Compatibility(paramsZod).then(
    (result) => {
      if (result.compatible === "unknown") compatibilityCache.delete(key);
      return result;
    },
    (err: unknown) => {
      compatibilityCache.delete(key);
      throw err;
    },
  );
  compatibilityCache.set(key, pending);
  while (compatibilityCache.size > COMPATIBILITY_CACHE_LIMIT) {
    compatibilityCache.delete(compatibilityCache.keys().next().value!);
  }
  return pending;
}

/** Test hook: empties the compatibility cache. */
export function clearZod4CompatibilityCache(): void {
  compatibilityCache.clear();
}

/** The warnings for one tool's paramsZod (empty or one entry), ready for a result's `warnings`. */
export async function zod3ToolWarnings(subject: string, paramsZod: string): Promise<string[]> {
  const warning = zod3WindowWarning(subject, await cachedZod4Compatibility(paramsZod));
  return warning ? [warning] : [];
}

/**
 * A tool row with its Zod 3 window warnings, for a caller who owns it (and so
 * already sees its paramsZod). Rows projected for anyone else, which carry no
 * paramsZod, pass through unchanged: a warning would reveal part of the schema.
 */
export async function withZod3ToolWarnings<T extends object>(projected: T): Promise<T | (T & { warnings: string[] })> {
  const row = projected as { name?: unknown; paramsZod?: unknown };
  if (typeof row.paramsZod !== "string" || typeof row.name !== "string") return projected;
  const warnings = await zod3ToolWarnings(toolSubject(row.name), row.paramsZod);
  return warnings.length ? { ...projected, warnings } : projected;
}

/**
 * dry_run_tool's check of a schema Zod 4 does compile: whether Zod 4 treats
 * the sample arguments as the current release does. Names no values.
 */
export function zod3SampleArgsWarning(
  subject: string,
  current: SandboxResult,
  zod4: SandboxResult,
): string | undefined {
  let how: string;
  if (current.ok && zod4.ok) {
    if (JSON.stringify(current.value) === JSON.stringify(zod4.value)) return undefined;
    how = "parses the sample arguments to a different value with Zod 4";
  } else if (current.ok !== zod4.ok) {
    how = current.ok ? "rejects the sample arguments with Zod 4" : "accepts the sample arguments with Zod 4";
  } else {
    return undefined;
  }
  return (
    `${subject} ${how}. Wardby still compiles it with Zod 3 in this release, but ${ZOD3_WINDOW_ENDS}: ` +
    "check the schema against the Zod 4 API."
  );
}

interface WarnLog {
  warn(fields: object, message: string): void;
}

/**
 * Logs one warning per stored tool whose paramsZod Zod 4 can't compile. Runs
 * in the background at startup; never throws.
 */
export async function logZod3ToolWarnings(db: Pick<PrismaClient, "tool">, log: WarnLog): Promise<number> {
  let warned = 0;
  try {
    const tools = await db.tool.findMany({ select: { id: true, name: true, paramsZod: true }, orderBy: { id: "asc" } });
    for (const tool of tools) {
      const compatibility = await cachedZod4Compatibility(tool.paramsZod);
      const warning = zod3WindowWarning(toolSubject(tool.name), compatibility);
      if (!warning) continue;
      const removed = compatibility.compatible === false ? compatibility.removed : [];
      log.warn({ toolId: tool.id, toolName: tool.name, removed }, warning);
      warned += 1;
    }
  } catch (err) {
    log.warn({ errorName: err instanceof Error ? err.name : typeof err }, "zod3_window_check_failed");
  }
  return warned;
}
