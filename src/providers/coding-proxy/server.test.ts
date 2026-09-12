import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryProxyLedger } from "./memory-ledger.js";
import { CodingProxy, type CreatedCodingProxySession } from "./proxy.js";
import { startCodingProxyServer, type CodingProxyServerHandle } from "./server.js";

describe("coding proxy HTTP boundary", () => {
  let server: CodingProxyServerHandle;
  let session: CreatedCodingProxySession;
  let anthropicSession: CreatedCodingProxySession;
  const upstream = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Response.json(
      url.includes("anthropic.com")
        ? { usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } }
        : { usage: { input_tokens: 1, output_tokens: 1 } },
      { status: 200 },
    );
  });

  beforeAll(async () => {
    const ledger = new MemoryProxyLedger();
    const proxy = new CodingProxy({
      ledger,
      credentials: { resolve: async () => "UPSTREAM_SECRET" },
      fetch: upstream,
      pricing: () => ({ encoding: "o200k_base", inputPerMTok: 1, outputPerMTok: 1 }),
    });
    session = await proxy.createSession({
      runId: "http-run",
      credentialRef: "openai/test",
      protocol: "openai-responses",
      allowedModels: ["test-model"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 1,
    });
    anthropicSession = await proxy.createSession({
      runId: "http-anthropic-run",
      credentialRef: "anthropic/test",
      protocol: "anthropic-messages",
      allowedModels: ["test-model"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 1,
    });
    server = await startCodingProxyServer(proxy, { host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => server.close());

  function call(path: string, init: RequestInit = {}) {
    return fetch(`http://127.0.0.1:${server.port}${path}`, init);
  }

  it("mounts only the reviewed endpoints and exact Claude compatibility probe", async () => {
    expect((await call("/mcp")).status).toBe(404);
    expect((await call("/health")).status).toBe(404);
    expect((await call("/v1/responses?run=other")).status).toBe(404);
    expect((await call("/v1/messages?beta=false", { method: "POST" })).status).toBe(404);
    expect((await call("/api/hello", { method: "HEAD" })).status).toBe(200);
    expect((await call("/api/hello", { method: "GET" })).status).toBe(404);
  });

  it("requires the one-run bearer and JSON content type", async () => {
    const raw = JSON.stringify({ model: "test-model", input: "x", max_output_tokens: 2, stream: false });
    expect((await call("/v1/responses", { method: "POST", body: raw })).status).toBe(415);
    const upstreamCalls = upstream.mock.calls.length;
    const denied = await call("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: raw,
    });
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain("wrong");
    expect(upstream).toHaveBeenCalledTimes(upstreamCalls);
  });

  it("forwards an authenticated bounded request without exposing the credential", async () => {
    const response = await call("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.capability}`,
        "idempotency-key": "http-request-1",
        "x-untrusted-secret": "WORKER_ONLY",
      },
      body: JSON.stringify({ model: "test-model", input: "x", max_output_tokens: 2, stream: false }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("UPSTREAM_SECRET");
    const headers = new Headers((upstream.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get("authorization")).toBe("Bearer UPSTREAM_SECRET");
    expect(headers.get("x-untrusted-secret")).toBeNull();
  });

  it("does not treat Codex's reusable client request id as an idempotency key", async () => {
    const callWithInput = (input: string) =>
      call("/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.capability}`,
          "x-client-request-id": "codex-tool-loop",
        },
        body: JSON.stringify({ model: "test-model", input, stream: false }),
      });

    expect((await callWithInput("first tool-loop request")).status).toBe(200);
    expect((await callWithInput("second tool-loop request")).status).toBe(200);
  });

  it("accepts Claude's x-api-key capability only on the Messages route", async () => {
    const body = JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      max_tokens: 2,
      stream: false,
    });
    const response = await call("/v1/messages?beta=true", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicSession.capability,
        "anthropic-beta": "claude-code-20250219",
      },
      body,
    });
    expect(response.status).toBe(200);
    const init = upstream.mock.calls.at(-1)![1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("UPSTREAM_SECRET");
    expect(headers.get("anthropic-beta")).toBe("claude-code-20250219");
    expect(headers.get("authorization")).toBeNull();

    expect(
      (
        await call("/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${anthropicSession.capability}`,
          },
          body,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call("/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": session.capability },
          body: JSON.stringify({ model: "test-model", input: "x", stream: false }),
        })
      ).status,
    ).toBe(401);
  });

  it("rejects malformed Claude requests before they can reach the credential holder", async () => {
    const upstreamCalls = upstream.mock.calls.length;
    const response = await call("/v1/messages?beta=true", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicSession.capability,
      },
      body: "not-json",
    });
    expect(response.status).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(upstreamCalls);
  });
});
