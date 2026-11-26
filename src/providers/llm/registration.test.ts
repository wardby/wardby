import { describe, it, expect } from "vitest";
import { resolveLlmRegistrations } from "./registration.js";
import { OpenAiLlmProvider } from "./openai.js";
import { AnthropicLlmProvider } from "./anthropic.js";
import { BedrockClaudeLlmProvider } from "./bedrock.js";
import { GoogleAiStudioLlmProvider } from "./google-ai-studio.js";
import { VertexGeminiLlmProvider } from "./vertex-gemini.js";

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
    expect(result.registrations[0].provider).toBe("openai");
    expect(result.registrations[0].adapter).toBeInstanceOf(OpenAiLlmProvider);
  });

  it("registers only the Anthropic adapter when only its credential is present", () => {
    const result = resolveLlmRegistrations(ANTHROPIC_ONLY);
    expect(result.kind).toBe("registrations");
    if (result.kind !== "registrations") throw new Error("unreachable");
    expect(result.registrations).toHaveLength(1);
    expect(result.registrations[0].provider).toBe("anthropic");
    expect(result.registrations[0].adapter).toBeInstanceOf(AnthropicLlmProvider);
  });

  it("registers only the Bedrock-Claude adapter when only AWS_REGION is present", () => {
    const result = resolveLlmRegistrations(BEDROCK_ONLY);
    expect(result.kind).toBe("registrations");
    if (result.kind !== "registrations") throw new Error("unreachable");
    expect(result.registrations).toHaveLength(1);
    expect(result.registrations[0].provider).toBe("bedrock-claude");
    expect(result.registrations[0].adapter).toBeInstanceOf(BedrockClaudeLlmProvider);
  });

  it("registers all three adapters additively when all three credentials are present — Bedrock is never exclusive", () => {
    const result = resolveLlmRegistrations(ALL_THREE);
    expect(result.kind).toBe("registrations");
    if (result.kind !== "registrations") throw new Error("unreachable");
    expect(result.registrations).toHaveLength(3);
    expect(result.registrations.map((r) => r.provider)).toEqual(["openai", "anthropic", "bedrock-claude"]);
    expect(result.registrations.map((r) => r.adapter)).toEqual([
      expect.any(OpenAiLlmProvider),
      expect.any(AnthropicLlmProvider),
      expect.any(BedrockClaudeLlmProvider),
    ]);
  });

  it("registers google-ai-studio when GEMINI_API_KEY is present", () => {
    const result = resolveLlmRegistrations({ GEMINI_API_KEY: "fake" });
    if (result.kind !== "registrations") throw new Error("unreachable");
    expect(result.registrations.map((r) => r.provider)).toEqual(["google-ai-studio"]);
    expect(result.registrations[0].adapter).toBeInstanceOf(GoogleAiStudioLlmProvider);
  });

  it("registers vertex-gemini when VERTEX_PROJECT or GOOGLE_CLOUD_PROJECT is present", () => {
    for (const env of [{ VERTEX_PROJECT: "p" }, { GOOGLE_CLOUD_PROJECT: "p" }]) {
      const result = resolveLlmRegistrations(env);
      if (result.kind !== "registrations") throw new Error("unreachable");
      expect(result.registrations.map((r) => r.provider)).toEqual(["vertex-gemini"]);
      expect(result.registrations[0].adapter).toBeInstanceOf(VertexGeminiLlmProvider);
    }
  });

  it("registers all five additively, in order", () => {
    const result = resolveLlmRegistrations({
      ...ALL_THREE,
      GEMINI_API_KEY: "fake",
      VERTEX_PROJECT: "p",
    });
    if (result.kind !== "registrations") throw new Error("unreachable");
    expect(result.registrations.map((r) => r.provider)).toEqual([
      "openai",
      "anthropic",
      "bedrock-claude",
      "vertex-gemini",
      "google-ai-studio",
    ]);
  });
});
