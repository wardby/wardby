/**
 * Real host-side implementations behind each `__bridge_*` function the
 * prelude calls. These run in Node, not in QuickJS — this is where the
 * actual I/O (fetch, Postgres, real parser libraries) happens. Every
 * implementation is JSON-in/JSON-out per bridge.ts's contract.
 */

import { randomUUID, randomBytes as nodeRandomBytes } from "node:crypto";
import { parse as parseHtml } from "node-html-parser";
import Papa from "papaparse";
import { XMLParser } from "fast-xml-parser";
import type { QuickJSContext, QuickJSRuntime } from "quickjs-emscripten";
import type { Datastore, DatastoreValue } from "../providers/datastore/types.js";
import { registerJsonAsyncFunction } from "./bridge.js";
import { FETCH_TIMEOUT_MS } from "./limits.js";

export interface HostFunctionOptions {
  agentId: string;
  datastore: Datastore;
  /** Tag prefixed onto forwarded console output — typically the tool name. */
  logTag: string;
}

function args<T extends unknown[]>(argsJson: string): T {
  return JSON.parse(argsJson) as T;
}

export function installHostFunctions(
  context: QuickJSContext,
  runtime: QuickJSRuntime,
  options: HostFunctionOptions,
): void {
  const { agentId, datastore, logTag } = options;

  registerJsonAsyncFunction(context, runtime, "__bridge_console", async (argsJson) => {
    const [level, logArgs] = args<[string, unknown[]]>(argsJson);
    const method = level === "warn" ? console.warn : level === "error" ? console.error : console.log;
    method(`[tool:${logTag}]`, ...logArgs);
    return null;
  });

  registerJsonAsyncFunction(context, runtime, "__bridge_sleep", async (argsJson) => {
    const [ms] = args<[number]>(argsJson);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
    return null;
  });

  registerJsonAsyncFunction(context, runtime, "__bridge_randomUUID", async () => {
    return randomUUID();
  });

  registerJsonAsyncFunction(context, runtime, "__bridge_randomBytes", async (argsJson) => {
    const [length] = args<[number]>(argsJson);
    return Array.from(nodeRandomBytes(length));
  });

  registerJsonAsyncFunction(context, runtime, "__bridge_fetch", async (argsJson) => {
    const [url, init] = args<[string, { method?: string; headers?: Record<string, string>; body?: string }]>(
      argsJson,
    );
    const response = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      headers,
      bodyBase64: buffer.toString("base64"),
    };
  });

  registerJsonAsyncFunction(context, runtime, "__bridge_datastoreGet", async (argsJson) => {
    const [key] = args<[string]>(argsJson);
    const value = await datastore.get(agentId, key);
    return value === undefined ? null : value;
  });

  registerJsonAsyncFunction(context, runtime, "__bridge_datastoreSet", async (argsJson) => {
    const [key, value] = args<[string, DatastoreValue]>(argsJson);
    await datastore.set(agentId, key, value);
    return null;
  });

  registerJsonAsyncFunction(context, runtime, "__bridge_datastoreDelete", async (argsJson) => {
    const [key] = args<[string]>(argsJson);
    await datastore.delete(agentId, key);
    return null;
  });

  registerJsonAsyncFunction(context, runtime, "__bridge_datastoreList", async (argsJson) => {
    const [prefix] = args<[string | null]>(argsJson);
    return datastore.list(agentId, prefix ?? undefined);
  });

  // Returns a focused, JSON-serializable extraction rather than the full DOM
  // tree (which isn't cleanly JSON-serializable): title, visible text, and
  // links. Good enough for the common "read this page" tool use case.
  registerJsonAsyncFunction(context, runtime, "__bridge_parseHTML", async (argsJson) => {
    const [html] = args<[string]>(argsJson);
    const root = parseHtml(html);
    const title = root.querySelector("title")?.text?.trim() ?? null;
    const text = root.text.replace(/\s+/g, " ").trim();
    const links = root.querySelectorAll("a[href]").map((a) => ({
      href: a.getAttribute("href") ?? "",
      text: a.text.trim(),
    }));
    return { title, text, links };
  });

  registerJsonAsyncFunction(context, runtime, "__bridge_parseCSV", async (argsJson) => {
    const [csv, csvOptions] = args<[string, { header?: boolean } | null]>(argsJson);
    const result = Papa.parse(csv, { header: csvOptions?.header ?? true, skipEmptyLines: true });
    return { data: result.data, errors: result.errors, meta: result.meta };
  });

  registerJsonAsyncFunction(context, runtime, "__bridge_parseXML", async (argsJson) => {
    const [xml, xmlOptions] = args<[string, Record<string, unknown> | null]>(argsJson);
    const parser = new XMLParser(xmlOptions ?? {});
    return parser.parse(xml);
  });
}
