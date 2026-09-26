import { request } from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildMcpServer } from "../server.js";
import { startHttpServer, type HttpServerHandle } from "./streamable-http.js";
import type { AuthProvider } from "../../providers/auth/types.js";
import type { PrismaClient } from "#prisma";
import type { McpProviders } from "../context.js";

let server: HttpServerHandle;
const verify = vi.fn(async () => {
  throw new Error("SECRET_DATABASE_DETAIL");
});
beforeAll(async () => {
  const db = {} as PrismaClient;
  const providers = {} as McpProviders;
  const mcp = buildMcpServer({ db, providers, config: { canonicalUri: "https://host/mcp" } });
  server = await startHttpServer({
    mcp,
    config: {
      canonicalUri: "https://host/mcp",
      httpBind: { host: "127.0.0.1", port: 0 },
      authProviderKind: "delegating",
      authorizationServer: "https://issuer.example",
      allowedOrigins: ["https://client.example"],
    },
    auth: { db, providers, authProvider: { verifyBearer: verify } as unknown as AuthProvider },
  });
});
afterAll(async () => server.close());
function send(
  path: string,
  opts: {
    host?: string | string[];
    origin?: string;
    body?: string;
    declaredLength?: number;
    chunked?: boolean;
    slow?: boolean;
    contentType?: string;
    authorization?: string;
  } = {},
) {
  return new Promise<{ status: number; body: string; headers: import("node:http").IncomingHttpHeaders }>(
    (resolve, reject) => {
      const headers: Record<string, string | string[]> = {};
      if (opts.host !== undefined) headers.host = opts.host;
      if (opts.origin) headers.origin = opts.origin;
      if (opts.authorization) headers.authorization = opts.authorization;
      if (opts.body !== undefined || opts.slow) {
        headers["content-type"] = opts.contentType ?? "application/json";
        if (!opts.chunked)
          headers["content-length"] = opts.slow ? "100" : String(opts.declaredLength ?? Buffer.byteLength(opts.body!));
      }
      const rawHeaders = Object.entries(headers).flatMap(([key, values]) =>
        (Array.isArray(values) ? values : [values]).flatMap((value) => [key, value]),
      );
      const req = request(
        {
          hostname: "127.0.0.1",
          port: server.port,
          path,
          method: opts.body !== undefined || opts.slow ? "POST" : "GET",
          setHost: false,
          headers: rawHeaders,
        },
        (res) => {
          let text = "";
          res.on("data", (b) => {
            text += b;
          });
          res.on("end", () => resolve({ status: res.statusCode!, body: text, headers: res.headers }));
        },
      );
      req.on("error", reject);
      if (opts.slow) {
        req.write("{");
        return;
      }
      if (opts.chunked) {
        let offset = 0;
        const writeChunk = () => {
          if (req.destroyed) return;
          if (offset === opts.body!.length) {
            req.end();
            return;
          }
          const end = Math.min(offset + 16 * 1024, opts.body!.length);
          const chunk = opts.body!.slice(offset, end);
          offset = end;
          req.write(chunk, (err) => (err ? reject(err) : setImmediate(writeChunk)));
        };
        writeChunk();
      } else req.end(opts.body);
    },
  );
}
it.each([undefined, "evil.example", "host:443", "host:123", "host.evil"])(
  "rejects missing, unapproved, or malformed Host %j",
  async (host) => expect((await send("/.well-known/oauth-protected-resource", { host })).status).toBe(403),
);
it.each(["evil.example", "host.evil", undefined])(
  "enforces the canonical Host on the GitHub user callback too (%j)",
  async (host) => expect((await send("/hosts/github/user-callback?code=c&state=s", { host })).status).toBe(403),
);
it("rejects duplicate Host headers", async () =>
  expect((await send("/mcp", { host: ["host", "evil"] })).status).toBe(403));
it("allows only exact origins and reports the delegated issuer in discovery", async () => {
  const good = await send("/.well-known/oauth-protected-resource/mcp", {
    host: "host",
    origin: "https://client.example",
  });
  expect(good.status).toBe(200);
  expect(JSON.parse(good.body).authorization_servers).toEqual(["https://issuer.example"]);
  expect((await send("/mcp", { host: "host", origin: "https://client.example.evil" })).status).toBe(403);
});
it.each(["/mcp", "/webhooks/id"])("bounds fixed/chunked bodies and rejects malformed JSON at %s", async (path) => {
  // Oversized Content-Length must be rejected before the client uploads anything.
  expect((await send(path, { host: "host", declaredLength: 1024 * 1024 + 1, body: "" })).status).toBe(413);
  expect((await send(path, { host: "host", chunked: true, body: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
  expect((await send(path, { host: "host", body: "{" })).status).toBe(400);
  expect((await send(path, { host: "host", body: "{}", contentType: "text/plain" })).status).toBe(415);
});
it("accepts exactly the body limit and sanitizes authentication failures", async () => {
  const body = JSON.stringify({ padding: "x".repeat(1024 * 1024 - 14) });
  expect(Buffer.byteLength(body)).toBe(1024 * 1024);
  const res = await send("/mcp", { host: "host", body, authorization: "Bearer test" });
  expect(res.status).toBe(401);
  expect(res.body).not.toContain("SECRET_DATABASE_DETAIL");
  expect(res.headers["cache-control"]).toBe("no-store");
});
it.each(["/authorize", "/token", "/register", "/.well-known/oauth-authorization-server"])(
  "does not mount self-hosted route %s in delegated mode",
  async (path) => expect((await send(path, { host: "host" })).status).toBe(404),
);
it("times out incomplete request bodies with 408 and closes the socket", async () => {
  const res = await send("/mcp", { host: "host", slow: true });
  expect(res.status).toBe(408);
  expect(res.headers.connection).toBe("close");
}, 20_000);
