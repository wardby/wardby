import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildMcpServer } from "../server.js";
import type { McpRequestContext } from "../context.js";
import { registerWhoamiTool } from "./whoami.js";

const CANONICAL_URI = "https://host/mcp";
const FAKE_TOKEN = "fake-bearer-token-DO-NOT-LEAK-7c1e";

function fakeDb(profileName: string | null) {
  return {
    principal: { findMany: async () => [{ id: "p1", subject: "ada" }] },
    principalProfile: {
      findMany: async () => (profileName ? [{ principalId: "p1", displayName: profileName }] : []),
    },
    hostIdentity: { findMany: async () => [] },
  } as never;
}

async function call(ctx: Partial<McpRequestContext>, profileName: string | null = "Ada Lovelace") {
  const providers = {} as McpRequestContext["providers"];
  const db = fakeDb(profileName);
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL_URI } });
  mcp.setFixedContext({
    principal: { id: "p1", subject: "ada", createdAt: new Date() },
    scopes: new Set(["agents:read"]),
    canonicalUri: CANONICAL_URI,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
    ...ctx,
  });
  registerWhoamiTool(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "whoami", arguments: {} });
  await client.close();
  return (result.content as { text: string }[])[0].text;
}

describe("whoami", () => {
  it("reports the principal, token identity claims, roles, scopes and teams", async () => {
    const text = await call({
      tokenIdentity: { sub: "ada", uid: "00u-fake", cid: "https://client.example/metadata" },
      roles: ["viewer", "admin"],
      scopes: new Set(["documents:read", "agents:read"]),
      teamIds: ["team-1"],
    });
    expect(JSON.parse(text)).toEqual({
      principal: { id: "p1", subject: "ada", name: "Ada Lovelace" },
      subjectFrom: { claim: "sub" },
      token: { sub: "ada", uid: "00u-fake", cid: "https://client.example/metadata" },
      roles: ["admin", "viewer"],
      scopes: ["agents:read", "documents:read"],
      teamIds: ["team-1"],
      operator: false,
    });
    expect(text).not.toContain(FAKE_TOKEN);
  });

  it("reports no token claims for the stdio operator", async () => {
    const parsed = JSON.parse(await call({ operator: true }, null));
    expect(parsed.token).toBeNull();
    expect(parsed.operator).toBe(true);
    // No profile and no GitHub link: the short subject fallback (core/documents/names.ts).
    expect(parsed.principal.name).toBe("user·ada");
  });
});
