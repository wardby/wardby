import { describe, expect, it, vi } from "vitest";
import { RunStepForwarder } from "./run-step-forwarder.js";
import { MAX_RUN_STEPS_POST_BYTES, MAX_STEP_TEXT_CHARS, type RunStepBatch } from "../../core/run-steps/types.js";

// A fake capability with the real shape: never a real one.
const CAP = `rrp_${"A".repeat(43)}`;
const FAKE_SECRET = "fake-secret-value-ZZ9";
const URL_BASE = "http://wardby-control-plane-internal:8792";
const batch: RunStepBatch = {
  steps: [{ kind: "tool", callId: "c1", tool: "Bash", text: "npm test", truncated: false }],
  results: [],
};
const accepted = () => vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 202 }));

describe("RunStepForwarder", () => {
  it("posts each batch, with the run capability, to the control plane's listener", async () => {
    const fetchImpl = accepted();
    const forwarder = new RunStepForwarder({
      url: URL_BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    forwarder.submit(CAP, "r1", batch);
    await forwarder.flush();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${URL_BASE}/internal/run-steps`);
    expect(url).not.toContain(CAP);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${CAP}`);
    expect(JSON.parse(init.body as string)).toEqual({ runId: "r1", ...batch });
    expect(init.body).not.toContain(CAP);
  });

  it("splits a large batch into bounded POSTs", async () => {
    const fetchImpl = accepted();
    const forwarder = new RunStepForwarder({
      url: URL_BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    forwarder.submit(CAP, "r1", {
      steps: Array.from({ length: 130 }, (_, n) => ({ ...batch.steps[0], callId: `c${n}` })),
      results: Array.from({ length: 300 }, (_, n) => ({ callId: `c${n}`, status: "ok" as const })),
    });
    await forwarder.flush();
    const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body as string) as RunStepBatch);
    expect(bodies.map((b) => [b.steps.length, b.results.length])).toEqual([
      [64, 0],
      [64, 0],
      [2, 0],
      [0, 256],
      [0, 44],
    ]);
  });

  it("splits detail-sized results by serialized size: every result once, no body over the cap", async () => {
    const fetchImpl = accepted();
    const forwarder = new RunStepForwarder({ url: URL_BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    const results = Array.from({ length: 400 }, (_, n) => ({
      callId: `c${n}`,
      status: "ok" as const,
      output: "x".repeat(4096),
      outputCut: true,
    }));
    forwarder.submit(CAP, "r1", { steps: [], results });
    await forwarder.flush();
    const bodies = fetchImpl.mock.calls.map(([, init]) => init.body as string);
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_RUN_STEPS_POST_BYTES);
    const ids = bodies.flatMap((body) => (JSON.parse(body) as RunStepBatch).results.map((r) => r.callId));
    expect(ids).toEqual(results.map((r) => r.callId));
  });

  it("counts input and output bytes in the queue bound: detail-sized steps are dropped past 8 MiB", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => {
      await gate;
      return new Response(null, { status: 202 });
    });
    const info = vi.fn();
    const forwarder = new RunStepForwarder({
      url: URL_BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: { info },
    });
    const big: RunStepBatch = {
      steps: [
        {
          kind: "tool",
          callId: "c1",
          tool: "Bash",
          text: "t".repeat(MAX_STEP_TEXT_CHARS),
          truncated: false,
          input: "i".repeat(MAX_STEP_TEXT_CHARS),
          inputTruncated: false,
        },
      ],
      results: [{ callId: "c1", status: "ok", output: "o".repeat(4096), outputCut: true }],
    };
    forwarder.submit(CAP, "r1", big); // taken at once, waiting on the gate
    await new Promise((resolve) => setImmediate(resolve));
    for (let n = 0; n < 300; n += 1) forwarder.submit(CAP, "r1", big);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ reason: "queue_full" }), expect.any(String));
    release();
    await forwarder.flush();
    const queuedBodies = fetchImpl.mock.calls
      .slice(1)
      .filter(([, init]) => (init.body as string).includes('"steps":[{'));
    const bytes = queuedBodies.reduce((sum, [, init]) => sum + Buffer.byteLength(init.body as string), 0);
    expect(queuedBodies.length).toBeGreaterThan(10);
    expect(queuedBodies.length).toBeLessThan(300);
    expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("drops on a full queue and logs only a reason and a count", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = vi.fn(async () => {
      await gate;
      return new Response(null, { status: 202 });
    });
    const info = vi.fn();
    const forwarder = new RunStepForwarder({
      url: URL_BASE,
      fetchImpl: fetchImpl,
      maxQueue: 1,
      log: { info },
    });
    forwarder.submit(CAP, "r1", batch); // taken at once, waiting on the gate
    await new Promise((resolve) => setImmediate(resolve));
    forwarder.submit(CAP, "r1", batch); // queued
    forwarder.submit(CAP, "r1", batch); // queue full: dropped
    expect(info).toHaveBeenCalledWith(
      { event: "run_steps.forward_dropped", reason: "queue_full", droppedParts: 1 },
      expect.any(String),
    );
    release();
    await forwarder.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(info.mock.calls)).not.toContain(CAP);
    expect(JSON.stringify(info.mock.calls)).not.toContain("npm test");
  });

  it.each([
    ["unreachable", () => vi.fn(async () => Promise.reject(new Error(`ECONNREFUSED ${CAP}`)))],
    ["http_401", () => vi.fn(async () => new Response(`refused ${CAP}`, { status: 401 }))],
    [
      "timeout",
      () =>
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) =>
              init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
            ),
        ),
    ],
  ])(
    "drops with reason %s, never throws, and keeps the capability out of the log even when the error or response quotes it",
    async (reason, makeFetch) => {
      const info = vi.fn();
      const forwarder = new RunStepForwarder({
        url: URL_BASE,
        fetchImpl: makeFetch() as unknown as typeof fetch,
        timeoutMs: 10,
        log: { info },
      });
      expect(() => forwarder.submit(CAP, "r1", batch)).not.toThrow();
      await expect(forwarder.flush()).resolves.toBeUndefined();
      expect(info).toHaveBeenCalledWith(
        { event: "run_steps.forward_dropped", reason, droppedParts: 1 },
        expect.any(String),
      );
      expect(JSON.stringify(info.mock.calls)).not.toContain(CAP);
    },
  );

  it("keeps step text and the capability out of every log call and out of anything but the POST body and Authorization header", async () => {
    const secretBatch: RunStepBatch = {
      steps: [
        {
          kind: "tool",
          callId: "c1",
          tool: "Bash",
          text: `curl -H "x: ${FAKE_SECRET}"`,
          truncated: false,
        },
      ],
      results: [],
    };
    const info = vi.fn();
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => {
      throw new Error(`boom ${FAKE_SECRET} ${CAP}`);
    });
    const forwarder = new RunStepForwarder({
      url: URL_BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: { info },
    });
    let thrown: unknown;
    try {
      forwarder.submit(CAP, "r1", secretBatch);
    } catch (error) {
      thrown = error;
    }
    const flushed = await forwarder.flush().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect(thrown).toBeUndefined();
    expect(flushed).toEqual({ value: undefined });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).not.toContain(CAP);
    expect(init.body).not.toContain(CAP); // the capability is only in the header
    expect(init.body).toContain(FAKE_SECRET); // the body is raw by design
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${CAP}`);
    expect(info).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain(CAP);
    expect(logged).not.toContain(FAKE_SECRET);
    expect(logged).not.toContain("curl");
  });

  it("flush is bounded: it returns even when a POST never settles", async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const forwarder = new RunStepForwarder({
      url: URL_BASE,
      fetchImpl: fetchImpl,
      flushTimeoutMs: 20,
    });
    forwarder.submit(CAP, "r1", batch);
    await expect(forwarder.flush()).resolves.toBeUndefined();
  });

  it("splits by serialized size: max-length multi-byte steps never exceed the body cap and nothing is dropped", async () => {
    const fetchImpl = accepted();
    const info = vi.fn();
    const forwarder = new RunStepForwarder({
      url: URL_BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: { info },
    });
    const text = "\u20ac".repeat(MAX_STEP_TEXT_CHARS); // 3 bytes each in UTF-8
    forwarder.submit(CAP, "r1", {
      steps: Array.from({ length: 64 }, (_, n) => ({ ...batch.steps[0], callId: `c${n}`, text })),
      results: [],
    });
    await forwarder.flush();
    const bodies = fetchImpl.mock.calls.map(([, init]) => init.body as string);
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_RUN_STEPS_POST_BYTES);
    const total = bodies.reduce((n, body) => n + (JSON.parse(body) as RunStepBatch).steps.length, 0);
    expect(total).toBe(64);
    expect(info).not.toHaveBeenCalled();
  });

  it("close(): starts no fetch afterwards, aborts the in-flight POST, resolves within the bound, leaks nothing", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const info = vi.fn();
    const forwarder = new RunStepForwarder({
      url: URL_BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      flushTimeoutMs: 20,
      log: { info },
    });
    const secretBatch: RunStepBatch = {
      steps: [{ kind: "said", callId: "s1", text: FAKE_SECRET, truncated: false }],
      results: [],
    };
    forwarder.submit(CAP, "r1", secretBatch);
    await new Promise((resolve) => setImmediate(resolve));
    forwarder.submit(CAP, "r1", secretBatch); // queued behind the hung POST
    const started = Date.now();
    await expect(forwarder.close()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(signal?.aborted).toBe(true);
    forwarder.submit(CAP, "r1", secretBatch);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain("closed");
    expect(logged).not.toContain(CAP);
    expect(logged).not.toContain(FAKE_SECRET);
  });

  it("reports serialize_failed when a batch cannot be serialized", async () => {
    const fetchImpl = accepted();
    const info = vi.fn();
    const forwarder = new RunStepForwarder({
      url: URL_BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: { info },
    });
    const cyclic = { kind: "said", callId: "x", text: "t", truncated: false } as Record<string, unknown>;
    cyclic.self = cyclic;
    forwarder.submit(CAP, "r1", { steps: [cyclic as never], results: [] });
    await forwarder.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      { event: "run_steps.forward_dropped", reason: "serialize_failed", droppedParts: 1 },
      expect.any(String),
    );
  });
});
