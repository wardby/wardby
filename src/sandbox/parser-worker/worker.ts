/**
 * Runs inside a spawned worker thread (see ./pool.ts) — the actual
 * node-html-parser/papaparse/fast-xml-parser calls happen here, off the
 * main event loop, so a pathological input can only ever hang this one
 * disposable thread. `parentPort` is null when this file is imported
 * directly (e.g. by worker.test.ts), so the message-wiring block below is
 * a no-op in that context — the exported functions are plain, directly
 * testable without spinning up a thread.
 */
import { parentPort } from "node:worker_threads";
import { parse as parseHtmlDom } from "node-html-parser";
import Papa from "papaparse";
import { XMLParser } from "fast-xml-parser";
import { boundedJson } from "../bounded-json.js";
import { BRIDGE_RESULT_BYTES, HTML_LINKS_LIMIT } from "../limits.js";

export function parseHtmlPayload(html: string): {
  title: string | null;
  text: string;
  links: { href: string; text: string }[];
} {
  const root = parseHtmlDom(html);
  const title = root.querySelector("title")?.text?.trim() ?? null;
  const text = root.text.replace(/\s+/g, " ").trim();
  const anchors = root.querySelectorAll("a[href]");
  if (anchors.length > HTML_LINKS_LIMIT) throw new Error("html_link_limit");
  const links: { href: string; text: string }[] = [];
  let remaining = BRIDGE_RESULT_BYTES - Buffer.byteLength(boundedJson({ title, text, links }, BRIDGE_RESULT_BYTES));
  // Nested anchors can repeat the same text; bound expansion during extraction.
  for (const a of anchors) {
    const link = { href: a.getAttribute("href") ?? "", text: a.text.trim() };
    remaining -= Buffer.byteLength(boundedJson(link, remaining)) + 1;
    if (remaining < 0) throw new Error("bridge_size_limit");
    links.push(link);
  }
  return { title, text, links };
}

export function parseCsvPayload(csv: string, header: boolean): { data: unknown; errors: unknown; meta: unknown } {
  const result = Papa.parse(csv, { header, skipEmptyLines: true });
  return { data: result.data, errors: result.errors, meta: result.meta };
}

export function parseXmlPayload(xml: string, xmlOptions: Record<string, unknown> | null): unknown {
  const parser = new XMLParser({ ...xmlOptions, processEntities: false });
  return parser.parse(xml);
}

interface ParseRequest {
  kind: "html" | "csv" | "xml";
  payload:
    { html: string } | { csv: string; header: boolean } | { xml: string; xmlOptions: Record<string, unknown> | null };
}

function handle(request: ParseRequest): unknown {
  if (request.kind === "html") return parseHtmlPayload((request.payload as { html: string }).html);
  if (request.kind === "csv") {
    const { csv, header } = request.payload as { csv: string; header: boolean };
    return parseCsvPayload(csv, header);
  }
  const { xml, xmlOptions } = request.payload as { xml: string; xmlOptions: Record<string, unknown> | null };
  return parseXmlPayload(xml, xmlOptions);
}

if (parentPort) {
  const port = parentPort;
  port.on("message", (request: ParseRequest) => {
    try {
      port.postMessage({ ok: true, value: handle(request) });
    } catch (err) {
      port.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  });
}
