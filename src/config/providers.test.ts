import { describe, it, expect } from "vitest";
import { loadProviderConfig } from "./providers.js";

describe("provider config", () => {
  it("accepts anthropic and bedrock as llm kinds", () => {
    expect(loadProviderConfig({ LLM_PROVIDER: "anthropic" } as NodeJS.ProcessEnv).llm).toBe("anthropic");
    expect(loadProviderConfig({ LLM_PROVIDER: "bedrock" } as NodeJS.ProcessEnv).llm).toBe("bedrock");
  });
});
