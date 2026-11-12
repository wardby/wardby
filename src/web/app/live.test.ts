import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUSY_RETRY_MS,
  coalesce,
  HIDDEN_STOP_MS,
  HiddenStopper,
  liveAction,
  LiveConnection,
  SseParser,
  statusConnected,
  versionAction,
  type LiveState,
  type SseMessage,
} from "./live.js";

describe("SseParser", () => {
  it("parses events across chunk boundaries, skips comments and reads retry", () => {
    const p = new SseParser();
    expect(p.push("retry: 3000\n\nevent: hel")).toEqual([]);
    expect(p.push('lo\ndata: {"connected":true}\n\n: ping\n\nevent: comment\r\ndata: {"a":1}\r\n\r\n')).toEqual([
      { event: "hello", data: '{"connected":true}' },
      { event: "comment", data: '{"a":1}' },
    ]);
    expect(p.retryMs).toBe(3000);
  });
  it("joins multi-line data and defaults the event name", () => {
    expect(new SseParser().push("data: a\ndata: b\n\n")).toEqual([{ event: "message", data: "a\nb" }]);
  });
});

describe("what the page does for a message", () => {
  const m = (event: string, data = "{}"): SseMessage => ({ event, data });
  it("maps thread, comment and share to a threads refetch; version and resync to their own", () => {
    expect(liveAction(m("thread"))).toBe("threads");
    expect(liveAction(m("comment"))).toBe("threads");
    expect(liveAction(m("share"))).toBe("threads");
    expect(liveAction(m("version"))).toBe("version");
    expect(liveAction(m("resync"))).toBe("resync");
    expect(liveAction(m("status"))).toBe("status");
    expect(liveAction(m("hello"))).toBeNull();
  });
  it("reads status data", () => {
    expect(statusConnected('{"connected":false}')).toBe(false);
    expect(statusConnected("nope")).toBeNull();
  });
  it("loads a newer version in place unless there are unsaved edits or a save is in flight", () => {
    expect(versionAction({ shown: 2, latest: 3, dirty: false, saving: false })).toBe("load");
    expect(versionAction({ shown: 2, latest: 3, dirty: true, saving: false })).toBe("banner");
    expect(versionAction({ shown: 3, latest: 3, dirty: true, saving: false })).toBe("none");
    expect(versionAction({ shown: 2, latest: 3, dirty: false, saving: true })).toBe("defer");
  });
});

describe("HiddenStopper", () => {
  afterEach(() => vi.useRealTimers());

  it("stops after five minutes hidden and resumes (with a refetch) when shown", () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    const resume = vi.fn();
    const s = new HiddenStopper({ stop, resume });
    s.visible(false);
    vi.advanceTimersByTime(HIDDEN_STOP_MS - 1);
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stop).toHaveBeenCalledOnce();
    s.visible(true);
    expect(resume).toHaveBeenCalledOnce();
    expect(HIDDEN_STOP_MS).toBe(5 * 60_000);
  });

  it("does nothing when the tab comes back before five minutes", () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    const resume = vi.fn();
    const s = new HiddenStopper({ stop, resume });
    s.visible(false);
    vi.advanceTimersByTime(HIDDEN_STOP_MS / 2);
    s.visible(true);
    vi.advanceTimersByTime(HIDDEN_STOP_MS);
    expect(stop).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });
});

describe("coalesce", () => {
  it("runs at most once more for calls during a run, never overlapping", async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    let release!: () => void;
    const task = coalesce(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      runs++;
      await new Promise<void>((r) => (release = r));
      active--;
    });
    const first = task();
    void task();
    void task();
    release();
    await new Promise((r) => setTimeout(r, 0));
    release();
    await first;
    expect(runs).toBe(2);
    expect(maxActive).toBe(1);
  });
});

/** A fake fetch whose responses are queued; each stream body is pushed by the test. */
function fakeFetch() {
  const calls: { headers: Record<string, string> }[] = [];
  const queue: (() => Response)[] = [];
  const impl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls.push({ headers: init?.headers as Record<string, string> });
    const next = queue.shift();
    if (!next) return new Promise<Response>(() => undefined);
    return next();
  });
  const stream = () => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => (ctrl = c) });
    const enc = new TextEncoder();
    return {
      response: () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      push: (text: string) => ctrl.enqueue(enc.encode(text)),
      end: () => ctrl.close(),
    };
  };
  return { impl: impl as unknown as typeof fetch, calls, queue, stream };
}

describe("LiveConnection", () => {
  afterEach(() => vi.useRealTimers());
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("sends the share token header, delivers messages and refetches after a reconnect", async () => {
    const f = fakeFetch();
    const s1 = f.stream();
    const s2 = f.stream();
    f.queue.push(s1.response, s2.response);
    const messages: string[] = [];
    const states: LiveState[] = [];
    const onReconnect = vi.fn();
    const live = new LiveConnection(
      "/d/api/doc/events",
      { "x-wardby-share": "tok" },
      { onMessage: (m) => messages.push(m.event), onReconnect, onState: (st) => states.push(st) },
      f.impl,
    );
    live.start();
    await flush();
    s1.push("retry: 5\n\nevent: hello\ndata: {}\n\nevent: comment\ndata: {}\n\n");
    await flush();
    expect(messages).toEqual(["hello", "comment"]);
    expect(f.calls[0].headers).toMatchObject({ accept: "text/event-stream", "x-wardby-share": "tok" });
    expect(onReconnect).not.toHaveBeenCalled();
    s1.end();
    await flush();
    expect(states).toContain("offline");
    await new Promise((r) => setTimeout(r, 20)); // the server's retry: 5
    expect(onReconnect).toHaveBeenCalledOnce();
    expect(states.at(-1)).toBe("live");
    live.stop();
  });

  it("stops for good when signed out, and waits longer when refused for too many tabs", async () => {
    vi.useFakeTimers();
    const f = fakeFetch();
    f.queue.push(
      () => new Response("{}", { status: 429 }),
      () => new Response("{}", { status: 401 }),
    );
    const states: LiveState[] = [];
    const live = new LiveConnection(
      "/d/api/doc/events",
      {},
      { onMessage: () => undefined, onReconnect: () => undefined, onState: (st) => states.push(st) },
      f.impl,
    );
    live.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(["offline"]);
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS - 1);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
    expect(states.at(-1)).toBe("stopped");
    await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS * 2);
    expect(f.calls).toHaveLength(2);
  });
});
