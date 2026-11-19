import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http, { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mcpTokenHash, mintMcpToken } from "../../coding/mcp-token.js";
import { createMcpRoute } from "./mcp-route.js";
import { MemoryProxyLedger } from "./memory-ledger.js";
import { CodingProxy, CodingProxyError, type CreatedCodingProxySession } from "./proxy.js";
import type { RegistryAdapter } from "../../coding/registry/types.js";
import { capabilityHash } from "./proxy.js";
import { npmAdapter } from "../../coding/registry/npm.js";
import { pypiAdapter } from "../../coding/registry/pypi.js";
import { RegistryError } from "../../coding/registry/types.js";
import {
  errorResponse,
  RegistryService,
  type RegistryOriginsRequest,
  type RegistryPlanRequest,
  type RegistryRefusalsRequest,
  type RegistryRequest,
  type RegistryResponse,
} from "./registry/service.js";
import { MemoryRegistryStore } from "./registry/store.js";
import { setLogLineFilter } from "../../core/logger.js";
import { logProxyAudit, startCodingProxyServer, type CodingProxyServerHandle } from "./server.js";

/** A minimal CodingProxy wired only well enough to start the HTTP server;
 *  the registry-routing tests never exercise the LLM proxy path. Mirrors
 *  the `beforeAll` construction above without the sessions/pricing this
 *  suite's other tests need. */
function fakeProxy(): CodingProxy {
  return new CodingProxy({
    ledger: new MemoryProxyLedger(),
    credentials: { resolve: async () => "UNUSED" },
  });
}

describe("coding proxy HTTP boundary", () => {
  let server: CodingProxyServerHandle;
  const observedRequests: Array<{ protocol: string; status: number }> = [];
  let session: CreatedCodingProxySession;
  let anthropicSession: CreatedCodingProxySession;
  let proxyForLogging: CodingProxy;
  let loggingSession: CreatedCodingProxySession;
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
    server = await startCodingProxyServer(proxy, {
      host: "127.0.0.1",
      port: 0,
      onRequest: (event) => observedRequests.push(event),
    });
    proxyForLogging = new CodingProxy({
      ledger: new MemoryProxyLedger(),
      credentials: { resolve: async () => "UPSTREAM_SECRET" },
      fetch: upstream,
      pricing: () => ({ encoding: "o200k_base", inputPerMTok: 1, outputPerMTok: 1 }),
      audit: (event) => logProxyAudit(event),
    });
    loggingSession = await proxyForLogging.createSession({
      runId: "http-logging-run",
      credentialRef: "openai/test",
      protocol: "openai-responses",
      allowedModels: ["test-model"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 1,
    });
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

  it("answers /substrate/ with 404 not_found when the route is not configured", async () => {
    const response = await call("/substrate/runs/x/input");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { type: "not_found" } });
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
    expect(observedRequests).toContainEqual(expect.objectContaining({ protocol: "openai-responses", status: 401 }));
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
  });

  describe("openai-responses with the capability in x-api-key (Substrate's gateway injects it)", () => {
    let sent = 0;
    // A fresh input each time: the proxy refuses a replayed identical body.
    const responsesBody = () => JSON.stringify({ model: "test-model", input: `x-api-key ${++sent}`, stream: false });
    const responses = (headers: Record<string, string>) =>
      call("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: responsesBody(),
      });

    it("openai-responses: accepts the capability in x-api-key when Authorization is absent", async () => {
      const response = await responses({ "x-api-key": session.capability });
      expect(response.status).toBe(200);
      const headers = new Headers((upstream.mock.calls.at(-1)![1] as RequestInit).headers);
      expect(headers.get("authorization")).toBe("Bearer UPSTREAM_SECRET");
      expect(headers.get("x-api-key")).toBeNull();
    });

    it("openai-responses: refuses x-api-key together with a real Bearer", async () => {
      const upstreamCalls = upstream.mock.calls.length;
      const response = await responses({
        "x-api-key": session.capability,
        authorization: `Bearer ${session.capability}`,
      });
      expect(response.status).toBe(401);
      expect(upstream).toHaveBeenCalledTimes(upstreamCalls);
    });

    it("openai-responses: refuses x-api-key beside any other Authorization, the placeholder Bearer included", async () => {
      for (const authorization of ["Bearer rrp_placeholder_injected_by_gateway", "Bearer rrp_OTHER_FAKE", ""]) {
        expect((await responses({ "x-api-key": session.capability, authorization })).status).toBe(401);
      }
    });

    it("openai-responses: refuses a wrong x-api-key", async () => {
      expect((await responses({ "x-api-key": "rrp_OTHER_FAKE" })).status).toBe(401);
    });

    it("openai-responses: Bearer alone is unchanged", async () => {
      expect((await responses({ authorization: `Bearer ${session.capability}` })).status).toBe(200);
    });

    it("never logs either header value", async () => {
      const lines: string[] = [];
      setLogLineFilter((line) => {
        lines.push(line);
        return line;
      });
      const events: unknown[] = [];
      const logged = await startCodingProxyServer(proxyForLogging, {
        host: "127.0.0.1",
        port: 0,
        onRequest: (event) => events.push(event),
      });
      try {
        const send = (headers: Record<string, string>) =>
          fetch(`http://127.0.0.1:${logged.port}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: responsesBody(),
          });
        expect((await send({ "x-api-key": loggingSession.capability })).status).toBe(200);
        expect(
          (
            await send({
              "x-api-key": loggingSession.capability,
              authorization: "Bearer rrp_placeholder_injected_by_gateway",
            })
          ).status,
        ).toBe(401);
        expect((await send({ "x-api-key": "rrp_placeholder_injected_by_gateway" })).status).toBe(401);
      } finally {
        await logged.close();
        setLogLineFilter((line) => line);
      }
      expect(lines.length).toBeGreaterThan(0);
      const seen = JSON.stringify(events) + lines.join("\n");
      expect(seen).not.toContain(loggingSession.capability);
      expect(seen).not.toContain("rrp_placeholder_injected_by_gateway");
    });
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

describe("coding proxy /mcp route", () => {
  const token = mintMcpToken();
  let gateway: Server;
  let gatewayUrl: string;
  let gatewayDelayMs = 0;
  const forwarded: { authorization?: string; body: string }[] = [];
  let ledger: MemoryProxyLedger;

  beforeAll(async () => {
    gateway = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        forwarded.push({ authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" }).end('{"jsonrpc":"2.0","id":1,"result":{}}');
        }, gatewayDelayMs);
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
    ledger = new MemoryProxyLedger();
    await ledger.createSession({
      id: "mcp-session",
      runId: "mcp-run",
      capabilityHash: "cap",
      credentialRef: "anthropic/test",
      protocol: "anthropic-messages",
      allowedModels: ["test-model"],
      deadlineAt: new Date(Date.now() + 60 * 60_000),
      budgetUsd: 1,
      registryTokenHash: "reg",
      mcpTools: [
        {
          exposedName: "docs__search",
          toolName: "search",
          serverId: "server-1",
          serverName: "docs",
          definition: { description: "Search", inputSchema: { type: "object" } },
        },
      ],
      mcpTokenHash: mcpTokenHash(token),
    });
  });

  afterAll(async () => new Promise<void>((resolve) => gateway.close(() => resolve())));

  const start = (options: { requestMs?: number; dependencyCache?: boolean } = {}) =>
    startCodingProxyServer(fakeProxy(), {
      host: "127.0.0.1",
      port: 0,
      requestMs: options.requestMs,
      ...(options.dependencyCache ? { dependencyCache: { handle: async () => undefined, uploadMs: 1_000 } } : {}),
      mcp: createMcpRoute({ ledger, gatewayUrl }),
    });

  it("forwards POST /mcp to the gateway with the worker's Authorization", async () => {
    const server = await start();
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
    expect(forwarded.at(-1)).toEqual({ authorization: `Bearer ${token}`, body });
    await server.close();
  });

  it("answers GET, DELETE and HEAD on /mcp with 405, and still answers HEAD /api/hello", async () => {
    const server = await start();
    const base = `http://127.0.0.1:${server.port}`;
    for (const method of ["GET", "DELETE", "HEAD"]) {
      const response = await fetch(`${base}/mcp`, { method, headers: { authorization: `Bearer ${token}` } });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(response.headers.get("www-authenticate")).toBeNull();
    }
    expect((await fetch(`${base}/api/hello`, { method: "HEAD" })).status).toBe(200);
    await server.close();
  });

  it("lets a forwarded call outlast the server's request window", async () => {
    // A 200 ms request window, enforced per request by the body timer the dependency cache turns
    // on, and a gateway that takes 1.5 s: the window covers receiving the request only.
    gatewayDelayMs = 1_500;
    try {
      const server = await start({ requestMs: 200, dependencyCache: true });
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}',
      });
      expect(response.status).toBe(200);
      await server.close();
    } finally {
      gatewayDelayMs = 0;
    }
  });
});

describe("coding proxy registry routing", () => {
  it("routes /registry/ requests with bearer or basic auth to the registry and streams the result", async () => {
    const calls: { ecosystem: string; subpath: string; token: string }[] = [];
    const registry = {
      handle: async (request: RegistryRequest): Promise<RegistryResponse> => {
        calls.push({ ecosystem: request.ecosystem, subpath: request.subpath, token: request.token });
        return request.subpath.startsWith("-/tarball")
          ? { status: 200 as const, contentType: "application/octet-stream", stream: new Response("bytes").body! }
          : { status: 200, contentType: "application/json", body: "{}" };
      },
    };
    const server = await startCodingProxyServer(fakeProxy(), {
      host: "127.0.0.1",
      port: 0,
      registry,
    });
    const base = `http://127.0.0.1:${server.port}/registry`;
    await fetch(`${base}/npm/react`, { headers: { authorization: "Bearer rrg_a" } });
    const tar = await fetch(`${base}/npm/-/tarball/react/19.0.0`, {
      headers: { authorization: `Basic ${Buffer.from("wardby:rrg_b").toString("base64")}` },
    });
    expect(await tar.text()).toBe("bytes");
    expect(calls).toEqual([
      expect.objectContaining({ ecosystem: "npm", subpath: "react", token: "rrg_a" }),
      expect.objectContaining({ ecosystem: "npm", subpath: "-/tarball/react/19.0.0", token: "rrg_b" }),
    ]);
    const post = await fetch(`${base}/npm/react`, { method: "POST" });
    expect(post.status).toBe(405);
    await server.close();
  });

  it("routes POST /registry/<ecosystem>/-/plan to the registry's plan, which reads the body within 20 MiB", async () => {
    const plans: { ecosystem: string; token: string; body: string }[] = [];
    const registry = {
      handle: async (): Promise<RegistryResponse> => ({ status: 200, contentType: "text", body: "" }),
      plan: async (request: RegistryPlanRequest): Promise<RegistryResponse> => {
        try {
          plans.push({ ecosystem: request.ecosystem, token: request.token, body: await request.readBody() });
        } catch (error) {
          return errorResponse(error as RegistryError);
        }
        return { status: 200, contentType: "application/json", body: '{"approved":1,"refused":[]}' };
      },
    };
    const server = await startCodingProxyServer(fakeProxy(), { host: "127.0.0.1", port: 0, registry });
    const url = `http://127.0.0.1:${server.port}/registry/npm/-/plan`;
    const ok = await fetch(url, { method: "POST", headers: { authorization: "Bearer rrg_p" }, body: '{"lock":1}' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ approved: 1, refused: [] });
    expect(plans).toEqual([{ ecosystem: "npm", token: "rrg_p", body: '{"lock":1}' }]);

    const large = await fetch(url, { method: "POST", body: "x".repeat(20 * 1024 * 1024 + 1) });
    expect(large.status).toBe(413);
    expect(await large.json()).toEqual({ error: expect.stringContaining("wardby_lockfile_too_large") });
    expect(plans).toHaveLength(1);
    // Only POST plans; a GET of the same path is an ordinary registry request.
    expect((await fetch(url)).status).toBe(200);
    await server.close();
  });

  it("routes GET /registry/-/refusals to the registry's refusals, with the token and since", async () => {
    const asked: RegistryRefusalsRequest[] = [];
    const handled: string[] = [];
    const registry = {
      handle: async (request: { subpath: string }): Promise<RegistryResponse> => {
        handled.push(request.subpath);
        return { status: 200, contentType: "text", body: "" };
      },
      refusals: async (request: RegistryRefusalsRequest) => {
        asked.push(request);
        return { status: 200, contentType: "application/json", body: '{"refusals":[]}' };
      },
    };
    const server = await startCodingProxyServer(fakeProxy(), { host: "127.0.0.1", port: 0, registry });
    const base = `http://127.0.0.1:${server.port}/registry/-/refusals`;
    const response = await fetch(`${base}?since=2026-10-18T12:00:00.000Z`, {
      headers: { authorization: "Bearer rrg_r" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ refusals: [] });
    await fetch(base, { headers: { authorization: "Bearer rrg_r" } });
    expect(asked).toEqual([{ token: "rrg_r", since: new Date("2026-10-18T12:00:00.000Z") }, { token: "rrg_r" }]);
    // Never treated as an ecosystem named "-".
    expect(handled).toEqual([]);
    await server.close();
  });

  it("routes POST /registry/<ecosystem>/-/origins to the registry's origins, which reads the body within 1 MiB", async () => {
    const asked: { ecosystem: string; token: string; body: string }[] = [];
    const registry = {
      handle: async (): Promise<RegistryResponse> => ({ status: 200, contentType: "text", body: "" }),
      origins: async (request: RegistryOriginsRequest): Promise<RegistryResponse> => {
        try {
          asked.push({ ecosystem: request.ecosystem, token: request.token, body: await request.readBody() });
        } catch (error) {
          return errorResponse(error as RegistryError);
        }
        return { status: 200, contentType: "application/json", body: '{"index":"i","files":[]}' };
      },
    };
    const server = await startCodingProxyServer(fakeProxy(), { host: "127.0.0.1", port: 0, registry });
    const url = `http://127.0.0.1:${server.port}/registry/pypi/-/origins`;
    const ok = await fetch(url, { method: "POST", headers: { authorization: "Bearer rrg_o" }, body: '{"files":[]}' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toEqual({ index: "i", files: [] });
    expect(asked).toEqual([{ ecosystem: "pypi", token: "rrg_o", body: '{"files":[]}' }]);

    const large = await fetch(url, { method: "POST", body: "x".repeat(1024 * 1024 + 1) });
    expect(large.status).toBe(413);
    expect(await large.json()).toEqual({ error: expect.stringContaining("wardby_request_too_large") });
    expect(asked).toHaveLength(1);
    // Only POST asks; a GET of the same path is an ordinary registry request.
    expect((await fetch(url)).status).toBe(200);
    await server.close();
  });

  it("rejects an unauthenticated origins request before reading its body", async () => {
    const registry = new RegistryService({
      adapters: new Map([["pypi", pypiAdapter]]),
      store: new MemoryRegistryStore(),
      audit: { audit: async () => ({ withheld: () => [], waived: () => [], reported: () => [] }) },
      upstream: async () => new Response("", { status: 500 }),
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1, maxTotalBytes: 1, maxFiles: 1, idleTimeoutMs: 1_000 },
    });
    const server = await startCodingProxyServer(fakeProxy(), { host: "127.0.0.1", port: 0, registry });
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        pulled += 1;
        if (pulled === 1) controller.enqueue(new TextEncoder().encode("{"));
        else await new Promise(() => {});
      },
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/registry/pypi/-/origins`, {
      method: "POST",
      headers: { authorization: "Bearer rrg_nope" },
      body,
      duplex: "half",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: expect.stringContaining("invalid_capability") });
    await server.close();
  });

  it("rejects an unauthenticated plan before reading its body", async () => {
    const registry = new RegistryService({
      adapters: new Map([["npm", npmAdapter]]),
      store: new MemoryRegistryStore(),
      audit: {
        audit: async () => ({ withheld: () => [], waived: () => [], reported: () => [] }),
        auditVersions: async () => new Map(),
      },
      upstream: async () => new Response("", { status: 500 }),
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1, maxTotalBytes: 1, maxFiles: 1, idleTimeoutMs: 1_000 },
    });
    const server = await startCodingProxyServer(fakeProxy(), { host: "127.0.0.1", port: 0, registry });
    let pulled = 0;
    // A body that never ends: the answer can only come before it is read.
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        pulled += 1;
        if (pulled === 1) controller.enqueue(new TextEncoder().encode("{"));
        else await new Promise(() => {});
      },
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/registry/npm/-/plan`, {
      method: "POST",
      headers: { authorization: "Bearer rrg_nope" },
      body,
      duplex: "half",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: expect.stringContaining("invalid_capability") });
    await server.close();
  });

  it("still enforces the expected-host check for /registry/ requests", async () => {
    const registry = {
      handle: async (): Promise<RegistryResponse> => ({ status: 200, contentType: "text", body: "" }),
    };
    const server = await startCodingProxyServer(fakeProxy(), {
      host: "127.0.0.1",
      port: 0,
      expectedHosts: ["wardby-proxy:8787"],
      registry,
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/registry/npm/react`);
    expect(response.status).toBe(403);
    await server.close();
  });

  it("sends a refusal's Retry-After header, and none when the refusal has no retry time", async () => {
    const proxy = fakeProxy();
    const execute = vi.spyOn(proxy, "execute");
    const server = await startCodingProxyServer(proxy, { host: "127.0.0.1", port: 0 });
    const post = () =>
      fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer any" },
        body: "{}",
      });
    execute.mockRejectedValueOnce(new CodingProxyError(503, "wardby_request_in_progress", 21));
    const inProgress = await post();
    expect(inProgress.status).toBe(503);
    expect(inProgress.headers.get("retry-after")).toBe("21");
    expect(await inProgress.json()).toEqual({
      error: { type: "wardby_request_in_progress", message: "wardby_request_in_progress" },
    });
    execute.mockRejectedValueOnce(new CodingProxyError(409, "duplicate_completed"));
    const duplicate = await post();
    expect(duplicate.status).toBe(409);
    expect(duplicate.headers.get("retry-after")).toBeNull();
    await server.close();
  });

  it("passes the registry only a Host the guard matched, never a forwarded one", async () => {
    const handled: (string | undefined)[] = [];
    const planned: (string | undefined)[] = [];
    const registry = {
      handle: async (request: RegistryRequest): Promise<RegistryResponse> => {
        handled.push(request.host);
        return { status: 200, contentType: "text", body: "" };
      },
      plan: async (request: RegistryPlanRequest): Promise<RegistryResponse> => {
        planned.push(request.host);
        return { status: 200, contentType: "application/json", body: "{}" };
      },
    };
    const hosts = ["wardby-proxy:8787", "coding-proxy.example.svc.cluster.local:8787"];
    const send = (port: number, host: string, path: string, method = "GET") =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, path, method, headers: { host, "x-forwarded-host": "evil.example:8787" } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(method === "POST" ? "{}" : undefined);
      });
    const guarded = await startCodingProxyServer(fakeProxy(), {
      host: "127.0.0.1",
      port: 0,
      expectedHosts: hosts,
      registry,
    });
    expect(await send(guarded.port, hosts[1], "/registry/pypi/simple/demo/")).toBe(200);
    expect(await send(guarded.port, hosts[0], "/registry/pypi/simple/demo/")).toBe(200);
    expect(await send(guarded.port, hosts[1], "/registry/npm/-/plan", "POST")).toBe(200);
    expect(await send(guarded.port, "evil.example:8787", "/registry/pypi/simple/demo/")).toBe(403);
    expect(handled).toEqual([hosts[1], hosts[0]]);
    expect(planned).toEqual([hosts[1]]);
    await guarded.close();
    // No guard configured: no host is passed, so the registry keeps its default base.
    const open = await startCodingProxyServer(fakeProxy(), { host: "127.0.0.1", port: 0, registry });
    expect(await send(open.port, hosts[1], "/registry/pypi/simple/demo/")).toBe(200);
    expect(await send(open.port, hosts[1], "/registry/npm/-/plan", "POST")).toBe(200);
    expect(handled.at(-1)).toBeUndefined();
    expect(handled).toHaveLength(3);
    expect(planned.at(-1)).toBeUndefined();
    expect(planned).toHaveLength(2);
    await open.close();
  });

  it("accepts any exactly listed host and rejects the rest", async () => {
    const registry = {
      handle: async (): Promise<RegistryResponse> => ({ status: 200, contentType: "text", body: "" }),
    };
    const hosts = ["wardby-proxy:8787", "coding-proxy.example.svc.cluster.local:8787"];
    const server = await startCodingProxyServer(fakeProxy(), {
      host: "127.0.0.1",
      port: 0,
      expectedHosts: hosts,
      registry,
    });
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: server.port, path: "/registry/npm/react", headers: { host } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
    expect(await status("coding-proxy.example.svc.cluster.local:8787")).toBe(200);
    expect(await status("wardby-proxy:8787")).toBe(200);
    expect(await status("coding-proxy.example.svc.cluster.local:9999")).toBe(403);
    expect(await status("evil.example:8787")).toBe(403);
    await server.close();
    const only = await startCodingProxyServer(fakeProxy(), {
      host: "127.0.0.1",
      port: 0,
      expectedHosts: [hosts[0]],
      registry,
    });
    expect(
      await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: only.port, path: "/registry/npm/react", headers: { host: hosts[1] } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      }),
    ).toBe(403);
    await only.close();
  });

  it("returns 404 for /registry/ when no registry is configured", async () => {
    const server = await startCodingProxyServer(fakeProxy(), { host: "127.0.0.1", port: 0 });
    expect((await fetch(`http://127.0.0.1:${server.port}/registry/npm/react`)).status).toBe(404);
    await server.close();
  });

  it("destroys the response instead of ending it cleanly when the registry stream errors mid-transfer", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial-bytes"));
        queueMicrotask(() => controller.error(new Error("upstream_broke")));
      },
    });
    const registry = {
      handle: async (): Promise<RegistryResponse> => ({
        status: 200,
        contentType: "application/octet-stream",
        stream,
      }),
    };
    const server = await startCodingProxyServer(fakeProxy(), {
      host: "127.0.0.1",
      port: 0,
      registry,
    });
    // The failure can surface either as the fetch() call itself rejecting
    // (the socket was destroyed before headers finished flushing) or as a
    // rejection reading the body (destroyed mid-stream): either way, the
    // client must see an aborted transfer, never a clean 200 with a
    // silently truncated body.
    await expect(
      (async () => {
        const response = await fetch(`http://127.0.0.1:${server.port}/registry/npm/-/tarball/react/19.0.0`);
        return response.text();
      })(),
    ).rejects.toThrow();
    await server.close();
  });

  describe("with the real registry service", () => {
    const NOW = new Date("2026-09-25T00:00:00Z");
    const adapter: RegistryAdapter = {
      id: "npm",
      osvEcosystem: "npm",
      upstreamHosts: ["upstream.test"],
      collectExclude: [],
      dependenciesInMetadata: true,
      parseAllowlistEntry: (raw) => ({ name: raw, wildcard: false }),
      normalizeName: (name) => name,
      satisfies: () => true,
      compareVersions: (a, b) => a.localeCompare(b),
      route: (_method, subpath) => {
        const download = subpath.match(/^-\/tarball\/([^/]+)\/([^/]+)$/);
        return download
          ? { kind: "download", name: download[1], version: download[2], filename: `${download[2]}.tgz` }
          : { kind: "metadata", name: subpath };
      },
      fetchMetadata: async (name) => ({
        name,
        raw: null,
        versions: new Map([
          [
            "1.0.0",
            {
              version: "1.0.0",
              dependencies: [],
              files: [
                {
                  filename: "1.0.0.tgz",
                  version: "1.0.0",
                  upstreamUrl: `https://upstream.test/${name}.tgz`,
                  integrity: null,
                  sizeBytes: null,
                  allowed: true,
                  publishedAt: new Date("2026-01-01T00:00:00Z"),
                },
              ],
            },
          ],
        ]),
      }),
      renderMetadata: () => ({ contentType: "application/json", body: "{}" }),
      resolveDownload: (route, meta) => meta.versions.get(route.version)?.files[0] ?? null,
      workerConfig: () => ({ env: {}, files: [] }),
    };

    async function start() {
      const store = new MemoryRegistryStore();
      store.contexts.set(capabilityHash("rrg_token"), {
        runId: "run-1",
        deadlineAt: new Date(NOW.getTime() + 86_400_000),
        allowlist: { npm: ["react"] },
        policy: {},
        repository: "owner/repo",
        cacheImage: null,
        dependencyCache: false,
        packageAudit: null,
      });
      let upstreamCalls = 0;
      let cancelled: () => void = () => {};
      const upstreamCancelled = new Promise<void>((resolve) => {
        cancelled = resolve;
      });
      const registry = new RegistryService({
        adapters: new Map([["npm", adapter]]),
        store,
        audit: { audit: async () => ({ withheld: () => [], waived: () => [], reported: () => [] }) },
        upstream: async () => {
          upstreamCalls += 1;
          // One chunk, then a stall: only a cancel ends it.
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(64 * 1024));
              },
              cancel: () => cancelled(),
            }),
          );
        },
        proxyBase: "http://wardby-proxy:8787/registry/",
        limits: { maxFileBytes: 10_000_000, maxTotalBytes: 20_000_000, maxFiles: 1, idleTimeoutMs: 60_000 },
        now: () => NOW,
      });
      const server = await startCodingProxyServer(fakeProxy(), { host: "127.0.0.1", port: 0, registry });
      const url = `http://127.0.0.1:${server.port}/registry/npm/-/tarball/react/1.0.0`;
      return { server, store, url, upstreamCancelled, upstreamCalls: () => upstreamCalls };
    }

    const auth = { authorization: "Bearer rrg_token" };

    it("HEAD starts no download and leaves the run's only file slot free", async () => {
      const { server, store, url, upstreamCalls } = await start();
      const head = await fetch(url, { method: "HEAD", headers: auth });
      expect(head.status).toBe(200);
      expect(upstreamCalls()).toBe(0);
      expect(store.fetches).toEqual([]);
      await server.close();
    });

    it("a client that disconnects mid-stream cancels the download and releases its reservation", async () => {
      const { server, store, url, upstreamCancelled } = await start();
      const client = new AbortController();
      const response = await fetch(url, { headers: auth, signal: client.signal });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await reader.read();
      client.abort();
      await upstreamCancelled;
      expect(store.fetches.filter((fetch) => fetch.outcome === "served")).toEqual([]);
      // maxFiles is 1: a leaked reservation would make this a 429.
      const again = new AbortController();
      const second = await fetch(url, { headers: auth, signal: again.signal });
      expect(second.status).toBe(200);
      again.abort();
      await server.close();
    });
  });
});

describe("logProxyAudit", () => {
  it("logs the event under an audit.<type> name with its fields", async () => {
    const { logProxyAudit } = await import("./server.js");
    const info = vi.fn();
    logProxyAudit(
      { type: "request.uncertain", runId: "r1", requestId: "q1", status: 200, reason: "upstream_failed:server_error" },
      { info },
    );
    expect(info).toHaveBeenCalledWith(
      {
        runId: "r1",
        requestId: "q1",
        status: 200,
        reason: "upstream_failed:server_error",
        event: "audit.request.uncertain",
      },
      "coding proxy audit",
    );
  });
});
