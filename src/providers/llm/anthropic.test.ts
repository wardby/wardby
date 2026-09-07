import { describe, it, expect } from "vitest";
import { AnthropicLlmProvider, anthropicCredentialsPresent } from "./anthropic.js";
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

describe("AnthropicLlmProvider", () => {
  it("streams text and a done event with a priced usage", async () => {
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
    const p = new AnthropicLlmProvider("key", fakeClient(events));
    const out = await collect(p.stream({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }));
    const done = out.find((e) => e.type === "done") as any;
    expect(done.usage.inputTokens).toBe(10);
    expect(done.usage.costUsd).toBeGreaterThanOrEqual(0);
  });

  it("defaults max_tokens well above a short report's worth of output, so a long final answer isn't silently truncated", async () => {
    let sentParams: any;
    const events = [
      {
        type: "message_start",
        message: {
          usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
        },
      },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const p = new AnthropicLlmProvider(
      "key",
      fakeClient(events, (params) => {
        sentParams = params;
      }),
    );
    await collect(p.stream({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }));
    expect(sentParams.max_tokens).toBeGreaterThanOrEqual(16000);
  });

  it("countTokens is offline, inflates over the raw estimate, and counts tools", async () => {
    const p = new AnthropicLlmProvider("key", fakeClient([]));
    const withoutTools = await p.countTokens("claude-sonnet-5", [{ role: "user", content: "hello world" }]);
    const withTools = await p.countTokens(
      "claude-sonnet-5",
      [{ role: "user", content: "hello world" }],
      [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }],
    );
    expect(withoutTools).toBeGreaterThan(0);
    expect(withTools).toBeGreaterThan(withoutTools);
  });

  it("credentials presence reflects env", () => {
    expect(anthropicCredentialsPresent({ ANTHROPIC_API_KEY: "sk-ant" })).toBe(true);
    expect(anthropicCredentialsPresent({})).toBe(false);
  });
});
