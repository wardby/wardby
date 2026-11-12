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

/**
 * The request body cap. It holds the largest request the control plane sends with room for JSON
 * escaping: a whole design (at most 2 MiB of boards, framed) or one paginated document (at most
 * MAX_PAGINATED_HTML_BYTES) even if every character doubles (a quote or backslash becomes two).
 * Characters escaped as \uXXXX can push a body past it; the client reports that as too large.
 */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** One board's HTML; a stored board is at most 512 KiB plus the frame the control plane adds. */
export const MAX_HTML_BYTES = 600 * 1024;
/** One paginated document's HTML (a Markdown document of at most 1 MiB, rendered and framed). */
export const MAX_PAGINATED_HTML_BYTES = 3 * 1024 * 1024;
export const MAX_PDF_BOARDS = 50;
/** A whole render (all boards of a PDF) must finish within this, or it is aborted. */
export const DEFAULT_RENDER_DEADLINE_MS = 90_000;
const MAX_DRAIN_BYTES = 32 * 1024 * 1024;

const htmlUpTo = (max: number) => z.string().refine((s) => Buffer.byteLength(s, "utf8") <= max);
const width = z.number().int().min(320).max(2560);
const board = z.object({ html: htmlUpTo(MAX_HTML_BYTES), width });
const pngBody = board;
const pdfBody = z.union([
  z.object({ boards: z.array(board).min(1).max(MAX_PDF_BOARDS), paginate: z.literal(false).optional() }),
  z.object({
    boards: z.array(z.object({ html: htmlUpTo(MAX_PAGINATED_HTML_BYTES), width })).length(1),
    paginate: z.literal(true),
  }),
]);

/** What the server needs from Chromium; `isConnected` absent = always connected (tests). */
export type RendererChrome = Pick<ChromeRenderer, "png" | "pdf"> & Partial<Pick<ChromeRenderer, "isConnected">>;

type Route = "healthz" | "png" | "pdf" | "other";
type Fail = "invalid_request" | "payload_too_large" | "busy" | "render_failed" | "not_found" | "unavailable";
const FAIL_STATUS: Record<Fail, number> = {
  invalid_request: 400,
  payload_too_large: 413,
  busy: 429,
  render_failed: 500,
  not_found: 404,
  unavailable: 503,
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

/**
 * Exits the process (non-zero) when Chromium goes away, so the orchestrator restarts the pod
 * instead of leaving a renderer whose every render fails. The log line is fixed text.
 */
export function superviseChrome(
  chrome: Pick<ChromeRenderer, "onDisconnected">,
  opts: { log?: Logger; exit?: (code: number) => void } = {},
): void {
  const log = opts.log ?? logger.child({ module: "renderer" });
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  chrome.onDisconnected(() => {
    log.error("renderer browser disconnected; exiting");
    exit(1);
  });
}

/** Runs `work` with an abort signal; past `ms` the signal fires and the result is render_failed. */
async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new HttpFail("render_failed"));
    }, ms);
  });
  const running = work(ctl.signal);
  // A render that settles after the deadline is ignored (its rejection too).
  running.catch(() => undefined);
  try {
    return await Promise.race([running, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export function createRendererServer(
  chrome: RendererChrome,
  opts: {
    maxBodyBytes?: number;
    concurrency?: number;
    queue?: number;
    renderDeadlineMs?: number;
    log?: Logger;
  } = {},
): Server {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const concurrency = opts.concurrency ?? 2;
  const queue = opts.queue ?? 8;
  const deadlineMs = opts.renderDeadlineMs ?? DEFAULT_RENDER_DEADLINE_MS;
  const slots = semaphore(concurrency, queue);
  const log = opts.log ?? logger.child({ module: "renderer" });
  const connected = () => chrome.isConnected?.() ?? true;

  async function handle(req: IncomingMessage, route: Route): Promise<{ type: string; bytes: Buffer }> {
    if (route === "healthz" && req.method === "GET") {
      if (!connected()) throw new HttpFail("unavailable");
      return { type: "text/plain", bytes: Buffer.from("ok") };
    }
    if ((route !== "png" && route !== "pdf") || req.method !== "POST") throw new HttpFail("not_found");
    const raw = await readBody(req, maxBodyBytes);
    const input = route === "png" ? { png: parse(pngBody, raw) } : { pdf: parse(pdfBody, raw) };
    if (!connected()) throw new HttpFail("unavailable");
    await slots.acquire();
    try {
      return await withDeadline(deadlineMs, async (signal) => {
        if (input.png) {
          return { type: "image/png", bytes: await chrome.png(input.png.html, input.png.width, { signal }) };
        }
        const paginate = input.pdf.paginate === true;
        return { type: "application/pdf", bytes: await chrome.pdf(input.pdf.boards, { paginate, signal }) };
      });
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
  // Bounds how many bodies can be in flight at once: the render slots and the queue, plus a few for
  // health probes and refusals. Connections past it are dropped by Node.
  server.maxConnections = concurrency + queue + 4;
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  return server;
}
