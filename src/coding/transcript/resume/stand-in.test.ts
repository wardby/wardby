import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { movedMessage, standInFactory } from "./stand-in.js";

async function connect(checkout: string) {
  const server = (await standInFactory({ checkout, from: "/workspace" })({ era: "modern" })) as McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("resume stand-in tool server", () => {
  it("offers run_command with the worker's input schema", async () => {
    const client = await connect("/home/dev/app-run-1");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["run_command"]);
    const schema = tools[0].inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(["command", "timeout_ms"]);
    expect(schema.required).toEqual(["command"]);
  });

  it("answers every call with the move message and runs nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wardby-standin-"));
    const marker = join(dir, "ran");
    const client = await connect(dir);
    const result = (await client.callTool({
      name: "run_command",
      arguments: { command: `touch ${marker}`, timeout_ms: 5000 },
    })) as { isError?: boolean; content: { type: string; text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(movedMessage({ checkout: dir, from: "/workspace" }));
    expect(result.content[0].text).toContain(`/workspace is now ${dir}`);
    expect(result.content[0].text).toMatch(/use your local tools \(Bash, Read, Edit\)/);
    expect(existsSync(marker)).toBe(false);
  });
});
