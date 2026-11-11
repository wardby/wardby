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

  it("tries the path-suffixed form first, then the root one, and OpenID configuration for the server", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.url === "/.well-known/oauth-protected-resource")
          return json(res, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        if (req.url === "/.well-known/openid-configuration") return json(res, asMeta(origin));
      }),
    );
    expect((await discoverOAuth(`${s.origin}/mcp`, options)).authorizationEndpoint).toBe(`${s.origin}/authorize`);
    const urls = s.seen.map((r) => r.url);
    const suffixed = urls.indexOf("/.well-known/oauth-protected-resource/mcp");
    expect(suffixed).toBeGreaterThanOrEqual(0);
    expect(urls.indexOf("/.well-known/oauth-protected-resource")).toBeGreaterThan(suffixed);
    expect(urls).toContain("/.well-known/oauth-authorization-server");
  });

  it("prefers the path-suffixed protected-resource form when both are served", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.url === "/.well-known/oauth-protected-resource/mcp")
          return json(res, {
            resource: `${origin}/mcp`,
            authorization_servers: [origin],
            scopes_supported: ["suffixed"],
          });
        if (req.url === "/.well-known/oauth-protected-resource")
          return json(res, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["root"] });
        if (req.url === "/.well-known/oauth-authorization-server") return json(res, asMeta(origin));
      }),
    );
    expect((await discoverOAuth(`${s.origin}/mcp`, options)).scopesSupported).toEqual(["suffixed"]);
    expect(s.seen.map((r) => r.url)).not.toContain("/.well-known/oauth-protected-resource");
  });

  it("follows a challenge's resource_metadata even when it is not a well-known path", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.method === "POST")
          return (
            res
              .writeHead(401, {
                "content-type": "application/json",
                "www-authenticate": `Bearer resource_metadata="${origin}/meta/prm"`,
              })
              .end("{}"),
            true
          );
        if (req.url === "/meta/prm") return json(res, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        if (req.url === "/.well-known/oauth-authorization-server") return json(res, asMeta(origin));
      }),
    );
    expect((await discoverOAuth(`${s.origin}/mcp`, options)).tokenEndpoint).toBe(`${s.origin}/token`);
    const urls = s.seen.map((r) => r.url);
    expect(urls).toContain("/meta/prm");
    expect(urls.filter((u) => u?.includes("oauth-protected-resource"))).toEqual([]);
  });

  it("rejects authorization-server metadata whose issuer does not match", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.url === "/.well-known/oauth-protected-resource/mcp")
          return json(res, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        if (req.url === "/.well-known/oauth-authorization-server")
          return json(res, asMeta(origin, { issuer: "https://evil.example.com" }));
      }),
    );
    expect(await failureCode(discoverOAuth(`${s.origin}/mcp`, options))).toBe("discovery_failed");
  });

  it("falls back to the OpenID path-appended form for an issuer with a path", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.url === "/.well-known/oauth-protected-resource/mcp")
          return json(res, { resource: `${origin}/mcp`, authorization_servers: [`${origin}/tenant`] });
        if (req.url === "/tenant/.well-known/openid-configuration") return json(res, asMeta(`${origin}/tenant`));
      }),
    );
    expect((await discoverOAuth(`${s.origin}/mcp`, options)).issuer).toBe(`${s.origin}/tenant`);
    expect(s.seen.map((r) => r.url)).toEqual(
      expect.arrayContaining([
        "/.well-known/oauth-authorization-server/tenant",
        "/.well-known/openid-configuration/tenant",
        "/tenant/.well-known/openid-configuration",
      ]),
    );
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

  const prmOk = (origin: string): Record<string, unknown> => ({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
  });

  it.each([401, 403, 405, 410])("moves on to the root path when the suffixed one answers %i", async (status) => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.url === "/.well-known/oauth-protected-resource/mcp") return json(res, { e: 1 }, status);
        if (req.url === "/.well-known/oauth-protected-resource") return json(res, prmOk(origin));
        if (req.url === "/.well-known/oauth-authorization-server") return json(res, asMeta(origin));
      }),
    );
    expect((await discoverOAuth(`${s.origin}/mcp`, options)).tokenEndpoint).toBe(`${s.origin}/token`);
  });

  it("moves on when an authorization-server candidate answers 403", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.url === "/.well-known/oauth-protected-resource/mcp") return json(res, prmOk(origin));
        if (req.url === "/.well-known/oauth-authorization-server") return json(res, {}, 403);
        if (req.url === "/.well-known/openid-configuration") return json(res, asMeta(origin));
      }),
    );
    await expect(discoverOAuth(`${s.origin}/mcp`, options)).resolves.toMatchObject({ issuer: s.origin });
  });

  it("gives provider_unavailable when a well-known path answers 5xx", async () => {
    const s = await track(
      inline((req, res) => {
        if (req.url === "/.well-known/oauth-protected-resource/mcp") return json(res, {}, 503);
      }),
    );
    expect(await failureCode(discoverOAuth(`${s.origin}/mcp`, options))).toBe("provider_unavailable");
  });

  it("ignores a large HTML 404 at the suffixed path", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.url === "/.well-known/oauth-protected-resource/mcp") {
          res.writeHead(404, { "content-type": "text/html" }).end("<html>" + "x".repeat(100 * 1024) + "</html>");
          return true;
        }
        if (req.url === "/.well-known/oauth-protected-resource") return json(res, prmOk(origin));
        if (req.url === "/.well-known/oauth-authorization-server") return json(res, asMeta(origin));
      }),
    );
    await expect(discoverOAuth(`${s.origin}/mcp`, options)).resolves.toMatchObject({ issuer: s.origin });
  });

  it("still discovers when the probe answers with a redirect", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.method === "POST") {
          res.writeHead(307, { location: `${origin}/elsewhere` }).end();
          return true;
        }
        if (req.url === "/.well-known/oauth-protected-resource/mcp") return json(res, prmOk(origin));
        if (req.url === "/.well-known/oauth-authorization-server") return json(res, asMeta(origin));
      }),
    );
    await expect(discoverOAuth(`${s.origin}/mcp`, options)).resolves.toMatchObject({ issuer: s.origin });
  });

  it("still discovers when the probe answers 200 text/event-stream", async () => {
    const s = await track(
      inline((req, res, origin) => {
        if (req.method === "POST") {
          res.writeHead(200, { "content-type": "text/event-stream" }).end("data: {}\n\n");
          return true;
        }
        if (req.url === "/.well-known/oauth-protected-resource/mcp") return json(res, prmOk(origin));
        if (req.url === "/.well-known/oauth-authorization-server") return json(res, asMeta(origin));
      }),
    );
    await expect(discoverOAuth(`${s.origin}/mcp`, options)).resolves.toMatchObject({ issuer: s.origin });
  });

  it("returns the server's canonical resource and sends the package version in the probe", async () => {
    let probeBody = "";
    const s = await track(
      inline((req, res, origin) => {
        if (req.method === "POST") {
          req.on("data", (c: Buffer) => (probeBody += c.toString()));
          return json(res, {});
        }
        if (req.url === "/.well-known/oauth-protected-resource/mcp")
          return json(res, { resource: `${origin}/mcp/`, authorization_servers: [origin] });
        if (req.url === "/.well-known/oauth-authorization-server") return json(res, asMeta(origin));
      }),
    );
    const m = await discoverOAuth(`${s.origin}/mcp`, options);
    expect(m.resource).toBe(`${s.origin}/mcp/`);
    expect(probeBody).toContain(`"version":"${packageVersion()}"`);
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
