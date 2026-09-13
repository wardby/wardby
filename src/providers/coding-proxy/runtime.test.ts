import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { CODING_PROXY_ALIAS, CODING_PROXY_PORT } from "../jobs/docker-isolation.js";
import type { CodingProxyServerHandle } from "./server.js";
import { startConfiguredCodingProxy } from "./runtime.js";

describe("configured coding proxy runtime", () => {
  it("binds the fixed worker-only endpoint and host header", async () => {
    const handle: CodingProxyServerHandle = { port: CODING_PROXY_PORT, close: async () => {} };
    const startServer = vi.fn(async () => handle);

    await expect(
      startConfiguredCodingProxy({ db: {} as PrismaClient, env: { OPENAI_API_KEY: "test-secret" }, startServer }),
    ).resolves.toBe(handle);

    expect(startServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        host: "0.0.0.0",
        port: CODING_PROXY_PORT,
        expectedHost: `${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}`,
      }),
    );
  });
});
