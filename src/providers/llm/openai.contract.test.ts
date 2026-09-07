/**
 * Thin contract test against the real OpenAI API. Skipped unless
 * OPENAI_API_KEY is set — never runs in offline CI.
 */

import { describe, expect, it } from "vitest";
import { OpenAiLlmProvider } from "./openai.js";
import type { LlmStreamEvent } from "./types.js";

const apiKey = process.env.OPENAI_API_KEY;

describe.skipIf(!apiKey)("OpenAiLlmProvider (network)", () => {
  it("streams a real completion and reports usage with a positive cost", async () => {
    const llm = new OpenAiLlmProvider(apiKey);
    const events: LlmStreamEvent[] = [];
    for await (const event of llm.stream({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Say hi in one word." }],
      maxTokens: 5,
    })) {
      events.push(event);
    }

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done?.type === "done") {
      expect(done.usage.inputTokens).toBeGreaterThan(0);
      expect(done.usage.costUsd).toBeGreaterThan(0);
    }
  }, 30_000);

  it("reassembles a real tool call from a live streaming round trip", async () => {
    const llm = new OpenAiLlmProvider(apiKey);
    const events: LlmStreamEvent[] = [];
    for await (const event of llm.stream({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "What is 17 plus 25? Use the add tool." }],
      tools: [
        {
          name: "add",
          description: "Adds two numbers",
          parameters: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        },
      ],
    })) {
      events.push(event);
    }

    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toBeDefined();
    if (toolCall?.type === "tool_call") {
      expect(toolCall.name).toBe("add");
      const args = JSON.parse(toolCall.argsJson);
      expect(args).toMatchObject({ a: 17, b: 25 });
    }
  }, 30_000);
});
