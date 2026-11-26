import { describe, expect, it, vi } from "vitest";
import type { LlmProvider, LlmRequest, LlmStreamEvent } from "../providers/index.js";
import type { EngineRunContext, EngineTurnEvent } from "../providers/engine/types.js";
import { NativeEngine } from "./engine-native.js";

const usage = { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 };

/** Turn 1 makes one tool call (with or without provider data); turn 2 answers. */
function llmWith(providerData: string | undefined): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      requests.push(structuredClone(req));
      if (requests.length === 1) {
        yield {
          type: "tool_call",
          id: "call_1",
          name: "echo",
          argsJson: "{}",
          ...(providerData !== undefined ? { providerData } : {}),
        };
        yield { type: "done", stopReason: "tool_calls", usage };
        return;
      }
      yield { type: "text", delta: "done" };
      yield { type: "done", stopReason: "stop", usage };
    },
    async countTokens() {
      return 10;
    },
    priceUsd() {
      return 0.0001;
    },
  };
}

async function run(llm: LlmProvider): Promise<EngineTurnEvent[]> {
  const events: EngineTurnEvent[] = [];
  const ctx: EngineRunContext = {
    agent: { systemPrompt: "sys", model: "m", budgetUsd: 1000, maxTurns: 10 },
    tools: [],
    providers: { llm },
    runSandboxTool: vi.fn(async () => '{"ok":true}'),
    onTurn: (e: EngineTurnEvent) => events.push(e),
  };
  await new NativeEngine().run(ctx);
  return events;
}

describe("providerData round-trip", () => {
  it("replays a tool call's providerData on the next turn and never emits it", async () => {
    const llm = llmWith("sig-abc");
    const events = await run(llm);
    const replay = llm.requests[1].messages.find((m) => m.role === "assistant");
    expect(replay?.toolCalls).toEqual([{ id: "call_1", name: "echo", argsJson: "{}", providerData: "sig-abc" }]);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain("sig-abc");
  });

  it("omits the key entirely when a provider sends none", async () => {
    const llm = llmWith(undefined);
    await run(llm);
    const replay = llm.requests[1].messages.find((m) => m.role === "assistant");
    expect(Object.keys(replay!.toolCalls![0])).toEqual(["id", "name", "argsJson"]);
  });
});
