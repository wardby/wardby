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
import type { SharedDatastoreAccessor } from "../core/datastores.js";
import { registerJsonAsyncFunction } from "./bridge.js";
import { parseAllowedHosts, type FetchPolicyOptions } from "./fetch-policy.js";
import { safeFetch } from "./safe-fetch.js";
import { FETCH_WILDCARD } from "./tool-capabilities.js";
import { boundedJson, boundedString } from "./bounded-json.js";
import { PARSER_INPUT_BYTES, RANDOM_BYTES_LIMIT, LOG_BYTES, WALL_TIME_LIMIT_MS } from "./limits.js";
import { setTimeout as sleep } from "node:timers/promises";
import { logger as defaultLogger, type Logger } from "../core/logger.js";
import { createParserWorkerPool, type ParserWorkerPool } from "./parser-worker/pool.js";
import { redactPii } from "./pii-redaction.js";

/** Below this length a "secret" is too likely to coincidentally match ordinary log text — not worth the false-positive risk of redacting it. */
const MIN_REDACTABLE_SECRET_LENGTH = 6;

const FETCH_ALLOWED_HOSTS = parseAllowedHosts(process.env.WARDBY_FETCH_ALLOWED_HOSTS);
let sharedParserPool: ParserWorkerPool | undefined;

/**
 * Fetch policy for one tool invocation. The tool's own host list only narrows
 * egress; private destinations open solely via the operator's
 * WARDBY_FETCH_ALLOWED_HOSTS (and, for a non-wildcard tool, only when the tool
 * also lists the host). Cloud metadata stays blocked either way (fetch-policy.ts).
 */
export function sandboxFetchPolicy(
  toolHosts: readonly string[],
  operatorHosts: readonly string[] = FETCH_ALLOWED_HOSTS,
): FetchPolicyOptions {
  if (toolHosts.includes(FETCH_WILDCARD)) return { privateHostAllowlist: [...operatorHosts] };
  return { allowedHosts: [...toolHosts], restrictToAllowedHosts: true, privateHostAllowlist: [...operatorHosts] };
}

export interface HostFunctionOptions {
  signal?: AbortSignal;
  agentId: string;
  datastore: Datastore;
  sharedDatastore: SharedDatastoreAccessor;
  /** Tag prefixed onto forwarded console output — typically the tool name. */
  logTag: string;
  /** Omitted (e.g. dry_run_tool, no real agent) — secrets.get always resolves undefined. */
  secrets?: SecretsAccessor;
  /** Overrides the shared default logger — mainly for tests. */
  logger?: Logger;
  /** Overrides the shared default parser-worker pool — mainly for tests. */
  parserPool?: ParserWorkerPool;
  /** Hosts this specific tool attachment may fetch. Omitted/empty = no outbound fetch at all; a literal "*" element lifts the restriction. Either way this list only narrows egress: private/link-local destinations need the operator's WARDBY_FETCH_ALLOWED_HOSTS, and cloud metadata is always blocked. */
  allowedFetchHosts?: string[];
  /**
   * Secret values to redact from console output even if this host never fetched them: a stateless
   * gateway serving one call of an invocation can't know what an earlier call on another replica
   * fetched, so it passes every value the attachment may read. Never logged or returned.
   */
  redactSecretValues?: readonly string[];
  /** Overrides the network call — tests only. */
  fetchImpl?: typeof safeFetch;
}

function args<T extends unknown[]>(argsJson: string): T {
  return JSON.parse(argsJson) as T;
}

/** One host bridge: JSON-string arguments in, a JSON-serializable value out (bridge.ts). */
export type HostBridge = (argsJson: string) => Promise<unknown>;

/**
 * The bridges that touch credentials, storage, the network, or the operator's
 * logs. They always run on the trusted side: in-process today, and served by
 * the native sandbox gateway for a run whose engine runs in a worker.
 */
export const PRIVILEGED_BRIDGE_NAMES = [
  "__bridge_console",
  "__bridge_fetch",
  "__bridge_datastoreGet",
  "__bridge_datastoreSet",
  "__bridge_datastoreDelete",
  "__bridge_datastoreList",
  "__bridge_sharedDatastoreGet",
  "__bridge_sharedDatastoreSet",
  "__bridge_sharedDatastoreDelete",
  "__bridge_sharedDatastoreList",
  "__bridge_secretsGet",
] as const;
export type PrivilegedBridgeName = (typeof PRIVILEGED_BRIDGE_NAMES)[number];
export type PrivilegedHost = Record<PrivilegedBridgeName, HostBridge>;

/** The bridges that need no privilege, run wherever QuickJS runs. */
export const LOCAL_BRIDGE_NAMES = [
  "__bridge_sleep",
  "__bridge_randomUUID",
  "__bridge_randomBytes",
  "__bridge_parseHTML",
  "__bridge_parseCSV",
  "__bridge_parseXML",
] as const;

export function isPrivilegedBridgeName(name: string): name is PrivilegedBridgeName {
  return (PRIVILEGED_BRIDGE_NAMES as readonly string[]).includes(name);
}

export type PrivilegedHostOptions = Omit<HostFunctionOptions, "parserPool">;

/** The privileged bridges for one tool invocation, scoped by its options. */
export function createPrivilegedHost(options: PrivilegedHostOptions): PrivilegedHost {
  const { agentId, datastore, sharedDatastore, logTag, secrets, signal, allowedFetchHosts } = options;
  const fetchImpl = options.fetchImpl ?? safeFetch;
  const sandboxLog = (options.logger ?? defaultLogger).child({
    module: "sandbox-tool",
    agentId,
    tool: logTag.slice(0, 100),
  });

  // Values fetched via secrets.get() during THIS invocation only — a tool
  // that logs a secret it never fetched has nothing to redact, and one that
  // fetches but doesn't log it costs nothing extra. Fresh per invocation
  // (one privileged host per sandbox context, one per tool call).
  const fetchedSecretValues = new Set<string>(options.redactSecretValues ?? []);
  function redactSecrets(text: string): string {
    let out = text;
    for (const value of fetchedSecretValues) {
      if (value.length < MIN_REDACTABLE_SECRET_LENGTH) continue;
      out = out.split(value).join("[REDACTED]");
    }
    return out;
  }

  return {
    async __bridge_console(argsJson) {
      const [level, logArgs] = args<[string, unknown[]]>(argsJson);
      const message = redactPii(redactSecrets(boundedJson(logArgs, LOG_BYTES)));
      if (level === "warn") sandboxLog.warn(message);
      else if (level === "error") sandboxLog.error(message);
      else sandboxLog.info(message);
      return null;
    },

    async __bridge_fetch(argsJson) {
      const [url, init = {}, secretNames] =
        args<[string, { method?: string; headers?: Record<string, string>; body?: string }?, unknown?]>(argsJson);
      const policy = { ...sandboxFetchPolicy(allowedFetchHosts ?? []), signal };
      if (secretNames === undefined || (Array.isArray(secretNames) && secretNames.length === 0)) {
        return fetchImpl(url, init, policy);
      }
      // Loaded only here: the brokering code needs packages the native worker image does not ship,
      // and the worker never runs this bridge (the gateway does).
      const { brokeredFetch } = await import("./brokered-fetch.js");
      return brokeredFetch({
        url,
        init,
        secretNames,
        secrets,
        fetchImpl,
        policy,
        redactFromConsole: (value) => fetchedSecretValues.add(value),
      });
    },

    async __bridge_datastoreGet(argsJson) {
      const [key] = args<[string]>(argsJson);
      boundedString(key, 1024);
      const value = await datastore.get(agentId, key);
      return value === undefined ? null : value;
    },

    async __bridge_datastoreSet(argsJson) {
      const [key, value, opts] = args<[string, DatastoreValue, DatastoreSetOptions | undefined]>(argsJson);
      boundedString(key, 1024);
      await datastore.set(agentId, key, value, opts);
      return null;
    },

    async __bridge_datastoreDelete(argsJson) {
      const [key] = args<[string]>(argsJson);
      boundedString(key, 1024);
      await datastore.delete(agentId, key);
      return null;
    },

    async __bridge_datastoreList(argsJson) {
      const [prefix] = args<[string | null]>(argsJson);
      if (prefix !== null) boundedString(prefix, 1024);
      return datastore.list(agentId, prefix ?? undefined);
    },

    async __bridge_sharedDatastoreGet(argsJson) {
      const [boundName, key] = args<[string, string]>(argsJson);
      boundedString(boundName, 1024);
      boundedString(key, 1024);
      const value = await sharedDatastore.get(boundName, key);
      return value === undefined ? null : value;
    },

    async __bridge_sharedDatastoreSet(argsJson) {
      const [boundName, key, value, opts] =
        args<[string, string, DatastoreValue, DatastoreSetOptions | undefined]>(argsJson);
      boundedString(boundName, 1024);
      boundedString(key, 1024);
      await sharedDatastore.set(boundName, key, value, opts);
      return null;
    },

    async __bridge_sharedDatastoreDelete(argsJson) {
      const [boundName, key] = args<[string, string]>(argsJson);
      boundedString(boundName, 1024);
      boundedString(key, 1024);
      await sharedDatastore.delete(boundName, key);
      return null;
    },

    async __bridge_sharedDatastoreList(argsJson) {
      const [boundName, prefix] = args<[string, string | null]>(argsJson);
      boundedString(boundName, 1024);
      if (prefix !== null) boundedString(prefix, 1024);
      return sharedDatastore.list(boundName, prefix ?? undefined);
    },

    async __bridge_secretsGet(argsJson) {
      const [name] = args<[string]>(argsJson);
      boundedString(name, 1024);
      const value = secrets ? await secrets.get(name) : undefined;
      if (value) fetchedSecretValues.add(value);
      return value ?? null;
    },
  };
}

export interface SandboxApiOptions {
  privileged: PrivilegedHost;
  signal?: AbortSignal;
  /** Overrides the shared default parser-worker pool — mainly for tests. */
  parserPool?: ParserWorkerPool;
}

/** Registers the whole sandbox API: the local bridges directly, the privileged ones through `privileged`. */
export function installSandboxApi(context: QuickJSContext, runtime: QuickJSRuntime, options: SandboxApiOptions): void {
  const { privileged, signal } = options;
  const register = (name: string, fn: HostBridge) => registerJsonAsyncFunction(context, runtime, name, fn, signal);
  const parserPool = options.parserPool ?? (sharedParserPool ??= createParserWorkerPool());

  for (const name of PRIVILEGED_BRIDGE_NAMES) register(name, (argsJson) => privileged[name](argsJson));

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
    if (
      xmlOptions &&
      Object.entries(xmlOptions).some(
        ([key, value]) =>
          !["ignoreAttributes", "trimValues", "parseTagValue"].includes(key) || typeof value !== "boolean",
      )
    )
      throw new Error("xml_options_invalid");
    return parserPool.run("xml", { xml, xmlOptions }, signal);
  });
}

/** The in-process sandbox API for one tool invocation: privileged bridges served right here. */
export function installHostFunctions(
  context: QuickJSContext,
  runtime: QuickJSRuntime,
  options: HostFunctionOptions,
): void {
  const { parserPool, ...privilegedOptions } = options;
  installSandboxApi(context, runtime, {
    privileged: createPrivilegedHost(privilegedOptions),
    signal: options.signal,
    parserPool,
  });
}
