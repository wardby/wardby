import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createPinnedProxyFetch, type PinnedProxyFetchOptions } from "./secure-fetch.js";

function response(status: number, headers: Record<string, string> = {}, chunks: Buffer[] = []): IncomingMessage {
  return Object.assign(Readable.from(chunks), {
    statusCode: status,
    statusMessage: "OK",
    headers,
  }) as unknown as IncomingMessage;
}

describe("pinned coding-proxy egress", () => {
  it("connects to the single vetted DNS address without a second lookup", async () => {
    const resolve = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const connect = vi.fn<NonNullable<PinnedProxyFetchOptions["connect"]>>(async () =>
      response(200, { "content-type": "application/json" }, [Buffer.from("ok")]),
    );
    const fetch = createPinnedProxyFetch({ allowedHosts: ["api.example.com"], resolve, connect });

    const result = await fetch("https://api.example.com/v1/responses", { method: "POST", body: "{}" });

    expect(await result.text()).toBe("ok");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0][0]).toMatchObject({ hostname: "api.example.com", address: "93.184.216.34" });
  });

  it.each([
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "10.0.0.1", family: 4 }],
    [
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.1", family: 4 },
    ],
  ])("rejects private, metadata, and mixed DNS answers", async (...addresses) => {
    const connect = vi.fn();
    const fetch = createPinnedProxyFetch({
      allowedHosts: ["api.example.com"],
      resolve: async () => addresses.flat(),
      connect,
    });
    await expect(fetch("https://api.example.com/v1/responses")).rejects.toThrow("proxy_egress_blocked");
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    "http://api.example.com/v1/responses",
    "https://other.example.com/v1/responses",
    "https://93.184.216.34/v1/responses",
  ])("rejects an unsafe destination: %s", async (url) => {
    const fetch = createPinnedProxyFetch({
      allowedHosts: ["api.example.com"],
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      connect: vi.fn(),
    });
    await expect(fetch(url)).rejects.toThrow("proxy_egress_blocked");
  });

  it("denies redirects without resolving or connecting to the target", async () => {
    const redirect = response(302, { location: "https://api.example.com/redirected" });
    const resolve = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const connect = vi.fn(async () => redirect);
    const fetch = createPinnedProxyFetch({ allowedHosts: ["api.example.com"], resolve, connect });

    await expect(fetch("https://api.example.com/v1/responses", { redirect: "error" })).rejects.toThrow(
      "proxy_egress_blocked",
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(redirect.destroyed).toBe(true);
  });
});
