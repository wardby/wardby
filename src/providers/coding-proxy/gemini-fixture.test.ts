import { describe, expect, it } from "vitest";
import { recordedGemini } from "./gemini.test-support.js";

describe("recorded Gemini CLI 0.70.0 requests", () => {
  it("cover both surfaces, both methods, the agent loop and both web helpers", async () => {
    const requests = await recordedGemini();
    expect(new Set(requests.map((r) => r.surface))).toEqual(new Set(["ai-studio", "vertex-express"]));
    expect(new Set(requests.map((r) => r.method))).toEqual(new Set(["streamGenerateContent", "generateContent"]));
    expect(requests.some((r) => r.scenario.includes("agent turn"))).toBe(true);
    expect(requests.some((r) => r.scenario.includes("web-search helper"))).toBe(true);
    expect(requests.some((r) => r.scenario.includes("web-fetch helper"))).toBe(true);
  });

  it("replay a function response and the model's thought signature", async () => {
    const requests = await recordedGemini();
    const replay = requests.find((r) => r.scenario.endsWith("agent turn 1"));
    const contents = (replay?.body.contents ?? []) as { role: string; parts: Record<string, unknown>[] }[];
    expect(contents.some((c) => c.parts.some((p) => "functionResponse" in p))).toBe(true);
    expect(contents.some((c) => c.role === "model" && c.parts.some((p) => "thoughtSignature" in p))).toBe(true);
  });

  it("hold no credential header", async () => {
    for (const r of await recordedGemini()) {
      expect(
        Object.keys(r.headers).filter((h) => /key|authorization|token|cookie/i.test(h)),
        r.scenario,
      ).toEqual([]);
    }
  });
});
