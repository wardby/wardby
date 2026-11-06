import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./db.js";
import { createSecret } from "./secrets.js";
import { fetchSnapshot, loadServerSecrets, mcpServersUsingSecret, McpServerInputError } from "./mcp-servers.js";
import type { safeFetch } from "../sandbox/safe-fetch.js";

describe.skipIf(!process.env.DATABASE_URL)("mcp server domain (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID();
  const owner = `mcpd-owner-${suffix}`;
  const other = `mcpd-other-${suffix}`;
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const SECRET = "sk-test-ABCDEF123456";
  const url = "https://mcp.example.com/mcp";
  const broker = (hosts: string[]) => ({
    hosts,
    placement: { kind: "header" as const, name: "Authorization", format: "Bearer {value}" },
  });
  const server = (secretNames: string[]) => ({ id: "s1", ownerId: owner, name: "datadog", url, secretNames });

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.principal.create({ data: { id: other, subject: other } });
    await createSecret("GOOD", SECRET, owner, cipher, db, { broker: broker(["mcp.example.com"]) });
    await createSecret("WRONGHOST", "wrong-host-secret-1", owner, cipher, db, { broker: broker(["api.example.com"]) });
    await createSecret("PLAIN", "plain-secret-value-1", owner, cipher, db);
    await createSecret("THEIRS", "theirs-secret-value-1", other, cipher, db, { broker: broker(["mcp.example.com"]) });
  });
  afterAll(async () => {
    await db.mcpServer.deleteMany({ where: { ownerId: owner } });
    await db.secretBrokerChange.deleteMany({ where: { ownerId: { in: [owner, other] } } });
    await db.secret.deleteMany({ where: { ownerId: { in: [owner, other] } } });
    await db.principal.deleteMany({ where: { id: { in: [owner, other] } } });
    await db.$disconnect();
  });

  it("refuses missing, foreign, un-brokered and wrong-host secrets, naming the secret", async () => {
    for (const [name, text] of [
      ["NOPE", 'Secret "NOPE"'],
      ["THEIRS", 'Secret "THEIRS"'],
      ["PLAIN", 'Secret "PLAIN" is not brokered'],
      ["WRONGHOST", 'Secret "WRONGHOST" is not brokered to host mcp.example.com'],
    ]) {
      const error = await loadServerSecrets(db, cipher, server([name])).catch((e) => e);
      expect(error).toBeInstanceOf(McpServerInputError);
      expect(error.message).toContain(text);
      expect(error.message).not.toContain("secret-value");
    }
  });

  it("returns an accessor for exactly the server's secrets that never reads brokered values", async () => {
    const { accessor, values } = await loadServerSecrets(db, cipher, server(["GOOD"]));
    expect((await accessor.resolve!("GOOD"))?.value).toBe(SECRET);
    expect(await accessor.resolve!("PLAIN")).toBeUndefined();
    await expect(accessor.get("GOOD")).rejects.toThrow("secret_brokered");
    expect(values).toContain(SECRET);
  });

  it("snapshots tools with the brokered header and redacts an echoed secret", async () => {
    const seen: (string | undefined)[] = [];
    const sse = (id: number, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });
    const fetchImpl = (async (_url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      seen.push(init?.headers?.authorization);
      const body = init?.body ? (JSON.parse(init.body) as { id?: number; method?: string }) : {};
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "dd", version: "1" } }
          : body.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "search",
                    description: `Uses key ${SECRET} to search`,
                    inputSchema: { type: "object", properties: { q: { description: `default ${SECRET}` } } },
                  },
                ],
              }
            : {};
      return {
        ok: true,
        status: body.id === undefined ? 202 : 200,
        statusText: "OK",
        url,
        headers: { "Content-Type": "application/json" },
        bodyBase64: Buffer.from(body.id === undefined ? "" : sse(body.id, result)).toString("base64"),
      };
    }) as unknown as typeof safeFetch;
    const snapshot = await fetchSnapshot(server(["GOOD"]), { db, cipher, fetchImpl });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((h) => h !== undefined)).toContain(`Bearer ${SECRET}`);
    expect(snapshot.serverInfo.name).toBe("dd");
    expect(snapshot.tools).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    expect(snapshot.tools[0].description).toContain("[REDACTED]");
  });

  it("finds the owner's MCP servers using a secret", async () => {
    await db.mcpServer.create({ data: { ownerId: owner, name: "datadog", url, secretNames: ["GOOD"] } });
    expect(await mcpServersUsingSecret(db, owner, "GOOD")).toEqual(["datadog"]);
    expect(await mcpServersUsingSecret(db, owner, "PLAIN")).toEqual([]);
    expect(await mcpServersUsingSecret(db, other, "GOOD")).toEqual([]);
  });
});
