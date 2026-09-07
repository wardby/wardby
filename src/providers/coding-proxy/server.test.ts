import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryProxyLedger } from "./memory-ledger.js";
import { CodingProxy, type CreatedCodingProxySession } from "./proxy.js";
import { startCodingProxyServer, type CodingProxyServerHandle } from "./server.js";

describe("coding proxy HTTP boundary", () => {
  let server: CodingProxyServerHandle;
  let session: CreatedCodingProxySession;
  const upstream = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }, { status: 200 }),
  );

  beforeAll(async () => {
    const proxy = new CodingProxy({
      ledger: new MemoryProxyLedger(),
      credentials: { resolve: async () => "UPSTREAM_SECRET" },
      fetch: upstream,
      pricing: () => ({ encoding: "o200k_base", inputPerMTok: 1, outputPerMTok: 1 }),
    });
    session = await proxy.createSession({
      runId: "http-run",
      credentialRef: "openai/test",
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

  it("mounts only the Responses endpoint", async () => {
    expect((await call("/mcp")).status).toBe(404);
    expect((await call("/health")).status).toBe(404);
    expect((await call("/v1/responses?run=other")).status).toBe(404);
  });

  it("requires the one-run bearer and JSON content type", async () => {
    const raw = JSON.stringify({ model: "test-model", input: "x", max_output_tokens: 2, stream: false });
    expect((await call("/v1/responses", { method: "POST", body: raw })).status).toBe(415);
    const denied = await call("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: raw,
    });
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain("wrong");
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
});
