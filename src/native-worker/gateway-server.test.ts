import { describe, expect, it, vi } from "vitest";
import type { LlmProvider, LlmStreamEvent } from "../providers/llm/types.js";
import { serveGatewayRequest, streamModel } from "./gateway-server.js";

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

  it("answers internal with only the error's leading code, never the rest of its message", async () => {
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
