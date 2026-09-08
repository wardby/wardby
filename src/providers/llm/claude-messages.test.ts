import { describe, it, expect } from "vitest";
import { toClaudeRequest, withCacheBreakpoints, estimateClaudeTokens } from "./claude-messages.js";
import type { LlmRequest, LlmMessage } from "./types.js";

const base: LlmRequest = {
  model: "claude-opus-5",
  messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "calling", toolCalls: [{ id: "t1", name: "getTime", argsJson: "{}" }] },
    { role: "tool", toolCallId: "t1", name: "getTime", content: '"noon"' },
  ],
  tools: [{ name: "getTime", description: "current time", parameters: { type: "object", properties: {} } }],
};

describe("toClaudeRequest", () => {
  it("lifts system messages into the top-level system param", () => {
    const r = toClaudeRequest(base, 1024);
    expect(r.system?.[0]).toMatchObject({ type: "text", text: "You are helpful." });
    expect(r.messages.every((m) => m.role !== ("system" as unknown))).toBe(true);
  });

  it("maps assistant toolCalls to tool_use blocks", () => {
    const r = toClaudeRequest(base, 1024);
    const asst = r.messages.find((m) => m.role === "assistant")!;
    const toolUse = (asst.content as any[]).find((b) => b.type === "tool_use");
    expect(toolUse).toMatchObject({ id: "t1", name: "getTime", input: {} });
  });

  it("maps tool results to a user tool_result block correlated by id", () => {
    const r = toClaudeRequest(base, 1024);
    const toolMsg = r.messages.find((m) => (m.content as any[]).some?.((b) => b.type === "tool_result"))!;
    expect(toolMsg.role).toBe("user");
    const block = (toolMsg.content as any[]).find((b) => b.type === "tool_result");
    expect(block).toMatchObject({ tool_use_id: "t1" });
  });

  it("maps tools to name/description/input_schema and defaults max_tokens", () => {
    const r = toClaudeRequest({ ...base, maxTokens: undefined }, 2048);
    expect(r.tools?.[0]).toMatchObject({ name: "getTime", input_schema: { type: "object" } });
    expect(r.max_tokens).toBe(2048);
  });
});

describe("withCacheBreakpoints", () => {
  it("marks the last system block (caches tools+system) and the last message block (rolling)", () => {
    const req = toClaudeRequest(base, 1024);
    const marked = withCacheBreakpoints(req);
    expect(marked.system?.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    const lastMsg = marked.messages.at(-1)!;
    expect((lastMsg.content.at(-1) as any).cache_control).toEqual({ type: "ephemeral" });
  });

  it("is a no-op-safe copy when there is no system and no messages", () => {
    const marked = withCacheBreakpoints({ messages: [], max_tokens: 10 });
    expect(marked.messages).toEqual([]);
    expect(marked.system).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const req = toClaudeRequest(base, 1024);
    withCacheBreakpoints(req);
    expect(req.system?.at(-1)?.cache_control).toBeUndefined();
  });
});

import { mapClaudeStream, type ClaudeStreamEvent } from "./claude-messages.js";
import type { LlmStreamEvent } from "./types.js";

async function* gen(events: ClaudeStreamEvent[]) {
  for (const e of events) yield e;
}
async function collect(it: AsyncIterable<LlmStreamEvent>) {
  const out: LlmStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("mapClaudeStream", () => {
  it("maps text deltas, a tool call, and a done event with mapped usage", async () => {
    const events: ClaudeStreamEvent[] = [
      {
        type: "message_start",
        message: {
          usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "u1", name: "getTime" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"tz":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"utc"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ];
    const out = await collect(mapClaudeStream(gen(events), (u) => u.inputTokens + u.outputTokens));

    expect(
      out
        .filter((e) => e.type === "text")
        .map((e: any) => e.delta)
        .join(""),
    ).toBe("Hello");
    const call = out.find((e) => e.type === "tool_call") as any;
    expect(call).toMatchObject({ id: "u1", name: "getTime", argsJson: '{"tz":"utc"}' });
    const done = out.find((e) => e.type === "done") as any;
    // inputTokens = input_tokens + cache_read; cachedInputTokens = cache_read; cacheWriteTokens = cache_creation
    expect(done.usage).toMatchObject({
      inputTokens: 1000,
      cachedInputTokens: 900,
      cacheWriteTokens: 50,
      outputTokens: 12,
    });
    expect(done.stopReason).toBe("tool_use");
  });
});

describe("estimateClaudeTokens", () => {
  it("returns a positive raw count for a simple message", () => {
    const raw = estimateClaudeTokens([{ role: "user", content: "hello world" }]);
    expect(raw).toBeGreaterThan(0);
  });

  it("counts more raw tokens when tool schemas are included", () => {
    const messages: LlmMessage[] = [{ role: "user", content: "hello world" }];
    const withoutTools = estimateClaudeTokens(messages);
    const withTools = estimateClaudeTokens(messages, [
      { name: "t", description: "d", parameters: { type: "object", properties: {} } },
    ]);
    expect(withTools).toBeGreaterThan(withoutTools);
  });
});
