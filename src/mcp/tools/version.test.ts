import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildMcpServer } from "../server.js";
import type { McpRequestContext } from "../context.js";
import { packageVersion } from "../../core/version.js";
import { registerVersionTool } from "./version.js";

const CANONICAL_URI = "https://host/mcp";
const fakeDb = {} as never;

async function connect(version?: () => string) {
  const providers = {} as McpRequestContext["providers"];
  const mcp = buildMcpServer({ providers, db: fakeDb, config: { canonicalUri: CANONICAL_URI } });
  mcp.setFixedContext({
    principal: { id: "p1", subject: "p1", createdAt: new Date() },
    scopes: new Set(["agents:read"]),
    canonicalUri: CANONICAL_URI,
    providers,
    db: fakeDb,
    operator: true,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  });
  registerVersionTool(mcp, version);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("get_version", () => {
  it("returns the version it is given", async () => {
    const client = await connect(() => "1.2.3");
    const result = await client.callTool({ name: "get_version", arguments: {} });
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ version: "1.2.3" });
  });

  it("defaults to the installed package version", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "get_version", arguments: {} });
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ version: packageVersion() });
  });
});
