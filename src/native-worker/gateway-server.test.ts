import { describe, expect, it, vi } from "vitest";
import { STREAM_STEPS_BOUND_MS } from "../core/run-steps/native.js";
import type { RunStepBatch, RunStepSink } from "../core/run-steps/types.js";
import type { LlmProvider, LlmStreamEvent } from "../providers/llm/types.js";
import {
  checkedEvents,
  CONSOLE_WITHHELD_MESSAGE,
  failureResponse,
  finish,
  GATEWAY_HOST_CALL_MARGIN_MS,
  hostCall,
  hostCallTimeoutMs,
  runSecretValues,
  serveGatewayRequest,
  streamModel,
} from "./gateway-server.js";
import { GATEWAY_INTERNAL_MESSAGE, GatewayError } from "./protocol.js";
import { gatewayLog } from "./gateway.js";

type Ctx = Parameters<typeof streamModel>[0];
type Ledger = Parameters<typeof streamModel>[1];

const MODEL = "m";
const HOLD_USD = 0.5;

function fakeLedger() {
  return {
    reserve: vi.fn(async () => ({ outcome: "reserved" as const })),
    complete: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    markUncertain: vi.fn(async () => undefined),
    medianOutputTokens: vi.fn(async (): Promise<number | undefined> => undefined),
  };
}

/** A provider whose stream yields one text event, then fails mid-stream. */
function failingLlm(opts: { priceAfterReserve: () => number; countAfterReserve?: () => Promise<number> }) {
  const streamError = new Error("upstream reset");
  let priced = 0;
  let counted = 0;
  const llm = {
    // Not async: a synchronous throw from countAfterReserve escapes rather than rejecting.
    countTokens: vi.fn((): Promise<number> => {
      counted += 1;
      return counted === 1 ? Promise.resolve(100) : (opts.countAfterReserve?.() ?? Promise.resolve(10));
    }),
    priceUsd: vi.fn(() => {
      priced += 1;
      return priced === 1 ? HOLD_USD : opts.priceAfterReserve();
    }),
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield { type: "text", delta: "partial" };
      throw streamError;
    },
  } as unknown as LlmProvider;
  return { llm, streamError };
}

function ctxFor(llm: LlmProvider): Ctx {
  return {
    session: { id: "sess_1" },
    snapshot: { input: { agent: { model: MODEL } } },
    llm,
  } as unknown as Ctx;
}

async function drain(events: AsyncIterable<LlmStreamEvent>): Promise<unknown> {
  try {
    for await (const _event of events) void _event;
  } catch (err) {
    return err;
  }
  return undefined;
}

const params = { request: { model: MODEL, messages: [{ role: "user" as const, content: "hi" }] } } as Parameters<
  typeof streamModel
>[3];

describe("streamModel mid-stream failure", () => {
  it("marks the call uncertain at an estimate clamped to the hold, and rethrows the stream error", async () => {
    const ledger = fakeLedger();
    const { llm, streamError } = failingLlm({ priceAfterReserve: () => HOLD_USD * 3 });
    const err = await drain(streamModel(ctxFor(llm), ledger as unknown as Ledger, "call_1", params));
    expect(err).toBe(streamError);
    expect(ledger.markUncertain).toHaveBeenCalledTimes(1);
    const [, , estimate] = ledger.markUncertain.mock.calls[0] as unknown as [string, string, { costUsd: number }];
    expect(estimate).toBeDefined();
    expect(estimate.costUsd).toBeLessThanOrEqual(HOLD_USD);
    expect(ledger.complete).not.toHaveBeenCalled();
    expect(ledger.release).not.toHaveBeenCalled();
  });

  it("counts streamed tool calls in the estimate, and falls back to a high byte count when counting fails", async () => {
    const ledger = fakeLedger();
    const argsJson = JSON.stringify({ path: "a".repeat(290) });
    let counted = 0;
    const priceUsd = vi.fn((_model: string, _usage: { inputTokens: number; outputTokens: number }) => 0.01);
    const llm = {
      countTokens: vi.fn(async () => {
        counted += 1;
        if (counted === 1) return 100;
        throw new Error("tokenizer unavailable");
      }),
      priceUsd,
      async *stream(): AsyncIterable<LlmStreamEvent> {
        yield { type: "text", delta: "abc" };
        yield { type: "tool_call", id: "t1", name: "read", argsJson };
        throw new Error("upstream reset");
      },
    } as unknown as LlmProvider;
    await drain(streamModel(ctxFor(llm), ledger as unknown as Ledger, "call_1", params));
    const output = Math.ceil(Buffer.byteLength(`abcread${argsJson}`) / 3);
    expect(priceUsd).toHaveBeenLastCalledWith(MODEL, { inputTokens: 100, outputTokens: output });
    expect(ledger.markUncertain).toHaveBeenCalledWith(
      "sess_1",
      "call_1",
      expect.objectContaining({ outputTokens: output }),
    );
  });

  /** A provider whose stream fails before its first event, after its response started or not. */
  function cutBeforeFirstEvent(started: boolean) {
    const priceUsd = vi.fn((_model: string, _usage: { inputTokens: number; outputTokens: number }) => 0.01);
    const llm = {
      countTokens: vi.fn(async () => 100),
      priceUsd,
      // eslint-disable-next-line require-yield
      async *stream(_req: unknown, _signal: unknown, hooks?: { onResponseStarted?: () => void }) {
        if (started) hooks?.onResponseStarted?.();
        throw new Error("upstream reset");
      },
    } as unknown as LlmProvider;
    return { llm, priceUsd };
  }

  it("once the response started, with no completed call to take a median from, books input and no output", async () => {
    const ledger = fakeLedger();
    const { llm, priceUsd } = cutBeforeFirstEvent(true);
    await drain(streamModel(ctxFor(llm), ledger as unknown as Ledger, "call_1", params));
    expect(priceUsd).toHaveBeenLastCalledWith(MODEL, { inputTokens: 100, outputTokens: 0 });
    expect(ledger.markUncertain).toHaveBeenCalledWith("sess_1", "call_1", expect.objectContaining({ outputTokens: 0 }));
    expect(ledger.release).not.toHaveBeenCalled();
  });

  it("once the response started, books the run's median output for a stream cut before its first event", async () => {
    const ledger = fakeLedger();
    ledger.medianOutputTokens.mockResolvedValue(700);
    const { llm, priceUsd } = cutBeforeFirstEvent(true);
    await drain(streamModel(ctxFor(llm), ledger as unknown as Ledger, "call_1", params));
    expect(priceUsd).toHaveBeenLastCalledWith(MODEL, { inputTokens: 100, outputTokens: 700 });
    expect(ledger.markUncertain).toHaveBeenCalledWith(
      "sess_1",
      "call_1",
      expect.objectContaining({ outputTokens: 700 }),
    );
  });

  it("before the response started, releases the hold: nothing was generated", async () => {
    const ledger = fakeLedger();
    const { llm } = cutBeforeFirstEvent(false);
    await drain(streamModel(ctxFor(llm), ledger as unknown as Ledger, "call_1", params));
    expect(ledger.release).toHaveBeenCalledWith("sess_1", "call_1");
    expect(ledger.markUncertain).not.toHaveBeenCalled();
  });

  it("marks the call uncertain without an estimate when pricing throws, and rethrows the stream error", async () => {
    const ledger = fakeLedger();
    const { llm, streamError } = failingLlm({
      priceAfterReserve: () => {
        throw new Error("no price");
      },
    });
    const err = await drain(streamModel(ctxFor(llm), ledger as unknown as Ledger, "call_1", params));
    expect(err).toBe(streamError);
    expect(ledger.markUncertain).toHaveBeenCalledTimes(1);
    expect(ledger.markUncertain.mock.calls[0]).toEqual(["sess_1", "call_1"]);
  });

  it("marks the call uncertain without an estimate when counting throws synchronously, and rethrows", async () => {
    const ledger = fakeLedger();
    const { llm, streamError } = failingLlm({
      priceAfterReserve: () => 0.01,
      countAfterReserve: () => {
        throw new Error("tokenizer crashed");
      },
    });
    const err = await drain(streamModel(ctxFor(llm), ledger as unknown as Ledger, "call_1", params));
    expect(err).toBe(streamError);
    expect(ledger.markUncertain).toHaveBeenCalledTimes(1);
    expect(ledger.markUncertain.mock.calls[0]).toEqual(["sess_1", "call_1"]);
  });
});

describe("serveGatewayRequest unexpected errors", () => {
  /** Deps whose session lookup throws `err`: the first thing a request does after its bearer check. */
  const throwingDeps = (err: Error) =>
    ({
      db: { nativeGatewaySession: { findUnique: async () => Promise.reject(err) } },
      providers: {},
    }) as unknown as Parameters<typeof serveGatewayRequest>[0];

  it("before the run's tools are rebuilt, passes a declared code, checked against the capability", async () => {
    const err = new Error("coding_execution_not_configured: detail-that-must-not-leave-the-gateway");
    const response = await serveGatewayRequest(throwingDeps(err), "Bearer cap", {});
    expect(response).toEqual({
      kind: "json",
      status: 500,
      body: {
        ok: false,
        error: {
          code: "internal",
          message: "The gateway could not serve this call (coding_execution_not_configured).",
          causeCode: "coding_execution_not_configured",
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain("detail-that-must-not-leave-the-gateway");
  });

  it("before the run's tools are rebuilt, redacts the capability from the log line and the cause code", async () => {
    // A capability that happens to equal a declared code: the exact-value guard still drops it.
    const capability = "coding_execution_not_configured";
    const logged: Array<{ err: Error }> = [];
    const spy = vi.spyOn(gatewayLog, "error").mockImplementation(((obj: { err: Error }) => {
      logged.push(obj);
    }) as never);
    let response: unknown;
    try {
      response = await serveGatewayRequest(throwingDeps(new Error(`${capability}: x`)), `Bearer ${capability}`, {});
    } finally {
      spy.mockRestore();
    }
    const body = (response as { body: { error: Record<string, unknown> } }).body;
    expect({
      keys: Object.keys(body.error).sort(),
      logged: logged.length,
      logRedacted: logged[0]?.err.message === "[REDACTED]: x",
    }).toEqual({ keys: ["code", "message"], logged: 1, logRedacted: true });
  });

  it("keeps the generic message when the error names no code", async () => {
    const response = await serveGatewayRequest(
      throwingDeps(new Error("Connection refused at 10.0.0.1")),
      "Bearer cap",
      {},
    );
    expect(response).toEqual({
      kind: "json",
      status: 500,
      body: { ok: false, error: { code: "internal", message: "The gateway could not serve this call." } },
    });
  });
});

// Obviously fake, and code-shaped on purpose: a token like this passes causeCodeOf on its own.
const FAKE_READABLE = "fake_readable_secret_0003";
const FAKE_CAPABILITY = "fake_capability_value_0003";
const FAKE_MCP = "fake_mcp_server_secret_0003";
const leaks = (value: unknown) => JSON.stringify(value).includes(FAKE_READABLE);

describe("gateway cause codes are checked against the run's secret values", () => {
  const rebuilt = {
    snapshot: { input: { userTools: { lookup: {}, other: {} } } },
    tools: {
      readableSecretValues: async (tool: string) => (tool === "lookup" ? [FAKE_READABLE] : ["other_value"]),
      mcpSecretValues: async () => [FAKE_MCP],
    },
  } as unknown as Parameters<typeof runSecretValues>[0];

  it("checks against every user tool's readable values and the request's own capability", async () => {
    const values = await runSecretValues(rebuilt, FAKE_CAPABILITY)();
    expect(values.includes(FAKE_READABLE) && values.includes("other_value") && values.includes(FAKE_CAPABILITY)).toBe(
      true,
    );
  });

  it("answers no cause code when the error's message is a readable secret value", async () => {
    const response = await failureResponse(new Error(FAKE_READABLE), runSecretValues(rebuilt, FAKE_CAPABILITY));
    const body = (response as { body: { error: Record<string, unknown> } }).body;
    expect({ keys: Object.keys(body.error).sort(), generic: body.error.message === GATEWAY_INTERNAL_MESSAGE }).toEqual({
      keys: ["code", "message"],
      generic: true,
    });
    expect(leaks(response)).toBe(false);
  });

  it("checks against the attached MCP servers' secret values too", async () => {
    expect((await runSecretValues(rebuilt, FAKE_CAPABILITY)()).includes(FAKE_MCP)).toBe(true);
    const response = await failureResponse(new Error(FAKE_MCP), runSecretValues(rebuilt, FAKE_CAPABILITY));
    expect(JSON.stringify(response).includes(FAKE_MCP)).toBe(false);
  });

  it("answers no cause code equal to the request's own capability", async () => {
    const response = await failureResponse(new Error(FAKE_CAPABILITY), runSecretValues(rebuilt, FAKE_CAPABILITY));
    expect(JSON.stringify(response).includes(FAKE_CAPABILITY)).toBe(false);
  });

  it("passes a normal code", async () => {
    const response = await failureResponse(
      new Error("coding_execution_not_configured: detail"),
      runSecretValues(rebuilt, FAKE_CAPABILITY),
    );
    expect(response).toEqual({
      kind: "json",
      status: 500,
      body: {
        ok: false,
        error: {
          code: "internal",
          message: "The gateway could not serve this call (coding_execution_not_configured).",
          causeCode: "coding_execution_not_configured",
        },
      },
    });
  });

  it("fails a model stream with the same checked error, never the raw one", async () => {
    // eslint-disable-next-line require-yield
    async function* failing(): AsyncIterable<LlmStreamEvent> {
      throw new Error(FAKE_READABLE);
    }
    const err = (await drain(checkedEvents(failing(), runSecretValues(rebuilt, FAKE_CAPABILITY)))) as GatewayError;
    expect({
      gatewayError: err instanceof GatewayError,
      code: err.code,
      generic: err.message === GATEWAY_INTERNAL_MESSAGE,
      hasCauseCode: err.causeCode !== undefined,
    }).toEqual({ gatewayError: true, code: "internal", generic: true, hasCauseCode: false });
  });
});

describe("console bridge when the tool's redaction list cannot be read", () => {
  const FAKE_CONSOLE = "fake_console_secret_0009";
  it("emits only a fixed marker line, never the console line", async () => {
    const consoleCalls: string[] = [];
    const ctx = {
      snapshot: { input: { userTools: { lookup: {} } } },
      tools: {
        readableSecretValues: () => Promise.reject(new Error("secret read failed")),
        privilegedHostFor: () => ({ __bridge_console: async (argsJson: string) => consoleCalls.push(argsJson) }),
      },
    } as unknown as Parameters<typeof hostCall>[0];
    const warned: unknown[] = [];
    const spy = vi.spyOn(gatewayLog, "warn").mockImplementation(((obj: unknown, msg: string) => {
      warned.push([obj, msg]);
    }) as never);
    let result: unknown;
    try {
      result = await hostCall(ctx, {} as never, "call_1", {
        tool: "lookup",
        invocation: "inv_1",
        bridge: "__bridge_console",
        argsJson: JSON.stringify(["info", [`saw ${FAKE_CONSOLE}`]]),
      });
    } finally {
      spy.mockRestore();
    }
    expect(result).toBeNull();
    expect(consoleCalls.length).toBe(0);
    expect(JSON.stringify(warned).includes(FAKE_CONSOLE)).toBe(false);
    expect(warned).toEqual([[{ tool: "lookup" }, CONSOLE_WITHHELD_MESSAGE]]);
  });
});

describe("a host call's time limit", () => {
  const session = (msLeft: number, now: number) => ({ deadlineAt: new Date(now + msLeft) });
  const tools = (timeoutMs: number | undefined) => ({ toolTimeoutMs: () => timeoutMs });

  it("is the tool's limit plus a margin (30 s for a default tool), cut to the run's deadline", () => {
    const now = 1_000_000;
    expect(hostCallTimeoutMs({ session: session(3_600_000, now), tools: tools(undefined) }, "t", now)).toBe(30_000);
    expect(hostCallTimeoutMs({ session: session(3_600_000, now), tools: tools(10_000) }, "t", now)).toBe(30_000);
    // Not cut off at 30 s when the tool may run longer.
    expect(hostCallTimeoutMs({ session: session(3_600_000, now), tools: tools(240_000) }, "t", now)).toBe(
      240_000 + GATEWAY_HOST_CALL_MARGIN_MS,
    );
    expect(hostCallTimeoutMs({ session: session(5_000, now), tools: tools(240_000) }, "t", now)).toBe(5_000);
    expect(hostCallTimeoutMs({ session: session(-1, now), tools: tools(240_000) }, "t", now)).toBe(0);
  });

  it("aborts a host call in progress when the run is stopped", async () => {
    const stop = new AbortController();
    const done = vi.fn();
    let seen: AbortSignal | undefined;
    const ctx = {
      session: { id: "s1", deadlineAt: new Date(Date.now() + 3_600_000) },
      snapshot: { input: { userTools: { slow: {} } } },
      tools: {
        toolTimeoutMs: () => 240_000,
        watchStop: () => ({ signal: stop.signal, done }),
        privilegedHostFor: (_tool: string, signal: AbortSignal) => {
          seen = signal;
          return {
            __bridge_secretsGet: () =>
              new Promise((_resolve, reject) =>
                signal.addEventListener("abort", () => reject(new Error("fetch_cancelled_or_timeout"))),
              ),
          };
        },
      },
    } as unknown as Parameters<typeof hostCall>[0];
    setTimeout(() => stop.abort(new Error("run_cancelled")), 50);
    const call = hostCall(ctx, {} as never, "call_1", {
      tool: "slow",
      invocation: "inv_1",
      bridge: "__bridge_secretsGet",
      argsJson: JSON.stringify(["k"]),
    });
    await expect(call).rejects.toMatchObject({ code: "bridge_error", message: "fetch_cancelled_or_timeout" });
    expect(seen?.aborted).toBe(true);
    expect(done).toHaveBeenCalled();
  });
});

describe("the worker's finish call", () => {
  // Fake value only; the assertion checks the stored row never holds it.
  const FAKE_KEY = "fake-secret-value-1234";

  it("stores the final text and error with the attached secret's value masked", async () => {
    const row: Record<string, unknown> = { id: "run_1", agentId: "a1", status: "running", parentRunId: null };
    const db = {
      run: {
        findUnique: async () => row,
        findUniqueOrThrow: async () => row,
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(row, data);
          return { count: 1 };
        },
      },
      // No MCP servers attached (src/core/mcp-tools.ts).
      agentMcpServer: { findMany: async () => [], findUnique: async () => null },
      agentSecret: {
        findMany: async () => [{ boundName: "API_KEY" }],
        findFirst: async () => ({ secret: { ciphertext: FAKE_KEY, ownerId: "p1" }, agent: { ownerId: "p1" } }),
      },
      runModelUsage: { upsert: async () => ({}) },
    };
    const secrets = { keyId: () => "k1", encrypt: async (v: string) => v, decrypt: async (v: string) => v };
    const ctx = {
      session: { id: "sess_1" },
      snapshot: { input: { agent: { model: MODEL } } },
      finishContext: {
        runId: "run_1",
        db,
        providers: { secrets },
        reviewHosts: undefined,
        repoAccess: undefined,
        issueTrackers: undefined,
      },
    } as unknown as Parameters<typeof finish>[0];
    const ledger = {
      claim: async () => ({ outcome: "claimed" }),
      totals: async () => ({ tokensIn: 0, tokensOut: 0, costUsd: 0, cachedInputTokens: 0, cacheWriteTokens: 0 }),
      recordResult: async () => undefined,
      endSession: async () => undefined,
    } as unknown as Parameters<typeof finish>[1];
    await finish(ctx, ledger, "call_1", {
      status: "failed",
      finalText: `the key is ${FAKE_KEY}`,
      error: `failed with ${FAKE_KEY}`,
      turns: 1,
    });
    expect({ status: row.status, finalText: row.finalText, error: row.error }).toEqual({
      status: "failed",
      finalText: "the key is [REDACTED]",
      error: "failed with [REDACTED]",
    });
  });
});

describe("streamModel run steps", () => {
  const llm = {
    countTokens: vi.fn(async () => 10),
    priceUsd: vi.fn(() => 0.001),
    async *stream(): AsyncIterable<LlmStreamEvent> {
      yield { type: "text", delta: "Checking." };
      yield { type: "tool_call", id: "t1", name: "lookup", argsJson: '{"query":"x"}' };
      yield { type: "done", stopReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.001 } };
    },
  } as unknown as LlmProvider;
  const ctx = {
    session: { id: "sess_1", runId: "run_1" },
    snapshot: { input: { agent: { model: MODEL } } },
    llm,
  } as unknown as Ctx;
  const withResult = {
    request: {
      model: MODEL,
      messages: [
        { role: "assistant" as const, content: "", toolCalls: [{ id: "t0", name: "lookup", argsJson: "{}" }] },
        { role: "tool" as const, toolCallId: "t0", content: "fine" },
      ],
    },
  } as Parameters<typeof streamModel>[3];
  const expectedBatch = {
    steps: [
      { kind: "said", callId: "said:5e447f59d541311dada70f8d9d26d0e3", text: "Checking.", truncated: false },
      { kind: "tool", callId: "t1", tool: "lookup", text: "x", truncated: false },
    ],
    results: [{ callId: "t0", status: "ok" }],
  };

  it("records the call's steps and the request's results for the session's run", async () => {
    const record = vi.fn(async (_runId: string, _batch: RunStepBatch, _extra?: readonly string[]) => undefined);
    const steps: RunStepSink = { record };
    expect(
      await drain(streamModel(ctx, fakeLedger() as unknown as Ledger, "call_9", withResult, steps)),
    ).toBeUndefined();
    expect(record).toHaveBeenCalledWith("run_1", expectedBatch, []);
  });

  it("passes the request's capability to the sink to redact, and nothing else", async () => {
    const capability = "wbFake-Capability-Value-c0ffee12";
    const record = vi.fn(async (_runId: string, _batch: RunStepBatch, _extra?: readonly string[]) => undefined);
    await drain(streamModel(ctx, fakeLedger() as unknown as Ledger, "call_9", withResult, { record }, capability));
    expect(record).toHaveBeenCalledWith("run_1", expectedBatch, [capability]);
  });

  it("ends the stream at the bound when the write never settles", async () => {
    vi.useFakeTimers();
    try {
      const steps: RunStepSink = { record: () => new Promise<void>(() => undefined) };
      let ended = false;
      void drain(streamModel(ctx, fakeLedger() as unknown as Ledger, "call_9", withResult, steps)).then(
        () => (ended = true),
      );
      await vi.advanceTimersByTimeAsync(STREAM_STEPS_BOUND_MS - 1);
      expect(ended).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(ended).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the stream normally when the sink throws", async () => {
    const steps: RunStepSink = {
      record: () => {
        throw new Error("sync");
      },
    };
    await expect(
      drain(streamModel(ctx, fakeLedger() as unknown as Ledger, "call_9", withResult, steps)),
    ).resolves.toBeUndefined();
  });
});
