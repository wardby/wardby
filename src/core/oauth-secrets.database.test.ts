import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeFetch } from "../sandbox/safe-fetch.js";
import { startFakeOAuthServer, type FakeOAuthServer } from "../test-support/fake-oauth-server.test-support.js";
import { createPrismaClient } from "./db.js";
import { completeOAuthCallback, type OAuthLinkAdapter } from "./oauth-link.js";
import {
  finishOAuthSecretConnect,
  OAUTH_SECRET_PURPOSE,
  oauthBroker,
  OAuthSecretMetaSchema,
  oauthSecretAdapter,
  SECRET_NOT_OAUTH,
  SECRET_OAUTH_CIPHER_FAILED,
  SECRET_OAUTH_CLIENT_ID_REQUIRED,
  SECRET_OAUTH_DISCOVERY_FAILED,
  SECRET_OAUTH_REFRESH_FAILED,
  SECRET_OAUTH_REFRESH_UNAVAILABLE,
  SECRET_REAUTH_REQUIRED,
  startOAuthSecretConnect,
} from "./oauth-secrets.js";
import { loadServerSecrets, redactForServer } from "./mcp-servers.js";
import { mcpNamedSecretValues } from "./mcp-tools.js";
import { withEscapedForms } from "./secret-spans.js";
import { buildSecretsAccessor, decryptEntry } from "./secrets.js";
import { consoleRedactionValues } from "../sandbox/secret-broker.js";
import { parseSecretBrokerConfig } from "./secret-broker-config.js";

const logged = vi.hoisted(() => vi.fn());
vi.mock("./logger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./logger.js")>();
  const child = real.logger.child.bind(real.logger);
  vi.spyOn(real.logger, "child").mockImplementation((bindings, options) => {
    const log = child(bindings, options);
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      vi.spyOn(log, level).mockImplementation(logged);
    }
    return log;
  });
  return real;
});

const db = createPrismaClient();
const HOST = "oauth.fake.test";
// The fake listens on 127.0.0.1; clients reach it through a dotted name so the broker schema validates.
const OPTS = {
  privateHostAllowlist: [HOST],
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
};
const REDIRECT = "https://wardby.example/oauth/callback";
const principalIds: string[] = [];
const agentIds: string[] = [];

const cipher = {
  keyId: () => "test-key",
  encrypt: async (v: string) => `enc:${Buffer.from(v).toString("base64")}`,
  decrypt: async (v: string) => Buffer.from(v.slice(4), "base64").toString(),
};

async function owner(): Promise<string> {
  const p = await db.principal.create({ data: { subject: `oauth-secret-${randomUUID()}` } });
  principalIds.push(p.id);
  return p.id;
}

/** A fetch that records every request and can rewrite the registration response. */
function recordingFetch(rewriteRegistration?: (body: Record<string, unknown>) => Record<string, unknown>) {
  const requests: { url: string; headers: Record<string, string>; body?: string }[] = [];
  const impl: typeof safeFetch = async (url, init, options) => {
    requests.push({ url, headers: { ...(init?.headers ?? {}) }, body: init?.body });
    const r = await safeFetch(url, init, options);
    if (rewriteRegistration && url.endsWith("/register")) {
      const body = JSON.parse(Buffer.from(r.bodyBase64, "base64").toString("utf8")) as Record<string, unknown>;
      return { ...r, bodyBase64: Buffer.from(JSON.stringify(rewriteRegistration(body))).toString("base64") };
    }
    return r;
  };
  return { impl, requests };
}

let fake: FakeOAuthServer;

async function callback(
  callbackUrl: string,
  adapter: OAuthLinkAdapter<unknown, unknown>,
  extra: { iss?: string; state?: string } = {},
) {
  const cb = new URL(callbackUrl);
  return completeOAuthCallback({
    db,
    adapters: new Map([[OAUTH_SECRET_PURPOSE, adapter]]),
    cipher,
    state: extra.state ?? cb.searchParams.get("state"),
    code: cb.searchParams.get("code"),
    iss: extra.iss,
    redirectUri: REDIRECT,
  });
}

async function connect(
  ownerId: string,
  name: string,
  opts: { fetchImpl?: typeof safeFetch; iss?: string; clientId?: string; scope?: string } = {},
) {
  const started = await startOAuthSecretConnect({
    db,
    cipher,
    ownerId,
    name,
    resource: fake.mcpUrl,
    redirectUri: REDIRECT,
    options: OPTS,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.clientId ? { clientId: opts.clientId } : {}),
    ...(opts.scope ? { scope: opts.scope } : {}),
  });
  const callbackUrl = await fake.approve(started.authorizeUrl);
  const adapter = oauthSecretAdapter(cipher, OPTS, opts.fetchImpl) as OAuthLinkAdapter<unknown, unknown>;
  const outcome = await callback(callbackUrl, adapter, { iss: opts.iss });
  return { started, callbackUrl, adapter, outcome };
}

async function confirmCode(ownerId: string, name: string, code: string) {
  return finishOAuthSecretConnect({ db, cipher, ownerId, name, confirmationCode: code });
}

describe.skipIf(!process.env.DATABASE_URL)("OAuth secrets (PostgreSQL, fake OAuth server)", () => {
  beforeEach(async () => {
    logged.mockClear();
    fake = await startFakeOAuthServer({ publicHost: HOST, checkClient: true });
  });
  afterEach(async () => {
    await fake.close();
  });
  afterAll(async () => {
    await db.agentMcpServer.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.mcpServer.deleteMany({ where: { ownerId: { in: principalIds } } });
    await db.agentSecret.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.secretBrokerChange.deleteMany({ where: { ownerId: { in: principalIds } } });
    await db.secret.deleteMany({ where: { ownerId: { in: principalIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("connects: discovery, registration, callback, confirm; stores a brokered OAuth secret", async () => {
    const ownerId = await owner();
    const { started, outcome } = await connect(ownerId, "browserstack", { scope: "read" });
    const authorize = new URL(started.authorizeUrl);
    expect(authorize.searchParams.get("resource")).toBe(fake.mcpUrl);
    expect(authorize.searchParams.get("scope")).toBe("read");
    expect(authorize.searchParams.get("client_id")).toMatch(/^fake-client-/);
    expect(outcome).toMatchObject({
      kind: "confirm",
      signedInAs: "the account you signed in with",
      target: HOST,
      tool: "create_secret",
    });
    if (outcome.kind !== "confirm") throw new Error("unreachable");

    const result = await confirmCode(ownerId, "browserstack", outcome.code);
    expect(result).toMatchObject({ name: "browserstack", kind: "oauth", status: "connected" });
    expect(result.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const row = await db.secret.findUniqueOrThrow({ where: { ownerId_name: { ownerId, name: "browserstack" } } });
    const meta = OAuthSecretMetaSchema.parse(row.oauth);
    expect(meta).toMatchObject({
      resource: fake.mcpUrl,
      issuer: fake.url,
      tokenEndpoint: `${fake.url}/token`,
      revocationEndpoint: `${fake.url}/revoke`,
      scope: "read",
      status: "connected",
      authMethod: "none",
      expiresAt: result.expiresAt,
    });
    expect(row.broker).toEqual(oauthBroker(fake.mcpUrl));
    expect(row.keyId).toBe("test-key");
    expect(JSON.parse(await cipher.decrypt(row.ciphertext))).toEqual({
      accessToken: "fake-access-1",
      refreshToken: "fake-refresh-1",
    });
    expect(JSON.stringify(row.oauth)).not.toContain("fake-access");
    expect(JSON.stringify(row.oauth)).not.toContain("fake-refresh");
    expect(JSON.stringify(row.broker)).not.toContain("fake-");
    expect(JSON.stringify(result)).not.toContain("fake-");

    const changes = await db.secretBrokerChange.findMany({ where: { secretId: row.id } });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ via: "mcp", actorId: ownerId, secretName: "browserstack", before: null });
    expect(changes[0].after).toEqual({ ...oauthBroker(fake.mcpUrl), oauthStatus: "connected" });
    expect(JSON.stringify(changes)).not.toContain("fake-");
    // The pending request is gone and logs never saw a value.
    expect(await db.oAuthLinkRequest.count({ where: { principalId: ownerId } })).toBe(0);
    expect(JSON.stringify(logged.mock.calls)).not.toContain("fake-");
  });

  it("reconnects under the same name: new tokens, same id", async () => {
    const ownerId = await owner();
    const first = await connect(ownerId, "bs");
    if (first.outcome.kind !== "confirm") throw new Error("unreachable");
    await confirmCode(ownerId, "bs", first.outcome.code);
    const before = await db.secret.findUniqueOrThrow({ where: { ownerId_name: { ownerId, name: "bs" } } });

    const second = await connect(ownerId, "bs");
    if (second.outcome.kind !== "confirm") throw new Error("unreachable");
    await confirmCode(ownerId, "bs", second.outcome.code);
    const after = await db.secret.findUniqueOrThrow({ where: { ownerId_name: { ownerId, name: "bs" } } });
    expect(after.id).toBe(before.id);
    expect(JSON.parse(await cipher.decrypt(after.ciphertext))).toEqual({
      accessToken: "fake-access-2",
      refreshToken: "fake-refresh-2",
    });
    const changes = await db.secretBrokerChange.findMany({
      where: { secretId: after.id },
      orderBy: { createdAt: "asc" },
    });
    expect(changes).toHaveLength(2);
    expect(changes[1].before).toEqual({ ...oauthBroker(fake.mcpUrl), oauthStatus: "connected" });
  });

  it("refuses a name used by a non-OAuth secret, at start and at confirm", async () => {
    const ownerId = await owner();
    await db.secret.create({ data: { ownerId, name: "plain", ciphertext: "enc:eA==", keyId: "test-key" } });
    await expect(
      startOAuthSecretConnect({
        db,
        cipher,
        ownerId,
        name: "plain",
        resource: fake.mcpUrl,
        redirectUri: REDIRECT,
        options: OPTS,
      }),
    ).rejects.toThrow(SECRET_NOT_OAUTH);
    expect(SECRET_NOT_OAUTH).toContain("a secret with this name already exists and is not an OAuth secret");

    // Created while the sign-in was pending: confirm refuses and leaves the plain secret alone.
    const { outcome } = await connect(ownerId, "late");
    if (outcome.kind !== "confirm") throw new Error("unreachable");
    await db.secret.create({ data: { ownerId, name: "late", ciphertext: "enc:eA==", keyId: "test-key" } });
    await expect(confirmCode(ownerId, "late", outcome.code)).rejects.toThrow(SECRET_NOT_OAUTH);
    const plain = await db.secret.findUniqueOrThrow({ where: { ownerId_name: { ownerId, name: "late" } } });
    expect(plain.oauth).toBeNull();
    expect(plain.ciphertext).toBe("enc:eA==");
  });

  it("needs a clientId when the provider has no registration endpoint; uses one when given", async () => {
    await fake.close();
    fake = await startFakeOAuthServer({ publicHost: HOST, dcr: false });
    const ownerId = await owner();
    await expect(
      startOAuthSecretConnect({
        db,
        cipher,
        ownerId,
        name: "x",
        resource: fake.mcpUrl,
        redirectUri: REDIRECT,
        options: OPTS,
      }),
    ).rejects.toThrow(SECRET_OAUTH_CLIENT_ID_REQUIRED);
    expect(SECRET_OAUTH_CLIENT_ID_REQUIRED).toContain("clientId");

    const { started, outcome } = await connect(ownerId, "x", { clientId: "my-client" });
    expect(new URL(started.authorizeUrl).searchParams.get("client_id")).toBe("my-client");
    if (outcome.kind !== "confirm") throw new Error("unreachable");
    await confirmCode(ownerId, "x", outcome.code);
    const row = await db.secret.findUniqueOrThrow({ where: { ownerId_name: { ownerId, name: "x" } } });
    expect(OAuthSecretMetaSchema.parse(row.oauth).clientId).toBe("my-client");
  });

  it("gives secret_oauth_discovery_failed for a provider without S256", async () => {
    await fake.close();
    fake = await startFakeOAuthServer({ publicHost: HOST, s256: false });
    const ownerId = await owner();
    await expect(
      startOAuthSecretConnect({
        db,
        cipher,
        ownerId,
        name: "x",
        resource: fake.mcpUrl,
        redirectUri: REDIRECT,
        options: OPTS,
      }),
    ).rejects.toThrow(SECRET_OAUTH_DISCOVERY_FAILED);
  });

  it("refuses a non-https resource unless its host is allow-listed", async () => {
    const ownerId = await owner();
    await expect(
      startOAuthSecretConnect({ db, cipher, ownerId, name: "x", resource: fake.mcpUrl, redirectUri: REDIRECT }),
    ).rejects.toThrow(/https/);
  });

  it("refuses a replayed callback state", async () => {
    const ownerId = await owner();
    const { callbackUrl, adapter, outcome } = await connect(ownerId, "replay");
    expect(outcome.kind).toBe("confirm");
    await expect(callback(callbackUrl, adapter)).resolves.toEqual({ kind: "invalid" });
  });

  it("accepts a matching iss and rejects a different one (RFC 9207) without logging values", async () => {
    const ownerId = await owner();
    const ok = await connect(ownerId, "iss-ok", { iss: fake.url });
    expect(ok.outcome.kind).toBe("confirm");

    const bad = await connect(ownerId, "iss-bad", { iss: "https://evil.example" });
    expect(bad.outcome).toEqual({ kind: "failed" });
    expect(logged).toHaveBeenCalledWith(
      { purpose: OAUTH_SECRET_PURPOSE, reason: "issuer_mismatch" },
      expect.any(String),
    );
    expect(JSON.stringify(logged.mock.calls)).not.toContain("fake-");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("evil");
  });

  it("keeps a registered client secret as ciphertext in the context and sends it as the provider asks", async () => {
    const ownerId = await owner();
    const rec = recordingFetch((body) => ({
      ...body,
      client_secret: "fake-client-secret-1",
      token_endpoint_auth_method: "client_secret_post",
    }));
    const started = await startOAuthSecretConnect({
      db,
      cipher,
      ownerId,
      name: "with-secret",
      resource: fake.mcpUrl,
      redirectUri: REDIRECT,
      options: OPTS,
      fetchImpl: rec.impl,
    });
    const pending = await db.oAuthLinkRequest.findFirstOrThrow({ where: { principalId: ownerId } });
    expect(JSON.stringify(pending.context)).not.toContain("fake-client-secret");
    expect(pending.context).toMatchObject({
      ownerId,
      name: "with-secret",
      client: { authMethod: "client_secret_post" },
    });
    expect((pending.context as { clientSecretCiphertext?: string }).clientSecretCiphertext).toMatch(/^enc:/);

    const adapter = oauthSecretAdapter(cipher, OPTS, rec.impl) as OAuthLinkAdapter<unknown, unknown>;
    const outcome = await callback(await fake.approve(started.authorizeUrl), adapter);
    if (outcome.kind !== "confirm") throw new Error("unreachable");
    const tokenCall = rec.requests.find((r) => r.url.endsWith("/token"));
    expect(new URLSearchParams(tokenCall?.body).get("client_secret")).toBe("fake-client-secret-1");

    const linkRow = await db.oAuthLinkRequest.findFirstOrThrow({ where: { principalId: ownerId } });
    // (The fake's client ids are "fake-client-<uuid>", which are not secret.)
    for (const value of ["fake-client-secret", "fake-access", "fake-refresh"]) {
      expect(JSON.stringify(linkRow.result)).not.toContain(value);
      expect(JSON.stringify(linkRow.context)).not.toContain(value);
    }

    await confirmCode(ownerId, "with-secret", outcome.code);
    const row = await db.secret.findUniqueOrThrow({ where: { ownerId_name: { ownerId, name: "with-secret" } } });
    expect(JSON.parse(await cipher.decrypt(row.ciphertext))).toEqual({
      accessToken: "fake-access-1",
      refreshToken: "fake-refresh-1",
      clientSecret: "fake-client-secret-1",
    });
    expect(OAuthSecretMetaSchema.parse(row.oauth).authMethod).toBe("client_secret_post");
    for (const value of ["fake-client-secret", "fake-access", "fake-refresh"]) {
      expect(JSON.stringify(row.oauth)).not.toContain(value);
    }
  });

  it("maps cipher failures to a fixed error with no cause text", async () => {
    const ownerId = await owner();
    const failing = {
      ...cipher,
      encrypt: async () => {
        throw new Error("kms said fake-access-LEAK");
      },
    };
    const rec = recordingFetch((body) => ({ ...body, client_secret: "fake-client-secret-2" }));
    const err = await startOAuthSecretConnect({
      db,
      cipher: failing,
      ownerId,
      name: "kms",
      resource: fake.mcpUrl,
      redirectUri: REDIRECT,
      options: OPTS,
      fetchImpl: rec.impl,
    }).then(
      () => new Error("expected a failure"),
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(SECRET_OAUTH_CIPHER_FAILED);
    expect(err.cause).toBeUndefined();
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain("fake-");

    // At confirm: the payload re-encryption fails closed, and the request stays for a retry.
    const { outcome } = await connect(ownerId, "kms2");
    if (outcome.kind !== "confirm") throw new Error("unreachable");
    const e2 = await finishOAuthSecretConnect({
      db,
      cipher: failing,
      ownerId,
      name: "kms2",
      confirmationCode: outcome.code,
    }).then(
      () => new Error("expected a failure"),
      (e: unknown) => e as Error,
    );
    expect(e2.message).toBe(SECRET_OAUTH_CIPHER_FAILED);
    expect(JSON.stringify(e2, Object.getOwnPropertyNames(e2))).not.toContain("fake-");
    expect(await db.secret.count({ where: { ownerId, name: "kms2" } })).toBe(0);
    // The request was not consumed: the same code works once the cipher does.
    await expect(confirmCode(ownerId, "kms2", outcome.code)).resolves.toMatchObject({ status: "connected" });
  });

  it("only confirms the pending sign-in for the same owner and name", async () => {
    const ownerId = await owner();
    const other = await owner();
    const { outcome } = await connect(ownerId, "mine");
    if (outcome.kind !== "confirm") throw new Error("unreachable");
    await expect(confirmCode(ownerId, "someone-else", outcome.code)).rejects.toThrow(/no OAuth sign-in/i);
    await expect(confirmCode(other, "mine", outcome.code)).rejects.toThrow(/no OAuth sign-in/i);
    await expect(confirmCode(ownerId, "mine", outcome.code)).resolves.toMatchObject({ status: "connected" });
  });

  it("stores a broker that passes the broker schema", async () => {
    const ownerId = await owner();
    const { outcome } = await connect(ownerId, "valid-broker");
    if (outcome.kind !== "confirm") throw new Error("unreachable");
    await confirmCode(ownerId, "valid-broker", outcome.code);
    const row = await db.secret.findUniqueOrThrow({ where: { ownerId_name: { ownerId, name: "valid-broker" } } });
    expect(parseSecretBrokerConfig(row.broker)).toEqual(oauthBroker(fake.mcpUrl));
    expect(parseSecretBrokerConfig(row.broker).hosts).toEqual([HOST]);
  });

  it("refuses an IP-literal resource even on the allow-list, and stores nothing", async () => {
    const ownerId = await owner();
    const before = await db.oAuthLinkRequest.count({ where: { principalId: ownerId } });
    await expect(
      startOAuthSecretConnect({
        db,
        cipher,
        ownerId,
        name: "ip-literal",
        resource: `${fake.url.replace(HOST, "127.0.0.1")}/mcp`,
        redirectUri: REDIRECT,
        options: { ...OPTS, privateHostAllowlist: [HOST, "127.0.0.1"] },
      }),
    ).rejects.toThrow();
    expect(await db.oAuthLinkRequest.count({ where: { principalId: ownerId } })).toBe(before);
    expect(await db.secret.count({ where: { ownerId, name: "ip-literal" } })).toBe(0);
  });

  it("refuses at confirm a context whose resource gives an invalid broker", async () => {
    const ownerId = await owner();
    const { outcome } = await connect(ownerId, "bad-context");
    if (outcome.kind !== "confirm") throw new Error("unreachable");
    const link = await db.oAuthLinkRequest.findFirstOrThrow({ where: { principalId: ownerId } });
    const ctx = link.context as { meta: Record<string, unknown> };
    await db.oAuthLinkRequest.update({
      where: { id: link.id },
      data: { context: { ...ctx, meta: { ...ctx.meta, resource: "http://127.0.0.1:9/mcp" } } },
    });
    await expect(confirmCode(ownerId, "bad-context", outcome.code)).rejects.toThrow(/not valid/);
    expect(await db.secret.count({ where: { ownerId, name: "bad-context" } })).toBe(0);
  });

  describe("resolving an OAuth secret", () => {
    const row = (ownerId: string, name: string) =>
      db.secret.findUniqueOrThrow({
        where: { ownerId_name: { ownerId, name } },
        select: { id: true, name: true, ciphertext: true, broker: true, oauth: true },
      });

    /** Connects `name` with access tokens living `ttl` seconds; later tokens live an hour. */
    async function connected(name: string, ttl = 3600) {
      const ownerId = await owner();
      fake.accessTtlSeconds = ttl;
      const { outcome } = await connect(ownerId, name);
      if (outcome.kind !== "confirm") throw new Error("unreachable");
      await confirmCode(ownerId, name, outcome.code);
      fake.accessTtlSeconds = 3600;
      logged.mockClear();
      return { ownerId, read: () => row(ownerId, name) };
    }

    const payloadOf = async (ciphertext: string) =>
      JSON.parse(await cipher.decrypt(ciphertext)) as Record<string, string>;
    const metaOf = (oauth: unknown) => OAuthSecretMetaSchema.parse(oauth);
    const logText = () => JSON.stringify(logged.mock.calls);

    /** A fetch that answers the token endpoint itself; everything else goes to the fake. */
    function tokenAnswer(status: number, body: unknown): typeof safeFetch {
      return async (url, init, options) =>
        url.endsWith("/token")
          ? {
              ok: status >= 200 && status < 300,
              status,
              statusText: "",
              url,
              headers: { "content-type": "application/json" },
              bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64"),
            }
          : safeFetch(url, init, options);
    }

    it("leaves a non-OAuth secret as it was", async () => {
      const ownerId = await owner();
      const s = await db.secret.create({
        data: { name: "plain", ciphertext: await cipher.encrypt("plain-value-123"), keyId: "k", ownerId },
      });
      const entry = await decryptEntry(db, cipher, { ...s, oauth: null });
      expect(entry).toEqual({ value: "plain-value-123", broker: null });
    });

    it("uses a token that is not due without a token request", async () => {
      const { read } = await connected("not-due");
      const entry = await decryptEntry(db, cipher, await read(), { options: OPTS });
      expect(entry.value).toBe("fake-access-1");
      expect(entry.broker).toEqual(oauthBroker(fake.mcpUrl));
      expect(fake.tokenRequests).toBe(0);
    });

    it("refreshes a token due within 60 s and stores the new ciphertext and expiry", async () => {
      const { read } = await connected("due", 30);
      const before = await read();
      const entry = await decryptEntry(db, cipher, before, { options: OPTS });
      expect(fake.tokenRequests).toBe(1);
      expect(entry.value).toBe("fake-access-2");
      const after = await read();
      expect(after.ciphertext).not.toBe(before.ciphertext);
      expect(await payloadOf(after.ciphertext)).toEqual({
        accessToken: "fake-access-2",
        refreshToken: "fake-refresh-2",
      });
      const expiresAt = Date.parse(metaOf(after.oauth).expiresAt!);
      expect(expiresAt - Date.now()).toBeGreaterThan(3000_000);
      expect(metaOf(after.oauth).status).toBe("connected");
      expect(logText()).not.toContain("fake-");
    });

    it("keeps the old refresh token when the provider does not rotate it", async () => {
      const { read } = await connected("no-rotate", 30);
      fake.rotateRefresh = false;
      // The provider leaves refresh_token out of its answer altogether.
      const omitting: typeof safeFetch = async (url, init, options) => {
        const r = await safeFetch(url, init, options);
        if (!url.endsWith("/token")) return r;
        const body = JSON.parse(Buffer.from(r.bodyBase64, "base64").toString("utf8")) as Record<string, unknown>;
        delete body.refresh_token;
        return { ...r, bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64") };
      };
      const entry = await decryptEntry(db, cipher, await read(), { options: OPTS, fetchImpl: omitting });
      expect(entry.value).toBe("fake-access-2");
      expect(await payloadOf((await read()).ciphertext)).toEqual({
        accessToken: "fake-access-2",
        refreshToken: "fake-refresh-1",
      });
    });

    it("refreshes once for five concurrent resolves of a due token", async () => {
      const { read } = await connected("concurrent", 30);
      const stale = await read();
      const entries = await Promise.all(
        Array.from({ length: 5 }, () => decryptEntry(db, cipher, stale, { options: OPTS })),
      );
      expect(fake.tokenRequests).toBe(1);
      expect(new Set(entries.map((e) => e.value))).toEqual(new Set(["fake-access-2"]));
    });

    it("forces a refresh only while the used token is still the stored one", async () => {
      const { read } = await connected("forced");
      const first = await decryptEntry(db, cipher, await read(), {
        options: OPTS,
        forceRefreshIfStill: "fake-access-1",
      });
      expect(first.value).toBe("fake-access-2");
      // A second caller that also saw fake-access-1 fail gets the new token without another request.
      const second = await decryptEntry(db, cipher, await read(), {
        options: OPTS,
        forceRefreshIfStill: "fake-access-1",
      });
      expect(second.value).toBe("fake-access-2");
      expect(fake.tokenRequests).toBe(1);
    });

    it("marks a spent refresh token reauth_required without logging or throwing token text", async () => {
      const { ownerId, read } = await connected("spent", 30);
      fake.revoked.add("fake-refresh-1");
      const error = await decryptEntry(db, cipher, await read(), { options: OPTS }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(SECRET_REAUTH_REQUIRED("spent"));
      expect((error as Error).cause).toBeUndefined();
      expect((error as { retryable?: boolean }).retryable).toBe(false);
      const after = await read();
      expect(metaOf(after.oauth)).toMatchObject({ status: "reauth_required", reauthReason: "invalid_grant" });
      const change = await db.secretBrokerChange.findFirstOrThrow({
        where: { secretId: after.id },
        orderBy: { createdAt: "desc" },
      });
      expect(change).toMatchObject({ ownerId, secretName: "spent", actorId: ownerId });
      expect(change.after).toMatchObject({ oauthStatus: "reauth_required" });
      expect(change.before).toMatchObject({ oauthStatus: "connected" });
      expect(logText()).toContain("invalid_grant");
      expect(logText()).toContain(after.id);
      expect(logText()).not.toContain("fake-refresh");
      expect(logText()).not.toContain("fake-access");
      expect(JSON.stringify(after.oauth)).not.toMatch(/fake-(access|refresh)/);
      // Once marked, no further token request is made.
      await expect(decryptEntry(db, cipher, after, { options: OPTS })).rejects.toThrow(SECRET_REAUTH_REQUIRED("spent"));
      expect(fake.tokenRequests).toBe(1);
    });

    it("marks reauth_required (invalid_client) when the provider refuses the client", async () => {
      const { read } = await connected("wrong-client", 30);
      const current = await read();
      await db.secret.update({
        where: { id: current.id },
        data: { oauth: { ...metaOf(current.oauth), clientId: "wrong-client-id" } },
      });
      await expect(decryptEntry(db, cipher, await read(), { options: OPTS })).rejects.toThrow(
        SECRET_REAUTH_REQUIRED("wrong-client"),
      );
      expect(metaOf((await read()).oauth)).toMatchObject({ status: "reauth_required", reauthReason: "invalid_client" });
    });

    it("keeps the status on a 5xx and throws a fixed retryable error", async () => {
      const { read } = await connected("five-hundred", 30);
      const before = await read();
      const error = await decryptEntry(db, cipher, before, {
        options: OPTS,
        fetchImpl: tokenAnswer(503, { error: "temporarily_unavailable", error_description: "fake-refresh-1" }),
      }).catch((e: unknown) => e);
      expect((error as Error).message).toBe(SECRET_OAUTH_REFRESH_UNAVAILABLE);
      expect((error as { retryable?: boolean }).retryable).toBe(true);
      expect((error as Error).cause).toBeUndefined();
      const after = await read();
      expect(metaOf(after.oauth).status).toBe("connected");
      expect(after.ciphertext).toBe(before.ciphertext);
      expect(logText()).not.toContain("fake-");
    });

    it("keeps the status on another refusal and throws a fixed error without provider text", async () => {
      const { read } = await connected("bad-response", 30);
      const error = await decryptEntry(db, cipher, await read(), {
        options: OPTS,
        fetchImpl: tokenAnswer(400, { error: "invalid_request", error_description: "fake-refresh-1 is odd" }),
      }).catch((e: unknown) => e);
      expect((error as Error).message).toBe(SECRET_OAUTH_REFRESH_FAILED);
      expect((error as Error).message).not.toContain("fake-");
      expect((error as Error).cause).toBeUndefined();
      expect(metaOf((await read()).oauth).status).toBe("connected");
    });

    it("maps an undecryptable payload to the fixed cipher error", async () => {
      const { read } = await connected("bad-cipher");
      const broken = { ...cipher, decrypt: async () => Promise.reject(new Error("kms said fake-access-1")) };
      const error = await decryptEntry(db, broken, await read(), { options: OPTS }).catch((e: unknown) => e);
      expect((error as Error).message).toBe(SECRET_OAUTH_CIPHER_FAILED);
      expect((error as Error).cause).toBeUndefined();
    });

    it("lists the access and refresh tokens for redaction", async () => {
      const { read } = await connected("redact");
      const entry = await decryptEntry(db, cipher, await read(), { options: OPTS });
      expect(entry.oauth?.redact).toEqual(expect.arrayContaining(["fake-access-1", "fake-refresh-1"]));
      expect(consoleRedactionValues(entry)).toEqual(expect.arrayContaining(["fake-access-1", "fake-refresh-1"]));
    });

    it("loadServerSecrets redacts both tokens, and a token minted mid-call joins the values", async () => {
      const { ownerId, read } = await connected("mcp-oauth");
      const server = { id: "srv-1", ownerId, name: "bs", url: fake.mcpUrl, secretNames: ["mcp-oauth"] };
      const { accessor, values } = await loadServerSecrets(db, cipher, server, { options: OPTS });
      const entry = await decryptEntry(db, cipher, await read(), { options: OPTS });
      for (const v of withEscapedForms(consoleRedactionValues(entry))) expect(values).toContain(v);
      expect(values).not.toContain("fake-access-2");

      const refreshed = await accessor.refresh!("mcp-oauth", "fake-access-1");
      expect(refreshed?.value).toBe("fake-access-2");
      expect(values).toContain("fake-access-2");
      expect(values).toContain("fake-refresh-2");
      const echoed = `seen ${Buffer.from("fake-refresh-2").toString("base64")} and ${encodeURIComponent("fake-access-2")}`;
      expect(redactForServer(echoed, values)).not.toMatch(/ZmFrZS1yZWZyZXNoLTI|fake-access-2/);
      // resolve reads the stored row, not what was loaded.
      expect((await accessor.resolve!("mcp-oauth"))?.value).toBe("fake-access-2");
      expect(fake.tokenRequests).toBe(1);
      // A stale caller's refresh does not spend the new token.
      expect((await accessor.refresh!("mcp-oauth", "fake-access-1"))?.value).toBe("fake-access-2");
      expect(fake.tokenRequests).toBe(1);
    });

    it("mcpNamedSecretValues lists an OAuth secret's tokens without refreshing", async () => {
      const { ownerId } = await connected("named", 30);
      const agentId = `oauth-agent-${randomUUID()}`;
      agentIds.push(agentId);
      await db.agent.create({
        data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId },
      });
      const server = await db.mcpServer.create({
        data: { ownerId, name: "bs", url: fake.mcpUrl, secretNames: ["named"], toolSnapshot: [] },
      });
      await db.agentMcpServer.create({
        data: { agentId, serverId: server.id, allowedTools: [], attachedById: ownerId },
      });
      const named = await mcpNamedSecretValues(db, cipher, agentId);
      expect(named).toHaveLength(1);
      expect(named[0].values).toEqual(expect.arrayContaining(["fake-access-1", "fake-refresh-1"]));
      expect(named[0].values.some((v) => v.includes("accessToken"))).toBe(false);
      expect(fake.tokenRequests).toBe(0);
    });

    it("buildSecretsAccessor resolves and refreshes an attached OAuth secret", async () => {
      const { ownerId, read } = await connected("attached", 30);
      const agentId = `oauth-agent-${randomUUID()}`;
      agentIds.push(agentId);
      await db.agent.create({
        data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId },
      });
      await db.agentSecret.create({ data: { agentId, secretId: (await read()).id, boundName: "BS" } });
      const accessor = buildSecretsAccessor(agentId, cipher, db, { options: OPTS });
      expect((await accessor.resolve!("BS"))?.value).toBe("fake-access-2");
      await expect(accessor.get("BS")).rejects.toThrow("secret_brokered");
      expect((await accessor.refresh!("BS", "fake-access-2"))?.value).toBe("fake-access-3");
      expect(await accessor.refresh!("NOPE", "x")).toBeUndefined();
      expect(fake.tokenRequests).toBe(2);
    });
  });
});
