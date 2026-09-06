/**
 * Real host-side implementations behind each `__bridge_*` function the
 * prelude calls. These run in Node, not in QuickJS — this is where the
 * actual I/O (fetch, Postgres, real parser libraries) happens. Every
 * implementation is JSON-in/JSON-out per bridge.ts's contract.
 */

import { randomUUID, randomBytes as nodeRandomBytes } from "node:crypto";
import type { QuickJSContext, QuickJSRuntime } from "quickjs-emscripten";
import type { Datastore, DatastoreSetOptions, DatastoreValue } from "../providers/datastore/types.js";
import type { SecretsAccessor } from "../core/secrets.js";
import { registerJsonAsyncFunction } from "./bridge.js";
import { parseAllowedHosts } from "./fetch-policy.js";
import { safeFetch } from "./safe-fetch.js";
import { FETCH_WILDCARD } from "./tool-capabilities.js";
import { boundedJson, boundedString } from "./bounded-json.js";
import { PARSER_INPUT_BYTES, RANDOM_BYTES_LIMIT, LOG_BYTES, WALL_TIME_LIMIT_MS } from "./limits.js";
import { setTimeout as sleep } from "node:timers/promises";
import { logger as defaultLogger, type Logger } from "../core/logger.js";
import { createParserWorkerPool, type ParserWorkerPool } from "./parser-worker/pool.js";

/** Below this length a "secret" is too likely to coincidentally match ordinary log text — not worth the false-positive risk of redacting it. */
const MIN_REDACTABLE_SECRET_LENGTH = 6;

const FETCH_ALLOWED_HOSTS = parseAllowedHosts(process.env.REEVO_FETCH_ALLOWED_HOSTS);
let sharedParserPool: ParserWorkerPool | undefined;

export interface HostFunctionOptions {
  signal?: AbortSignal;
  agentId: string;
  datastore: Datastore;
  /** Tag prefixed onto forwarded console output — typically the tool name. */
  logTag: string;
  /** Omitted (e.g. dry_run_tool, no real agent) — secrets.get always resolves undefined. */
  secrets?: SecretsAccessor;
  /** Overrides the shared default logger — mainly for tests. */
  logger?: Logger;
  /** Overrides the shared default parser-worker pool — mainly for tests. */
  parserPool?: ParserWorkerPool;
  /** Hosts this specific tool attachment may fetch. Omitted/empty = no outbound fetch at all; a literal "*" element lifts the restriction (existing SSRF protection against private/link-local addresses still applies). */
  allowedFetchHosts?: string[];
}

function args<T extends unknown[]>(argsJson: string): T {
  return JSON.parse(argsJson) as T;
}

export function installHostFunctions(
  context: QuickJSContext,
  runtime: QuickJSRuntime,
  options: HostFunctionOptions,
): void {
  const { agentId, datastore, logTag, secrets, signal, allowedFetchHosts } = options;
  const register = (name: string, fn: (json: string) => Promise<unknown>) => registerJsonAsyncFunction(context, runtime, name, fn, signal);
  const sandboxLog = (options.logger ?? defaultLogger).child({ module: "sandbox-tool", agentId, tool: logTag.slice(0, 100) });
  const parserPool = options.parserPool ?? (sharedParserPool ??= createParserWorkerPool());

  // Values fetched via secrets.get() during THIS invocation only — a tool
  // that logs a secret it never fetched has nothing to redact, and one that
  // fetches but doesn't log it costs nothing extra. Fresh per invocation
  // (installHostFunctions runs once per sandbox context, one per tool call).
  const fetchedSecretValues = new Set<string>();
  function redactSecrets(text: string): string {
    let out = text;
    for (const value of fetchedSecretValues) {
      if (value.length < MIN_REDACTABLE_SECRET_LENGTH) continue;
      out = out.split(value).join("[REDACTED]");
    }
    return out;
  }

  register("__bridge_console", async (argsJson) => {
    const [level, logArgs] = args<[string, unknown[]]>(argsJson);
    const message = redactSecrets(boundedJson(logArgs, LOG_BYTES));
    if (level === "warn") sandboxLog.warn(message);
    else if (level === "error") sandboxLog.error(message);
    else sandboxLog.info(message);
    return null;
  });

  register("__bridge_sleep", async (argsJson) => {
    const [ms] = args<[number]>(argsJson);
    if (!Number.isFinite(ms) || ms < 0 || ms > WALL_TIME_LIMIT_MS) throw new Error("sleep_limit");
    await sleep(ms, undefined, { signal });
    return null;
  });

  register("__bridge_randomUUID", async () => {
    return randomUUID();
  });

  register("__bridge_randomBytes", async (argsJson) => {
    const [length] = args<[number]>(argsJson);
    if (!Number.isInteger(length) || length < 0 || length > RANDOM_BYTES_LIMIT) throw new Error("random_bytes_limit");
    return Array.from(nodeRandomBytes(length));
  });

  register("__bridge_fetch", async (argsJson) => {
    const [url, init] = args<[string, { method?: string; headers?: Record<string, string>; body?: string }]>(
      argsJson,
    );
    const hosts = allowedFetchHosts ?? [];
    if (hosts.includes(FETCH_WILDCARD)) {
      return safeFetch(url, init, { allowedHosts: FETCH_ALLOWED_HOSTS, signal });
    }
    return safeFetch(url, init, { allowedHosts: hosts, restrictToAllowedHosts: true, signal });
  });

  register("__bridge_datastoreGet", async (argsJson) => {
    const [key] = args<[string]>(argsJson);
    boundedString(key, 1024);
    const value = await datastore.get(agentId, key);
    return value === undefined ? null : value;
  });

  register("__bridge_datastoreSet", async (argsJson) => {
    const [key, value, opts] = args<[string, DatastoreValue, DatastoreSetOptions | undefined]>(argsJson);
    boundedString(key, 1024);
    await datastore.set(agentId, key, value, opts);
    return null;
  });

  register("__bridge_datastoreDelete", async (argsJson) => {
    const [key] = args<[string]>(argsJson);
    boundedString(key, 1024);
    await datastore.delete(agentId, key);
    return null;
  });

  register("__bridge_datastoreList", async (argsJson) => {
    const [prefix] = args<[string | null]>(argsJson);
    if (prefix !== null) boundedString(prefix, 1024);
    return datastore.list(agentId, prefix ?? undefined);
  });

  register("__bridge_secretsGet", async (argsJson) => {
    const [name] = args<[string]>(argsJson);
    boundedString(name, 1024);
    const value = secrets ? await secrets.get(name) : undefined;
    if (value) fetchedSecretValues.add(value);
    return value ?? null;
  });

  // The actual node-html-parser/papaparse/fast-xml-parser calls run in a
  // disposable worker thread (see ./parser-worker/pool.ts) — this host
  // process runs fully attacker-controlled (but size-capped) input through
  // third-party parsers, and QuickJS's own CPU/memory/wall-time limits
  // don't apply to that host-side work at all.
  register("__bridge_parseHTML", async (argsJson) => {
    const [html] = args<[string]>(argsJson);
    boundedString(html, PARSER_INPUT_BYTES);
    return parserPool.run("html", { html }, signal);
  });

  register("__bridge_parseCSV", async (argsJson) => {
    const [csv, csvOptions] = args<[string, { header?: boolean } | null]>(argsJson);
    boundedString(csv, PARSER_INPUT_BYTES);
    return parserPool.run("csv", { csv, header: csvOptions?.header ?? true }, signal);
  });

  register("__bridge_parseXML", async (argsJson) => {
    const [xml, xmlOptions] = args<[string, Record<string, unknown> | null]>(argsJson);
    boundedString(xml, PARSER_INPUT_BYTES);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("xml_entities_blocked");
    if (xmlOptions && Object.entries(xmlOptions).some(([key, value]) => !["ignoreAttributes", "trimValues", "parseTagValue"].includes(key) || typeof value !== "boolean")) throw new Error("xml_options_invalid");
    return parserPool.run("xml", { xml, xmlOptions }, signal);
  });
}
