/**
 * Thin contract test against the real OpenAI API. Skipped unless
 * OPENAI_API_KEY is set — never runs in offline CI.
 */

import { describe, expect, it } from "vitest";
import { OpenAiLlmProvider } from "./openai.js";
import type { LlmStreamEvent } from "./types.js";

const apiKey = process.env.OPENAI_API_KEY;

describe.skipIf(!apiKey)("OpenAiLlmProvider (network)", () => {
  it(
    "streams a real completion and reports usage with a positive cost",
    async () => {
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
    },
    30_000,
  );
});
