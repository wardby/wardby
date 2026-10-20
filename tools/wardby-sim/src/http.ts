// tools/wardby-sim — TEST ONLY. A stateful simulator of the outside services wardby
// talks to, for the release regression suite. Never part of the npm package or any
// production image.
import type { IncomingHttpHeaders } from "node:http";

/** One request, fully buffered, as every simulator route sees it. */
export interface SimRequest {
  method: string;
  /** The path after the service prefix, without the query string ("/repos/o/r/pulls"). */
  path: string;
  /** The full request path including the service prefix. */
  fullPath: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
}

export interface SimResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

export function json(value: unknown, status = 200, headers: Record<string, string> = {}): SimResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(value),
  };
}

export function text(value: string, status = 200, contentType = "text/plain; charset=utf-8"): SimResponse {
  return { status, headers: { "content-type": contentType }, body: value };
}

export function empty(status = 204): SimResponse {
  return { status };
}

export function header(req: SimRequest, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** The parsed JSON body, or `undefined` when the body is empty or not JSON. */
export function jsonBody(req: SimRequest): unknown {
  if (req.rawBody.length === 0) return undefined;
  try {
    return JSON.parse(req.rawBody.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Matches `path` against a pattern of `/`-separated segments where `{name}` captures one
 * segment and a trailing `*` matches the rest. Returns the captures, or null.
 */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/");
  const got = path.split("/");
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    const segment = want[i];
    if (segment === "*" && i === want.length - 1) {
      params["*"] = got.slice(i).join("/");
      return params;
    }
    if (i >= got.length) return null;
    if (segment.startsWith("{") && segment.endsWith("}")) {
      if (got[i] === "") return null;
      params[segment.slice(1, -1)] = decodeURIComponent(got[i]);
    } else if (segment !== got[i]) {
      return null;
    }
  }
  return want.length === got.length ? params : null;
}
