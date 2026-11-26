import { describe, expect, it } from "vitest";
import { GeminiUpstreamUnavailable, geminiUpstreamUrl } from "./gemini-upstream.js";

describe("geminiUpstreamUrl", () => {
  it("builds the AI Studio and Vertex URLs from the wardby model id", () => {
    expect(geminiUpstreamUrl("google-ai-studio", "google-ai-studio.gemini-4-neon", "streamGenerateContent", {})).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse",
    );
    expect(
      geminiUpstreamUrl("vertex-gemini", "gemini-4-neon", "generateContent", { vertexProject: "example-project" }),
    ).toBe(
      "https://aiplatform.googleapis.com/v1beta1/projects/example-project/locations/global/publishers/google/models/gemini-4-neon:generateContent",
    );
    expect(
      geminiUpstreamUrl("vertex-gemini", "eu.gemini-4-neon", "streamGenerateContent", {
        vertexProject: "example-project",
      }),
    ).toBe(
      "https://aiplatform.eu.rep.googleapis.com/v1beta1/projects/example-project/locations/eu/publishers/google/models/gemini-4-neon:streamGenerateContent?alt=sse",
    );
  });

  it("refuses a Vertex URL without a project", () => {
    expect(() => geminiUpstreamUrl("vertex-gemini", "gemini-4-neon", "generateContent", {})).toThrow(
      GeminiUpstreamUnavailable,
    );
  });
});
