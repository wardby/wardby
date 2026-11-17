import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { LlmStreamEvent } from "../providers/llm/types.js";

// Obviously fake, and code-shaped on purpose: a token like this passes causeCodeOf on its own.
const FAKE_READABLE = "fake_readable_secret_0004";

const streamFailure = vi.hoisted(() => ({
  error: undefined as unknown as Error,
  handlerThrows: undefined as Error | undefined,
}));
const inputRoute = vi.hoisted(() => {
  const response: unknown = { kind: "json", status: 200, body: { ok: true, result: { input: {} } } };
  return { response, delayMs: 0, calls: 0 };
});
vi.mock("./gateway-server.js", () => ({
  serveGatewayInput: async () => {
    inputRoute.calls += 1;
    await new Promise((done) => setTimeout(done, inputRoute.delayMs));
    return inputRoute.response;
  },
  serveGatewayRequest: async () => {
    if (streamFailure.handlerThrows) throw streamFailure.handlerThrows;
    return {
      kind: "stream",
      status: 200,
      // eslint-disable-next-line require-yield
      events: (async function* (): AsyncIterable<LlmStreamEvent> {
        throw streamFailure.error;
      })(),
    };
  },
}));

const { createGatewayServer, httpLog, MAX_CANARY_REQUEST_BYTES, MAX_INPUT_REQUEST_BYTES, NATIVE_GATEWAY_PATH } =
  await import("./http-server.js");
const { GATEWAY_INTERNAL_MESSAGE, GatewayError, NATIVE_GATEWAY_CANARY_PATH, NATIVE_GATEWAY_INPUT_PATH } =
  await import("./protocol.js");

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  streamFailure.handlerThrows = undefined;
  inputRoute.response = { kind: "json", status: 200, body: { ok: true, result: { input: {} } } };
  inputRoute.delayMs = 0;
  inputRoute.calls = 0;
});

async function listenOn(deps: object = {}): Promise<string> {
  const server = createGatewayServer(deps as never);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  close = () =>
    new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The last ndjson frame the listener sends for a model stream that fails with `err`. */
async function streamErrorFrame(err: Error): Promise<{ error: Record<string, unknown> }> {
  streamFailure.error = err;
  const server = createGatewayServer({} as never);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  close = () => new Promise<void>((done) => server.close(() => done()));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${NATIVE_GATEWAY_PATH}`, { method: "POST", body: "{}" });
  const lines = (await response.text()).trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as { error: Record<string, unknown> };
}

describe("native gateway HTTP listener, model stream failures", () => {
  it("never sends an unexpected error's own text", async () => {
    const frame = await streamErrorFrame(new Error(`${FAKE_READABLE}: raw exception text`));
    expect({
      keys: Object.keys(frame.error).sort(),
      code: frame.error.code,
      generic: frame.error.message === GATEWAY_INTERNAL_MESSAGE,
      leaks: JSON.stringify(frame).includes(FAKE_READABLE),
    }).toEqual({ keys: ["code", "message"], code: "internal", generic: true, leaks: false });
  });

  it("carries a checked cause code from the gateway", async () => {
    const frame = await streamErrorFrame(
      new GatewayError("internal", GATEWAY_INTERNAL_MESSAGE, "coding_execution_not_configured"),
    );
    expect(frame.error).toEqual({
      code: "internal",
      message: GATEWAY_INTERNAL_MESSAGE,
      causeCode: "coding_execution_not_configured",
    });
  });
});

describe("native gateway HTTP listener, handler failures", () => {
  it("logs only the error's name and declared code, never its text", async () => {
    streamFailure.handlerThrows = new Error(`${FAKE_READABLE}: raw handler text`);
    const lines: unknown[] = [];
    const spy = vi.spyOn(httpLog, "error").mockImplementation((obj: unknown) => {
      lines.push(obj);
    });
    try {
      const server = createGatewayServer({} as never);
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      close = () => new Promise<void>((done) => server.close(() => done()));
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}${NATIVE_GATEWAY_PATH}`, { method: "POST", body: "{}" });
      expect(response.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(inspect(lines, { depth: 10 }).includes(FAKE_READABLE)).toBe(false);
    expect(lines).toEqual([{ errName: "Error", causeCode: undefined }]);
  });
});

describe("native gateway HTTP listener, input route", () => {
  it("answers the route's JSON", async () => {
    const base = await listenOn();
    const response = await fetch(`${base}${NATIVE_GATEWAY_INPUT_PATH}`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: { input: {} } });
    expect(inputRoute.calls).toBe(1);
  });

  it("answers a non-JSON result with a generic 500 instead of leaving the request open", async () => {
    // eslint-disable-next-line require-yield
    const events = (async function* (): AsyncIterable<LlmStreamEvent> {
      throw new Error(`${FAKE_READABLE}: never read`);
    })();
    inputRoute.response = { kind: "stream", status: 200, events };
    const base = await listenOn();
    const response = await fetch(`${base}${NATIVE_GATEWAY_INPUT_PATH}`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: { code: "internal", message: GATEWAY_INTERNAL_MESSAGE } });
    expect(text).not.toContain(FAKE_READABLE);
  });

  it("answers a small body as usual", async () => {
    const base = await listenOn();
    const response = await fetch(`${base}${NATIVE_GATEWAY_INPUT_PATH}`, { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
  });

  it("cuts off a body past its bound and does not answer it", async () => {
    inputRoute.delayMs = 300;
    const base = await listenOn();
    const outcome = await fetch(`${base}${NATIVE_GATEWAY_INPUT_PATH}`, {
      method: "POST",
      body: "x".repeat(MAX_INPUT_REQUEST_BYTES * 1024),
      signal: AbortSignal.timeout(5_000),
    }).then(
      (r) => `status ${r.status}`,
      (err: unknown) => (err instanceof Error && err.name === "TimeoutError" ? "timeout" : "closed"),
    );
    expect(outcome).toBe("closed");
  });
});

describe("native gateway HTTP listener, canary route", () => {
  // Obviously fake: a run capability a caller might send. The route must never read or log it.
  const FAKE_NATIVE_CAP = "fake_native_capability_" + "0".repeat(21);
  const ACTOR = "wr-0123456789abcdef0123-canary";

  function store(recorded = true) {
    return { report: vi.fn(async () => recorded), create: vi.fn(), result: vi.fn(), delete: vi.fn() };
  }
  const post = (base: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${NATIVE_GATEWAY_CANARY_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      signal: AbortSignal.timeout(5_000),
    });

  it("records a valid verdict and answers 204, logging only the result and whether it was recorded", async () => {
    const canaries = store();
    const lines: unknown[] = [];
    const spy = vi.spyOn(httpLog, "info").mockImplementation((obj: unknown) => void lines.push(obj));
    try {
      const base = await listenOn({ canaries });
      const response = await post(base, JSON.stringify({ actor: ACTOR, result: "pass" }), {
        authorization: `Bearer ${FAKE_NATIVE_CAP}`,
      });
      expect(response.status).toBe(204);
    } finally {
      spy.mockRestore();
    }
    expect(canaries.report).toHaveBeenCalledWith(ACTOR, "pass", expect.any(Date));
    expect(lines).toEqual([{ result: "pass", recorded: true }]);
    for (const line of lines)
      expect(Object.keys(line as object).every((k) => ["result", "recorded"].includes(k))).toBe(true);
    expect(inspect(lines, { depth: 10 })).not.toContain(FAKE_NATIVE_CAP);
    expect(inspect(lines, { depth: 10 })).not.toContain(ACTOR);
  });

  it("answers 204 whether or not a row took the report (no oracle)", async () => {
    const canaries = store(false);
    const spy = vi.spyOn(httpLog, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(httpLog, "warn").mockImplementation(() => {});
    onTestFinished(() => {
      spy.mockRestore();
      warnSpy.mockRestore();
    });
    const base = await listenOn({ canaries });
    const response = await post(base, JSON.stringify({ actor: ACTOR, result: "outside_reachable" }));
    expect(response.status).toBe(204);
    canaries.report.mockRejectedValueOnce(new Error("database down"));
    expect((await post(base, JSON.stringify({ actor: ACTOR, result: "pass" }))).status).toBe(204);
  });

  it("logs reports no row took as one summary line a minute at most, so the route cannot flood the log", async () => {
    const canaries = store(false);
    const info: unknown[] = [];
    const warn: unknown[] = [];
    const infoSpy = vi.spyOn(httpLog, "info").mockImplementation((obj: unknown) => void info.push(obj));
    const warnSpy = vi.spyOn(httpLog, "warn").mockImplementation((obj: unknown) => void warn.push(obj));
    onTestFinished(() => {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    });
    const base = await listenOn({ canaries });
    for (let i = 0; i < 20; i += 1) {
      const response = await post(base, JSON.stringify({ actor: ACTOR, result: "pass" }));
      expect(response.status).toBe(204);
    }
    expect(canaries.report).toHaveBeenCalledTimes(20);
    expect(info).toEqual([]);
    expect(warn).toEqual([{ unrecorded: 1 }]);
    expect(inspect(warn, { depth: 10 })).not.toContain(ACTOR);
  });

  it.each([
    ["an extra field", JSON.stringify({ actor: ACTOR, result: "pass", extra: 1 })],
    ["a run actor's name", JSON.stringify({ actor: "wr-0123456789abcdef0123-native", result: "pass" })],
    ["an unknown result", JSON.stringify({ actor: ACTOR, result: "maybe" })],
    ["a body that is not JSON", "pass"],
    ["a 2 KiB body", JSON.stringify({ actor: ACTOR, result: "pass", pad: "x".repeat(2 * MAX_CANARY_REQUEST_BYTES) })],
  ])("refuses %s with 400 and records nothing", async (_name, body) => {
    const canaries = store();
    const lines: unknown[] = [];
    const spy = vi.spyOn(httpLog, "info").mockImplementation((obj: unknown) => void lines.push(obj));
    try {
      const base = await listenOn({ canaries });
      const response = await post(base, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false });
    } finally {
      spy.mockRestore();
    }
    expect(canaries.report).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it("is not served without a canary store", async () => {
    const base = await listenOn();
    const response = await post(base, JSON.stringify({ actor: ACTOR, result: "pass" }));
    expect(response.status).toBe(404);
  });
});
