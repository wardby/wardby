import { expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { canonicalUrl, parseBody, readBody } from "./http-limits.js";

function request(headers: Record<string, string> = {}) {
  return Object.assign(new PassThrough(), { headers }) as unknown as IncomingMessage;
}
it.each(["http://public.example/mcp", "https://u:p@host/mcp", "https://host/mcp#x"])("rejects insecure canonical URI %s", (url) => expect(() => canonicalUrl(url)).toThrow());
it("accepts secure canonical and explicit loopback URLs", () => {
  expect(canonicalUrl("https://host:443/mcp").href).toBe("https://host/mcp");
  expect(canonicalUrl("http://127.0.0.1:3000/mcp").port).toBe("3000");
});
it("rejects declared oversized bodies before streaming", async () => {
  await expect(readBody(request({ "content-length": "101" }), 100, new AbortController().signal)).rejects.toMatchObject({ status: 413 });
});
it("rejects chunked overflow and accepts exactly the byte limit", async () => {
  const over = request(); const a = readBody(over, 3, new AbortController().signal);
  (over as unknown as PassThrough).end("four"); await expect(a).rejects.toMatchObject({ status: 413 });
  const exact = request(); const b = readBody(exact, 3, new AbortController().signal);
  (exact as unknown as PassThrough).end("abc"); await expect(b).resolves.toBe("abc");
});
it("aborts an incomplete body and removes listeners", async () => {
  const req = request(); const abort = new AbortController(); const p = readBody(req, 100, abort.signal);
  abort.abort(); await expect(p).rejects.toMatchObject({ status: 408 }); expect(req.listenerCount("data")).toBe(0);
});
it("rejects duplicate form fields, bad encodings, JSON, and content types", () => {
  expect(() => parseBody("a=1&a=2", "application/x-www-form-urlencoded")).toThrow();
  expect(() => parseBody("a=%xx", "application/x-www-form-urlencoded")).toThrow();
  expect(() => parseBody("{", "application/json")).toThrow();
  expect(() => parseBody("{}", "text/plain")).toThrow();
});
