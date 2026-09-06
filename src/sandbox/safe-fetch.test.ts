import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { safeFetch, pinnedLookup, type SafeFetchOptions } from "./safe-fetch.js";
import { isGlobalAddress, resolveDestination, parseAllowedHosts } from "./fetch-policy.js";
import { FETCH_RESPONSE_BYTES } from "./limits.js";
import { gzipSync } from "node:zlib";

function response(status: number, headers: Record<string, string> = {}, chunks: Buffer[] = []): IncomingMessage {
  return Object.assign(Readable.from(chunks), { statusCode: status, statusMessage: "OK", headers }) as unknown as IncomingMessage;
}
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];
it.each(["0.0.0.0", "100.64.1.1", "127.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255", "::", "::1", "::ffff:8.8.8.8", "64:ff9b::1", "2001:db8::1", "2002::1", "3fff::1", "fc00::1", "ff00::1"])("blocks special address %s", (address) => expect(isGlobalAddress(address)).toBe(false));
it.each(["8.8.8.8", "93.184.216.34", "2001:4860:4860::8888", "2606:4700:4700::1111"])("allows global address %s", (address) => expect(isGlobalAddress(address)).toBe(true));
it.each(["file:///etc/passwd", "ftp://public.example", "http://u:p@public.example", "http://2130706433", "http://0x7f000001", "http://127.1"])("rejects alternate or unsafe URL %s", async (url) => await expect(resolveDestination(url)).rejects.toThrow());
it("rejects wildcard/empty allowlist entries and normalizes exact names", () => {
  expect(() => parseAllowedHosts("*.example.com")).toThrow(); expect(() => parseAllowedHosts("a,,b")).toThrow();
  expect(parseAllowedHosts("Example.COM.")).toEqual(["example.com"]);
});
it.each(["http://127.0.0.1", "http://10.1.1.1", "http://[::1]", "http://169.254.169.254"])("blocks public redirect to %s", async (location) => {
  const connect = vi.fn(async () => response(302, { location }));
  await expect(safeFetch("https://public.example", {}, { resolve: publicDns, connect })).rejects.toThrow(/blocked/);
  expect(connect).toHaveBeenCalledTimes(1);
});
it("rejects mixed DNS answers before a connection", async () => {
  const connect = vi.fn();
  await expect(safeFetch("https://public.example", {}, { resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }], connect })).rejects.toThrow(/blocked/);
  expect(connect).not.toHaveBeenCalled();
});
it("pins the vetted DNS address to both Node lookup calling conventions", async () => {
  const resolve = vi.fn(publicDns);
  const destination = await resolveDestination("https://public.example", { resolve });
  const lookup = pinnedLookup(destination) as Function;
  const callback = vi.fn(); lookup("public.example", {}, callback);
  expect(callback).toHaveBeenLastCalledWith(null, "93.184.216.34", 4);
  lookup("public.example", { all: true }, callback);
  expect(callback).toHaveBeenLastCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  expect(resolve).toHaveBeenCalledTimes(1);
});
it("follows public relative redirects and strips all credentials across origins", async () => {
  const connect = vi.fn<NonNullable<SafeFetchOptions["connect"]>>().mockResolvedValueOnce(response(302, { location: "/next" })).mockResolvedValueOnce(response(302, { location: "https://other.example/" })).mockResolvedValueOnce(response(200, {}, [Buffer.from("ok")]));
  const result = await safeFetch("https://public.example/start", { headers: { Authorization: "bearer", Cookie: "cookie", "Proxy-Authorization": "proxy", "X-Api-Key": "secret", Accept: "text/plain" } }, { resolve: publicDns, connect });
  expect(result.bodyBase64).toBe(Buffer.from("ok").toString("base64"));
  expect(connect.mock.calls[1][1].headers?.authorization).toBe("bearer");
  expect(connect.mock.calls[2][1].headers).toEqual({ accept: "text/plain", "accept-encoding": "identity" });
});
it("terminates redirect loops", async () => {
  const connect = vi.fn(async () => response(302, { location: "/loop" }));
  await expect(safeFetch("https://public.example", {}, { resolve: publicDns, connect })).rejects.toThrow(/redirect_limit/);
  expect(connect).toHaveBeenCalledTimes(6);
});
it("bounds streamed and compressed response allocations", async () => {
  for (const zipped of [false, true]) {
    const payload = Buffer.alloc(FETCH_RESPONSE_BYTES + 1, "a");
    const stream = response(200, zipped ? { "content-encoding": "gzip" } : {}, [zipped ? gzipSync(payload) : payload]);
    await expect(safeFetch("https://public.example", {}, { resolve: publicDns, connect: async () => stream })).rejects.toThrow(/response_limit/);
    expect(stream.destroyed).toBe(true);
  }
});
it("aborts an in-flight response when the invocation is cancelled", async () => {
  const abort = new AbortController();
  const stream = Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: {} }) as IncomingMessage;
  const result = safeFetch("https://public.example", {}, { resolve: publicDns, signal: abort.signal, connect: async () => { queueMicrotask(() => abort.abort()); return stream; } });
  await expect(result).rejects.toThrow(/cancelled/); expect(stream.destroyed).toBe(true);
});
it("cancels while DNS resolution is pending", async () => {
  const abort = new AbortController();
  const pending = safeFetch("https://public.example", {}, { resolve: () => new Promise(() => {}), signal: abort.signal });
  abort.abort(); await expect(pending).rejects.toThrow(/cancelled/);
});
