import { describe, expect, it } from "vitest";
import { matchGeminiRoute } from "./gemini-route.js";

describe("matchGeminiRoute", () => {
  it("reads surface, Google model and method from both path shapes", () => {
    expect(matchGeminiRoute("/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse")).toEqual({
      ok: true,
      route: { surface: "ai-studio", model: "gemini-4-neon", method: "streamGenerateContent" },
    });
    expect(matchGeminiRoute("/v1beta1/publishers/google/models/gemini-4-neon:generateContent")).toEqual({
      ok: true,
      route: { surface: "vertex-express", model: "gemini-4-neon", method: "generateContent" },
    });
  });

  it("refuses other methods and any other query, a key in the URL included", () => {
    expect(matchGeminiRoute("/v1beta/models/gemini-4-neon:countTokens")).toEqual({
      ok: false,
      code: "gemini_method_not_supported",
    });
    expect(matchGeminiRoute("/v1beta/models/gemini-4-neon:streamGenerateContent")).toEqual({
      ok: false,
      code: "gemini_query_not_allowed",
    });
    expect(matchGeminiRoute("/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse&key=AIzaFAKE")).toEqual({
      ok: false,
      code: "gemini_query_not_allowed",
    });
    expect(matchGeminiRoute("/v1beta/models/gemini-4-neon:generateContent?key=AIzaFAKE")).toEqual({
      ok: false,
      code: "gemini_query_not_allowed",
    });
    expect(matchGeminiRoute("/v1beta/models/../x:generateContent")).toEqual({
      ok: false,
      code: "gemini_method_not_supported",
    });
  });

  it("is undefined for every other path", () => {
    for (const url of [
      "/v1/responses",
      "/v1/messages",
      "/v1/models/gemini-4-neon:generateContent",
      "/v1beta/cachedContents",
      undefined,
    ]) {
      expect(matchGeminiRoute(url)).toBeUndefined();
    }
  });
});
