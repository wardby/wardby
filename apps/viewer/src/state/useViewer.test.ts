import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FramePayload, StreamFrame } from "../api/client";
import type { GraphSnapshot, ViewerEvent } from "../api/types";

const calls: string[] = [];
let handler: ((p: FramePayload) => void) | null = null;
const unlisten = vi.fn();

vi.mock("../api/client", () => ({
  isAppError: (e: unknown) => typeof e === "object" && e !== null && "kind" in e && "message" in e,
  onFrame: vi.fn(async (cb: (p: FramePayload) => void) => {
    calls.push("onFrame");
    handler = cb;
    return unlisten;
  }),
  connect: vi.fn(async () => void calls.push("connect")),
  disconnect: vi.fn(async () => void calls.push("disconnect")),
  fetchGraph: vi.fn(async () => {
    calls.push("fetchGraph");
    return snapshot();
  }),
}));

import * as client from "../api/client";
import { useViewer } from "./useViewer";

const URL_ = "https://w.example";

function snapshot(): GraphSnapshot {
  return {
    generatedAt: "2026-10-02T00:00:00.000Z",
    since: "2026-10-01T23:00:00.000Z",
    limit: 500,
    truncated: false,
    runs: [],
    spend: { todayUsd: 0, groups: [] },
  };
}

const send = (frame: StreamFrame) => act(() => handler!({ server: URL_, frame }));
const runEvent = (runId: string): ViewerEvent =>
  ({
    kind: "run",
    runId,
    agentId: "a",
    status: "running",
    turns: 1,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    finishedAt: null,
    parentRunId: null,
  }) as ViewerEvent;
const settle = () => act(async () => {});
const fetches = () => calls.filter((c) => c === "fetchGraph").length;

beforeEach(() => {
  calls.length = 0;
  handler = null;
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(client.fetchGraph).mockImplementation(async () => {
    calls.push("fetchGraph");
    return snapshot();
  });
});
afterEach(() => vi.useRealTimers());

describe("useViewer", () => {
  it("opens the stream before the first graph fetch", async () => {
    renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    expect(calls.indexOf("onFrame")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("onFrame")).toBeLessThan(calls.indexOf("connect"));
    expect(calls.indexOf("connect")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("connect")).toBeLessThan(calls.indexOf("fetchGraph"));
    expect(fetches()).toBe(1);
  });

  it("does not fetch twice when hello arrives before connect resolves", async () => {
    renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    await send({ type: "hello", connected: true });
    await settle();
    expect(fetches()).toBe(1);
  });

  it("refetches on resync and tracks live status", async () => {
    const { result } = renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    await send({ type: "status", connected: true });
    expect(result.current.model.live).toBe(true);
    await send({ type: "resync" });
    await settle();
    expect(fetches()).toBe(2);
    await send({ type: "reconnecting", attempt: 1, delay_ms: 100 });
    expect(result.current.model.live).toBe(false);
    expect(result.current.reconnecting).toBe(true);
  });

  it("refetches once for three unknown-run events within 750 ms", async () => {
    renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    expect(fetches()).toBe(1);
    await send({ type: "event", kind: "run", data: runEvent("r1") });
    await send({ type: "event", kind: "run", data: runEvent("r2") });
    await send({ type: "event", kind: "run", data: runEvent("r3") });
    expect(fetches()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(fetches()).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetches()).toBe(2);
  });

  it("refetches when a known run finishes, so today's spend includes it", async () => {
    const known = { ...snapshot(), runs: [{ id: "r1" } as GraphSnapshot["runs"][number]] };
    vi.mocked(client.fetchGraph).mockImplementation(async () => {
      calls.push("fetchGraph");
      return known;
    });
    renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    expect(fetches()).toBe(1);
    // Still running: applied in place, no refetch.
    await send({ type: "event", kind: "run", data: runEvent("r1") });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(fetches()).toBe(1);
    const done = { ...runEvent("r1"), status: "succeeded", finishedAt: "2026-10-02T00:01:00.000Z" } as ViewerEvent;
    await send({ type: "event", kind: "run", data: done });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(fetches()).toBe(2);
  });

  it("exposes needsSignIn and forbidden from an ended frame", async () => {
    const { result } = renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    await send({ type: "ended", error: { kind: "not_signed_in", message: "sign in" } });
    expect(result.current.needsSignIn).toBe(true);
    await send({ type: "ended", error: { kind: "forbidden", message: "no" } });
    expect(result.current.needsSignIn).toBe(false);
    expect(result.current.forbidden).toBe(true);
  });

  it("exposes needsSignIn when connect rejects and does not fetch", async () => {
    vi.mocked(client.connect).mockRejectedValueOnce({ kind: "not_signed_in", message: "x" });
    const { result } = renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    expect(result.current.needsSignIn).toBe(true);
    expect(fetches()).toBe(0);
  });

  it("Retry runs connect again after it failed for a reason other than sign-in", async () => {
    vi.mocked(client.connect).mockRejectedValueOnce({ kind: "keychain", message: "locked" });
    const { result } = renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    expect(result.current.error?.kind).toBe("keychain");
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(fetches()).toBe(0);
    act(() => result.current.retry());
    await settle();
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.loaded).toBe(true);
  });

  it("drops the live badge when the view is torn down or switches server", async () => {
    const { result, rerender } = renderHook(
      ({ url }: { url: string | null }) => useViewer(url, { since: "1h", limit: 500 }),
      {
        initialProps: { url: URL_ as string | null },
      },
    );
    await settle();
    await send({ type: "status", connected: true });
    expect(result.current.model.live).toBe(true);
    // No server left to show: nothing may keep claiming the stream is live.
    rerender({ url: null });
    expect(result.current.model.live).toBe(false);
    expect(client.disconnect).toHaveBeenCalledWith(URL_);
  });

  it("a switched-to server is not live until its own stream says so", async () => {
    const { result, rerender } = renderHook(({ url }) => useViewer(url, { since: "1h", limit: 500 }), {
      initialProps: { url: URL_ },
    });
    await settle();
    await send({ type: "status", connected: true });
    expect(result.current.model.live).toBe(true);
    rerender({ url: "https://b.example" });
    await settle();
    expect(result.current.model.live).toBe(false);
    // A straggler from the old server's stream changes nothing.
    await send({ type: "status", connected: true });
    expect(result.current.model.live).toBe(false);
    act(() => handler!({ server: "https://b.example", frame: { type: "status", connected: true } }));
    expect(result.current.model.live).toBe(true);
  });

  it("ignores malformed event frames", async () => {
    const { result } = renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    await send({ type: "event", kind: "run", data: null as unknown as ViewerEvent });
    await send({ type: "event", kind: "run", data: { kind: "run" } as unknown as ViewerEvent });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetches()).toBe(1);
    expect(result.current.model.ticker).toHaveLength(0);
  });

  it("refetches when the window changes", async () => {
    const { rerender } = renderHook(({ since }) => useViewer(URL_, { since, limit: 500 }), {
      initialProps: { since: "1h" },
    });
    await settle();
    rerender({ since: "6h" });
    await settle();
    expect(fetches()).toBe(2);
    expect(vi.mocked(client.fetchGraph).mock.calls[1]).toEqual([URL_, "6h", 500]);
  });

  it("ignores frames for other servers and cleans up on unmount", async () => {
    const { result, unmount } = renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    act(() => handler!({ server: "https://other", frame: { type: "status", connected: true } }));
    expect(result.current.model.live).toBe(false);
    await send({ type: "event", kind: "run", data: runEvent("r1") });
    unmount();
    expect(unlisten).toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalledWith(URL_);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetches()).toBe(1);
  });

  const deferred = () => {
    let resolve!: (s: GraphSnapshot) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<GraphSnapshot>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const withRun = (id: string): GraphSnapshot => ({
    ...snapshot(),
    runs: [{ id, agentId: "a", agentName: "agent", status: "running" } as GraphSnapshot["runs"][number]],
  });

  it("discards a stale response and refetches when the window changes during the first load", async () => {
    const first = deferred();
    const second = deferred();
    vi.mocked(client.fetchGraph).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(({ since }) => useViewer(URL_, { since, limit: 500 }), {
      initialProps: { since: "1h" },
    });
    await settle();
    rerender({ since: "7d" });
    await settle();
    expect(vi.mocked(client.fetchGraph).mock.calls.map((c) => c[1])).toEqual(["1h", "7d"]);
    await act(async () => second.resolve(withRun("new-window")));
    await act(async () => first.resolve(withRun("old-window")));
    expect([...result.current.model.runs.keys()]).toEqual(["new-window"]);
  });

  it("surfaces a failed first fetch, retries on Retry, and again on the next hello", async () => {
    vi.mocked(client.fetchGraph).mockRejectedValueOnce({ kind: "network", message: "down" });
    const { result } = renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    expect(result.current.error?.kind).toBe("network");
    expect(result.current.loaded).toBe(false);
    act(() => result.current.retry());
    await settle();
    expect(result.current.loaded).toBe(true);
    expect(result.current.error).toBeNull();

    vi.mocked(client.fetchGraph).mockRejectedValueOnce({ kind: "network", message: "down" });
    await send({ type: "resync" });
    await settle();
    expect(result.current.error?.kind).toBe("network");
    const before = fetches();
    await send({ type: "hello", connected: true });
    await settle();
    expect(fetches()).toBe(before + 1);
    expect(result.current.error).toBeNull();
  });

  it("window change after a failed first fetch refetches", async () => {
    vi.mocked(client.fetchGraph).mockRejectedValueOnce({ kind: "network", message: "down" });
    const { result, rerender } = renderHook(({ since }) => useViewer(URL_, { since, limit: 500 }), {
      initialProps: { since: "1h" },
    });
    await settle();
    rerender({ since: "6h" });
    await settle();
    expect(result.current.loaded).toBe(true);
  });

  it("keeps an unknown-run event that arrives while a fetch is in flight", async () => {
    const slow = deferred();
    renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    vi.mocked(client.fetchGraph).mockReturnValueOnce(slow.promise);
    await send({ type: "resync" });
    await send({ type: "event", kind: "run", data: runEvent("late") });
    await act(async () => slow.resolve(snapshot()));
    const before = fetches();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(fetches()).toBe(before + 1);
  });

  it("retries a failed refetch with backoff, then stops", async () => {
    renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    vi.mocked(client.fetchGraph).mockRejectedValue({ kind: "network", message: "down" });
    await send({ type: "resync" });
    await settle();
    const n = vi.mocked(client.fetchGraph).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(vi.mocked(client.fetchGraph).mock.calls.length).toBe(n + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(vi.mocked(client.fetchGraph).mock.calls.length).toBe(n + 2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(vi.mocked(client.fetchGraph).mock.calls.length).toBe(n + 3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(vi.mocked(client.fetchGraph).mock.calls.length).toBe(n + 3);
  });

  it("never refetches the graph for a step event, whatever run it names", async () => {
    renderHook(() => useViewer(URL_, { since: "1h", limit: 500 }));
    await settle();
    expect(fetches()).toBe(1);
    const step = {
      kind: "step",
      runId: "unknown-run",
      seq: 1,
      stepKind: "said",
      tool: null,
      summary: "x",
      status: null,
      at: "2026-10-02T00:00:00.000Z",
    } as ViewerEvent;
    await send({ type: "event", kind: "step", data: step });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetches()).toBe(1);
  });
});
