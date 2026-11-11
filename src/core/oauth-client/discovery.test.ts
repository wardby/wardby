import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { packageVersion } from "../../package-version.js";
import { startFakeOAuthServer, type FakeOAuthServer } from "../../test-support/fake-oauth-server.test-support.js";
import { discoverOAuth } from "./discovery.js";
import { OAuthProtocolError } from "./http.js";

const options = { privateHostAllowlist: ["127.0.0.1"] };

type Handler = (req: IncomingMessage, res: ServerResponse, origin: string) => boolean | void;
interface Inline {
  origin: string;
  seen: { method?: string; url?: string; userAgent?: string }[];
  close(): Promise<void>;
}

async function inline(handler: Handler): Promise<Inline> {
  const seen: Inline["seen"] = [];
  let origin = "";
  const http = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, userAgent: req.headers["user-agent"] });
    req.resume();
    if (handler(req, res, origin) === true) return;
    res.writeHead(404, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    origin,
    seen,
    close: () => {
      http.closeAllConnections();
      return new Promise((r) => http.close(() => r()));
    },
  };
}

function json(res: ServerResponse, body: unknown, status = 200): true {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  return true;
}

function asMeta(origin: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    ...extra,
  };
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});
async function track<T extends { close(): Promise<void> }>(s: Promise<T>): Promise<T> {
  const v = await s;
  open.push(v);
  return v;
}

async function failureCode(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OAuthProtocolError);
  return (err as OAuthProtocolError).code;
}

describe("discoverOAuth", () => {
  let fake: FakeOAuthServer;

  it("follows the resource_metadata from a 401 challenge", async () => {
    fake = await track(startFakeOAuthServer());
    const meta = await discoverOAuth(fake.mcpUrl, options);
    expect(meta).toMatchObject({
      resource: fake.mcpUrl,
      issuer: fake.url,
      authorizationEndpoint: `${fake.url}/authorize`,
      tokenEndpoint: `${fake.url}/token`,
      registrationEndpoint: `${fake.url}/register`,
      revocationEndpoint: `${fake.url}/revoke`,
      scopesSupported: ["read", "write", "admin"],
    });
  });

  it("omits optional endpoints the server does not offer", async () => {
    fake = await track(startFakeOAuthServer({ dcr: false, revocation: false }));
    const meta = await discoverOAuth(fake.mcpUrl, options);
    expect(meta.registrationEndpoint).toBeUndefined();
    expect(meta.revocationEndpoint).toBeUndefined();
  });

  it("uses the root well-known path when there is no challenge", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.url === "/.well-known/oauth-protected-resource")
          return json(res, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        if (req.url === "/.well-known/oauth-authorization-server") return json(res, asMeta(origin));
        if (req.method === "POST") return json(res, { ok: true });
      }),
    );
    expect((await discoverOAuth(`${s.origin}/mcp`, options)).tokenEndpoint).toBe(`${s.origin}/token`);
  });

  it("tries the path-suffixed form when the root one is 404, and OpenID configuration for the server", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.url === "/.well-known/oauth-protected-resource/mcp")
          return json(res, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        if (req.url === "/.well-known/openid-configuration") return json(res, asMeta(origin));
      }),
    );
    expect((await discoverOAuth(`${s.origin}/mcp`, options)).authorizationEndpoint).toBe(`${s.origin}/authorize`);
    const urls = s.seen.map((r) => r.url);
    expect(urls).toContain("/.well-known/oauth-protected-resource");
    expect(urls).toContain("/.well-known/oauth-authorization-server");
  });

  it("rejects a server without S256", async () => {
    fake = await track(startFakeOAuthServer({ s256: false }));
    expect(await failureCode(discoverOAuth(fake.mcpUrl, options))).toBe("discovery_failed");
  });

  it("rejects a server that does not support authorization_code", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.url === "/.well-known/oauth-protected-resource")
          return json(res, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        if (req.url === "/.well-known/oauth-authorization-server")
          return json(res, asMeta(origin, { grant_types_supported: ["client_credentials"] }));
      }),
    );
    expect(await failureCode(discoverOAuth(`${s.origin}/mcp`, options))).toBe("discovery_failed");
  });

  it("rejects non-https endpoints outside the allowlist", async () => {
    fake = await track(startFakeOAuthServer());
    expect(await failureCode(discoverOAuth(fake.mcpUrl))).toBe("discovery_failed");
    expect(await failureCode(discoverOAuth(fake.mcpUrl, { privateHostAllowlist: [] }))).toBe("discovery_failed");
  });

  it("rejects a discovered endpoint that is not https or allowlisted", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.url === "/.well-known/oauth-protected-resource")
          return json(res, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        if (req.url === "/.well-known/oauth-authorization-server")
          return json(res, asMeta(origin, { token_endpoint: "http://example.com/token" }));
      }),
    );
    expect(await failureCode(discoverOAuth(`${s.origin}/mcp`, options))).toBe("discovery_failed");
  });

  it("rejects metadata whose resource does not match", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.url === "/.well-known/oauth-protected-resource")
          return json(res, { resource: `${origin}/other`, authorization_servers: [origin] });
        if (req.url === "/.well-known/oauth-authorization-server") return json(res, asMeta(origin));
      }),
    );
    expect(await failureCode(discoverOAuth(`${s.origin}/mcp`, options))).toBe("discovery_failed");
  });

  it("accepts a resource that differs only by trailing slash or host case", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.url === "/.well-known/oauth-protected-resource")
          return json(res, { resource: `${origin}/mcp/`, authorization_servers: [origin] });
        if (req.url === "/.well-known/oauth-authorization-server") return json(res, asMeta(origin));
      }),
    );
    await expect(discoverOAuth(`${s.origin}/mcp`, options)).resolves.toMatchObject({ issuer: s.origin });
  });

  it("gives bad_response for a body over 64 KiB", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.url === "/.well-known/oauth-protected-resource")
          return json(res, {
            resource: `${origin}/mcp`,
            authorization_servers: [origin],
            pad: "x".repeat(70 * 1024),
          });
      }),
    );
    expect(await failureCode(discoverOAuth(`${s.origin}/mcp`, options))).toBe("bad_response");
  });

  it("treats a redirect as bad_response", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.url === "/.well-known/oauth-protected-resource") {
          res.writeHead(302, { location: `${origin}/elsewhere` }).end();
          return true;
        }
      }),
    );
    expect(await failureCode(discoverOAuth(`${s.origin}/mcp`, options))).toBe("bad_response");
  });

  it("sends the wardby user agent on every request and keeps provider text out of errors", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.url === "/.well-known/oauth-protected-resource")
          return json(res, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        if (req.url === "/.well-known/oauth-authorization-server")
          return json(res, { error: "SECRET-PROVIDER-TEXT" }, 500);
      }),
    );
    const err = await discoverOAuth(`${s.origin}/mcp`, options).then(
      () => new Error("unexpected success"),
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(OAuthProtocolError);
    expect(err.message).not.toContain("SECRET-PROVIDER-TEXT");
    expect(s.seen.length).toBeGreaterThanOrEqual(3);
    for (const r of s.seen) expect(r.userAgent).toBe(`wardby/${packageVersion()}`);
  });
});
