import { describe, it, expect } from "vitest";
import { resolveLlmRegistrations } from "./registration.js";
import { OpenAiLlmProvider } from "./openai.js";
import { AnthropicLlmProvider } from "./anthropic.js";
import { supportedModels as openaiSupportedModels } from "./pricing.js";
import { anthropicSupportedModels } from "./anthropic.js";

const NO_CREDS = {} as NodeJS.ProcessEnv;
const OPENAI_ONLY = { OPENAI_API_KEY: "sk-test-openai" } as NodeJS.ProcessEnv;
const ANTHROPIC_ONLY = { ANTHROPIC_API_KEY: "sk-test-anthropic" } as NodeJS.ProcessEnv;
const BOTH = { OPENAI_API_KEY: "sk-test-openai", ANTHROPIC_API_KEY: "sk-test-anthropic" } as NodeJS.ProcessEnv;

describe("resolveLlmRegistrations", () => {
  it("rejects LLM_PROVIDER=bedrock as reserved, regardless of credentials", () => {
    expect(resolveLlmRegistrations({ llm: "bedrock" }, BOTH)).toEqual({ kind: "bedrock-reserved" });
  });

  it("reports no-credentials when neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is set", () => {
    expect(resolveLlmRegistrations({ llm: "openai" }, NO_CREDS)).toEqual({ kind: "no-credentials" });
  });

  it("registers only the OpenAI adapter when only its credential is present", () => {
    const result = resolveLlmRegistrations({ llm: "openai" }, OPENAI_ONLY);
    expect(result.kind).toBe("registrations");
    if (result.kind !== "registrations") throw new Error("unreachable");
    expect(result.registrations).toHaveLength(1);
    expect(result.registrations[0].provider).toBeInstanceOf(OpenAiLlmProvider);
    expect(result.registrations[0].models).toEqual(openaiSupportedModels());
  });

  it("registers only the Anthropic adapter when only its credential is present", () => {
    const result = resolveLlmRegistrations({ llm: "anthropic" }, ANTHROPIC_ONLY);
    expect(result.kind).toBe("registrations");
    if (result.kind !== "registrations") throw new Error("unreachable");
    expect(result.registrations).toHaveLength(1);
    expect(result.registrations[0].provider).toBeInstanceOf(AnthropicLlmProvider);
    expect(result.registrations[0].models).toEqual(anthropicSupportedModels());
  });

  it("registers both adapters when both credentials are present", () => {
    const result = resolveLlmRegistrations({ llm: "openai" }, BOTH);
    expect(result.kind).toBe("registrations");
    if (result.kind !== "registrations") throw new Error("unreachable");
    expect(result.registrations).toHaveLength(2);
    expect(result.registrations.map((r) => r.provider)).toEqual([
      expect.any(OpenAiLlmProvider),
      expect.any(AnthropicLlmProvider),
    ]);
  });
});
