import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { GitHubUserAuthorizer } from "../../providers/review-host/github-user-auth.js";
import { fakeGitHub, json } from "../../providers/review-host/github.test-support.js";
import type { HostUserAuthorizerRegistry } from "../../providers/review-host/types.js";
import type { McpProviders, McpRequestContext } from "../context.js";
import { handleHostUserCallback } from "../host-events/github-user-callback.js";
import { buildMcpServer } from "../server.js";
import { registerHostAccountTools } from "./host-accounts.js";

const db = createPrismaClient();
const principalIds: string[] = [];
const CANONICAL = "https://wardby.example/mcp";
const REDIRECT = "https://wardby.example/hosts/github/user-callback";
const CLIENT_ID = "Iv23liTestClient0001";

/** The real GitHub authorizer against a faked GitHub (web flow and API), answering as `login`/`id`. */
function githubAuthorizer(id: number, login: string): HostUserAuthorizerRegistry {
  const { client } = fakeGitHub(({ method, path }) => {
    if (method === "GET" && path === "/user") return json({ id, login, type: "User" });
    if (method === "DELETE" && path === `/applications/${CLIENT_ID}/token`) return new Response(null, { status: 204 });
    return undefined;
  });
  const web = vi.fn(async () => json({ access_token: "ghu_FakeUserToken0123456789abcdef", token_type: "bearer" }));
  return {
    github: new GitHubUserAuthorizer({
      client,
      clientId: CLIENT_ID,
      clientSecret: "test-secret-not-real-0000000000",
      fetch: web,
    }),
  };
}

async function principal(): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `host-account-${randomUUID()}` } });
  principalIds.push(p.id);
  return p;
}

async function connect(p: Principal, authorizers: HostUserAuthorizerRegistry | undefined, canonicalUri = CANONICAL) {
  const providers = { hostUserAuthorizers: authorizers } as unknown as McpProviders;
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri } });
  const ctx: McpRequestContext = {
    principal: p,
    scopes: new Set(["agents:read", "agents:write"]),
    roles: [],
    canonicalUri,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
  mcp.setFixedContext(ctx);
  registerHostAccountTools(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: Boolean(result.isError), text: result.content[0].text };
  };
  return { call, close: () => client.close() };
}

async function visitCallback(authorizeUrl: string, authorizers: HostUserAuthorizerRegistry): Promise<string> {
  const state = new URL(authorizeUrl).searchParams.get("state");
  let body = "";
  const res = {
    setHeader: () => undefined,
    writeHead: () => res,
    end: (b: string) => {
      body = b;
      return res;
    },
  } as unknown as ServerResponse;
  await handleHostUserCallback(new URL(`${REDIRECT}?code=gh-code&state=${state}`), res, {
    db,
    authorizer: authorizers.github!,
    redirectUri: REDIRECT,
  });
  return /([A-Z2-7]{4}-[A-Z2-7]{4})/.exec(body)?.[1] ?? "";
}

describe.skipIf(!process.env.DATABASE_URL)("host account MCP tools (PostgreSQL)", () => {
  afterAll(async () => {
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("links a GitHub account end to end: authorize URL, callback page code, confirmation", async () => {
    const p = await principal();
    const id = Math.floor(Math.random() * 1e9) + 1;
    const authorizers = githubAuthorizer(id, "octo");
    const { call, close } = await connect(p, authorizers);

    const started = await call("link_host_account");
    expect(started.isError).toBe(false);
    const { authorizeUrl, next } = JSON.parse(started.text) as { authorizeUrl: string; next: string };
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(next).toMatch(/confirmationCode/);

    const code = await visitCallback(authorizeUrl, authorizers);
    expect(code).not.toBe("");
    const linked = await call("link_host_account", { confirmationCode: code });
    expect(linked.isError).toBe(false);
    expect(JSON.parse(linked.text)).toMatchObject({ linked: true, provider: "github", login: "octo" });

    const got = JSON.parse((await call("get_host_account")).text) as { accounts: unknown[] };
    expect(got.accounts).toEqual([
      expect.objectContaining({ provider: "github", login: "octo", hostUserId: String(id) }),
    ]);
    await close();
  });

  it("says clearly when linking is not configured or the transport has no callback", async () => {
    const p = await principal();
    const off = await connect(p, {});
    const refused = await off.call("link_host_account");
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/GITHUB_APP_CLIENT_ID/);
    await off.close();

    const stdio = await connect(p, githubAuthorizer(1, "octo"), "urn:wardby:local-stdio");
    const noHttp = await stdio.call("link_host_account");
    expect(noHttp.isError).toBe(true);
    expect(noHttp.text).toMatch(/HTTP/);
    await stdio.close();
  });

  it("get_host_account and unlink_host_account act only on the caller", async () => {
    const a = await principal();
    const b = await principal();
    await db.hostIdentity.create({
      data: { principalId: a.id, provider: "github", hostUserId: `${Date.now()}1`, login: "a" },
    });
    await db.hostIdentity.create({
      data: { principalId: b.id, provider: "github", hostUserId: `${Date.now()}2`, login: "b" },
    });
    const asA = await connect(a, {});
    expect(JSON.parse((await asA.call("get_host_account")).text).accounts).toEqual([
      expect.objectContaining({ login: "a" }),
    ]);
    expect(JSON.parse((await asA.call("unlink_host_account")).text)).toEqual({ unlinked: true });
    expect(JSON.parse((await asA.call("unlink_host_account")).text)).toEqual({ unlinked: false });
    expect(JSON.parse((await asA.call("get_host_account")).text).accounts).toEqual([]);
    expect(await db.hostIdentity.count({ where: { principalId: b.id } })).toBe(1);
    await asA.close();
  });

  it("maps a wrong code to an error that counts attempts", async () => {
    const p = await principal();
    const authorizers = githubAuthorizer(Math.floor(Math.random() * 1e9) + 1, "octo");
    const { call, close } = await connect(p, authorizers);
    const { authorizeUrl } = JSON.parse((await call("link_host_account")).text) as { authorizeUrl: string };
    const code = await visitCallback(authorizeUrl, authorizers);
    const wrong = await call("link_host_account", { confirmationCode: code.startsWith("A") ? "BBBBBBBB" : "AAAAAAAA" });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/4 attempts left/);
    await close();
  });
});
