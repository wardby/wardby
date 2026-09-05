import { describe, it, expect } from "vitest";
import { toClaudeRequest, withCacheBreakpoints } from "./claude-messages.js";
import type { LlmRequest } from "./types.js";

const base: LlmRequest = {
  model: "claude-opus-5",
  messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "calling", toolCalls: [{ id: "t1", name: "getTime", argsJson: "{}" }] },
    { role: "tool", toolCallId: "t1", name: "getTime", content: "\"noon\"" },
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
