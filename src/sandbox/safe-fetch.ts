import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import type { LookupFunction } from "node:net";
import { resolveDestination, type FetchPolicyOptions } from "./fetch-policy.js";
import { BRIDGE_INPUT_BYTES, FETCH_RESPONSE_BYTES, FETCH_TIMEOUT_MS, MAX_REDIRECTS } from "./limits.js";

type Destination = Awaited<ReturnType<typeof resolveDestination>>;
export interface SafeFetchInit { method?: string; headers?: Record<string, string>; body?: string; }
export function pinnedLookup(destination: Destination): LookupFunction {
  return ((_: string, options: { all?: boolean }, callback: (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void) => {
    if (options?.all) callback(null, [{ address: destination.address, family: destination.family }]);
    else callback(null, destination.address, destination.family);
  });
}
export function requestPinned(destination: Destination, init: SafeFetchInit, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    // The URL preserves Host and TLS SNI. Only the vetted address reaches the socket.
    const request = (destination.url.protocol === "https:" ? httpsRequest : httpRequest)(destination.url, {
      method: init.method, headers: init.headers, lookup: pinnedLookup(destination), family: destination.family,
      agent: false, signal, maxHeaderSize: 16 * 1024,
    }, resolve);
    request.once("error", reject);
    request.end(init.body);
  });
}
export interface SafeFetchOptions extends FetchPolicyOptions {
  signal?: AbortSignal;
  connect?: typeof requestPinned;
}
async function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("fetch_cancelled_or_timeout"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export async function safeFetch(input: string, init: SafeFetchInit = {}, options: SafeFetchOptions = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("fetch_timeout")), FETCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  let url = input;
  let method = init.method ?? "GET";
  let body = init.body;
  let headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let response: IncomingMessage | undefined;
  try {
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) throw new Error("fetch_method_invalid");
    if (body !== undefined && (typeof body !== "string" || Buffer.byteLength(body) > BRIDGE_INPUT_BYTES)) throw new Error("fetch_body_limit");
    if (Object.keys(headers).some((k) => ["host", "connection", "transfer-encoding", "content-length", "upgrade", "proxy-connection"].includes(k))) throw new Error("fetch_header_invalid");
    headers["accept-encoding"] = "identity";
    for (let hop = 0; ; hop++) {
      signal.throwIfAborted();
      const destination = await untilAbort(resolveDestination(url, options), signal);
      signal.throwIfAborted();
      response = await (options.connect ?? requestPinned)(destination, { method, headers, body }, signal);
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.destroy();
        if (hop >= MAX_REDIRECTS) throw new Error("fetch_redirect_limit");
        const next = new URL(response.headers.location, destination.url);
        if ((status === 303 && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST")) { method = "GET"; body = undefined; delete headers["content-type"]; }
        if (next.origin !== destination.url.origin) {
          if (body) throw new Error("fetch_cross_origin_body_blocked");
          // Only non-credential headers survive; custom API-key headers must not leak either.
          headers = Object.fromEntries(Object.entries(headers).filter(([key]) => ["accept", "accept-language", "content-type", "user-agent", "accept-encoding"].includes(key)));
        }
        url = next.href; continue;
      }
      let encoded = 0;
      response.on("data", (chunk: Buffer) => { encoded += chunk.length; if (encoded > FETCH_RESPONSE_BYTES) response!.destroy(new Error("fetch_response_limit")); });
      const encoding = response.headers["content-encoding"];
      const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : undefined;
      if (encoding && encoding !== "identity" && !decoder) throw new Error("fetch_encoding_invalid");
      const chunks: Buffer[] = []; let size = 0;
      const sink = new Writable({ write(chunk: Buffer, _, callback) {
        size += chunk.length;
        if (size > FETCH_RESPONSE_BYTES) callback(new Error("fetch_response_limit"));
        else { chunks.push(chunk); callback(); }
      } });
      if (decoder) await pipeline(response, decoder, sink, { signal });
      else await pipeline(response, sink, { signal });
      const resultHeaders = Object.fromEntries(Object.entries(response.headers).filter(([key]) => !["content-encoding", "content-length", "set-cookie"].includes(key)).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value ?? ""]));
      return { ok: status >= 200 && status < 300, status, statusText: response.statusMessage ?? "", url: destination.url.href, headers: resultHeaders, bodyBase64: Buffer.concat(chunks, size).toString("base64") };
    }
  } catch (err) {
    if (signal.aborted) throw new Error("fetch_cancelled_or_timeout", { cause: err });
    if (err instanceof Error && /^fetch_/.test(err.message)) throw err;
    throw new Error("fetch_failed", { cause: err });
  } finally { clearTimeout(timer); response?.destroy(); abort.abort(); }
}
