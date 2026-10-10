import { describe, expect, it, vi } from "vitest";
import type { LlmProvider, LlmStreamEvent } from "../providers/llm/types.js";
import { PRIVILEGED_BRIDGE_NAMES, type PrivilegedHost } from "../sandbox/host-functions.js";
import {
  runSandboxedEngine,
  SandboxRunCancelledError,
  type NativeGateway,
  type RunDrivability,
  type SandboxedEngineOptions,
} from "./gateway.js";
import { GatewayError, type WorkerInput } from "./protocol.js";
import { loopbackLauncher } from "./loopback.js";

const input: WorkerInput = {
  v: 1,
  runId: "run_1",
  agent: { systemPrompt: "s", model: "m", budgetUsd: 1, maxTurns: 3 },
  tools: [],
  builtinTools: ["memory_get"],
  userTools: { lookup: { code: "return 1;", paramsZod: "z.object({})" } },
  runsConcurrently: [],
  pricing: {
    provider: "anthropic",
    modelId: "m",
    encoding: "o200k_base",
    inputPerMTok: 1,
    outputPerMTok: 5,
    cachedInputPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    efforts: [],
    thinkingMode: "none",
  },
};

const req = (method: string, params: unknown, callId = `${method}-${Math.random()}`) => ({
  v: 1,
  runId: "run_1",
  callId,
  method,
  params,
});

const finish = (callId = "finish-1") => req("finish", { status: "succeeded", finalText: "done", turns: 1 }, callId);

function llmStreaming(events: LlmStreamEvent[]): LlmProvider {
  return {
    async *stream() {
      for (const event of events) yield event;
    },
    countTokens: async (_model, messages) => JSON.stringify(messages).length,
    priceUsd: (_model, usage) => usage.inputTokens * 0.001 + usage.outputTokens * 0.002,
  };
}

const drain = async (stream: AsyncIterable<LlmStreamEvent>) => {
  const events: LlmStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

/** Runs the gateway with a scripted "worker" that drives it directly, as an untrusted worker could. */
async function withWorker(
  worker: (gateway: NativeGateway) => Promise<void>,
  overrides: Partial<SandboxedEngineOptions> = {},
) {
  const progress = vi.fn(async () => {});
  const options: SandboxedEngineOptions = {
    runId: "run_1",
    input,
    ctx: {
      providers: {
        llm: llmStreaming([
          { type: "text", delta: "hi" },
          { type: "done", stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.25 } },
        ]),
      },
      onProgress: progress,
    },
    builtinHandler: (name) => (name === "memory_get" ? async (args) => `memory:${args}` : undefined),
    privilegedHostFor: () => undefined,
    drivability: async () => "drivable",
    launcher: {
      async run(_input, gateway) {
        await worker(gateway);
        return { exitCode: 0 };
      },
    },
    ...overrides,
  };
  return { result: runSandboxedEngine(options), progress };
}

describe("runSandboxedEngine (trusted gateway)", () => {
  it("meters usage from what the provider streamed, and writes progress from that, not from the worker's claim", async () => {
    const { result, progress } = await withWorker(async (gateway) => {
      await drain(gateway.stream(req("llm.stream", { request: { model: "m", messages: [] } })));
      await gateway.call(req("progress", { turns: 1, usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 } }));
      await gateway.call(finish());
    });
    const engine = await result;
    expect(engine.usage).toMatchObject({ tokensIn: 100, tokensOut: 10, costUsd: 0.25 });
    expect(progress).toHaveBeenCalledWith({ turns: 1, usage: { tokensIn: 100, tokensOut: 10, costUsd: 0.25 } });
  });

  it("bills its own estimate for a stream the worker abandons before the provider's usage arrives", async () => {
    const { result } = await withWorker(async (gateway) => {
      for await (const event of gateway.stream(req("llm.stream", { request: { model: "m", messages: [] } }))) {
        if (event.type === "text") break; // a mid-stream cutoff: the worker stops reading
      }
      await gateway.call(finish());
    });
    const engine = await result;
    expect(engine.usage.costUsd).toBeGreaterThan(0);
  });

  it("refuses a model other than the run's own", async () => {
    const { result } = await withWorker(async (gateway) => {
      await expect(
        drain(gateway.stream(req("llm.stream", { request: { model: "expensive-model", messages: [] } }))),
      ).rejects.toMatchObject({ code: "not_allowed" });
      await gateway.call(finish());
    });
    expect((await result).usage.costUsd).toBe(0);
  });

  it("refuses requests for another run, malformed params, and unknown methods", async () => {
    const { result } = await withWorker(async (gateway) => {
      await expect(gateway.call({ ...finish(), runId: "run_2" })).rejects.toMatchObject({ code: "not_allowed" });
      await expect(gateway.call(req("finish", { status: "succeeded" }))).rejects.toMatchObject({
        code: "invalid_request",
      });
      await expect(gateway.call(req("db.query", {}))).rejects.toMatchObject({ code: "invalid_request" });
      await expect(gateway.call({ ...finish(), v: 2 })).rejects.toBeInstanceOf(GatewayError);
      await gateway.call(finish());
    });
    expect((await result).status).toBe("succeeded");
  });

  it("serves only the run's own built-ins, and replays a repeated built-in callId instead of acting twice", async () => {
    const handler = vi.fn(async (args: string) => `memory:${args}`);
    const { result } = await withWorker(
      async (gateway) => {
        const first = await gateway.call(req("builtin.call", { name: "memory_get", argsJson: "{}" }, "b-1"));
        const again = await gateway.call(req("builtin.call", { name: "memory_get", argsJson: "{}" }, "b-1"));
        expect(again).toBe(first);
        await expect(
          gateway.call(req("builtin.call", { name: "delegate_to_admin", argsJson: "{}" })),
        ).rejects.toMatchObject({ code: "not_allowed" });
        await gateway.call(finish());
      },
      { builtinHandler: (name) => (name === "memory_get" ? handler : undefined) },
    );
    await result;
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("serves privileged bridges only for the run's own user tools, and only privileged bridge names", async () => {
    const host = Object.fromEntries(
      PRIVILEGED_BRIDGE_NAMES.map((name) => [name, async () => (name === "__bridge_secretsGet" ? "v" : null)]),
    ) as unknown as PrivilegedHost;
    const scoped = vi.fn((tool: string) => (tool === "lookup" ? host : undefined));
    const { result } = await withWorker(
      async (gateway) => {
        const call = (tool: string, bridge: string) =>
          gateway.call(req("host.call", { tool, invocation: "t1", bridge, argsJson: "[]" }));
        expect(await call("lookup", "__bridge_secretsGet")).toBe("v");
        await expect(call("other-agents-tool", "__bridge_secretsGet")).rejects.toMatchObject({ code: "not_allowed" });
        await expect(call("lookup", "__bridge_parseHTML")).rejects.toMatchObject({ code: "not_allowed" });
        await gateway.call(finish());
      },
      { privilegedHostFor: scoped },
    );
    await result;
  });

  it("returns a bridge failure as the message the tool would see in-process", async () => {
    const host = Object.fromEntries(
      PRIVILEGED_BRIDGE_NAMES.map((name) => [
        name,
        async () => {
          throw new Error("fetch_host_not_allowed");
        },
      ]),
    ) as unknown as PrivilegedHost;
    const { result } = await withWorker(
      async (gateway) => {
        await expect(
          gateway.call(
            req("host.call", { tool: "lookup", invocation: "t1", bridge: "__bridge_fetch", argsJson: "[]" }),
          ),
        ).rejects.toMatchObject({ code: "bridge_error", message: "fetch_host_not_allowed" });
        await gateway.call(finish());
      },
      { privilegedHostFor: () => host },
    );
    await result;
  });

  it("refuses a reused callId for a one-shot call", async () => {
    const { result } = await withWorker(async (gateway) => {
      await gateway.call(finish("f-1"));
      await expect(gateway.call(finish("f-1"))).rejects.toMatchObject({ code: "duplicate_call" });
    });
    expect((await result).status).toBe("succeeded");
  });

  it("refuses every call once the run is no longer drivable, and reports a cancelled run as cancelled", async () => {
    let state: RunDrivability = "drivable";
    const { result } = await withWorker(
      async (gateway) => {
        state = "cancelled";
        await expect(gateway.call(finish())).rejects.toMatchObject({ code: "run_not_drivable" });
      },
      { drivability: async () => state },
    );
    await expect(result).rejects.toBeInstanceOf(SandboxRunCancelledError);
  });

  it("fails the run when the worker exits without a result", async () => {
    const { result } = await withWorker(async () => {});
    await expect(result).rejects.toThrow(/native_sandbox_worker_exited/);
  });

  it("delivers every streamed text delta in order when the gateway answers text calls out of order", async () => {
    // Each gateway call first awaits a drivability check (a database read in production). Make
    // every check faster than the one before it, so two calls in flight at once finish in reverse
    // order, as load can make them.
    let checks = 0;
    const drivability = async (): Promise<RunDrivability> => {
      checks += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 100 - checks * 20)));
      return "drivable";
    };
    const texts: string[] = [];
    const result = await runSandboxedEngine({
      runId: "run_1",
      input: { ...input, userTools: {} },
      ctx: {
        providers: {
          llm: llmStreaming([
            { type: "text", delta: "The note says " },
            { type: "text", delta: "hello." },
            { type: "done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 } },
          ]),
        },
        onText: (delta) => texts.push(delta),
      },
      builtinHandler: () => undefined,
      privilegedHostFor: () => undefined,
      drivability,
      launcher: loopbackLauncher,
    });
    expect(result.finalText).toBe("The note says hello.");
    expect(texts).toEqual(["The note says ", "hello."]);
  });
});
