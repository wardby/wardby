/**
 * The renderer service's HTTP API (no database, no secrets, no egress). Untrusted board HTML comes
 * in, PNG or PDF bytes go out. Request bodies, board text and render errors are never logged or
 * echoed: a log line carries only a fixed route label, the status, the duration and the byte count,
 * and an error reply is one fixed code.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { logger, type Logger } from "../core/logger.js";
import type { ChromeRenderer } from "./chrome.js";

export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** One board's HTML; a stored board is at most 512 KiB plus the frame the control plane adds. */
export const MAX_HTML_BYTES = 600 * 1024;
export const MAX_PDF_BOARDS = 50;
const MAX_DRAIN_BYTES = 32 * 1024 * 1024;

const html = z.string().refine((s) => Buffer.byteLength(s, "utf8") <= MAX_HTML_BYTES);
const width = z.number().int().min(320).max(2560);
const board = z.object({ html, width });
const pngBody = board;
const pdfBody = z.object({ boards: z.array(board).min(1).max(MAX_PDF_BOARDS) });

type Route = "healthz" | "png" | "pdf" | "other";
type Fail = "invalid_request" | "payload_too_large" | "busy" | "render_failed" | "not_found";
const FAIL_STATUS: Record<Fail, number> = {
  invalid_request: 400,
  payload_too_large: 413,
  busy: 429,
  render_failed: 500,
  not_found: 404,
};

class HttpFail extends Error {
  constructor(readonly code: Fail) {
    super(code);
  }
}

/** Waiters beyond `concurrency` queue up to `queue`; past that a request is refused as busy. */
function semaphore(concurrency: number, queue: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    async acquire(): Promise<void> {
      if (active < concurrency) {
        active += 1;
        return;
      }
      if (waiting.length >= queue) throw new HttpFail("busy");
      await new Promise<void>((resolve) => waiting.push(resolve));
    },
    release(): void {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    },
  };
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? "");
    if (Number.isFinite(declared) && declared > max) return reject(new HttpFail("payload_too_large"));
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > max) {
        done = true;
        reject(new HttpFail("payload_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks, size));
    });
    req.on("error", () => {
      if (done) return;
      done = true;
      reject(new HttpFail("invalid_request"));
    });
  });
}

function parse<T>(schema: z.ZodType<T>, raw: Buffer): T {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpFail("invalid_request");
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new HttpFail("invalid_request");
  return r.data;
}

export function createRendererServer(
  chrome: Pick<ChromeRenderer, "png" | "pdf">,
  opts: { maxBodyBytes?: number; concurrency?: number; queue?: number; log?: Logger } = {},
): Server {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const slots = semaphore(opts.concurrency ?? 2, opts.queue ?? 8);
  const log = opts.log ?? logger.child({ module: "renderer" });

  async function handle(req: IncomingMessage, route: Route): Promise<{ type: string; bytes: Buffer }> {
    if (route === "healthz" && req.method === "GET") return { type: "text/plain", bytes: Buffer.from("ok") };
    if ((route !== "png" && route !== "pdf") || req.method !== "POST") throw new HttpFail("not_found");
    const raw = await readBody(req, maxBodyBytes);
    const input = route === "png" ? { png: parse(pngBody, raw) } : { pdf: parse(pdfBody, raw) };
    await slots.acquire();
    try {
      if (input.png) return { type: "image/png", bytes: await chrome.png(input.png.html, input.png.width) };
      return { type: "application/pdf", bytes: await chrome.pdf(input.pdf.boards) };
    } catch (err) {
      if (err instanceof HttpFail) throw err;
      // The error is dropped: a Chromium message can quote the page it failed on.
      throw new HttpFail("render_failed");
    } finally {
      slots.release();
    }
  }

  function reply(
    req: IncomingMessage,
    res: ServerResponse,
    route: Route,
    started: number,
    status: number,
    type: string,
    bytes: Buffer,
  ) {
    res.writeHead(status, {
      "content-type": type,
      "content-length": bytes.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(bytes);
    log.info({ route, status, ms: Date.now() - started, bytes: bytes.length }, "render request");
    // A refused oversized upload is drained (so the client reads the 413) up to a bound, then cut.
    if (status === 413) {
      let drained = 0;
      req.on("data", (chunk: Buffer) => {
        drained += chunk.length;
        if (drained > MAX_DRAIN_BYTES) req.destroy();
      });
      req.resume();
    }
  }

  const server = createServer((req, res) => {
    const started = Date.now();
    const path = (req.url ?? "").split("?")[0];
    const route: Route =
      path === "/healthz" ? "healthz" : path === "/v1/png" ? "png" : path === "/v1/pdf" ? "pdf" : "other";
    handle(req, route).then(
      (ok) => reply(req, res, route, started, 200, ok.type, ok.bytes),
      (err: unknown) => {
        const code: Fail = err instanceof HttpFail ? err.code : "render_failed";
        if (code !== "payload_too_large") req.resume();
        reply(
          req,
          res,
          route,
          started,
          FAIL_STATUS[code],
          "application/json",
          Buffer.from(JSON.stringify({ error: code })),
        );
      },
    );
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  return server;
}
