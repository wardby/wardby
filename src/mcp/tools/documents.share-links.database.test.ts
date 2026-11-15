/**
 * Share-link MCP tools against real PostgreSQL: owner-only, the URL is
 * returned once and never listed, revoke. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { createDocument } from "../../core/documents/service.js";
import type { McpProviders, McpRequestContext } from "../context.js";
import { buildMcpServer } from "../server.js";
import { registerDocumentTools } from "./documents.js";

describe.skipIf(!process.env.DATABASE_URL)("share-link MCP tools (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID();
  let owner: Principal;
  let other: Principal;
  let docId: string;

  async function connect(p: Principal, scopes: string[] = ["documents:read", "documents:write"]) {
    const providers = { secrets: cipher } as unknown as McpProviders;
    const canonicalUri = "https://wardby.example/mcp";
    const mcp = buildMcpServer({ providers, db, config: { canonicalUri } });
    const ctx: McpRequestContext = {
      principal: p,
      scopes: new Set(scopes),
      roles: [],
      canonicalUri,
      providers,
      db,
      clientSupportsTasks: false,
      mcpReq: { requestState: () => undefined },
    };
    mcp.setFixedContext(ctx);
    registerDocumentTools(mcp);
    const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      const text = result.content[0].text;
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        // an error message
      }
      return { isError: Boolean(result.isError), text, json };
    };
  }

  beforeAll(async () => {
    owner = await db.principal.create({ data: { subject: `slmcp-owner-${s}` } });
    other = await db.principal.create({ data: { subject: `slmcp-other-${s}` } });
    docId = (await createDocument(db, cipher, { ownerId: owner.id, title: "T", markdown: "x" })).id;
  });
  afterAll(async () => {
    await db.document.deleteMany({ where: { ownerId: owner.id } });
    await db.principal.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
    await db.$disconnect();
  });

  it("creates a link once, lists it without the URL, and revokes it", async () => {
    const call = await connect(owner);
    const created = await call("create_share_link", { documentId: docId, permission: "comment", expiresInDays: 7 });
    expect(created.isError).toBe(false);
    expect(created.json.url).toMatch(/^https:\/\/wardby\.example\/s\/[A-Za-z0-9_-]{43}$/);
    const token = created.json.url.split("/s/")[1];

    const listed = await call("list_share_links", { documentId: docId });
    expect(listed.text).not.toContain(token);
    expect(listed.json).toEqual([
      expect.objectContaining({ id: created.json.id, permission: "comment", revoked: false, guestCount: 0 }),
    ]);

    const revoked = await call("revoke_share_link", { shareLinkId: created.json.id });
    expect(revoked.json).toEqual({ revoked: created.json.id });
    expect((await call("list_share_links", { documentId: docId })).json[0].revoked).toBe(true);
  });

  it("refuses non-owners and bad arguments", async () => {
    const mine = await connect(owner);
    const link = (await mine("create_share_link", { documentId: docId, permission: "view" })).json;
    const theirs = await connect(other);
    expect((await theirs("create_share_link", { documentId: docId, permission: "view" })).isError).toBe(true);
    expect((await theirs("list_share_links", { documentId: docId })).isError).toBe(true);
    const revoke = await theirs("revoke_share_link", { shareLinkId: link.id });
    expect(revoke.isError).toBe(true);
    expect(revoke.text).toContain("share_link_not_found");
    expect((await mine("create_share_link", { documentId: docId, permission: "everyone" })).isError).toBe(true);
    expect(
      (await mine("create_share_link", { documentId: docId, permission: "view", expiresInDays: 91 })).isError,
    ).toBe(true);
  });

  it("needs the documents scopes", async () => {
    const call = await connect(owner, ["agents:read"]);
    expect((await call("list_share_links", { documentId: docId })).isError).toBe(true);
  });
});
