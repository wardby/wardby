/**
 * One Server-Sent Events response, shared by the Viewer stream
 * (/admin/api/events) and the document stream (/d/api/<id>/events).
 *
 * - Headers: text/event-stream, no-store, `x-accel-buffering: no` (nginx and
 *   compatible proxies otherwise buffer the stream), then `retry: 3000`.
 * - Backlog cap: a client that stops reading must not grow server memory
 *   without bound. Past `maxBufferedBytes` the stream is dropped (its backlog
 *   with it); the client reconnects and resyncs.
 * - Heartbeat: a `: ping` comment every `heartbeatMs`. With `beforeHeartbeat`,
 *   the check runs first (never two at once) and the stream ends when it
 *   returns false or throws.
 * - `close()` ends the response and the connection (so shutdown never waits
 *   for the keep-alive timeout); cleanup runs once however the stream ends.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export const SSE_RETRY_MS = 3000;

export interface SseStream {
  /** Writes one frame (ignored once the stream is done). */
  send(frame: string): void;
  /** Runs `fn` when the stream ends (at once if it already has). */
  onEnd(fn: () => void): void;
  /** Ends the stream and its connection. */
  close(): void;
  readonly done: boolean;
}

export interface SseOptions {
  heartbeatMs: number;
  maxBufferedBytes: number;
  /** Re-checks the stream's right to stay open before each heartbeat. */
  beforeHeartbeat?: () => Promise<boolean> | boolean;
}

/** Opens the stream, or returns null when the client already went away (nothing to subscribe for). */
export function openSseStream(req: IncomingMessage, res: ServerResponse, options: SseOptions): SseStream | null {
  // The client may have gone while the caller awaited authentication; its close
  // events already fired and will not fire again, so subscribing now would leak.
  if (req.destroyed || res.destroyed || res.writableEnded) return null;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  });
  let done = false;
  const enders: (() => void)[] = [];
  const cleanup = (): void => {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    for (const fn of enders.splice(0)) {
      try {
        fn();
      } catch {
        /* one failing cleanup must not stop the others */
      }
    }
  };
  const stream: SseStream = {
    send(frame) {
      if (done) return;
      res.write(frame);
      if (res.writableLength > options.maxBufferedBytes) {
        cleanup();
        res.destroy();
      }
    },
    onEnd(fn) {
      if (done) fn();
      else enders.push(fn);
    },
    close() {
      cleanup();
      res.shouldKeepAlive = false;
      res.end();
    },
    get done() {
      return done;
    },
  };
  res.write(`retry: ${SSE_RETRY_MS}\n\n`);
  let checking = false;
  const heartbeat = setInterval(() => {
    if (!options.beforeHeartbeat) return stream.send(": ping\n\n");
    if (checking) return;
    checking = true;
    Promise.resolve()
      .then(() => options.beforeHeartbeat!())
      .then(
        (ok) => (ok ? stream.send(": ping\n\n") : stream.close()),
        () => stream.close(),
      )
      .finally(() => {
        checking = false;
      });
  }, options.heartbeatMs);
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
  return stream;
}
