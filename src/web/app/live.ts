/**
 * Live updates for the document page: reads /d/api/<id>/events and tells the
 * page what to refetch. Events carry ids and a kind only; the page always
 * refetches through the access-checked API.
 *
 * The stream is read with fetch rather than EventSource: on /s/<token> pages
 * a member's access comes from the share token in the `x-wardby-share`
 * header, which EventSource cannot send (and the token must not go in a URL).
 * The parser and reconnect rules below follow the SSE format (`retry`,
 * `event`, `data`, `:` comments).
 *
 * A tab hidden for HIDDEN_STOP_MS stops listening; when it is shown again the
 * stream reopens and the page refetches everything (as on `resync`).
 */

/** How long a hidden tab keeps listening (ruling R24). */
export const HIDDEN_STOP_MS = 5 * 60_000;
/** Reconnect delay when the server sends no `retry:`. */
export const DEFAULT_RETRY_MS = 3000;
/** Reconnect delay after the server refused the stream for too many open tabs (429). */
export const BUSY_RETRY_MS = 30_000;
export const MAX_BACKOFF_MS = 60_000;

export interface SseMessage {
  event: string;
  data: string;
}

/** Incremental SSE parser: feed it decoded text chunks, get complete messages. */
export class SseParser {
  private buf = "";
  private event = "";
  private data: string[] = [];
  /** The last `retry:` value the server sent, if any. */
  retryMs: number | null = null;

  push(chunk: string): SseMessage[] {
    this.buf += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const nl = this.buf.search(/\r\n|\r|\n/);
      if (nl < 0) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + (this.buf.startsWith("\r\n", nl) ? 2 : 1));
      if (line === "") {
        if (this.data.length > 0 || this.event) {
          out.push({ event: this.event || "message", data: this.data.join("\n") });
        }
        this.event = "";
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.event = value;
      else if (field === "data") this.data.push(value);
      else if (field === "retry" && /^\d+$/.test(value)) this.retryMs = Number(value);
    }
    return out;
  }
}

/** What the page does for a stream message. */
export type LiveAction = "threads" | "version" | "resync" | "status" | null;

export function liveAction(message: SseMessage): LiveAction {
  switch (message.event) {
    case "thread":
    case "comment":
    case "share":
      return "threads";
    case "version":
      return "version";
    case "resync":
      return "resync";
    case "hello":
    case "status":
      return "status";
    default:
      return null;
  }
}

/** `hello` and `status` data: whether the server is hearing changes (its LISTEN connection is up). */
export function statusConnected(data: string): boolean | null {
  try {
    const v = (JSON.parse(data) as { connected?: unknown }).connected;
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}

/**
 * What to do when the server has a version: nothing (already showing it),
 * load it in place, show the "document changed" banner (unsaved local
 * edits), or wait for an in-flight save to finish and decide again.
 */
export function versionAction(input: {
  shown: number;
  latest: number;
  dirty: boolean;
  saving: boolean;
}): "none" | "load" | "banner" | "defer" {
  if (input.saving) return "defer";
  if (input.latest <= input.shown) return "none";
  return input.dirty ? "banner" : "load";
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Stops the stream once the tab has been hidden for `hiddenMs`, and resumes
 * (with a full refetch) when it is shown again. Drive it with `visible(bool)`
 * from the Page Visibility API.
 */
export class HiddenStopper {
  private timer: unknown = null;
  private stopped = false;

  constructor(
    private readonly hooks: { stop(): void; resume(): void },
    private readonly hiddenMs: number = HIDDEN_STOP_MS,
    private readonly timers: Timers = realTimers,
  ) {}

  visible(isVisible: boolean): void {
    if (!isVisible) {
      if (this.timer === null && !this.stopped) {
        this.timer = this.timers.set(() => {
          this.timer = null;
          this.stopped = true;
          this.hooks.stop();
        }, this.hiddenMs);
      }
      return;
    }
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    if (this.stopped) {
      this.stopped = false;
      this.hooks.resume();
    }
  }
}

export type LiveState = "connecting" | "live" | "offline" | "stopped";

export interface LiveHandlers {
  onMessage(message: SseMessage): void;
  /** A stream opened after an earlier one (a reconnect): anything may have been missed. */
  onReconnect(): void;
  onState(state: LiveState): void;
}

/**
 * The page's connection: opens the stream, parses it, reconnects after the
 * server's retry delay, and stops for good on 401/403/404 (signed out, no
 * access, gone). `stop()` / `start()` are for the hidden-tab rule.
 */
export class LiveConnection {
  private controller: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private opened = false;
  private running = false;
  private retryMs = DEFAULT_RETRY_MS;
  /** Delay before the next retry after a failed open; doubles per failure, reset by a successful open. */
  private failMs = DEFAULT_RETRY_MS;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly handlers: LiveHandlers,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.controller?.abort();
    this.controller = null;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.handlers.onState("offline");
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, ms);
  }

  /** Back off 3 s, 6 s, 12 s … up to MAX_BACKOFF_MS while the server keeps failing to open the stream. */
  private scheduleFailure(): void {
    const ms = Math.max(this.retryMs, this.failMs);
    this.failMs = Math.min(this.failMs * 2, MAX_BACKOFF_MS);
    this.schedule(Math.min(ms, MAX_BACKOFF_MS));
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    const controller = new AbortController();
    this.controller = controller;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        headers: { accept: "text/event-stream", ...this.headers },
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) return;
      return this.scheduleFailure();
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      this.running = false;
      this.handlers.onState("stopped");
      return;
    }
    if (!res.ok || !res.body) {
      return res.status === 429 ? this.schedule(BUSY_RETRY_MS) : this.scheduleFailure();
    }
    this.failMs = DEFAULT_RETRY_MS;
    const reconnect = this.opened;
    this.opened = true;
    this.handlers.onState("live");
    if (reconnect) this.handlers.onReconnect();
    const parser = new SseParser();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const message of parser.push(decoder.decode(value, { stream: true }))) {
          this.handlers.onMessage(message);
        }
        if (parser.retryMs !== null) this.retryMs = parser.retryMs;
      }
    } catch {
      /* dropped or aborted */
    }
    if (controller.signal.aborted || this.controller !== controller) return;
    this.schedule(this.retryMs);
  }
}

/**
 * Wraps an async task so that calls during a run collapse into one more run
 * after it (a burst of events costs at most two refetches, never overlapping).
 */
export function coalesce(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  const run = async (): Promise<void> => {
    do {
      again = false;
      try {
        await task();
      } catch {
        /* the task reports its own errors */
      }
    } while (again);
    running = null;
  };
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = run();
    return running;
  };
}
