import { describe, it, expect } from "vitest";
import { BedrockClaudeLlmProvider, bedrockCredentialsPresent } from "./bedrock.js";
import type { LlmStreamEvent } from "./types.js";

function fakeClient(events: any[], onParams?: (params: any) => void) {
  return {
    messages: {
      stream: (params: any) => {
        onParams?.(params);
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    },
  } as any;
}
async function collect(it: AsyncIterable<LlmStreamEvent>) {
  const o: LlmStreamEvent[] = [];
  for await (const e of it) o.push(e);
  return o;
}

const MODEL = "anthropic.claude-sonnet-5-v1:0";

describe("BedrockClaudeLlmProvider", () => {
  it("streams text and a done event with a priced usage, wired through the shared ClaudeLlmProvider logic", async () => {
    const events = [
      {
        type: "message_start",
        message: {
          usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    const p = new BedrockClaudeLlmProvider("us-east-1", fakeClient(events));
    const out = await collect(p.stream({ model: MODEL, messages: [{ role: "user", content: "hi" }] }));
    const done = out.find((e) => e.type === "done") as any;
    expect(done.usage.inputTokens).toBe(10);
    expect(done.usage.costUsd).toBeGreaterThanOrEqual(0);
  });

  it("countTokens fails closed on an unknown model", async () => {
    const p = new BedrockClaudeLlmProvider("us-east-1", fakeClient([]));
    await expect(p.countTokens("unknown-model", [{ role: "user", content: "hi" }])).rejects.toThrow(
      /No pricing entry/,
    );
  });

  it("throws when constructed with no region and no injected client", () => {
    expect(() => new BedrockClaudeLlmProvider("")).toThrow(/BEDROCK_REGION.*AWS_REGION/);
  });

  it("credentials presence reflects env (BEDROCK_REGION or AWS_REGION)", () => {
    expect(bedrockCredentialsPresent({ BEDROCK_REGION: "us-east-1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(bedrockCredentialsPresent({ AWS_REGION: "us-east-1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(bedrockCredentialsPresent({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
