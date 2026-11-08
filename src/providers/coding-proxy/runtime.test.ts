import type { PrismaClient } from "#prisma";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { CODING_PROXY_ALIAS, CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "../jobs/docker-isolation.js";
import { logger } from "../../core/logger.js";
import { MemoryProxyLedger } from "./memory-ledger.js";
import type { CodingProxy, CodingProxyOptions, ProxyResponseSink } from "./proxy.js";
import { DependencyCacheService } from "./dependency-cache/service.js";
import { RunStepForwarder } from "./run-step-forwarder.js";
import { RegistryService } from "./registry/service.js";
import { createRegistryUpstream, loadMcpGatewayUrl, loadRunStepsUrl, startConfiguredCodingProxy } from "./runtime.js";
import type { CodingProxyServerHandle } from "./server.js";
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
        expectedHost: `${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}`,
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
});
