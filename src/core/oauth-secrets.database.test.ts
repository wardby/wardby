import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brokeredFetch } from "../sandbox/brokered-fetch.js";
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
  SECRET_OAUTH_RESOURCE_INVALID,
  SECRET_REAUTH_REQUIRED,
  startOAuthSecretConnect,
} from "./oauth-secrets.js";
import { loadServerSecrets, redactForServer } from "./mcp-servers.js";
import {
  handleMcpTool,
  loadMcpToolPins,
  mcpNamedSecretValues,
  SHARED_CREDENTIALS_MESSAGE,
  SHARED_CREDENTIALS_RETRY_MESSAGE,
} from "./mcp-tools.js";
import { loadAgentSecretValues } from "./secret-guard.js";
import { fulfillSecretElicitation } from "../mcp/tools/secret-elicitation.js";
import { createSecret, deleteSecret, listSecrets, setSecretBroker } from "./secrets.js";
import { SECRET_OAUTH_MANAGED } from "./oauth-secrets.js";
import { readRedactionValues } from "./runner.js";
import { buildRunStepWriter } from "./run-steps/writer.js";
import { withEscapedForms } from "./secret-spans.js";
import { buildSecretsAccessor, decryptEntry } from "./secrets.js";
import { consoleRedactionValues } from "../sandbox/secret-broker.js";
import { fakeMcpServer, textResult } from "./mcp-tools.test-support.js";
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
    await db.resourceGrant.deleteMany({ where: { grantedById: { in: principalIds } } });
    await db.agentMcpServer.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.mcpServer.deleteMany({ where: { ownerId: { in: principalIds } } });
    await db.agentSecret.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.run.deleteMany({ where: { agentId: { in: agentIds } } });
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

  it("refuses an empty iss through the real adapter and stores nothing", async () => {
    const ownerId = await owner();
    const tokensBefore = fake.tokenRequests;
    // The helper forwards "" as given: an empty iss is present, and is not the discovered issuer.
    const { outcome } = await connect(ownerId, "iss-empty", { iss: "" });
    expect(outcome).toEqual({ kind: "failed" });
    // Refused before the code exchange: no token request, no tokens, no secret.
    expect(fake.tokenRequests).toBe(tokensBefore);
    expect(await db.secret.findUnique({ where: { ownerId_name: { ownerId, name: "iss-empty" } } })).toBeNull();
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
    ).rejects.toMatchObject({ message: SECRET_OAUTH_RESOURCE_INVALID });
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

    it("get refuses a due or reauth_required OAuth secret as brokered, without any token request", async () => {
      const { ownerId, read } = await connected("getdue", 30);
      const agentId = `oauth-agent-${randomUUID()}`;
      agentIds.push(agentId);
      await db.agent.create({
        data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId },
      });
      const secret = await read();
      await db.agentSecret.create({ data: { agentId, secretId: secret.id, boundName: "BS" } });
      const accessor = buildSecretsAccessor(agentId, cipher, db, { options: OPTS });
      const before = fake.tokenRequests;
      await expect(accessor.get("BS")).rejects.toThrow("secret_brokered");
      expect(fake.tokenRequests).toBe(before);
      await db.secret.update({
        where: { id: secret.id },
        data: { oauth: { ...metaOf(secret.oauth), status: "reauth_required", reauthReason: "invalid_grant" } },
      });
      await expect(accessor.get("BS")).rejects.toThrow("secret_brokered");
      expect(fake.tokenRequests).toBe(before);
    });

    /** Connects `name` for an existing owner; its first access token lives `ttl` seconds. */
    async function connectAs(ownerId: string, name: string, ttl = 3600) {
      fake.accessTtlSeconds = ttl;
      const { outcome } = await connect(ownerId, name);
      if (outcome.kind !== "confirm") throw new Error("unreachable");
      await confirmCode(ownerId, name, outcome.code);
      fake.accessTtlSeconds = 3600;
      return row(ownerId, name);
    }

    async function agentOf(ownerId: string): Promise<string> {
      const agentId = `oauth-agent-${randomUUID()}`;
      agentIds.push(agentId);
      await db.agent.create({
        data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId },
      });
      return agentId;
    }

    /** Ciphertext with no refresh token, and an expiry `msFromNow` away. */
    async function withoutRefreshToken(id: string, oauth: unknown, msFromNow: number) {
      const ciphertext = await cipher.encrypt(JSON.stringify({ accessToken: "fake-access-norefresh" }));
      await db.secret.update({
        where: { id },
        data: { ciphertext, oauth: { ...metaOf(oauth), expiresAt: new Date(Date.now() + msFromNow).toISOString() } },
      });
    }

    it("masks a token minted mid-call in the step text the real run-steps writer stores", async () => {
      const { ownerId } = await connected("step-tok", 30);
      const agentId = await agentOf(ownerId);
      const secretRow = await db.secret.findUniqueOrThrow({ where: { ownerId_name: { ownerId, name: "step-tok" } } });
      await db.agentSecret.create({ data: { agentId, secretId: secretRow.id, boundName: "STEP_TOK" } });
      const run = await db.run.create({ data: { agentId, status: "running", runStepsLevel: "detail" } });
      const writer = buildRunStepWriter(db, cipher, { WARDBY_RUN_STEPS: "detail" });

      // What the loader knew when the call began: the first tokens only.
      const atStart = (await loadAgentSecretValues(db, cipher, agentId)).flatMap((e) => e.values);
      expect(atStart).toContain("fake-access-1");
      expect(atStart).not.toContain("fake-access-2");

      // The call refreshes mid-way and mints the second pair.
      const accessor = buildSecretsAccessor(agentId, cipher, db, { options: OPTS });
      expect((await accessor.resolve!("STEP_TOK"))?.value).toBe("fake-access-2");

      await writer.record(run.id, {
        steps: [
          {
            kind: "tool",
            callId: "call-1",
            tool: "mcp__bs__echo",
            text: "echo fake-access-2",
            input: JSON.stringify({ auth: "fake-access-2", refresh: "fake-refresh-2" }),
            truncated: false,
          },
        ],
        results: [{ callId: "call-1", status: "ok", output: "server said fake-access-2 and fake-refresh-2" }],
      });
      const rows = await db.runStep.findMany({ where: { runId: run.id } });
      expect(rows).toHaveLength(1);
      const stored = JSON.stringify(rows);
      expect(stored).toContain("[REDACTED]");
      for (const leak of ["fake-access-2", "fake-refresh-2", "fake-access-1", "fake-refresh-1"]) {
        expect(stored).not.toContain(leak);
      }
    });

    it("redaction lists read attached OAuth secrets as stored: no refresh, and reauth_required still listed", async () => {
      const ownerId = await owner();
      const due = await connectAs(ownerId, "list-due", 30);
      const broken = await connectAs(ownerId, "list-broken");
      await db.secret.update({
        where: { id: broken.id },
        data: { oauth: { ...metaOf(broken.oauth), status: "reauth_required", reauthReason: "invalid_grant" } },
      });
      const agentId = await agentOf(ownerId);
      await db.agentSecret.create({ data: { agentId, secretId: due.id, boundName: "DUE" } });
      await db.agentSecret.create({ data: { agentId, secretId: broken.id, boundName: "BROKEN" } });
      const dueTokens = Object.values(await payloadOf(due.ciphertext));
      const brokenTokens = Object.values(await payloadOf(broken.ciphertext));
      expect(dueTokens.length + brokenTokens.length).toBe(4);

      const named = await loadAgentSecretValues(db, cipher, agentId);
      const byName = new Map(named.map((n) => [n.name, n.values]));
      expect(byName.get("DUE")).toEqual(expect.arrayContaining(dueTokens));
      expect(byName.get("BROKEN")).toEqual(expect.arrayContaining(brokenTokens));

      const accessor = buildSecretsAccessor(agentId, cipher, db, { options: OPTS });
      const listed = await readRedactionValues(accessor, ["DUE", "BROKEN"]);
      expect(listed).toEqual(expect.arrayContaining([...dueTokens, ...brokenTokens]));
      expect(listed.some((v) => v.includes("accessToken"))).toBe(false);

      expect(fake.tokenRequests).toBe(0);
      expect(metaOf((await row(ownerId, "list-due")).oauth).status).toBe("connected");
      // Only an actual use refreshes or fails.
      await expect(accessor.resolve!("BROKEN")).rejects.toThrow(SECRET_REAUTH_REQUIRED("list-broken"));
      expect((await accessor.resolve!("DUE"))?.value).toBe("fake-access-3");
      expect(fake.tokenRequests).toBe(1);
    });

    it("marks an access token past its expiry with no refresh token reauth_required (expired), with an audit row", async () => {
      const { ownerId, read } = await connected("expired");
      const current = await read();
      await withoutRefreshToken(current.id, current.oauth, -1000);
      const error = await decryptEntry(db, cipher, await read(), { options: OPTS }).catch((e: unknown) => e);
      expect((error as Error).message).toBe(SECRET_REAUTH_REQUIRED("expired"));
      expect((error as Error).cause).toBeUndefined();
      expect(fake.tokenRequests).toBe(0);
      expect(metaOf((await read()).oauth)).toMatchObject({ status: "reauth_required", reauthReason: "expired" });
      const change = await db.secretBrokerChange.findFirstOrThrow({
        where: { secretId: current.id },
        orderBy: { createdAt: "desc" },
      });
      expect(change).toMatchObject({ ownerId, secretName: "expired", actorId: ownerId });
      expect(change.before).toMatchObject({ oauthStatus: "connected" });
      expect(change.after).toMatchObject({ oauthStatus: "reauth_required" });
      expect(logText()).toContain("expired");
      expect(logText()).not.toContain("fake-");
    });

    it("sends an access token inside the early window with no refresh token as is", async () => {
      const { read } = await connected("window");
      const current = await read();
      await withoutRefreshToken(current.id, current.oauth, 30_000);
      const entry = await decryptEntry(db, cipher, await read(), { options: OPTS });
      expect(entry.value).toBe("fake-access-norefresh");
      expect(fake.tokenRequests).toBe(0);
      expect(metaOf((await read()).oauth).status).toBe("connected");
      expect(await db.secretBrokerChange.count({ where: { secretId: current.id } })).toBe(1); // the connect's
    });

    /**
     * Holds every token request until the test calls `release`; `arrived` settles when the first one
     * reaches the provider. Everything else goes straight to the fake. No timer is involved.
     */
    function gatedToken() {
      let arrive!: () => void;
      const arrived = new Promise<void>((r) => (arrive = r));
      let open!: () => void;
      const opened = new Promise<void>((r) => (open = r));
      const signals: Array<AbortSignal | undefined> = [];
      const fetchImpl: typeof safeFetch = async (url, init, options) => {
        if (url.endsWith("/token")) {
          signals.push(options?.signal);
          arrive();
          await opened;
        }
        return safeFetch(url, init, options);
      };
      return { fetchImpl, arrived, release: open, signals };
    }

    /**
     * Connections blocked by one specific backend. Scoped to the lock holder so a waiter from another
     * test file (or a stale one) sharing this database can never satisfy the check.
     */
    async function lockWaitersBlockedBy(holderPid: number): Promise<number> {
      const rows = await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${holderPid} = ANY(pg_blocking_pids(pid))`;
      return rows[0].n;
    }

    /** The backend holding the row lock on a Secret, found through the locking transaction id (row xmax). */
    async function rowLockHolderPid(id: string): Promise<number> {
      const rows = await db.$queryRaw<{ pid: number }[]>`
        SELECT l.pid::int AS pid FROM "Secret" s
        JOIN pg_locks l ON l.locktype = 'transactionid' AND l.granted AND l.transactionid::text = s.xmax::text
        WHERE s."id" = ${id}`;
      if (rows.length !== 1) throw new Error("the row lock holder is not visible yet");
      return rows[0].pid;
    }

    it("a caller that waited for the lock refreshes within its budget, and the newest refresh token is stored", async () => {
      const { read } = await connected("slow-ok", 30);
      // Every refreshed token is also due, so the waiter must refresh again after the lock.
      fake.accessTtlSeconds = 30;
      const stale = await read();
      const gate = gatedToken();
      const fetchImpl = gate.fetchImpl;
      // Separate single-flight tables: the two callers act as two processes, meeting at the row lock.
      const first = decryptEntry(db, cipher, stale, { options: OPTS, fetchImpl, flights: new Map() });
      // The first holds the lock and its request is at the provider; the second then queues for the lock.
      await gate.arrived;
      const holderPid = await rowLockHolderPid(stale.id);
      const second = decryptEntry(db, cipher, stale, { options: OPTS, fetchImpl, flights: new Map() });
      await until(async () => (await lockWaitersBlockedBy(holderPid)) > 0);
      gate.release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.value).toBe("fake-access-2");
      expect(b.value).toBe("fake-access-3");
      expect(fake.tokenRequests).toBe(2);
      const after = await read();
      expect((await payloadOf(after.ciphertext)).refreshToken).toBe("fake-refresh-3");
      expect(metaOf(after.oauth).status).toBe("connected");
    }, 20_000);

    it("a caller whose lock wait runs out gets the retryable error, and the holder's rotated token is kept", async () => {
      const { read } = await connected("slow-wait", 30);
      fake.accessTtlSeconds = 30;
      const stale = await read();
      const gate = gatedToken();
      const fetchImpl = gate.fetchImpl;
      // Separate single-flight tables: the two callers act as two processes, meeting at the row lock.
      const first = decryptEntry(db, cipher, stale, { options: OPTS, fetchImpl, flights: new Map() });
      await gate.arrived;
      // The holder's request stays at the provider until the test releases it, after the waiter has
      // given up at the 4 s lock timeout (database time): no timer in the test decides the order.
      const second = await decryptEntry(db, cipher, stale, {
        options: OPTS,
        fetchImpl,
        flights: new Map(),
      }).catch((e: unknown) => e);
      gate.release();
      expect((second as Error).message).toBe(SECRET_OAUTH_REFRESH_UNAVAILABLE);
      expect((second as { retryable?: boolean }).retryable).toBe(true);
      expect((second as Error).cause).toBeUndefined();
      expect((await first).value).toBe("fake-access-2");
      expect(fake.tokenRequests).toBe(1);
      const after = await read();
      expect((await payloadOf(after.ciphertext)).refreshToken).toBe("fake-refresh-2");
      expect(metaOf(after.oauth).status).toBe("connected");
      expect(logText()).toContain("lock_timeout");
      expect(logText()).not.toContain("fake-");
    }, 20_000);

    it("gives the retryable error, with no Prisma text, when another transaction holds the lock past 4 s", async () => {
      const { read } = await connected("held", 30);
      const stale = await read();
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      const holder = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Secret" WHERE "id" = ${stale.id} FOR UPDATE`;
          locked();
          await released;
        },
        { timeout: 15_000 },
      );
      await isLocked;
      try {
        const started = performance.now();
        const error = await decryptEntry(db, cipher, stale, { options: OPTS }).catch((e: unknown) => e);
        // It waited for the lock (the 4 s lock timeout) rather than failing at once; a wide margin.
        expect(performance.now() - started).toBeGreaterThanOrEqual(3000);
        expect((error as Error).message).toBe(SECRET_OAUTH_REFRESH_UNAVAILABLE);
        expect((error as { retryable?: boolean }).retryable).toBe(true);
        expect((error as Error).cause).toBeUndefined();
        expect(fake.tokenRequests).toBe(0);
        expect(logText()).toContain("lock_timeout");
        expect(logText()).not.toMatch(/prisma|55P03|fake-/i);
      } finally {
        release();
        await holder;
      }
      expect((await read()).ciphertext).toBe(stale.ciphertext);
    }, 20_000);

    it("refuses, sending no request, when less than 3 s would be left for the token request", async () => {
      const { read } = await connected("no-budget", 30);
      const before = await read();
      // The first reading starts the budget; every later one is 15 s on, leaving 5 s - 3 s = 2 s.
      let calls = 0;
      const clock = () => (calls++ === 0 ? 0 : 15_000);
      const error = await decryptEntry(db, cipher, before, { options: OPTS, clock }).catch((e: unknown) => e);
      expect((error as Error).message).toBe(SECRET_OAUTH_REFRESH_UNAVAILABLE);
      expect((error as { retryable?: boolean }).retryable).toBe(true);
      expect(fake.tokenRequests).toBe(0);
      const after = await read();
      expect(after.ciphertext).toBe(before.ciphertext);
      expect(metaOf(after.oauth).status).toBe("connected");
    });

    describe("the token request's timeout from what is left of the transaction", () => {
      /** A clock that reads 0 at the budget's start and `lockedAtMs` once the lock is held. */
      const clockAt = (lockedAtMs: number) => {
        let calls = 0;
        return () => (calls++ === 0 ? 0 : lockedAtMs);
      };
      /** Records the timeout each token request is given; the request then goes to the fake. */
      function timeoutRecorder() {
        const timeouts: Array<number | undefined> = [];
        const fetchImpl: typeof safeFetch = async (url, init, options) => {
          if (url.endsWith("/token")) timeouts.push(options?.timeoutMs);
          return safeFetch(url, init, options);
        };
        return { timeouts, fetchImpl };
      }

      it("gives the full 15 s when the lock was won at once", async () => {
        const { read } = await connected("timeout-full", 30);
        const rec = timeoutRecorder();
        await decryptEntry(db, cipher, await read(), { options: OPTS, fetchImpl: rec.fetchImpl, clock: clockAt(0) });
        expect(rec.timeouts).toEqual([15_000]);
      });

      it("gives a reduced timeout (what is left less the 3 s commit margin) after a long lock wait", async () => {
        const { read } = await connected("timeout-reduced", 30);
        const rec = timeoutRecorder();
        // Locked 13 s in: 20 s - 13 s = 7 s left, less 3 s to commit = 4 s, inside 3 s <= t < 15 s.
        await decryptEntry(db, cipher, await read(), {
          options: OPTS,
          fetchImpl: rec.fetchImpl,
          clock: clockAt(13_000),
        });
        expect(rec.timeouts).toEqual([4000]);
      });

      it("aborts a provider slower than the reduced timeout, well before the transaction expires", async () => {
        const { read } = await connected("timeout-slow", 30);
        const current = await read();
        // A provider that accepts the request and never answers.
        const stalled = createServer(() => undefined);
        await new Promise<void>((r) => stalled.listen(0, "127.0.0.1", r));
        const port = (stalled.address() as AddressInfo).port;
        try {
          await db.secret.update({
            where: { id: current.id },
            data: { oauth: { ...metaOf(current.oauth), tokenEndpoint: `http://${HOST}:${port}/token` } },
          });
          const before = await read();
          const started = performance.now();
          // Locked 14 s in: 20 s - 14 s = 6 s left, less the 3 s margin = the 3 s floor, a real timeout.
          const error = await decryptEntry(db, cipher, before, {
            options: OPTS,
            clock: clockAt(14_000),
          }).catch((e: unknown) => e);
          expectRetryable(error);
          // Ended by the request's own timeout, not the 20 s transaction one: a wide margin either side.
          const elapsed = performance.now() - started;
          expect(elapsed).toBeGreaterThanOrEqual(2000);
          expect(elapsed).toBeLessThan(12_000);
          const after = await read();
          expect(after.ciphertext).toBe(before.ciphertext);
          expect(metaOf(after.oauth).status).toBe("connected");
        } finally {
          stalled.closeAllConnections();
          await new Promise((r) => stalled.close(r));
        }
      }, 20_000);

      it("refuses, sending nothing, at exactly the 3 s floor minus a millisecond", async () => {
        const { read } = await connected("timeout-floor", 30);
        const rec = timeoutRecorder();
        // 20 s - 14.001 s = 5.999 s left, less 3 s = 2.999 s: under the floor.
        const error = await decryptEntry(db, cipher, await read(), {
          options: OPTS,
          fetchImpl: rec.fetchImpl,
          clock: clockAt(14_001),
        }).catch((e: unknown) => e);
        expectRetryable(error);
        expect(rec.timeouts).toEqual([]);
        const edge = timeoutRecorder();
        await decryptEntry(db, cipher, await read(), {
          options: OPTS,
          fetchImpl: edge.fetchImpl,
          clock: clockAt(14_000),
        });
        expect(edge.timeouts).toEqual([3000]);
      });
    });

    it("logs rotated_unsaved when the provider refreshed but the new tokens could not be encrypted", async () => {
      const { read } = await connected("rotated", 30);
      const before = await read();
      const failing = { ...cipher, encrypt: async () => Promise.reject(new Error("kms said fake-access-2")) };
      const error = await decryptEntry(db, failing, before, { options: OPTS }).catch((e: unknown) => e);
      expect((error as Error).message).toBe(SECRET_OAUTH_CIPHER_FAILED);
      expect((error as { retryable?: boolean }).retryable).toBe(true);
      expect((error as Error).cause).toBeUndefined();
      expect(fake.tokenRequests).toBe(1);
      expect(logText()).toContain("rotated_unsaved");
      expect(logText()).toContain(before.id);
      expect(logText()).not.toContain("cipher_failed");
      expect(logText()).not.toContain("fake-");
      const after = await read();
      expect(after.ciphertext).toBe(before.ciphertext);
      expect(metaOf(after.oauth).status).toBe("connected");
    });

    /** The test database with a spy counting the transactions opened. */
    function countingDb() {
      const transaction = vi.fn((...args: unknown[]) =>
        (db.$transaction as (...a: unknown[]) => Promise<unknown>).apply(db, args),
      );
      return { db: { secret: db.secret, $transaction: transaction } as unknown as typeof db, transaction };
    }

    const expectRetryable = (error: unknown) => {
      expect((error as Error).message).toBe(SECRET_OAUTH_REFRESH_UNAVAILABLE);
      expect((error as { retryable?: boolean }).retryable).toBe(true);
      expect((error as Error).cause).toBeUndefined();
    };

    /** Waits until `check` holds, polling every 50 ms, up to `ms`. */
    async function until(check: () => boolean | Promise<boolean>, ms = 10_000) {
      const deadline = Date.now() + ms;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error("condition not met in time");
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    /** Holds the secret's row lock from another transaction until `release` is called. */
    async function holdLock(id: string) {
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let locked!: (pid: number) => void;
      const isLocked = new Promise<number>((r) => (locked = r));
      const holder = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Secret" WHERE "id" = ${id} FOR UPDATE`;
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
          locked(pid);
          await released;
        },
        { timeout: 15_000 },
      );
      const pid = await isLocked;
      return {
        pid,
        release: async () => {
          release();
          await holder;
        },
      };
    }

    it("a refresh already sent completes and stores the rotated token even when every caller stops", async () => {
      const { read } = await connected("abort-after-send", 30);
      const stale = await read();
      const flights = new Map();
      // The provider answers (and rotates) only when the test lets it, after the callers have stopped.
      const gate = gatedToken();
      const fetchImpl = gate.fetchImpl;
      const stops = [new AbortController(), new AbortController()];
      const stopped = stops.map((s) =>
        decryptEntry(db, cipher, stale, {
          options: { ...OPTS, signal: s.signal },
          fetchImpl,
          signal: s.signal,
          flights,
        }).catch((e: unknown) => e),
      );
      await gate.arrived;
      // A sent request carries no stop signal, the flight's or a caller's.
      expect(gate.signals).toEqual([undefined]);
      for (const s of stops) s.abort();
      // Both callers are released while the provider has still not answered.
      for (const e of await Promise.all(stopped)) expectRetryable(e);
      expect((await read()).ciphertext).toBe(stale.ciphertext);
      gate.release();
      // The abandoned refresh finishes in the background and its result is stored.
      await until(async () => (await read()).ciphertext !== stale.ciphertext);
      const after = await read();
      expect((await payloadOf(after.ciphertext)).refreshToken).toBe("fake-refresh-2");
      expect(metaOf(after.oauth).status).toBe("connected");
      expect(fake.tokenRequests).toBe(1);
      await until(() => flights.size === 0);
      expect(logText()).not.toContain("aborted");
      expect(logText()).not.toContain("rotated_unsaved");
      expect(logText()).not.toContain("fake-");
    }, 20_000);

    it("a stop before the token request is sent rolls back with no request, logged aborted", async () => {
      const { read } = await connected("abort-before-send", 30);
      const stale = await read();
      const lock = await holdLock(stale.id);
      const stop = new AbortController();
      let error: unknown;
      try {
        const pending = decryptEntry(db, cipher, stale, {
          options: OPTS,
          signal: stop.signal,
          flights: new Map(),
        }).catch((e: unknown) => e);
        // The refresh is waiting for the lock: it has not sent anything yet.
        await until(async () => (await lockWaitersBlockedBy(lock.pid)) > 0);
        stop.abort();
        error = await pending;
      } finally {
        await lock.release();
      }
      expectRetryable(error);
      await until(() => logText().includes("aborted"));
      expect(fake.tokenRequests).toBe(0);
      const after = await read();
      expect(after.ciphertext).toBe(stale.ciphertext);
      expect(metaOf(after.oauth).status).toBe("connected");
      expect(logText()).not.toContain("fake-");
    }, 20_000);

    it("a lock wait that runs out during a stop is logged lock_timeout, not aborted", async () => {
      const { read } = await connected("abort-lock-timeout", 30);
      const stale = await read();
      const lock = await holdLock(stale.id);
      try {
        const stop = new AbortController();
        const pending = decryptEntry(db, cipher, stale, {
          options: OPTS,
          signal: stop.signal,
          flights: new Map(),
        }).catch((e: unknown) => e);
        await until(async () => (await lockWaitersBlockedBy(lock.pid)) > 0);
        stop.abort();
        expectRetryable(await pending);
        // The abandoned flight's lock wait runs out (4 s) while the lock is still held.
        await until(() => logText().includes("lock_timeout"), 10_000);
        expect(logText()).not.toContain("aborted");
        expect(fake.tokenRequests).toBe(0);
      } finally {
        await lock.release();
      }
      expect((await read()).ciphertext).toBe(stale.ciphertext);
    }, 20_000);

    it("a caller whose signal is already aborted opens no transaction and sends no request", async () => {
      const { read } = await connected("abort-early", 30);
      const counted = countingDb();
      const stop = new AbortController();
      stop.abort();
      const error = await decryptEntry(counted.db, cipher, await read(), {
        options: OPTS,
        signal: stop.signal,
      }).catch((e: unknown) => e);
      expectRetryable(error);
      expect(counted.transaction).not.toHaveBeenCalled();
      expect(fake.tokenRequests).toBe(0);
    });

    it("shares one refresh among five concurrent resolves in one process: one transaction, one request", async () => {
      const { read } = await connected("single-flight", 30);
      const stale = await read();
      const counted = countingDb();
      const flights = new Map();
      const gate = gatedToken();
      const pending = Array.from({ length: 5 }, () =>
        decryptEntry(counted.db, cipher, stale, { options: OPTS, fetchImpl: gate.fetchImpl, flights }),
      );
      // The one request is at the provider, so every caller has joined it; none can start another.
      await gate.arrived;
      gate.release();
      const entries = await Promise.all(pending);
      expect(counted.transaction).toHaveBeenCalledTimes(1);
      expect(fake.tokenRequests).toBe(1);
      expect(new Set(entries.map((e) => e.value))).toEqual(new Set(["fake-access-2"]));
      expect(flights.size).toBe(0);
    });

    it("shares one refresh by default too (the process-wide table)", async () => {
      const { read } = await connected("single-flight-default", 30);
      const stale = await read();
      const counted = countingDb();
      const gate = gatedToken();
      const pending = Array.from({ length: 5 }, () =>
        decryptEntry(counted.db, cipher, stale, { options: OPTS, fetchImpl: gate.fetchImpl }),
      );
      await gate.arrived;
      gate.release();
      await Promise.all(pending);
      expect(counted.transaction).toHaveBeenCalledTimes(1);
      expect(fake.tokenRequests).toBe(1);
    });

    it("one caller's abort fails only that caller; the shared refresh goes on for the live ones", async () => {
      const { read } = await connected("abort-shared", 30);
      const stale = await read();
      const counted = countingDb();
      const flights = new Map();
      const gate = gatedToken();
      const fetchImpl = gate.fetchImpl;
      const stop = new AbortController();
      const stopped = decryptEntry(counted.db, cipher, stale, {
        options: OPTS,
        fetchImpl,
        signal: stop.signal,
        flights,
      }).catch((e: unknown) => e);
      const liveSignal = new AbortController().signal;
      const live = [
        decryptEntry(counted.db, cipher, stale, { options: OPTS, fetchImpl, flights, signal: liveSignal }),
        decryptEntry(counted.db, cipher, stale, { options: OPTS, fetchImpl, flights }),
      ];
      await gate.arrived;
      stop.abort();
      // The stopped caller is released while the provider has still not answered.
      expectRetryable(await stopped);
      gate.release();
      const entries = await Promise.all(live);
      expect(entries.map((e) => e.value)).toEqual(["fake-access-2", "fake-access-2"]);
      expect(counted.transaction).toHaveBeenCalledTimes(1);
      expect(fake.tokenRequests).toBe(1);
      expect(flights.size).toBe(0);
    }, 20_000);

    it("a caller arriving after the first one aborted joins the refresh, which keeps going for it", async () => {
      const { read } = await connected("abort-then-join", 30);
      const stale = await read();
      const flights = new Map();
      const gate = gatedToken();
      const fetchImpl = gate.fetchImpl;
      const stop = new AbortController();
      const first = decryptEntry(db, cipher, stale, { options: OPTS, fetchImpl, signal: stop.signal, flights }).catch(
        (e: unknown) => e,
      );
      const second = decryptEntry(db, cipher, stale, { options: OPTS, fetchImpl, flights });
      await gate.arrived;
      stop.abort();
      expectRetryable(await first);
      gate.release();
      expect((await second).value).toBe("fake-access-2");
      expect(fake.tokenRequests).toBe(1);
    }, 20_000);

    it("when every caller aborts, the shared refresh stops and the next call starts a new one", async () => {
      const { read } = await connected("abort-all", 30);
      const stale = await read();
      const counted = countingDb();
      const flights = new Map();
      // Hold the lock so the stop lands before the token request is sent (a sent one completes).
      const lock = await holdLock(stale.id);
      const stops = [new AbortController(), new AbortController()];
      let stopped: unknown[];
      try {
        const pending = stops.map((s) =>
          decryptEntry(counted.db, cipher, stale, {
            options: OPTS,
            signal: s.signal,
            flights,
          }).catch((e: unknown) => e),
        );
        await until(async () => (await lockWaitersBlockedBy(lock.pid)) > 0);
        for (const s of stops) s.abort();
        stopped = await Promise.all(pending);
      } finally {
        await lock.release();
      }
      for (const e of stopped) expectRetryable(e);
      // The entry is gone at once: a new caller does not join the stopped refresh.
      expect(flights.size).toBe(0);
      const entry = await decryptEntry(counted.db, cipher, stale, { options: OPTS, flights });
      expect(entry.value).toBe("fake-access-2");
      expect(counted.transaction).toHaveBeenCalledTimes(2);
      expect(fake.tokenRequests).toBe(1);
      await until(() => logText().includes("aborted"));
    }, 20_000);

    it("a failed shared refresh is not kept: the next call starts a new one", async () => {
      const { read } = await connected("flight-fails", 30);
      const stale = await read();
      const counted = countingDb();
      const flights = new Map();
      const failing = tokenAnswer(503, { error: "temporarily_unavailable" });
      const errors = await Promise.all(
        Array.from({ length: 3 }, () =>
          decryptEntry(counted.db, cipher, stale, { options: OPTS, fetchImpl: failing, flights }).catch(
            (e: unknown) => e,
          ),
        ),
      );
      for (const e of errors) expectRetryable(e);
      expect(counted.transaction).toHaveBeenCalledTimes(1);
      expect(flights.size).toBe(0);
      const entry = await decryptEntry(counted.db, cipher, stale, { options: OPTS, flights });
      expect(entry.value).toBe("fake-access-2");
      expect(counted.transaction).toHaveBeenCalledTimes(2);
      expect(fake.tokenRequests).toBe(1);
    });

    it("a forced refresh does not join an unforced one: each keys its own flight", async () => {
      const { read } = await connected("flight-keys", 30);
      const stale = await read();
      const counted = countingDb();
      const flights = new Map();
      const gate = gatedToken();
      const fetchImpl = gate.fetchImpl;
      const plainCall = decryptEntry(counted.db, cipher, stale, { options: OPTS, fetchImpl, flights });
      const forcedCall = decryptEntry(counted.db, cipher, stale, {
        options: OPTS,
        fetchImpl,
        flights,
        forceRefreshIfStill: "fake-access-1",
      });
      // One request is at the provider and the other flight queues for the row lock behind it.
      await gate.arrived;
      const holderPid = await rowLockHolderPid(stale.id);
      await until(async () => (await lockWaitersBlockedBy(holderPid)) > 0);
      gate.release();
      const [plain, forced] = await Promise.all([plainCall, forcedCall]);
      // Two flights, two transactions; the row lock still makes the second find the token refreshed.
      expect(counted.transaction).toHaveBeenCalledTimes(2);
      expect(fake.tokenRequests).toBe(1);
      expect([plain.value, forced.value]).toEqual(["fake-access-2", "fake-access-2"]);
    });

    it("the accessors pass a stop signal through to the refresh", async () => {
      const { ownerId, read } = await connected("accessor-abort", 30);
      const agentId = `oauth-agent-${randomUUID()}`;
      agentIds.push(agentId);
      await db.agent.create({
        data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId },
      });
      await db.agentSecret.create({ data: { agentId, secretId: (await read()).id, boundName: "BS" } });
      const stop = new AbortController();
      stop.abort();
      const accessor = buildSecretsAccessor(agentId, cipher, db, { options: OPTS });
      expectRetryable(await accessor.resolve!("BS", { signal: stop.signal }).catch((e: unknown) => e));
      expectRetryable(await accessor.refresh!("BS", "fake-access-1", { signal: stop.signal }).catch((e: unknown) => e));
      expect(fake.tokenRequests).toBe(0);

      // An MCP server's accessor: the load's signal, and a per-call one on refresh.
      const server = { id: "srv-abort", ownerId, name: "bs", url: fake.mcpUrl, secretNames: ["accessor-abort"] };
      const loadError = await loadServerSecrets(db, cipher, server, { options: OPTS, signal: stop.signal }).catch(
        (e: unknown) => e,
      );
      expect((loadError as Error).message).toBe(SECRET_OAUTH_REFRESH_UNAVAILABLE);
      expect((loadError as { retryable?: boolean }).retryable).toBe(true);
      expect(fake.tokenRequests).toBe(0);
      const { accessor: serverAccessor } = await loadServerSecrets(db, cipher, server, { options: OPTS });
      expect(fake.tokenRequests).toBe(1);
      const refreshError = await serverAccessor.refresh!("accessor-abort", "fake-access-2", {
        signal: stop.signal,
      }).catch((e: unknown) => e);
      expect((refreshError as Error).message).toBe(SECRET_OAUTH_REFRESH_UNAVAILABLE);
      expect((refreshError as { retryable?: boolean }).retryable).toBe(true);
      expect(fake.tokenRequests).toBe(1);
    });

    /** An MCP server on the resource's host, owned by a new owner and shared (use) with a guest. */
    async function sharedServer(name: string, secretName: string) {
      const ownerId = await owner();
      const guestId = await owner();
      await connectAs(ownerId, secretName);
      // Brokered secrets go only over https: the MCP side is a stand-in on the resource's host.
      const mcpUrl = `https://${HOST}/mcp`;
      const server = await db.mcpServer.create({
        data: {
          ownerId,
          name,
          url: mcpUrl,
          secretNames: [secretName],
          toolSnapshot: [{ name: "echo", description: "Echo.", inputSchema: { type: "object" } }],
        },
      });
      await db.resourceGrant.create({
        data: {
          resourceType: "mcp_server",
          resourceId: server.id,
          granteeKind: "principal",
          granteePrincipalId: guestId,
          granteeKey: `principal:${guestId}`,
          level: "use",
          source: "owner",
          grantedById: ownerId,
        },
      });
      const ownAgent = await agentOf(ownerId);
      const guestAgent = await agentOf(guestId);
      for (const [agentId, by] of [
        [ownAgent, ownerId],
        [guestAgent, guestId],
      ]) {
        await db.agentMcpServer.create({
          data: { agentId, serverId: server.id, allowedTools: ["echo"], attachedById: by },
        });
      }
      const call = async (agentId: string, fetchImpl: typeof safeFetch) => {
        const pin = (await loadMcpToolPins(db, agentId)).find((p) => p.toolName === "echo");
        if (!pin) throw new Error("no pin");
        const log = { info: vi.fn(), warn: vi.fn() };
        const out = await handleMcpTool(pin, "{}", {
          db,
          cipher,
          agentId,
          runId: `run-${randomUUID()}`,
          signal: new AbortController().signal,
          fetchImpl,
          log: log as never,
        });
        return { out, parsed: JSON.parse(out) as { error?: string; message?: string }, log };
      };
      return { ownerId, mcpUrl, ownAgent, guestAgent, call };
    }

    it("marks a token the resource rejects (401) with no refresh token reauth_required (rejected), before expiry", async () => {
      const { ownerId, mcpUrl, ownAgent, call } = await sharedServer("rj", "rejected");
      const current = await row(ownerId, "rejected");
      await withoutRefreshToken(current.id, current.oauth, 3600_000);
      const changesBefore = await db.secretBrokerChange.count({ where: { secretId: current.id } });
      logged.mockClear();
      // RFC 6750: the resource says the bearer token itself is invalid; the scheme's case doesn't matter.
      const mcp = fakeMcpServer(() => textResult("never"), {
        status: 401,
        headers: { "WWW-Authenticate": 'bEARER realm="mcp", error="invalid_token"' },
      });
      const fetchImpl: typeof safeFetch = async (url, init, options) => {
        if (url !== mcpUrl) throw new Error("unexpected request");
        return mcp.impl(url, init, options);
      };
      const { out, parsed, log } = await call(ownAgent, fetchImpl);
      expect(parsed).toEqual({ error: "mcp_server_error", message: SECRET_REAUTH_REQUIRED("rejected") });
      expect(parsed.message).toMatch(/^secret_reauth_required:/);
      expect(fake.tokenRequests).toBe(0);
      // One request with the rejected token, then no retry: nothing new to send.
      expect(mcp.seen).toHaveLength(1);
      const after = await row(ownerId, "rejected");
      expect(metaOf(after.oauth)).toMatchObject({ status: "reauth_required", reauthReason: "rejected" });
      expect(Date.parse(metaOf(after.oauth).expiresAt!)).toBeGreaterThan(Date.now());
      expect(await db.secretBrokerChange.count({ where: { secretId: current.id } })).toBe(changesBefore + 1);
      const change = await db.secretBrokerChange.findFirstOrThrow({
        where: { secretId: current.id },
        orderBy: { createdAt: "desc" },
      });
      expect(change).toMatchObject({ ownerId, secretName: "rejected", actorId: ownerId });
      expect(change.before).toMatchObject({ oauthStatus: "connected" });
      expect(change.after).toMatchObject({ oauthStatus: "reauth_required" });
      expect(logged.mock.calls).toContainEqual([
        { secretId: current.id, reason: "rejected" },
        "OAuth secret needs connecting again",
      ]);
      const everything = [out, logText(), JSON.stringify(log.info.mock.calls), JSON.stringify(log.warn.mock.calls)];
      for (const text of everything) expect(text).not.toContain("fake-access");
      // Once marked, it is not sent again.
      await expect(decryptEntry(db, cipher, after, { options: OPTS })).rejects.toThrow(
        SECRET_REAUTH_REQUIRED("rejected"),
      );
    });

    /** An agent with each named secret attached under the same name, and its accessor. */
    async function accessorFor(ownerId: string, names: string[]) {
      const agentId = await agentOf(ownerId);
      for (const name of names) {
        await db.agentSecret.create({ data: { agentId, secretId: (await row(ownerId, name)).id, boundName: name } });
      }
      return buildSecretsAccessor(agentId, cipher, db, { options: OPTS });
    }

    /** A brokered resource on the secrets' host: answers 401 (with `headers`) until `okAfter` requests. */
    function resource401(headers: Record<string, string>, okAfter = Infinity) {
      const seen: Record<string, string>[] = [];
      const fetchImpl: typeof safeFetch = async (url, init) => {
        if (!url.startsWith(`https://${HOST}/api`)) throw new Error("unexpected request");
        seen.push({ ...(init?.headers ?? {}) });
        const status = seen.length > okAfter ? 200 : 401;
        return {
          ok: status === 200,
          status,
          statusText: "",
          url,
          headers: status === 401 ? { "content-type": "text/plain", ...headers } : { "content-type": "text/plain" },
          bodyBase64: Buffer.from(status === 401 ? "denied" : "fine").toString("base64"),
        };
      };
      return { seen, fetchImpl };
    }

    it("a 401 without an RFC 6750 invalid_token leaves a secret with no refresh token connected and returns the 401", async () => {
      const ownerId = await owner();
      await connectAs(ownerId, "unattributed");
      const current = await row(ownerId, "unattributed");
      await withoutRefreshToken(current.id, current.oauth, 3600_000);
      const changesBefore = await db.secretBrokerChange.count({ where: { secretId: current.id } });
      const accessor = await accessorFor(ownerId, ["unattributed"]);
      const tokensBefore = fake.tokenRequests;
      for (const headers of [
        {} as Record<string, string>,
        { "www-authenticate": 'Bearer realm="api"' },
        { "www-authenticate": 'Bearer error="insufficient_scope"' },
        { "www-authenticate": 'Basic error="invalid_token"' },
      ]) {
        const resource = resource401(headers, 1);
        const out = (await brokeredFetch({
          url: `https://${HOST}/api/other-path`,
          init: { method: "GET" },
          secretNames: ["unattributed"],
          secrets: accessor,
          fetchImpl: resource.fetchImpl,
          policy: {},
          redactFromConsole: () => {},
        })) as { status: number; bodyBase64: string };
        expect(out.status).toBe(401);
        expect(Buffer.from(out.bodyBase64, "base64").toString()).toBe("denied");
        // Nothing new to send: no retry, even though the resource would now answer 200.
        expect(resource.seen).toHaveLength(1);
        expect(resource.seen[0].authorization).toBe("Bearer fake-access-norefresh");
      }
      expect(fake.tokenRequests).toBe(tokensBefore);
      const after = await row(ownerId, "unattributed");
      expect(metaOf(after.oauth).status).toBe("connected");
      expect(metaOf(after.oauth).reauthReason).toBeUndefined();
      expect(await db.secretBrokerChange.count({ where: { secretId: current.id } })).toBe(changesBefore);
    });

    it("a 401 for a request with two OAuth secrets marks neither, and refreshes and retries the one with a refresh token", async () => {
      const ownerId = await owner();
      await connectAs(ownerId, "two-norefresh");
      await connectAs(ownerId, "two-refresh");
      const bare = await row(ownerId, "two-norefresh");
      await withoutRefreshToken(bare.id, bare.oauth, 3600_000);
      // The second secret goes in its own header, so both placements fit one request.
      const other = await row(ownerId, "two-refresh");
      const otherBroker = parseSecretBrokerConfig(other.broker);
      await db.secret.update({
        where: { id: other.id },
        data: { broker: { ...otherBroker, placement: { kind: "header", name: "X-Other", format: "Bearer {value}" } } },
      });
      const usedBefore = (await payloadOf((await row(ownerId, "two-refresh")).ciphertext)).accessToken;
      const accessor = await accessorFor(ownerId, ["two-norefresh", "two-refresh"]);
      const tokensBefore = fake.tokenRequests;
      // Even an invalid_token 401 is not attributable to either secret when the request carried both.
      const resource = resource401({ "www-authenticate": 'Bearer error="invalid_token"' }, 1);
      const out = (await brokeredFetch({
        url: `https://${HOST}/api/two`,
        init: { method: "GET" },
        secretNames: ["two-norefresh", "two-refresh"],
        secrets: accessor,
        fetchImpl: resource.fetchImpl,
        policy: {},
        redactFromConsole: () => {},
      })) as { status: number };
      expect(out.status).toBe(200);
      expect(fake.tokenRequests).toBe(tokensBefore + 1);
      expect(resource.seen).toHaveLength(2);
      const usedAfter = (await payloadOf((await row(ownerId, "two-refresh")).ciphertext)).accessToken;
      expect(usedAfter).not.toBe(usedBefore);
      expect(resource.seen[0]).toMatchObject({
        authorization: "Bearer fake-access-norefresh",
        "x-other": `Bearer ${usedBefore}`,
      });
      expect(resource.seen[1]).toMatchObject({
        authorization: "Bearer fake-access-norefresh",
        "x-other": `Bearer ${usedAfter}`,
      });
      for (const name of ["two-norefresh", "two-refresh"]) {
        const meta = metaOf((await row(ownerId, name)).oauth);
        expect(meta.status).toBe("connected");
        expect(meta.reauthReason).toBeUndefined();
      }
    });

    it("a forced refresh for a token no longer stored leaves a secret with no refresh token connected", async () => {
      const { read } = await connected("rejected-stale");
      const current = await read();
      await withoutRefreshToken(current.id, current.oauth, 3600_000);
      const entry = await decryptEntry(db, cipher, await read(), {
        options: OPTS,
        forceRefreshIfStill: "fake-access-1",
      });
      expect(entry.value).toBe("fake-access-norefresh");
      expect(metaOf((await read()).oauth).status).toBe("connected");
    });

    it("a run stopped while its MCP secrets load stops waiting at once and says the call was stopped", async () => {
      const name = "stop-at-load";
      const { ownerId, ownAgent } = await sharedServer("stop-load", name);
      const current = await row(ownerId, name);
      const oauth = {
        ...metaOf(current.oauth),
        tokenEndpoint: `https://${HOST}/token`,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      };
      await db.secret.update({ where: { id: current.id }, data: { oauth } });
      // The token endpoint fails when the test says so, after the request reached it. A sent request
      // is not cut by the stop: it runs to its end in the background.
      let arrive!: () => void;
      const arrived = new Promise<void>((r) => (arrive = r));
      let fail!: () => void;
      const failing = new Promise<never>((_resolve, reject) => {
        fail = () => reject(new Error("fetch_cancelled_or_timeout"));
      });
      const fetchImpl: typeof safeFetch = async (url) => {
        if (!url.endsWith("/token")) throw new Error("unexpected request");
        arrive();
        return failing;
      };
      const pin = (await loadMcpToolPins(db, ownAgent)).find((p) => p.toolName === "echo");
      if (!pin) throw new Error("no pin");
      const stop = new AbortController();
      const log = { info: vi.fn(), warn: vi.fn() };
      const pending = handleMcpTool(pin, "{}", {
        db,
        cipher,
        agentId: ownAgent,
        runId: `run-${randomUUID()}`,
        signal: stop.signal,
        fetchImpl,
        log: log as never,
      });
      await arrived;
      stop.abort();
      // Settles while the token endpoint has still not answered: the stop does not wait for it.
      const out = await pending;
      expect(JSON.parse(out)).toEqual({ error: "mcp_call_timeout", message: "The call was stopped." });
      expect(out).not.toContain("fake-");
      // Nothing changed: the transaction rolled back.
      expect((await row(ownerId, name)).ciphertext).toBe(current.ciphertext);
      expect(metaOf((await row(ownerId, name)).oauth).status).toBe("connected");
      // The background request then fails and rolls back too, leaving the secret as it was.
      fail();
      // The background refresh failing is logged after its transaction rolled back.
      await until(() => logText().includes("refresh_unavailable"));
      expect((await row(ownerId, name)).ciphertext).toBe(current.ciphertext);
      expect(metaOf((await row(ownerId, name)).oauth).status).toBe("connected");
    }, 20_000);

    for (const when of ["load", "mid-call"] as const) {
      it(`a retryable refresh failure at ${when} gives a grantee the try-again message; the owner the specific one`, async () => {
        const name = `retry-${when}`;
        const { ownerId, mcpUrl, ownAgent, guestAgent, call } = await sharedServer(`rt-${when}`, name);
        const mcp = fakeMcpServer(() => textResult("never"));
        // Due, with an https token endpoint the handler's refresh (no fetch-policy override) will call.
        const makeDue = async () => {
          const current = await row(ownerId, name);
          const oauth = {
            ...metaOf(current.oauth),
            tokenEndpoint: `https://${HOST}/token`,
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          };
          await db.secret.update({ where: { id: current.id }, data: { oauth } });
        };
        // The token endpoint answers 503 (with token text in its body); the MCP side is the stand-in.
        const fetchImpl: typeof safeFetch = async (url, init, options) => {
          if (url.endsWith("/token")) {
            return {
              ok: false,
              status: 503,
              statusText: "",
              url,
              headers: { "content-type": "application/json" },
              bodyBase64: Buffer.from(JSON.stringify({ error: "fake-refresh-1" })).toString("base64"),
            };
          }
          if (url !== mcpUrl) throw new Error("unexpected request");
          if (when === "mid-call" && init?.body?.includes('"initialize"')) await makeDue();
          return mcp.impl(url, init, options);
        };
        if (when === "load") await makeDue();
        const guest = await call(guestAgent, fetchImpl);
        expect(guest.parsed).toEqual({ error: "mcp_server_error", message: SHARED_CREDENTIALS_RETRY_MESSAGE });
        expect(guest.out).not.toContain(name);
        expect(guest.out).not.toContain("fake-");
        if (when === "load") await makeDue();
        const own = await call(ownAgent, fetchImpl);
        expect(own.parsed).toEqual({ error: "mcp_server_error", message: SECRET_OAUTH_REFRESH_UNAVAILABLE });
        expect(metaOf((await row(ownerId, name)).oauth).status).toBe("connected");
        expect(logText()).not.toContain("fake-");
      });
    }

    it("a grantee whose call hits reauth mid-call gets the shared message; the owner gets the specific one", async () => {
      const ownerId = await owner();
      const guestId = await owner();
      await connectAs(ownerId, "midcall");
      // Brokered secrets go only over https: the MCP side is a stand-in on the resource's host.
      const mcpUrl = `https://${HOST}/mcp`;
      const mcp = fakeMcpServer(() => textResult("never"));
      const server = await db.mcpServer.create({
        data: {
          ownerId,
          name: "fk",
          url: mcpUrl,
          secretNames: ["midcall"],
          toolSnapshot: [{ name: "echo", description: "Echo.", inputSchema: { type: "object" } }],
        },
      });
      await db.resourceGrant.create({
        data: {
          resourceType: "mcp_server",
          resourceId: server.id,
          granteeKind: "principal",
          granteePrincipalId: guestId,
          granteeKey: `principal:${guestId}`,
          level: "use",
          source: "owner",
          grantedById: ownerId,
        },
      });
      const ownAgent = await agentOf(ownerId);
      const guestAgent = await agentOf(guestId);
      for (const [agentId, by] of [
        [ownAgent, ownerId],
        [guestAgent, guestId],
      ]) {
        await db.agentMcpServer.create({
          data: { agentId, serverId: server.id, allowedTools: ["echo"], attachedById: by },
        });
      }
      // Loading finds the token good; once initialize is sent, it expires with no refresh token, so
      // the next request's resolve marks the secret reauth_required (the handler's refresh has no
      // fetch-policy override, so it could not reach this http fake's token endpoint).
      const midCall: typeof safeFetch = async (url, init, options) => {
        if (url !== mcpUrl) throw new Error("unexpected request");
        if (init?.body?.includes('"initialize"')) {
          const current = await row(ownerId, "midcall");
          await withoutRefreshToken(current.id, current.oauth, -1000);
        }
        return mcp.impl(url, init, options);
      };
      const call = async (agentId: string) => {
        const pin = (await loadMcpToolPins(db, agentId)).find((p) => p.toolName === "echo");
        if (!pin) throw new Error("no pin");
        const log = { info: vi.fn(), warn: vi.fn() };
        const out = await handleMcpTool(pin, "{}", {
          db,
          cipher,
          agentId,
          runId: `run-${randomUUID()}`,
          signal: new AbortController().signal,
          fetchImpl: midCall,
          log: log as never,
        });
        return JSON.parse(out) as { error?: string; message?: string };
      };

      const guest = await call(guestAgent);
      expect(guest).toEqual({ error: "mcp_server_error", message: SHARED_CREDENTIALS_MESSAGE });
      expect(JSON.stringify(guest)).not.toContain("midcall");

      await connectAs(ownerId, "midcall"); // connected again, for the owner's own call
      const own = await call(ownAgent);
      expect(own).toEqual({ error: "mcp_server_error", message: SECRET_REAUTH_REQUIRED("midcall") });
      expect(fake.tokenRequests).toBe(0);
      // Each call got as far as initialize, then failed resolving the secret for the next request.
      expect(mcp.seen.filter((s) => s.method === "initialize")).toHaveLength(2);
      expect(mcp.seen.filter((s) => s.method === "tools/call")).toEqual([]);
      expect(metaOf((await row(ownerId, "midcall")).oauth)).toMatchObject({ reauthReason: "expired" });
    });
  });

  describe("guards, listing and revoking on delete", () => {
    async function connectedSecret(name: string, fetchImpl?: typeof safeFetch) {
      const ownerId = await owner();
      const { outcome } = await connect(ownerId, name, { fetchImpl });
      if (outcome.kind !== "confirm") throw new Error("unreachable");
      await confirmCode(ownerId, name, outcome.code);
      const row = await db.secret.findUniqueOrThrow({ where: { ownerId_name: { ownerId, name } } });
      const payload = JSON.parse(await cipher.decrypt(row.ciphertext)) as { accessToken: string; refreshToken: string };
      logged.mockClear();
      return { ownerId, row, payload };
    }
    const logText = () => JSON.stringify(logged.mock.calls);

    it("refuses a typed value and a broker change on an OAuth secret", async () => {
      const { ownerId, row } = await connectedSecret("guarded");
      await expect(createSecret("guarded", "typed-by-hand-value", ownerId, cipher, db)).rejects.toThrow(
        SECRET_OAUTH_MANAGED,
      );
      await expect(
        setSecretBroker(db, cipher, {
          ownerId,
          name: "guarded",
          broker: null,
          actorId: ownerId,
          via: "mcp",
        }),
      ).rejects.toThrow(SECRET_OAUTH_MANAGED);
      const after = await db.secret.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.ciphertext).toBe(row.ciphertext);
      expect(after.broker).toEqual(row.broker);
    });

    it("refuses the browser form's value for an OAuth secret's name", async () => {
      const { ownerId, row } = await connectedSecret("formguard");
      const out = await fulfillSecretElicitation(
        { ownerId, secretName: "formguard", kind: "create" },
        "typed-in-the-form-value",
        cipher,
        db,
      );
      expect(out).toMatchObject({ ok: false, error: SECRET_OAUTH_MANAGED });
      const after = await db.secret.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.ciphertext).toBe(row.ciphertext);
      await db.secretElicitationOutcome.deleteMany({ where: { ownerId } });
    });

    it("lists kind oauth with status and expiry, and kind value for the rest, with no value or client id", async () => {
      const { ownerId, payload } = await connectedSecret("listed");
      await createSecret("plain-one", "plain-fake-value-123456", ownerId, cipher, db);
      const list = await listSecrets(ownerId, db);
      const oauth = list.find((s) => s.name === "listed")!;
      expect(oauth.kind).toBe("oauth");
      expect(oauth.oauth).toEqual({
        resource: fake.mcpUrl,
        status: "connected",
        expiresAt: expect.stringMatching(/^\d{4}-/),
        connectedAt: expect.stringMatching(/^\d{4}-/),
      });
      expect(list.find((s) => s.name === "plain-one")!.kind).toBe("value");
      const text = JSON.stringify(list);
      for (const v of [
        payload.accessToken,
        payload.refreshToken,
        "ciphertext",
        "clientId",
        "fake-client-",
        "tokenEndpoint",
      ]) {
        expect(text).not.toContain(v);
      }
    });

    it("revokes the refresh token, then the access token, then deletes and audits", async () => {
      const { ownerId, row, payload } = await connectedSecret("revoked");
      const rec = recordingFetch();
      await deleteSecret(row.id, db, { cipher, fetchImpl: rec.impl, options: OPTS, actorId: ownerId });
      const revokes = rec.requests.filter((r) => r.url.endsWith("/revoke"));
      expect(revokes).toHaveLength(2);
      expect(revokes[0].body).toContain(`token=${payload.refreshToken}`);
      expect(revokes[1].body).toContain(`token=${payload.accessToken}`);
      expect(fake.revoked.has(payload.refreshToken)).toBe(true);
      expect(await db.secret.findUnique({ where: { id: row.id } })).toBeNull();
      const all = await db.secretBrokerChange.findMany({ where: { secretId: row.id }, orderBy: { createdAt: "asc" } });
      expect(all).toHaveLength(2); // the connect, then the disconnect
      const audit = all.slice(1);
      expect(audit[0]).toMatchObject({ after: null, via: "mcp", actorId: ownerId });
      expect(audit[0].before).toMatchObject({ oauthStatus: "connected" });
      expect(JSON.stringify(audit)).not.toContain(payload.accessToken);
    });

    it("still deletes when the provider answers 5xx, logging no token", async () => {
      const { ownerId, row, payload } = await connectedSecret("revoke5xx");
      const failing: typeof safeFetch = async (url, init, options) =>
        url.endsWith("/revoke")
          ? {
              ok: false,
              status: 503,
              statusText: "Service Unavailable",
              url,
              headers: {},
              bodyBase64: Buffer.from(`oops ${payload.refreshToken}`).toString("base64"),
            }
          : safeFetch(url, init, options);
      await deleteSecret(row.id, db, { cipher, fetchImpl: failing, options: OPTS, actorId: ownerId });
      expect(await db.secret.findUnique({ where: { id: row.id } })).toBeNull();
      expect(logged).toHaveBeenCalled();
      expect(logText()).not.toContain(payload.refreshToken);
      expect(logText()).not.toContain(payload.accessToken);
      expect(logText()).toContain(row.id);
    });

    it("still deletes when the cipher fails, logging cipher_failed", async () => {
      const { ownerId, row } = await connectedSecret("revokecipher");
      const broken = {
        ...cipher,
        decrypt: async () => {
          throw new Error("kms said sk-secret-detail");
        },
      };
      await deleteSecret(row.id, db, { cipher: broken, options: OPTS, actorId: ownerId });
      expect(await db.secret.findUnique({ where: { id: row.id } })).toBeNull();
      expect(logText()).toContain("cipher_failed");
      expect(logText()).not.toContain("sk-secret-detail");
    });
  });
});
