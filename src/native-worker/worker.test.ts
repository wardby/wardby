import { describe, expect, it, vi } from "vitest";
import type { EngineRunContext } from "../providers/engine/types.js";
import { GatewayError, type GatewayRequest, type WorkerInput } from "./protocol.js";
import type { GatewayTransport } from "./worker.js";

// The engine's only job here is to call the built-in the way the model would.
vi.mock("../core/engine-native.js", () => ({
  NativeEngine: class {
    async run(ctx: EngineRunContext) {
      await ctx.runSandboxTool("delegate_to_a", "{}");
      return { status: "succeeded", finalText: "", turns: 1 };
    }
  },
}));

const { runNativeWorker } = await import("./worker.js");

const input = {
  v: 1,
  runId: "run-1",
  agent: { systemPrompt: "s", model: "m", budgetUsd: 1, maxTurns: 3 },
  tools: [],
  builtinTools: ["delegate_to_a"],
  userTools: {},
  runsConcurrently: [],
  pricing: { inputPerMTok: 1, outputPerMTok: 1 },
} as unknown as WorkerInput;

function transportRejecting(err: Error) {
  const finishes: GatewayRequest[] = [];
  const transport: GatewayTransport = {
    async call(request) {
      if (request.method === "builtin.call") throw err;
      if (request.method === "finish") finishes.push(request);
      return undefined;
    },
    stream: () => (async function* () {})(),
  };
  return { transport, finishes };
}

describe("runNativeWorker gateway errors", () => {
  it("reports a failed gateway call as a failed run instead of throwing", async () => {
    const { transport, finishes } = transportRejecting(new GatewayError("not_allowed", "boom"));
    await expect(runNativeWorker(input, transport)).resolves.toBeUndefined();
    expect(finishes).toHaveLength(1);
    expect(finishes[0].params).toEqual({
      status: "failed",
      finalText: "",
      turns: 0,
      error: "native_sandbox_gateway_error: not_allowed: boom",
    });
  });

  it("truncates a long gateway message", async () => {
    const { transport, finishes } = transportRejecting(new GatewayError("not_allowed", "x".repeat(5000)));
    await runNativeWorker(input, transport);
    const error = (finishes[0].params as { error: string }).error;
    expect(error).toBe(`native_sandbox_gateway_error: not_allowed: ${"x".repeat(1024)}`);
  });

  it("reports only the code of an internal gateway error, never its message", async () => {
    const { transport, finishes } = transportRejecting(
      new GatewayError("internal", "connect ECONNREFUSED postgresql://user:pw@10.0.0.1:5432/db"),
    );
    await runNativeWorker(input, transport);
    expect((finishes[0].params as { error: string }).error).toBe("native_sandbox_gateway_error: internal");
  });

  it("keeps a run that already ended quiet: no finish, the error still propagates", async () => {
    const err = new GatewayError("run_not_drivable", "ended");
    const { transport, finishes } = transportRejecting(err);
    await expect(runNativeWorker(input, transport)).rejects.toBe(err);
    expect(finishes).toHaveLength(0);
  });

  it("leaves errors that are not gateway errors alone", async () => {
    const err = new Error("local");
    const { transport, finishes } = transportRejecting(err);
    await expect(runNativeWorker(input, transport)).rejects.toBe(err);
    expect(finishes).toHaveLength(0);
  });
});
