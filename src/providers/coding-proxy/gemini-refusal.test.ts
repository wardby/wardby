import { describe, expect, it } from "vitest";
import { GEMINI_BUDGET_EXHAUSTED_MESSAGE, geminiRefusalBody } from "./gemini-refusal.js";

describe("geminiRefusalBody", () => {
  it("shapes the budget refusal as Google's terminal quota error, keeping wardby's code", () => {
    expect(JSON.parse(geminiRefusalBody(429, "wardby_budget_exhausted"))).toEqual({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "wardby_budget_exhausted (limit: 0)",
        type: "wardby_budget_exhausted",
      },
    });
    // The Gemini CLI treats a 429 whose message matches /limit:\s*0/ as terminal (risk spike, risk 6).
    expect(GEMINI_BUDGET_EXHAUSTED_MESSAGE).toMatch(/limit:\s*0/);
    // wardby's own matching (Codex/Claude drivers, streamFailureCode, docs) looks for the code as a substring.
    expect(GEMINI_BUDGET_EXHAUSTED_MESSAGE).toContain("wardby_budget_exhausted");
  });

  it("gives every other refusal Google's status name and the code as message", () => {
    expect(JSON.parse(geminiRefusalBody(403, "model_not_allowed")).error).toEqual({
      code: 403,
      status: "PERMISSION_DENIED",
      message: "model_not_allowed",
      type: "model_not_allowed",
    });
    expect(JSON.parse(geminiRefusalBody(401, "invalid_capability")).error.status).toBe("UNAUTHENTICATED");
    expect(JSON.parse(geminiRefusalBody(404, "gemini_method_not_supported")).error.status).toBe("NOT_FOUND");
    expect(JSON.parse(geminiRefusalBody(409, "duplicate_request")).error.status).toBe("ABORTED");
    expect(JSON.parse(geminiRefusalBody(429, "request_in_progress")).error.message).toBe("request_in_progress");
    expect(JSON.parse(geminiRefusalBody(503, "upstream_unavailable")).error.status).toBe("UNAVAILABLE");
    expect(JSON.parse(geminiRefusalBody(418, "x")).error.status).toBe("UNKNOWN");
  });
});
