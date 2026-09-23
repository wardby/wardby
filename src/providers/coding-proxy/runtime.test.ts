import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { CODING_PROXY_ALIAS, CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "../jobs/docker-isolation.js";
import type { CodingProxyServerHandle } from "./server.js";
import { startConfiguredCodingProxy } from "./runtime.js";

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
      }),
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
