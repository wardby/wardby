import type { PrismaClient } from "#prisma";
import { describe, expect, it, vi } from "vitest";
import { CODING_PROXY_ALIAS, CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "../jobs/docker-isolation.js";
import { RegistryService } from "./registry/service.js";
import { createRegistryUpstream, startConfiguredCodingProxy } from "./runtime.js";
import type { CodingProxyServerHandle } from "./server.js";

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
  });
});
