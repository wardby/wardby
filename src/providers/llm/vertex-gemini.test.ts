import { describe, it, expect } from "vitest";
import { VertexGeminiLlmProvider, vertexGeminiCredentialsPresent, vertexLocation } from "./vertex-gemini.js";
import { SHIPPED_CATALOG } from "./catalog-shipped.js";

const okBody =
  'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}\n\n';

function recorder() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(okBody, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function drain(p: { stream: VertexGeminiLlmProvider["stream"] }, model: string) {
  for await (const _ of p.stream({ model, messages: [{ role: "user", content: "x" }] })) void _;
}

describe("vertexLocation", () => {
  it.each([
    ["gemini-4-neon", "global", "gemini-4-neon"],
    ["us.gemini-4-neon", "us", "gemini-4-neon"],
    ["eu.gemini-4-carbon", "eu", "gemini-4-carbon"],
  ])("%s → %s / %s", (id, location, googleModel) => expect(vertexLocation(id)).toEqual({ location, googleModel }));
});

describe("VertexGeminiLlmProvider", () => {
  it.each([
    [
      "gemini-4-neon",
      "https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global/publishers/google/models/gemini-4-neon:streamGenerateContent?alt=sse",
    ],
    [
      "us.gemini-4-neon",
      "https://aiplatform.us.rep.googleapis.com/v1/projects/proj-1/locations/us/publishers/google/models/gemini-4-neon:streamGenerateContent?alt=sse",
    ],
    [
      "eu.gemini-4-neon",
      "https://aiplatform.eu.rep.googleapis.com/v1/projects/proj-1/locations/eu/publishers/google/models/gemini-4-neon:streamGenerateContent?alt=sse",
    ],
  ])("%s calls %s with a bearer token", async (modelId, url) => {
    const entry = SHIPPED_CATALOG.find((e) => e.modelId === modelId)!;
    expect(entry).toBeDefined();
    const { calls, fetchImpl } = recorder();
    const p = new VertexGeminiLlmProvider("proj-1", {
      fetch: fetchImpl,
      token: async () => "fake-vertex-token",
    }).withEntry(entry);
    await drain(p, modelId);
    expect(calls[0].url).toBe(url);
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer fake-vertex-token");
    expect(calls[0].url).not.toContain("fake-vertex-token");
  });

  it("a token failure throws a fixed message with no token or credential detail", async () => {
    const entry = SHIPPED_CATALOG.find((e) => e.modelId === "gemini-4-neon")!;
    const { fetchImpl } = recorder();
    const p = new VertexGeminiLlmProvider("proj-1", {
      fetch: fetchImpl,
      token: async () => {
        throw new Error("secret detail /home/x/adc.json");
      },
    }).withEntry(entry);
    const err = (await drain(p, "gemini-4-neon").catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/^vertex_auth_unavailable/);
    expect(`${err.message}${err.stack}`).not.toContain("adc.json");
    expect(`${err.message}${err.stack}`).not.toContain("secret detail");
  });

  it("constructing without options does no network I/O and requires a project", () => {
    expect(() => new VertexGeminiLlmProvider("proj-1")).not.toThrow();
    expect(() => new VertexGeminiLlmProvider("")).toThrow(/VERTEX_PROJECT/);
  });

  it("detects credentials from VERTEX_PROJECT or GOOGLE_CLOUD_PROJECT", () => {
    expect(vertexGeminiCredentialsPresent({ VERTEX_PROJECT: "p" })).toBe(true);
    expect(vertexGeminiCredentialsPresent({ GOOGLE_CLOUD_PROJECT: "p" })).toBe(true);
    expect(vertexGeminiCredentialsPresent({})).toBe(false);
  });
});
