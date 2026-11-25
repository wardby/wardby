import type { PrismaClient } from "#prisma";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODING_PROXY_ALIAS, CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "../jobs/docker-isolation.js";
import { logger } from "../../core/logger.js";
import { MemoryProxyLedger } from "./memory-ledger.js";
import type { CodingProxy, CodingProxyOptions, ProxyResponseSink } from "./proxy.js";
import { DependencyCacheService } from "./dependency-cache/service.js";
import { RunStepForwarder } from "./run-step-forwarder.js";
import { RegistryService } from "./registry/service.js";
import {
  createRegistryUpstream,
  loadMcpGatewayUrl,
  loadRunStepsUrl,
  loadSubstrateProxyConfig,
  startConfiguredCodingProxy,
  substrateRunLayoutLookup,
} from "./runtime.js";
import type { CodingProxyServerHandle } from "./server.js";
import { LedgerTunnelAuthenticator } from "./tunnel-auth.js";
import { generateInterceptCa } from "./tunnel-ca.js";
import type { Interceptor } from "./tunnel-intercept.js";
import type { ProxyAuditEvent } from "./types.js";

// Records the options every CodingProxy is constructed with, so a test can see
// what startConfiguredCodingProxy handed it (the instance keeps them private).
const constructed = vi.hoisted(() => [] as CodingProxyOptions[]);
vi.mock("./proxy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./proxy.js")>();
  class RecordingCodingProxy extends actual.CodingProxy {
    constructor(options: CodingProxyOptions) {
      super(options);
      constructed.push(options);
    }
  }
  return { ...actual, CodingProxy: RecordingCodingProxy };
});

describe("configured coding proxy runtime", () => {
  it("binds the fixed worker-only endpoint and host header", async () => {
    const handle: CodingProxyServerHandle = { port: CODING_PROXY_PORT, close: async () => {} };
    const startServer = vi.fn(async () => handle);
    const startDenyPort = vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} }));

    const started = await startConfiguredCodingProxy({
      db: {} as PrismaClient,
      env: { OPENAI_API_KEY: "test-secret" },
      startServer,
      startDenyPort,
    });
    expect(started.port).toBe(handle.port);

    expect(startServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        host: "0.0.0.0",
        port: CODING_PROXY_PORT,
        expectedHosts: [`${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}`],
        registry: expect.any(RegistryService),
      }),
    );
  });

  it("wires the registry service's pinned upstream with the OSV host allowed alongside every adapter's hosts", async () => {
    const handle: CodingProxyServerHandle = { port: CODING_PROXY_PORT, close: async () => {} };
    const startServer = vi.fn(async () => handle);
    const startDenyPort = vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} }));
    let allowedHosts: string[] = [];
    const createPinnedFetch = vi.fn((options: { allowedHosts: string[] }) => {
      allowedHosts = options.allowedHosts;
      return vi.fn(async () => new Response("{}"));
    });

    await startConfiguredCodingProxy({
      db: {} as PrismaClient,
      env: { OPENAI_API_KEY: "test-secret" },
      startServer,
      startDenyPort,
      createPinnedFetch,
    });

    expect(createPinnedFetch).toHaveBeenCalledTimes(1);
    expect(allowedHosts).toEqual(
      expect.arrayContaining(["api.osv.dev", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]),
    );
  });

  it("leases the proxy's requests, and refuses to start when the lease is too short for the heartbeat", async () => {
    const handle: CodingProxyServerHandle = { port: CODING_PROXY_PORT, close: async () => {} };
    const startServer = vi.fn(async () => handle);
    const startDenyPort = vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} }));
    const before = constructed.length;

    await startConfiguredCodingProxy({
      db: {} as PrismaClient,
      env: { OPENAI_API_KEY: "test-secret", CODING_PROXY_LEASE_SECONDS: "60" },
      startServer,
      startDenyPort,
    }).then((started) => started.close());
    expect(constructed[before]).toMatchObject({ leaseMs: 60_000 });

    startServer.mockClear();
    await expect(
      startConfiguredCodingProxy({
        db: {} as PrismaClient,
        env: { OPENAI_API_KEY: "test-secret", CODING_PROXY_LEASE_SECONDS: "20", CODING_PROXY_HEARTBEAT_SECONDS: "10" },
        startServer,
        startDenyPort,
      }),
    ).rejects.toThrow("CODING_PROXY_LEASE_SECONDS must be greater than twice CODING_PROXY_HEARTBEAT_SECONDS.");
    expect(startServer).not.toHaveBeenCalled();
  });

  it("runs the lease sweep until the server has drained, then stops it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const order: string[] = [];
      const handle: CodingProxyServerHandle = {
        port: CODING_PROXY_PORT,
        close: async () => void order.push("server closed"),
      };
      // The database stub has no query methods, so every sweep fails and is reported.
      const onLeaseError = vi.fn((stage: string) => void order.push(`${stage} failed`));
      const started = await startConfiguredCodingProxy({
        db: {} as PrismaClient,
        env: { OPENAI_API_KEY: "test-secret", CODING_PROXY_SWEEP_SECONDS: "15" },
        startServer: vi.fn(async () => handle),
        startDenyPort: vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} })),
        onLeaseError,
      });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(order).toEqual(["sweep failed"]);

      await started.close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(order).toEqual(["sweep failed", "server closed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the deny-port listener alongside the proxy and closes both", async () => {
    const closed: string[] = [];
    const handle: CodingProxyServerHandle = {
      port: CODING_PROXY_PORT,
      close: async () => void closed.push("proxy"),
    };
    const startServer = vi.fn(async () => handle);
    const startDenyPort = vi.fn(async () => ({
      port: CODING_PROXY_DENY_PORT,
      close: async () => void closed.push("deny"),
    }));

    const started = await startConfiguredCodingProxy({
      db: {} as PrismaClient,
      env: { OPENAI_API_KEY: "test-secret" },
      startServer,
      startDenyPort,
    });

    expect(startDenyPort).toHaveBeenCalledWith("0.0.0.0", CODING_PROXY_DENY_PORT);
    expect(started.port).toBe(CODING_PROXY_PORT);
    await started.close();
    expect(closed).toEqual(["deny", "proxy"]);
  });

  it("wires the dependency cache only when it is on and a blob store is configured", async () => {
    const handle: CodingProxyServerHandle = { port: CODING_PROXY_PORT, close: async () => {} };
    const startDenyPort = vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} }));
    const cacheOf = async (env: NodeJS.ProcessEnv) => {
      const startServer = vi.fn(async () => handle);
      const started = await startConfiguredCodingProxy({ db: {} as PrismaClient, env, startServer, startDenyPort });
      await started.close();
      const [proxy, config] = startServer.mock.calls[0] as unknown[];
      return {
        ...(config as { dependencyCache?: unknown }),
        sealsOnModelRequest: (proxy as { onModelRequest?: unknown }).onModelRequest !== undefined,
      };
    };
    const base = { OPENAI_API_KEY: "test-secret" };
    const blob = { BLOB_STORE: "local", BLOB_STORE_LOCAL_DIR: "/tmp/wardby-cache-test" };
    const off = await cacheOf(base);
    expect([off.dependencyCache, off.sealsOnModelRequest]).toEqual([undefined, false]);
    expect((await cacheOf({ ...base, ...blob })).dependencyCache).toBeUndefined();
    const warn = vi.spyOn(logger, "warn");
    expect((await cacheOf({ ...base, WARDBY_DEPENDENCY_CACHE: "true" })).dependencyCache).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "proxy.dependency_cache_no_blob_store" }),
      expect.any(String),
    );
    warn.mockRestore();
    const on = await cacheOf({ ...base, ...blob, WARDBY_DEPENDENCY_CACHE: "true" });
    expect(on.dependencyCache).toBeInstanceOf(DependencyCacheService);
    expect(on.sealsOnModelRequest).toBe(true);
    expect((on.dependencyCache as DependencyCacheService).uploadMs).toBe(900_000);
  });

  it("reads a Substrate run's layout from its row by token: single only when the row says so", async () => {
    const rows: Record<string, { actorShape: string; repositories: unknown }> = {
      "wr-single": { actorShape: "single", repositories: null },
      "wr-pair": { actorShape: "pair", repositories: null },
      "wr-odd": { actorShape: "other", repositories: null },
    };
    const findUnique = vi.fn(async ({ where }: { where: { token: string } }) => rows[where.token] ?? null);
    const lookup = substrateRunLayoutLookup({ substrateRun: { findUnique } } as unknown as PrismaClient);
    expect(await lookup("wr-single")).toEqual({ shape: "single" });
    expect(await lookup("wr-pair")).toEqual({ shape: "pair" });
    expect(await lookup("wr-odd")).toEqual({ shape: "pair" });
    expect(await lookup("wr-missing")).toBeUndefined();
    expect(findUnique).toHaveBeenCalledWith({
      where: { token: "wr-single" },
      select: { actorShape: true, repositories: true, services: true },
    });
  });

  it("reads a Substrate run's services only when they parse", async () => {
    const rows: Record<string, { actorShape: string; repositories: unknown; services: unknown }> = {
      "wr-services": { actorShape: "pair", repositories: null, services: ["postgres"] },
      "wr-bad-services": { actorShape: "pair", repositories: null, services: "x" },
    };
    const findUnique = vi.fn(async ({ where }: { where: { token: string } }) => rows[where.token] ?? null);
    const lookup = substrateRunLayoutLookup({ substrateRun: { findUnique } } as unknown as PrismaClient);
    expect(await lookup("wr-services")).toEqual({ shape: "pair", services: ["postgres"] });
    const bad = await lookup("wr-bad-services");
    expect(bad).toEqual({ shape: "pair" });
    expect(bad).not.toHaveProperty("services");
  });

  it("reads a Substrate run's extra repositories only when they parse", async () => {
    const rows: Record<string, { actorShape: string; repositories: unknown }> = {
      "wr-extras": { actorShape: "pair", repositories: [{ name: "extra-alpha", access: "write" }] },
      "wr-bad-extras": { actorShape: "single", repositories: [{ name: "x", access: "admin" }] },
    };
    const findUnique = vi.fn(async ({ where }: { where: { token: string } }) => rows[where.token] ?? null);
    const lookup = substrateRunLayoutLookup({ substrateRun: { findUnique } } as unknown as PrismaClient);
    expect(await lookup("wr-extras")).toEqual({
      shape: "pair",
      repositories: [{ name: "extra-alpha", access: "write" }],
    });
    const bad = await lookup("wr-bad-extras");
    expect(bad).toEqual({ shape: "single" });
    expect(bad).not.toHaveProperty("repositories");
  });

  it("mounts the Substrate routes only when SUBSTRATE_ATESPACE is set, and names what is missing", async () => {
    const handle: CodingProxyServerHandle = { port: CODING_PROXY_PORT, close: async () => {} };
    const startDenyPort = vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} }));
    const substrateOf = async (env: NodeJS.ProcessEnv) => {
      const startServer = vi.fn(async () => handle);
      const started = await startConfiguredCodingProxy({ db: {} as PrismaClient, env, startServer, startDenyPort });
      await started.close();
      return (startServer.mock.calls[0] as unknown[])[1] as { substrate?: unknown };
    };
    const base = { OPENAI_API_KEY: "test-secret" };
    const blob = { BLOB_STORE: "local", BLOB_STORE_LOCAL_DIR: "/tmp/wardby-substrate-test" };
    expect((await substrateOf(base)).substrate).toBeUndefined();
    const on = {
      ...base,
      ...blob,
      SUBSTRATE_ATESPACE: "wardby-runs",
      SUBSTRATE_ACTOR_JWT_ISSUER: "https://idp.example.invalid",
      SUBSTRATE_PROXY_HOST: "coding-proxy.example.svc.cluster.local",
    };
    expect(typeof (await substrateOf(on)).substrate).toBe("function");
    const hostsOf = async (env: NodeJS.ProcessEnv) =>
      ((await substrateOf(env)) as unknown as { expectedHosts: string[] }).expectedHosts;
    expect(await hostsOf(base)).toEqual(["wardby-proxy:8787"]);
    expect(await hostsOf(on)).toEqual(["wardby-proxy:8787", "coding-proxy.example.svc.cluster.local:8787"]);
    // A Service that maps another port to 8787: the guard accepts the port actors use (same parser as
    // the control plane), and the bare host on port 80, which clients leave out of Host.
    expect(await hostsOf({ ...on, SUBSTRATE_PROXY_PORT: "9000" })).toEqual([
      "wardby-proxy:8787",
      "coding-proxy.example.svc.cluster.local:9000",
    ]);
    expect(await hostsOf({ ...on, SUBSTRATE_PROXY_PORT: "80" })).toEqual([
      "wardby-proxy:8787",
      "coding-proxy.example.svc.cluster.local:80",
      "coding-proxy.example.svc.cluster.local",
    ]);
    for (const bad of ["0", "65536", "8787x", "1.5", "-1"])
      await expect(substrateOf({ ...on, SUBSTRATE_PROXY_PORT: bad })).rejects.toThrow("SUBSTRATE_PROXY_PORT");
    for (const bad of ["", "http://proxy.example", "proxy.example:8787", "proxy.example/x", "a b"])
      await expect(substrateOf({ ...on, SUBSTRATE_PROXY_HOST: bad })).rejects.toThrow("SUBSTRATE_PROXY_HOST");
    await expect(substrateOf({ ...on, SUBSTRATE_ACTOR_JWT_ISSUER: "" })).rejects.toThrow(
      "SUBSTRATE_ACTOR_JWT_ISSUER is required",
    );
    await expect(
      substrateOf({ ...base, SUBSTRATE_ATESPACE: "wardby-runs", SUBSTRATE_ACTOR_JWT_ISSUER: "x:" }),
    ).rejects.toThrow(/BLOB_STORE|valid URL/);
    await expect(substrateOf({ ...on, BLOB_STORE: "" })).rejects.toThrow("BLOB_STORE is required");
    expect(loadSubstrateProxyConfig(on)?.jwksUrl.href).toBe("https://idp.example.invalid/openid/v1/jwks");
    expect(
      loadSubstrateProxyConfig({ ...on, SUBSTRATE_ACTOR_JWKS_URL: "https://keys.example.invalid/jwks" })?.jwksUrl.href,
    ).toBe("https://keys.example.invalid/jwks");
  });

  it("reads SUBSTRATE_WARM_ROUNDS for the substrate routes (off unless true)", () => {
    const on = {
      SUBSTRATE_ATESPACE: "wardby-runs",
      SUBSTRATE_ACTOR_JWT_ISSUER: "https://idp.example.invalid",
      SUBSTRATE_PROXY_HOST: "coding-proxy.example.svc.cluster.local",
      BLOB_STORE: "local",
      BLOB_STORE_LOCAL_DIR: "/tmp/wardby-substrate-test",
    };
    expect(loadSubstrateProxyConfig(on)).not.toHaveProperty("warmRounds");
    expect(loadSubstrateProxyConfig({ ...on, SUBSTRATE_WARM_ROUNDS: "false" })).not.toHaveProperty("warmRounds");
    expect(loadSubstrateProxyConfig({ ...on, SUBSTRATE_WARM_ROUNDS: "true" })?.warmRounds).toBe(true);
    expect(() => loadSubstrateProxyConfig({ ...on, SUBSTRATE_WARM_ROUNDS: "on" })).toThrow("SUBSTRATE_WARM_ROUNDS");
  });

  it("closes the proxy server when the deny port cannot bind", async () => {
    const closed: string[] = [];
    const handle: CodingProxyServerHandle = {
      port: CODING_PROXY_PORT,
      close: async () => void closed.push("proxy"),
    };
    await expect(
      startConfiguredCodingProxy({
        db: {} as PrismaClient,
        env: { OPENAI_API_KEY: "test-secret" },
        startServer: async () => handle,
        startDenyPort: async () => {
          throw new Error("EADDRINUSE");
        },
      }),
    ).rejects.toThrow("EADDRINUSE");
    expect(closed).toEqual(["proxy"]);
  });
});

describe("configured coding proxy runtime: /mcp", () => {
  const handle: CodingProxyServerHandle = { port: CODING_PROXY_PORT, close: async () => {} };
  const startDenyPort = async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} });
  /** Starts the runtime and answers one POST /mcp with no token through the route it wired. */
  const mcpStatus = async (env: NodeJS.ProcessEnv) => {
    const startServer = vi.fn(async () => handle);
    await startConfiguredCodingProxy({ db: {} as PrismaClient, env, startServer, startDenyPort });
    const config = (startServer.mock.calls[0] as unknown as [unknown, { mcp?: unknown }])[1];
    expect(config.mcp).toEqual(expect.any(Function));
    const route = config.mcp as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    const res = { statusCode: 0, headersSent: false, writableFinished: false } as unknown as ServerResponse;
    Object.assign(res, {
      setHeader: () => res,
      writeHead: (status: number) => Object.assign(res, { statusCode: status, headersSent: true }),
      end: () => res,
    });
    await route({ method: "POST", headers: {}, complete: true } as unknown as IncomingMessage, res);
    return res.statusCode;
  };

  it("wires /mcp; without WARDBY_MCP_GATEWAY_URL it answers 503", async () => {
    expect(await mcpStatus({ OPENAI_API_KEY: "test-secret" })).toBe(503);
  });

  it("with WARDBY_MCP_GATEWAY_URL, /mcp checks the token (401 without one)", async () => {
    expect(
      await mcpStatus({ OPENAI_API_KEY: "test-secret", WARDBY_MCP_GATEWAY_URL: "http://wardby-gateway:8790/" }),
    ).toBe(401);
  });

  it.each(["not a url", "ftp://gateway", "http://user:pass@gateway", "http://gateway?x=1", "http://gateway#x"])(
    "refuses to start with WARDBY_MCP_GATEWAY_URL=%j, without echoing it",
    async (value) => {
      const startServer = vi.fn(async () => handle);
      const start = startConfiguredCodingProxy({
        db: {} as PrismaClient,
        env: { OPENAI_API_KEY: "test-secret", WARDBY_MCP_GATEWAY_URL: value },
        startServer,
        startDenyPort,
      });
      await expect(start).rejects.toThrow("WARDBY_MCP_GATEWAY_URL must be an http(s) URL");
      await expect(start).rejects.not.toThrow(value);
      expect(startServer).not.toHaveBeenCalled();
    },
  );

  it("normalizes the gateway URL", () => {
    expect(loadMcpGatewayUrl({})).toBeUndefined();
    expect(loadMcpGatewayUrl({ WARDBY_MCP_GATEWAY_URL: "  " })).toBeUndefined();
    expect(loadMcpGatewayUrl({ WARDBY_MCP_GATEWAY_URL: "https://gw.internal:8790/" })).toBe("https://gw.internal:8790");
    expect(loadMcpGatewayUrl({ WARDBY_MCP_GATEWAY_URL: "http://gw:8790/base/" })).toBe("http://gw:8790/base");
  });
});

describe("createRegistryUpstream", () => {
  it("maps accept to a header, sends json content-type only when a body is present, and forwards method/signal/redirect", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const pinned = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;
    const upstream = createRegistryUpstream(pinned);
    const signal = new AbortController().signal;

    await upstream("https://api.osv.dev/v1/query", {
      method: "POST",
      accept: "application/json",
      body: '{"package":{"name":"left-pad"}}',
      signal,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.osv.dev/v1/query");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.redirect).toBe("error");
    expect(calls[0].init.signal).toBe(signal);
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("omits content-type for a bodyless GET and defaults to method GET", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const pinned = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;
    const upstream = createRegistryUpstream(pinned);

    await upstream("https://registry.npmjs.org/left-pad", { accept: "application/json" });

    expect(calls[0].init.method).toBe("GET");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.has("content-type")).toBe(false);
    expect(headers.has("accept-encoding")).toBe(false);

    // A caller that decompresses itself (lockfile plans stream packuments) asks for gzip.
    await upstream("https://registry.npmjs.org/left-pad", { accept: "application/json", acceptEncoding: "gzip" });
    expect(new Headers(calls[1].init.headers).get("accept-encoding")).toBe("gzip");
  });
});

describe("configured coding proxy runtime: database pools", () => {
  it("gives the package registry its own client, so registry traffic cannot starve the ledger's pool", async () => {
    const handle: CodingProxyServerHandle = { port: CODING_PROXY_PORT, close: async () => {} };
    const startServer = vi.fn(async () => handle);
    const startDenyPort = vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} }));
    const db = { name: "ledger" } as unknown as PrismaClient;
    const registryDb = { name: "registry" } as unknown as PrismaClient;

    await startConfiguredCodingProxy({ db, registryDb, env: {}, startServer, startDenyPort });

    const calls = startServer.mock.calls as unknown as [unknown, { registry: RegistryService }][];
    const registry = calls[0][1].registry as unknown as { options: { store: { db: unknown } } };
    expect(registry.options.store.db).toBe(registryDb);
  });
});

describe("configured coding proxy runtime: load-test mock upstream", () => {
  const MOCK_ENV = {
    OPENAI_API_KEY: "test-secret",
    WARDBY_LOAD_TEST: "1",
    WARDBY_CODING_PROXY_MOCK_UPSTREAM: "1",
    WARDBY_LOAD_MOCK_LATENCY_MS: "0",
  };

  async function start(env: NodeJS.ProcessEnv) {
    constructed.length = 0;
    const events: ProxyAuditEvent[] = [];
    let proxy: CodingProxy | undefined;
    const handle: CodingProxyServerHandle = { port: CODING_PROXY_PORT, close: async () => {} };
    const startServer = vi.fn(async (built: CodingProxy) => {
      proxy = built;
      return handle;
    });
    const startDenyPort = vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} }));
    const createPinnedFetch = vi.fn(() => vi.fn(async () => new Response("{}")));
    await startConfiguredCodingProxy({
      db: {} as PrismaClient,
      env,
      startServer,
      startDenyPort,
      createPinnedFetch,
      audit: (event) => events.push(event),
    });
    expect(constructed).toHaveLength(1);
    // The ledger is built from the Prisma client; swap in the in-memory one so a
    // request can run through the constructed proxy without a database.
    (proxy as unknown as { ledger: MemoryProxyLedger }).ledger = new MemoryProxyLedger();
    return { proxy: proxy!, options: constructed[0], events, createPinnedFetch };
  }

  async function oneRequest(proxy: CodingProxy) {
    const session = await proxy.createSession({
      runId: "run-load-1",
      credentialRef: "env:OPENAI_API_KEY",
      protocol: "openai-responses",
      allowedModels: ["gpt-5.6-luna"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 1,
    });
    const chunks: Buffer[] = [];
    const sink: ProxyResponseSink & { status?: number } = {
      start(status: number) {
        sink.status = status;
      },
      write: (chunk: Uint8Array) => void chunks.push(Buffer.from(chunk)),
      end: () => {},
      destroy: () => {},
    };
    await proxy.execute(
      {
        bearer: session.capability,
        protocol: session.protocol,
        rawBody: JSON.stringify({
          model: "gpt-5.6-luna",
          stream: true,
          input: "Task:\nx\n\nThe final JSON runId must be run-load-1.",
        }),
        requestKey: "k1",
      },
      sink,
    );
    return { status: sink.status, text: Buffer.concat(chunks).toString("utf8") };
  }

  it("with both switches set, hands the proxy the mock fetch, warns, and tags every audit event", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
    try {
      const { proxy, options, events } = await start(MOCK_ENV);
      expect(options.fetch).toEqual(expect.any(Function));
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: "proxy.mock_upstream_enabled" }),
        expect.stringContaining("MOCK MODEL UPSTREAM ENABLED"),
      );

      const { status, text } = await oneRequest(proxy);
      expect(status).toBe(200);
      expect(text).toContain("resp_mock_run-load-1");
      expect(text).toContain("no_changes");
      expect(network).not.toHaveBeenCalled();

      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining(["session.created", "request.reserved", "response.completed"]),
      );
      for (const event of events) expect(event.mockUpstream).toBe(true);
    } finally {
      warn.mockRestore();
      network.mockRestore();
    }
  });

  it("refuses to start with only the mock switch set", async () => {
    await expect(
      startConfiguredCodingProxy({
        db: {} as PrismaClient,
        env: { WARDBY_CODING_PROXY_MOCK_UPSTREAM: "1" },
        startServer: vi.fn(async () => ({ port: CODING_PROXY_PORT, close: async () => {} })),
        startDenyPort: vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} })),
      }),
    ).rejects.toThrow(/^mock_upstream_guard:/);
  });

  it("refuses to start with only the load-test switch set, before any listener starts", async () => {
    const startServer = vi.fn(async () => ({ port: CODING_PROXY_PORT, close: async () => {} }));
    await expect(
      startConfiguredCodingProxy({
        db: {} as PrismaClient,
        env: { WARDBY_LOAD_TEST: "1" },
        startServer,
        startDenyPort: vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} })),
      }),
    ).rejects.toThrow(/^mock_upstream_guard:/);
    expect(startServer).not.toHaveBeenCalled();
  });

  it("with neither switch, passes no fetch, does not warn, and leaves audit events untagged", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const { proxy, options, events } = await start({ OPENAI_API_KEY: "test-secret" });
      expect(options).not.toHaveProperty("fetch");
      expect(warn).not.toHaveBeenCalled();
      await proxy.createSession({
        runId: "run-real-1",
        credentialRef: "env:OPENAI_API_KEY",
        protocol: "openai-responses",
        allowedModels: ["gpt-5.6-luna"],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
      });
      expect(events).toEqual([expect.objectContaining({ type: "session.created" })]);
      for (const event of events) expect(event).not.toHaveProperty("mockUpstream");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createRegistryUpstream with an upstream credential", () => {
  const credentials = { host: "example.jfrog.io", authorization: "Basic c3ZjOnB3" };
  const capture = () => {
    const seen: { url: string; headers: Headers }[] = [];
    const pinned = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: new Headers(init?.headers) });
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;
    return { seen, upstream: createRegistryUpstream(pinned, credentials) };
  };

  it("sends the credential to the JFrog host only, never to public registries or OSV", async () => {
    const { seen, upstream } = capture();
    await upstream("https://example.jfrog.io/acme/api/npm/npm-local/@acme%2fui");
    await upstream("https://registry.npmjs.org/left-pad");
    await upstream("https://pypi.org/simple/requests/");
    await upstream("https://api.osv.dev/v1/query", { method: "POST", body: "{}" });
    await upstream("https://example.jfrog.io.evil.test/x");
    expect(seen.map((call) => call.headers.get("authorization"))).toEqual(["Basic c3ZjOnB3", null, null, null, null]);
  });

  it("sends no authorization header without a credential", async () => {
    const seen: Headers[] = [];
    const pinned = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;
    await createRegistryUpstream(pinned)("https://example.jfrog.io/x");
    expect(seen[0].has("authorization")).toBe(false);
  });
});

describe("createRegistryUpstream redirect following", () => {
  const credentials = { host: "example.jfrog.io", authorization: "Basic c3ZjOnB3" };
  const file = "https://example.jfrog.io/acme/api/pypi/pypi/packages/packages/ab/cd/x-1.0-py3-none-any.whl";
  const redirect = (location: string | null, status = 302) =>
    new Response(null, { status, headers: location ? { location } : {} });

  const setup = (first: Response, second: Response = new Response("wheel")) => {
    const calls: { fetcher: "pinned" | "redirect"; url: string; init?: RequestInit }[] = [];
    const pinned = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ fetcher: "pinned", url, init });
      return first;
    }) as unknown as typeof globalThis.fetch;
    const redirectFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ fetcher: "redirect", url, init });
      return second;
    }) as unknown as typeof globalThis.fetch;
    return { calls, upstream: createRegistryUpstream(pinned, credentials, redirectFetch) };
  };

  it("follows one redirect from JFrog to the target, without the credential", async () => {
    const { calls, upstream } = setup(redirect("https://storage.googleapis.com/bucket/x.whl?X-Goog-Signature=abc"));
    const response = await upstream(file, { accept: "application/octet-stream" });
    expect(await response.text()).toBe("wheel");
    expect(calls.map((call) => call.fetcher)).toEqual(["pinned", "redirect"]);
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Basic c3ZjOnB3");
    expect(calls[0].init?.redirect).toBe("manual");
    expect(calls[1].url).toBe("https://storage.googleapis.com/bucket/x.whl?X-Goog-Signature=abc");
    expect(new Headers(calls[1].init?.headers).has("authorization")).toBe(false);
    expect(new Headers(calls[1].init?.headers).get("accept")).toBe("application/octet-stream");
    expect(calls[1].init?.redirect).toBe("error");
  });

  it("resolves a relative Location against the JFrog URL", async () => {
    const { calls, upstream } = setup(redirect("/other/path/x.whl"));
    await upstream(file);
    expect(calls[1].url).toBe("https://example.jfrog.io/other/path/x.whl");
  });

  it.each([
    ["a plain-http target", "http://storage.googleapis.com/x.whl"],
    ["a target with embedded credentials", "https://user:pw@storage.googleapis.com/x.whl"],
    ["no Location header", null],
  ])("refuses a redirect with %s", async (_label, location) => {
    const { calls, upstream } = setup(redirect(location));
    await expect(upstream(file)).rejects.toThrow("proxy_egress_blocked");
    expect(calls.map((call) => call.fetcher)).toEqual(["pinned"]);
  });

  it("does not follow redirects for other hosts, for non-GET requests, or without a redirect fetch", async () => {
    const other = setup(redirect("https://storage.googleapis.com/x"));
    await other.upstream("https://registry.npmjs.org/left-pad");
    expect(other.calls[0].init?.redirect).toBe("error");

    const post = setup(redirect("https://storage.googleapis.com/x"));
    await post.upstream(file, { method: "POST", body: "{}" });
    expect(post.calls[0].init?.redirect).toBe("error");

    const seen: RequestInit[] = [];
    const pinned = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;
    await createRegistryUpstream(pinned, credentials)(file);
    expect(seen[0].redirect).toBe("error");
  });

  it("returns a non-redirect response from JFrog untouched", async () => {
    const { calls, upstream } = setup(new Response("index"));
    expect(await (await upstream(file)).text()).toBe("index");
    expect(calls.map((call) => call.fetcher)).toEqual(["pinned"]);
  });
});

describe("configured coding proxy runtime with a JFrog registry", () => {
  const jfrogEnv = {
    OPENAI_API_KEY: "test-secret",
    REGISTRY_JFROG_URL: "https://example.jfrog.io/acme",
    REGISTRY_JFROG_NPM_REPO: "npm-local",
    REGISTRY_JFROG_NPM_SCOPES: "@acme",
    REGISTRY_JFROG_PYPI_REPO: "pypi",
    REGISTRY_UPSTREAM_USERNAME: "env:JFROG_USER",
    REGISTRY_UPSTREAM_PASSWORD: "env:JFROG_PASS",
    JFROG_USER: "svc",
    JFROG_PASS: "s3cret",
  };
  const start = (
    env: Record<string, string>,
    createPinnedFetch: (options: { allowedHosts: string[] }) => typeof globalThis.fetch = () =>
      vi.fn(async () => new Response("{}")),
  ) => {
    const startServer = vi.fn(async () => ({ port: CODING_PROXY_PORT, close: async () => {} }));
    const startDenyPort = vi.fn(async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} }));
    return {
      startServer,
      createPinnedFetch,
      started: startConfiguredCodingProxy({
        db: {} as PrismaClient,
        env,
        startServer,
        startDenyPort,
        createPinnedFetch,
      }),
    };
  };

  it("allows the JFrog host alongside public npm and OSV, and no longer allows the public PyPI hosts", async () => {
    const built: { allowedHosts: string[]; anyPublicHost?: boolean }[] = [];
    const createPinnedFetch = vi.fn((options: { allowedHosts: string[]; anyPublicHost?: boolean }) => {
      built.push(options);
      return vi.fn(async () => new Response("{}"));
    });
    await start(jfrogEnv, createPinnedFetch).started;
    const strict = built.filter((options) => !options.anyPublicHost);
    expect(strict).toHaveLength(1);
    const allowedHosts = strict[0].allowedHosts;
    expect(allowedHosts).toEqual(expect.arrayContaining(["api.osv.dev", "registry.npmjs.org", "example.jfrog.io"]));
    expect(allowedHosts).not.toContain("pypi.org");
    expect(allowedHosts).not.toContain("files.pythonhosted.org");
  });

  it("builds a second, redirect-only fetch for JFrog downloads, never with OSV or the credential's hosts widened", async () => {
    const built: { allowedHosts: string[]; anyPublicHost?: boolean }[] = [];
    const createPinnedFetch = vi.fn((options: { allowedHosts: string[]; anyPublicHost?: boolean }) => {
      built.push(options);
      return vi.fn(async () => new Response("{}"));
    });
    await start(jfrogEnv, createPinnedFetch).started;
    const open = built.filter((options) => options.anyPublicHost);
    expect(open).toHaveLength(1);
    expect(open[0].allowedHosts).not.toContain("api.osv.dev");
  });

  it("builds no redirect fetch without a JFrog registry", async () => {
    const built: { anyPublicHost?: boolean }[] = [];
    const createPinnedFetch = vi.fn((options: { allowedHosts: string[]; anyPublicHost?: boolean }) => {
      built.push(options);
      return vi.fn(async () => new Response("{}"));
    });
    await start({ OPENAI_API_KEY: "test-secret" }, createPinnedFetch).started;
    expect(built.some((options) => options.anyPublicHost)).toBe(false);
  });

  it.each([
    ["an invalid setting", { ...jfrogEnv, REGISTRY_JFROG_URL: "http://example.jfrog.io/acme" }],
    ["a missing credential", { ...jfrogEnv, REGISTRY_UPSTREAM_PASSWORD: undefined }],
    ["a credential reference to an unset variable", { ...jfrogEnv, JFROG_PASS: undefined }],
    [
      "a credential with no repo configured",
      { OPENAI_API_KEY: "x", REGISTRY_UPSTREAM_USERNAME: "env:A", REGISTRY_UPSTREAM_PASSWORD: "env:B" },
    ],
  ])("fails before listening on %s", async (_label, env) => {
    const { started, startServer } = start(env as Record<string, string>);
    await expect(started).rejects.toThrow(/registry_jfrog_config_invalid/);
    expect(startServer).not.toHaveBeenCalled();
  });
});

describe("loadRunStepsUrl", () => {
  it("is unset by default and keeps an http(s) origin", () => {
    expect(loadRunStepsUrl({})).toBeUndefined();
    expect(loadRunStepsUrl({ WARDBY_RUN_STEPS_URL: " " })).toBeUndefined();
    expect(loadRunStepsUrl({ WARDBY_RUN_STEPS_URL: "http://wardby-control-plane-internal:8792" })).toBe(
      "http://wardby-control-plane-internal:8792",
    );
    expect(loadRunStepsUrl({ WARDBY_RUN_STEPS_URL: "http://host.docker.internal:8792/" })).toBe(
      "http://host.docker.internal:8792",
    );
  });

  it.each(["ftp://cp:8792", "http://user:pass@cp:8792", "http://cp:8792/steps", "http://cp:8792/?q=1", "not a url"])(
    "refuses %s without echoing it",
    (value) => {
      expect(() => loadRunStepsUrl({ WARDBY_RUN_STEPS_URL: value })).toThrow(
        "WARDBY_RUN_STEPS_URL must be an http(s) URL without credentials, path, query or fragment",
      );
      expect(() => loadRunStepsUrl({ WARDBY_RUN_STEPS_URL: value })).not.toThrow(value);
    },
  );
});

describe("configured coding proxy runtime: run steps", () => {
  const startDenyPort = async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} });
  const start = async (env: NodeJS.ProcessEnv) => {
    constructed.length = 0;
    const startServer = vi.fn(async () => ({ port: CODING_PROXY_PORT, close: async () => {} }));
    const handle = await startConfiguredCodingProxy({ db: {} as PrismaClient, env, startServer, startDenyPort });
    return { handle, startServer, options: constructed[constructed.length - 1] };
  };

  it("builds a forwarder when WARDBY_RUN_STEPS_URL is set, and shutdown closes it", async () => {
    const close = vi.spyOn(RunStepForwarder.prototype, "close").mockResolvedValue();
    try {
      const { handle, options } = await start({ WARDBY_RUN_STEPS_URL: "http://cp:8792" });
      expect(options.steps).toBeInstanceOf(RunStepForwarder);
      expect(close).not.toHaveBeenCalled();
      await handle.close();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  it("builds none when it is unset", async () => {
    const close = vi.spyOn(RunStepForwarder.prototype, "close").mockResolvedValue();
    try {
      const { handle, options } = await start({});
      expect(options.steps).toBeUndefined();
      await handle.close();
      expect(close).not.toHaveBeenCalled();
    } finally {
      close.mockRestore();
    }
  });

  it("an invalid value stops start-up naming the variable, without echoing it", async () => {
    const startServer = vi.fn(async () => ({ port: CODING_PROXY_PORT, close: async () => {} }));
    const secretUrl = "http://user:fake-secret-pw@cp:8792";
    const result = startConfiguredCodingProxy({
      db: {} as PrismaClient,
      env: { WARDBY_RUN_STEPS_URL: secretUrl },
      startServer,
      startDenyPort,
    });
    await expect(result).rejects.toThrow("WARDBY_RUN_STEPS_URL");
    await expect(result).rejects.not.toThrow("fake-secret-pw");
    expect(startServer).not.toHaveBeenCalled();
  });

  it("an invalid CODING_TUNNEL_* setting stops start-up before anything listens, without echoing it", async () => {
    const startServer = vi.fn(async () => ({ port: CODING_PROXY_PORT, close: async () => {} }));
    const secret = "fake-secret-host-value";
    for (const env of [
      { CODING_TUNNEL_PORT: "8789", CODING_TUNNEL_ALLOWED_HOSTS: `https://u:${secret}@h.example.com` },
      { CODING_TUNNEL_PORT: "8789" },
      { CODING_TUNNEL_ALLOWED_HOSTS: "ghcr.io" },
    ]) {
      const result = startConfiguredCodingProxy({ db: {} as PrismaClient, env, startServer, startDenyPort });
      await expect(result).rejects.toThrow("CODING_TUNNEL_");
      await expect(result).rejects.not.toThrow(secret);
    }
    expect(startServer).not.toHaveBeenCalled();
  });

  describe("CONNECT tunnel", () => {
    const tunnelEnv = { CODING_TUNNEL_PORT: "8789", CODING_TUNNEL_ALLOWED_HOSTS: "registry.example.com" };
    const authenticator = { authenticate: vi.fn(), isActive: vi.fn() };

    it("is not started when CODING_TUNNEL_PORT is unset", async () => {
      const startTunnel = vi.fn();
      const handle = await startConfiguredCodingProxy({
        db: {} as PrismaClient,
        env: {},
        startServer: vi.fn(async () => ({ port: CODING_PROXY_PORT, close: async () => {} })),
        startDenyPort,
        startTunnel,
      });
      await handle.close();
      expect(startTunnel).not.toHaveBeenCalled();
    });

    it("authenticates against the session ledger unless told otherwise", async () => {
      const startTunnel = vi.fn(async () => ({ port: 8789, close: async () => {} }));
      const handle = await startConfiguredCodingProxy({
        db: {} as PrismaClient,
        env: tunnelEnv,
        startServer: vi.fn(async () => ({ port: CODING_PROXY_PORT, close: async () => {} })),
        startDenyPort,
        startTunnel,
      });
      await handle.close();
      expect(startTunnel).toHaveBeenCalledWith(
        expect.objectContaining({ authenticator: expect.any(LedgerTunnelAuthenticator) }),
      );
    });

    it("starts the tunnel on its own port with the configured settings, and closes it first", async () => {
      const order: string[] = [];
      const startTunnel = vi.fn(async () => ({
        port: 8789,
        close: async () => void order.push("tunnel"),
      }));
      const audit = vi.fn();
      const onRequest = vi.fn();
      const handle = await startConfiguredCodingProxy({
        db: {} as PrismaClient,
        env: { ...tunnelEnv, CODING_TUNNEL_MAX_CONNECTIONS: "3" },
        startServer: vi.fn(async () => ({ port: CODING_PROXY_PORT, close: async () => void order.push("server") })),
        startDenyPort: vi.fn(async () => ({
          port: CODING_PROXY_DENY_PORT,
          close: async () => void order.push("deny"),
        })),
        tunnelAuthenticator: authenticator,
        tunnelAudit: audit,
        onRequest,
        startTunnel,
      });
      expect(startTunnel).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "0.0.0.0",
          config: expect.objectContaining({
            port: 8789,
            allowedHosts: ["registry.example.com"],
            maxConnections: 3,
          }),
          authenticator,
          audit,
          onRequest,
        }),
      );
      await handle.close();
      expect(order).toEqual(["tunnel", "deny", "server"]);
    });

    it("stops the proxy it already started when the tunnel cannot listen", async () => {
      const closed: string[] = [];
      await expect(
        startConfiguredCodingProxy({
          db: {} as PrismaClient,
          env: tunnelEnv,
          startServer: vi.fn(async () => ({ port: CODING_PROXY_PORT, close: async () => void closed.push("server") })),
          startDenyPort: vi.fn(async () => ({
            port: CODING_PROXY_DENY_PORT,
            close: async () => void closed.push("deny"),
          })),
          tunnelAuthenticator: authenticator,
          startTunnel: vi.fn(async () => {
            throw new Error("listen EADDRINUSE");
          }),
        }),
      ).rejects.toThrow("EADDRINUSE");
      expect(closed).toEqual(["deny", "server"]);
    });

    describe("TLS interception", () => {
      let directory: string;
      let interceptEnv: Record<string, string>;

      beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "runtime-intercept-"));
        const ca = await generateInterceptCa({ hosts: ["registry.example.com"] });
        await writeFile(join(directory, "ca.crt"), ca.certificatePem);
        await writeFile(join(directory, "ca.key"), ca.privateKeyPem);
        interceptEnv = {
          ...tunnelEnv,
          CODING_TUNNEL_INTERCEPT_RULES: JSON.stringify([
            { host: "registry.example.com", scheme: "bearer", credential: "env:FAKE_REGISTRY_CREDENTIAL" },
          ]),
          CODING_TUNNEL_INTERCEPT_CA_CERT_FILE: join(directory, "ca.crt"),
          CODING_TUNNEL_INTERCEPT_CA_KEY_FILE: join(directory, "ca.key"),
        };
      });

      afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
      });

      it("gives the tunnel an interceptor for the rules' hosts", async () => {
        const startTunnel = vi.fn(async () => ({ port: 8789, close: async () => {} }));
        const handle = await startConfiguredCodingProxy({
          db: {} as PrismaClient,
          env: { ...interceptEnv, FAKE_REGISTRY_CREDENTIAL: "fake-credential-value" },
          startServer: vi.fn(async () => ({ port: CODING_PROXY_PORT, close: async () => {} })),
          startDenyPort,
          tunnelAuthenticator: authenticator,
          startTunnel,
        });
        await handle.close();
        const [{ interceptor }] = startTunnel.mock.calls[0] as unknown as [{ interceptor?: Interceptor }];
        expect([...(interceptor?.hosts ?? [])]).toEqual(["registry.example.com"]);
      });

      it("stops start-up, closing what it started, when a credential is unset, naming only the variable", async () => {
        const closed: string[] = [];
        const startTunnel = vi.fn();
        await expect(
          startConfiguredCodingProxy({
            db: {} as PrismaClient,
            env: interceptEnv,
            startServer: vi.fn(async () => ({
              port: CODING_PROXY_PORT,
              close: async () => void closed.push("server"),
            })),
            startDenyPort: vi.fn(async () => ({
              port: CODING_PROXY_DENY_PORT,
              close: async () => void closed.push("deny"),
            })),
            tunnelAuthenticator: authenticator,
            startTunnel,
          }),
        ).rejects.toThrow("FAKE_REGISTRY_CREDENTIAL, which is not set");
        expect(startTunnel).not.toHaveBeenCalled();
        expect(closed).toEqual(["deny", "server"]);
      });
    });
  });

  it("builds none when WARDBY_RUN_STEPS is off, and builds one at the default and at detail", async () => {
    const close = vi.spyOn(RunStepForwarder.prototype, "close").mockResolvedValue();
    try {
      const url = "http://cp:8792";
      const off = await start({ WARDBY_RUN_STEPS_URL: url, WARDBY_RUN_STEPS: "off" });
      expect(off.options.steps).toBeUndefined();
      await off.handle.close();
      expect(close).not.toHaveBeenCalled();
      for (const level of [undefined, "summary", "detail"]) {
        const on = await start({ WARDBY_RUN_STEPS_URL: url, ...(level ? { WARDBY_RUN_STEPS: level } : {}) });
        expect(on.options.steps).toBeInstanceOf(RunStepForwarder);
      }
    } finally {
      close.mockRestore();
    }
  });

  it("an invalid WARDBY_RUN_STEPS stops start-up", async () => {
    const startServer = vi.fn(async () => ({ port: CODING_PROXY_PORT, close: async () => {} }));
    await expect(
      startConfiguredCodingProxy({
        db: {} as PrismaClient,
        env: { WARDBY_RUN_STEPS_URL: "http://cp:8792", WARDBY_RUN_STEPS: "bogus" },
        startServer,
        startDenyPort,
      }),
    ).rejects.toThrow("WARDBY_RUN_STEPS");
    expect(startServer).not.toHaveBeenCalled();
  });

  it("closes the forwarder when the server fails to start", async () => {
    const close = vi.spyOn(RunStepForwarder.prototype, "close").mockResolvedValue();
    try {
      await expect(
        startConfiguredCodingProxy({
          db: {} as PrismaClient,
          env: { WARDBY_RUN_STEPS_URL: "http://cp:8792" },
          startServer: async () => {
            throw new Error("bind failed");
          },
          startDenyPort,
        }),
      ).rejects.toThrow("bind failed");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  it("closes the forwarder even when the server's close throws", async () => {
    const close = vi.spyOn(RunStepForwarder.prototype, "close").mockResolvedValue();
    try {
      const handle = await startConfiguredCodingProxy({
        db: {} as PrismaClient,
        env: { WARDBY_RUN_STEPS_URL: "http://cp:8792" },
        startServer: async () => ({
          port: CODING_PROXY_PORT,
          close: async () => {
            throw new Error("close failed");
          },
        }),
        startDenyPort,
      });
      await expect(handle.close()).rejects.toThrow("close failed");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  it("closes the forwarder when the deny port fails to start", async () => {
    const close = vi.spyOn(RunStepForwarder.prototype, "close").mockResolvedValue();
    try {
      await expect(
        startConfiguredCodingProxy({
          db: {} as PrismaClient,
          env: { WARDBY_RUN_STEPS_URL: "http://cp:8792" },
          startServer: async () => ({
            port: CODING_PROXY_PORT,
            close: async () => {
              throw new Error("close failed");
            },
          }),
          startDenyPort: async () => {
            throw new Error("deny failed");
          },
        }),
      ).rejects.toThrow("close failed");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });
});
