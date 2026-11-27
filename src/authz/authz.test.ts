import { describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../mcp/server.js";
import type { McpRequestContext } from "../mcp/context.js";
import { SCOPES_SUPPORTED, authenticate, isOwnerAll } from "../mcp/auth/resource-server.js";
import type { AuthProvider, VerifiedToken } from "../providers/auth/types.js";
import { fakeResourceGrants } from "../core/grants.test-support.js";
import { PERMISSION_TIER, TIER_SCOPES, VIEWER_SCOPE, scopesCover } from "./tiers.js";

/**
 * The seam is a tool call through the MCP server with a caller's token: build a
 * server with one synthetic tool per tier, call it, and assert the outcome a
 * real client would see.
 */
const URI = "https://host/mcp";
const providers = {} as unknown as import("../providers/index.js").ProviderRegistry;
/** The server lists shared agents as prompts when it builds, so the stand-in answers with none. */
const db = {
  resourceGrant: fakeResourceGrants([]),
  agent: { findMany: async () => [] },
} as unknown as import("#prisma").PrismaClient;

function ctxFor(scopes: string[], roles?: string[]): McpRequestContext {
  return {
    principal: { id: "p1", subject: "user-1", createdAt: new Date() },
    scopes: new Set(scopes),
    roles,
    canonicalUri: URI,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
}

/** One tool per permission under test, each answering "ok". */
const TOOLS = ["agents:read", "agents:write", "tools:write", "models:admin", "admin:view", "owner:all"] as const;

async function connect(ctx: McpRequestContext) {
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri: URI } });
  mcp.setFixedContext(ctx);
  for (const permission of TOOLS) {
    mcp.registerTool({
      name: permission,
      permission: permission,
      inputSchema: {},
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
  }
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(st);
  await client.connect(ct);
  return client;
}

type Outcome = "ok" | "insufficient_scope" | "forbidden";

async function call(ctx: McpRequestContext, tool: (typeof TOOLS)[number]): Promise<Outcome> {
  const client = await connect(ctx);
  try {
    const result = await client.callTool({ name: tool, arguments: {} });
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    if (!result.isError) return "ok";
    if (/Insufficient scope/.test(text)) return "insufficient_scope";
    if (/Forbidden/.test(text)) return "forbidden";
    throw new Error(`unexpected refusal: ${text}`);
  } finally {
    await client.close();
  }
}

describe("scope tiers at the tool-call seam", () => {
  it("a token carrying only the write tier can call a write tool", async () => {
    expect(await call(ctxFor([TIER_SCOPES.write]), "agents:write")).toBe("ok");
    expect(await call(ctxFor([TIER_SCOPES.write]), "tools:write")).toBe("ok");
  });

  it("a read-tier token gets insufficient_scope on a write tool", async () => {
    expect(await call(ctxFor([TIER_SCOPES.read]), "agents:write")).toBe("insufficient_scope");
  });

  it("tiers nest: each tier covers the ones below it", async () => {
    expect(await call(ctxFor([TIER_SCOPES.write]), "agents:read")).toBe("ok");
    expect(await call(ctxFor([TIER_SCOPES.admin]), "agents:write")).toBe("ok");
    expect(await call(ctxFor([TIER_SCOPES.owner]), "agents:read")).toBe("ok");
    expect(await call(ctxFor([TIER_SCOPES.write]), "models:admin")).toBe("insufficient_scope");
    expect(await call(ctxFor([TIER_SCOPES.admin]), "owner:all")).toBe("insufficient_scope");
  });

  it("the implicit member role grants non-privileged permissions without any role", async () => {
    for (const roles of [undefined, []]) {
      expect(await call(ctxFor([TIER_SCOPES.write], roles), "agents:write")).toBe("ok");
    }
  });

  it("a privileged permission needs a granting role as well as the admin tier", async () => {
    expect(await call(ctxFor([TIER_SCOPES.admin]), "models:admin")).toBe("forbidden");
    expect(await call(ctxFor([TIER_SCOPES.admin], ["model-manager"]), "models:admin")).toBe("ok");
    // A role without the tier still gets a scope challenge: re-authorizing is the fix.
    expect(await call(ctxFor([TIER_SCOPES.write], ["model-manager"]), "models:admin")).toBe("insufficient_scope");
  });

  it("legacy scope strings are accepted and mapped to their tier", async () => {
    expect(await call(ctxFor(["agents:write"]), "agents:write")).toBe("ok");
    expect(await call(ctxFor(["agents:write"]), "tools:write")).toBe("ok");
    expect(await call(ctxFor(["agents:read"]), "agents:write")).toBe("insufficient_scope");
    expect(await call(ctxFor(["models:admin"], ["model-manager"]), "models:admin")).toBe("ok");
    expect(await call(ctxFor(["models:admin"]), "models:admin")).toBe("forbidden");
  });

  it("the viewer scope, and the legacy admin:view, cover admin:view and nothing else", async () => {
    for (const scope of [VIEWER_SCOPE, "admin:view"]) {
      expect(await call(ctxFor([scope], ["viewer"]), "admin:view")).toBe("ok");
      expect(await call(ctxFor([scope], ["admin"]), "models:admin")).toBe("insufficient_scope");
      expect(await call(ctxFor([scope], ["admin"]), "agents:read")).toBe("insufficient_scope");
    }
  });

  it("the challenge still names the permission the operation needs", async () => {
    const client = await connect(ctxFor([TIER_SCOPES.read]));
    const result = await client.callTool({ name: "agents:write", arguments: {} });
    expect((result.content as { text: string }[])[0].text).toMatch(/requires: agents:write$/);
    await client.close();
  });
});

describe("the owner bypass needs the owner scope AND the wardby_owner role", () => {
  it("is held only with both", () => {
    expect(isOwnerAll(ctxFor([TIER_SCOPES.owner], ["wardby_owner"]))).toBe(true);
    expect(isOwnerAll(ctxFor(["owner:all"], ["wardby_owner"]))).toBe(true);
    expect(isOwnerAll(ctxFor([TIER_SCOPES.owner], ["admin"]))).toBe(false);
    expect(isOwnerAll(ctxFor([TIER_SCOPES.owner]))).toBe(false);
    expect(isOwnerAll(ctxFor([TIER_SCOPES.admin], ["wardby_owner"]))).toBe(false);
  });

  it("a wardby_owner holding the owner scope reaches every tier, and a role without the scope does not", async () => {
    const owner = ctxFor([TIER_SCOPES.owner], ["wardby_owner"]);
    for (const tool of TOOLS) expect(await call(owner, tool)).toBe("ok");
    expect(await call(ctxFor([TIER_SCOPES.admin], ["wardby_owner"]), "owner:all")).toBe("insufficient_scope");
  });
});

describe("the tier table", () => {
  it("maps exactly the advertised legacy scopes, so every legacy string has a tier", () => {
    expect(Object.keys(PERMISSION_TIER).sort()).toEqual([...SCOPES_SUPPORTED].sort());
  });

  it("refuses an unknown permission whatever the token carries", () => {
    expect(scopesCover([TIER_SCOPES.owner], "no:such")).toBe(false);
  });
});

describe("a context built from a verified token", () => {
  /** What every AuthProvider (delegating or self-hosted) hands back, so both modes arrive here identically. */
  function providerReturning(verified: VerifiedToken): AuthProvider {
    return {
      authorizeUrl: () => "",
      exchangeCode: async () => ({ idToken: "", accessToken: "" }),
      refresh: async () => ({ idToken: "", accessToken: "" }),
      profile: async () => ({ subject: "", roles: [] }),
      verifyBearer: async () => verified,
    };
  }
  const fakeDb = {
    principal: {
      upsert: vi.fn(async ({ where }: { where: { subject: string } }) => ({
        id: `principal-${where.subject}`,
        subject: where.subject,
        createdAt: new Date(),
      })),
    },
    teamMember: { findMany: vi.fn(async () => []) },
  } as unknown as import("#prisma").PrismaClient;

  it("carries the tier from the token and the role from the provider into the tool-call decision", async () => {
    const verified: VerifiedToken = {
      subject: "u",
      roles: [],
      wardbyRoles: ["model-manager"],
      scopes: [TIER_SCOPES.admin],
    };
    const ctx = await authenticate(
      { authorization: "Bearer t" },
      { authProvider: providerReturning(verified), db: fakeDb, providers, canonicalUri: URI },
    );
    expect(await call(ctx, "models:admin")).toBe("ok");
    expect(await call(ctx, "owner:all")).toBe("insufficient_scope");
  });
});
