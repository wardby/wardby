import { describe, it, expect } from "vitest";
import { Readable, Writable } from "node:stream";
import { buildMcpServer } from "../server.js";
import { runStdioServer } from "./stdio.js";

const fakeProviders = {} as unknown as import("../../providers/index.js").ProviderRegistry;
const fakeDb = {} as unknown as import("@prisma/client").PrismaClient;

describe("runStdioServer", () => {
  it("reads one JSON object per line and writes one JSON object per line", async () => {
    const mcp = buildMcpServer({ providers: fakeProviders, db: fakeDb, config: { canonicalUri: "https://host/mcp" } });

    const input = new Readable({ read() {} });
    const chunks: Buffer[] = [];
    const output = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });

    const handle = runStdioServer(mcp, { input, output });

    input.push(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }) + "\n",
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    const written = Buffer.concat(chunks).toString("utf8");
    const lines = written.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toBe(1);
    expect("result" in parsed).toBe(true);
    expect(parsed.result.capabilities.extensions?.["io.modelcontextprotocol/tasks"]).toBeDefined();

    input.push(null);
    await handle.close();
  });
});
