import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setLogLineFilter } from "../../core/logger.js";
import { shippedCatalog } from "../llm/catalog.js";
import { entryOf } from "../llm/catalog-types.js";
import { MemoryProxyLedger } from "./memory-ledger.js";
import { CodingProxy, type CreatedCodingProxySession } from "./proxy.js";
import { logProxyAudit, startCodingProxyServer, type CodingProxyServerHandle } from "./server.js";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "trace";
});

const FAKE_GEMINI_KEY = "AIzaFAKEfakeFAKEfake0123456789abcdEFGH";
const sse = `data: ${JSON.stringify({
  candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
})}\r\n\r\n`;

describe("coding proxy Gemini routes", () => {
  let server: CodingProxyServerHandle;
  let session: CreatedCodingProxySession;
  const lines: string[] = [];
  const upstream = vi.fn(
    async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
  );
  const observed: { protocol: string; status: number }[] = [];

  beforeAll(async () => {
    setLogLineFilter((line) => {
      lines.push(line);
      return "";
    });
    const proxy = new CodingProxy({
      ledger: new MemoryProxyLedger(),
      credentials: { resolve: async () => FAKE_GEMINI_KEY },
      fetch: upstream,
      audit: (event) => logProxyAudit(event),
    });
    session = await proxy.createSession({
      runId: "gemini-server-run",
      credentialRef: "env:GEMINI_API_KEY",
      protocol: "gemini-generate-content",
      allowedModels: ["google-ai-studio.gemini-4-neon"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 5,
      terms: { version: "v", entry: entryOf(shippedCatalog().require("google-ai-studio.gemini-4-neon")) },
    });
    server = await startCodingProxyServer(proxy, { host: "127.0.0.1", port: 0, onRequest: (e) => observed.push(e) });
  });
  afterAll(async () => {
    setLogLineFilter((line) => line);
    await server.close();
  });

  const post = (
    path: string,
    headers: Record<string, string>,
    body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { maxOutputTokens: 10 },
    }),
  ) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  it("serves the AI Studio stream path with the capability in x-goog-api-key", async () => {
    const response = await post("/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse", {
      "x-goog-api-key": session.capability,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"ok"');
    expect(observed.at(-1)).toMatchObject({ protocol: "gemini-generate-content", status: 200 });
  });

  it("refuses the Vertex path on an AI Studio session", async () => {
    const response = await post("/v1beta1/publishers/google/models/gemini-4-neon:generateContent", {
      "x-goog-api-key": session.capability,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { type: "gemini_backend_mismatch", message: "gemini_backend_mismatch" },
    });
  });

  it("refuses countTokens and a key in the query before reading the body or calling upstream", async () => {
    const calls = upstream.mock.calls.length;
    const counted = await post("/v1beta/models/gemini-4-neon:countTokens", { "x-goog-api-key": session.capability });
    expect(counted.status).toBe(404);
    expect(await counted.json()).toEqual({
      error: { type: "gemini_method_not_supported", message: "gemini_method_not_supported" },
    });
    const keyed = await post(`/v1beta/models/gemini-4-neon:generateContent?key=${session.capability}`, {});
    expect(keyed.status).toBe(404);
    expect(await keyed.json()).toEqual({
      error: { type: "gemini_query_not_allowed", message: "gemini_query_not_allowed" },
    });
    expect(upstream.mock.calls.length).toBe(calls);
  });

  it("refuses a capability sent in more than one header", async () => {
    const calls = upstream.mock.calls.length;
    for (const extra of [
      { authorization: `Bearer ${session.capability}` },
      { "x-api-key": session.capability },
    ] as Record<string, string>[]) {
      const response = await post("/v1beta/models/gemini-4-neon:generateContent", {
        "x-goog-api-key": session.capability,
        ...extra,
      });
      expect(response.status).toBe(401);
    }
    expect(upstream.mock.calls.length).toBe(calls);
  });

  it("never logs the capability or the upstream key", async () => {
    await post("/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse", { "x-goog-api-key": session.capability });
    await post(`/v1beta/models/gemini-4-neon:generateContent?key=${session.capability}`, {});
    await post("/v1beta/models/gemini-4-neon:generateContent", {
      "x-goog-api-key": session.capability,
      authorization: `Bearer ${session.capability}`,
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("")).not.toContain(session.capability);
    expect(lines.join("")).not.toContain(FAKE_GEMINI_KEY);
  });
});
