// Replays the requests the driver-configured Gemini CLI made in the worker image
// (gemini-coding-worker/compatibility.docker.test.ts, GEMINI_RECORD=1): every one, helpers and
// sub-agents included, must parse for the run model with the driver's output cap.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { shippedCatalog } from "../llm/catalog.js";
import { entryOf } from "../llm/catalog-types.js";
import { parseGeminiRequest } from "./gemini-request.js";
import { PROXY_MAX_BODY_BYTES, PROXY_MAX_OUTPUT_TOKENS } from "./proxy.js";

interface Recorded {
  scenario: string;
  surface: "ai-studio" | "vertex-express";
  method: "streamGenerateContent" | "generateContent";
  model: string;
  body: Record<string, unknown>;
}

describe("the driver-configured Gemini CLI's requests", () => {
  it("all parse for the run model (helpers and sub-agents remapped, thinking levels in the catalog's efforts)", async () => {
    const { requests } = JSON.parse(
      await readFile(new URL("./fixtures/gemini-cli-0.70.0-driver-requests.json", import.meta.url), "utf8"),
    ) as { requests: Recorded[] };
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      const runModel = request.surface === "ai-studio" ? "google-ai-studio.gemini-4-neon" : "us.gemini-4-neon";
      const entry = entryOf(shippedCatalog().require(runModel));
      const parsed = parseGeminiRequest(JSON.stringify(request.body), {
        route: { surface: request.surface, model: request.model, method: request.method },
        backend: entry.provider as "google-ai-studio" | "vertex-gemini",
        allowedModels: [runModel],
        efforts: entry.efforts ?? [],
        webTools: "off",
        maxBodyBytes: PROXY_MAX_BODY_BYTES,
        maxOutputTokens: PROXY_MAX_OUTPUT_TOKENS,
      });
      expect(parsed.model, request.scenario).toBe(runModel);
      expect(parsed.maxOutputTokens, request.scenario).toBe(32_000);
    }
    expect(requests.some((r) => r.scenario.includes("compression helper"))).toBe(true);
    expect(requests.some((r) => r.scenario.includes("sub-agent"))).toBe(true);
  });
});
