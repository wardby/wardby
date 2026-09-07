import type { IncomingMessage } from "node:http";

export const HTTP_LIMITS = { json: 1024 * 1024, auth: 64 * 1024, requestMs: 15_000, headersMs: 10_000 };
export class HttpBoundaryError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export class PayloadTooLargeError extends HttpBoundaryError {
  constructor() {
    super(413, "payload_too_large");
  }
}

export function canonicalUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error(
      "Canonical URI must be HTTPS (HTTP is allowed only for loopback development), without credentials, query, or fragment.",
    );
  }
  return url;
}

export function readBody(req: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<string> {
  const length = req.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return Promise.reject(new PayloadTooLargeError());
  if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")
    return Promise.reject(new HttpBoundaryError(415, "unsupported_encoding"));
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const clean = () => {
      req.off("data", data);
      req.off("end", end);
      req.off("error", error);
      req.off("aborted", aborted);
      signal.removeEventListener("abort", timeout);
    };
    const error = (err: Error) => {
      clean();
      req.pause();
      reject(err);
    };
    const aborted = () => error(new HttpBoundaryError(400, "incomplete_body"));
    const timeout = () => error(new HttpBoundaryError(408, "request_timeout"));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) error(new PayloadTooLargeError());
      else chunks.push(chunk);
    };
    const end = () => {
      clean();
      resolve(Buffer.concat(chunks, size).toString("utf8"));
    };
    req.on("data", data);
    req.once("end", end);
    req.once("error", error);
    req.once("aborted", aborted);
    signal.addEventListener("abort", timeout, { once: true });
    if (signal.aborted) timeout();
  });
}

export function parseBody(raw: string, contentType: string | undefined): unknown {
  const type = contentType?.split(";", 1)[0].trim().toLowerCase();
  if (type === "application/json") {
    try {
      const value: unknown = JSON.parse(raw);
      if (value === null || typeof value !== "object") throw new Error();
      return value;
    } catch {
      throw new HttpBoundaryError(400, "invalid_json");
    }
  }
  if (type === "application/x-www-form-urlencoded") {
    if (/%(?![a-f\d]{2})/i.test(raw)) throw new HttpBoundaryError(400, "invalid_form");
    const params = new URLSearchParams(raw);
    for (const key of params.keys())
      if (params.getAll(key).length !== 1) throw new HttpBoundaryError(400, "duplicate_parameter");
    return params;
  }
  throw new HttpBoundaryError(415, "unsupported_content_type");
}
