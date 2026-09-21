#!/usr/bin/env node
import { createServer } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MAX_COMMAND_BYTES, MAX_TIMEOUT_MS, runCommand } from "./command.mjs";

const SOCKET_PATH = "/run/wardby/tool/runner.sock";
export const TOOL_RUNNER_READY_MESSAGE = "wardby_tool_runner_ready";
function toolServer() {
  const server = new McpServer({ name: "wardby_tools", version: "1.0.0" });
  server.registerTool(
    "run_command",
    {
      description: "Run one bounded shell command in the isolated repository workspace.",
      inputSchema: {
        command: z.string().min(1).max(MAX_COMMAND_BYTES),
        timeout_ms: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional(),
      },
    },
    async ({ command, timeout_ms }) => {
      const result = await runCommand(command, timeout_ms ?? 60_000);
      return {
        content: [{ type: "text", text: `exit_code=${result.code}\n${result.output}` }],
        isError: result.code !== 0,
      };
    },
  );
  return server;
}

export async function startToolRunner(socketPath = SOCKET_PATH) {
  if (!isAbsolute(socketPath)) throw new Error("tool_socket_path_invalid");
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  const server = createServer((socket) => {
    const mcp = toolServer();
    void mcp.connect(new StdioServerTransport(socket, socket)).catch(() => socket.destroy());
  });
  await new Promise((resolve, reject) => server.listen(socketPath, () => resolve()).once("error", reject));
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await startToolRunner();
  process.stdout.write(`${TOOL_RUNNER_READY_MESSAGE}\n`);
}
