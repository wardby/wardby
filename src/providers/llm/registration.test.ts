import { describe, it, expect } from "vitest";
import { resolveLlmRegistrations } from "./registration.js";
import { OpenAiLlmProvider } from "./openai.js";
import { AnthropicLlmProvider } from "./anthropic.js";
import { BedrockClaudeLlmProvider } from "./bedrock.js";
import { supportedModels as openaiSupportedModels } from "./pricing.js";
import { anthropicSupportedModels } from "./anthropic.js";
import { bedrockClaudeSupportedModels } from "./bedrock.js";

const NO_CREDS = {} as NodeJS.ProcessEnv;
const OPENAI_ONLY = { OPENAI_API_KEY: "sk-test-openai" } as NodeJS.ProcessEnv;
const ANTHROPIC_ONLY = { ANTHROPIC_API_KEY: "sk-test-anthropic" } as NodeJS.ProcessEnv;
const BEDROCK_ONLY = { AWS_REGION: "us-east-1" } as NodeJS.ProcessEnv;
const ALL_THREE = {
  OPENAI_API_KEY: "sk-test-openai",
  ANTHROPIC_API_KEY: "sk-test-anthropic",
  AWS_REGION: "us-east-1",
} as NodeJS.ProcessEnv;

describe("resolveLlmRegistrations", () => {
  it("reports no-credentials when no provider's credential is set", () => {
    expect(resolveLlmRegistrations(NO_CREDS)).toEqual({ kind: "no-credentials" });
  });

  it("registers only the OpenAI adapter when only its credential is present", () => {
    const result = resolveLlmRegistrations(OPENAI_ONLY);
    expect(result.kind).toBe("registrations");
    if (result.kind !== "registrations") throw new Error("unreachable");
    expect(result.registrations).toHaveLength(1);
    expect(result.registrations[0].provider).toBeInstanceOf(OpenAiLlmProvider);
    expect(result.registrations[0].models).toEqual(openaiSupportedModels());
  });

  it("registers only the Anthropic adapter when only its credential is present", () => {
    const result = resolveLlmRegistrations(ANTHROPIC_ONLY);
    expect(result.kind).toBe("registrations");
    if (result.kind !== "registrations") throw new Error("unreachable");
    expect(result.registrations).toHaveLength(1);
    expect(result.registrations[0].provider).toBeInstanceOf(AnthropicLlmProvider);
    expect(result.registrations[0].models).toEqual(anthropicSupportedModels());
  });

  it("registers only the Bedrock-Claude adapter when only AWS_REGION is present", () => {
    const result = resolveLlmRegistrations(BEDROCK_ONLY);
    expect(result.kind).toBe("registrations");
    if (result.kind !== "registrations") throw new Error("unreachable");
    expect(result.registrations).toHaveLength(1);
    expect(result.registrations[0].provider).toBeInstanceOf(BedrockClaudeLlmProvider);
    expect(result.registrations[0].models).toEqual(bedrockClaudeSupportedModels());
  });

  it("registers all three adapters additively when all three credentials are present — Bedrock is never exclusive", () => {
    const result = resolveLlmRegistrations(ALL_THREE);
    expect(result.kind).toBe("registrations");
    if (result.kind !== "registrations") throw new Error("unreachable");
    expect(result.registrations).toHaveLength(3);
    expect(result.registrations.map((r) => r.provider)).toEqual([
      expect.any(OpenAiLlmProvider),
      expect.any(AnthropicLlmProvider),
      expect.any(BedrockClaudeLlmProvider),
    ]);
  });
});
