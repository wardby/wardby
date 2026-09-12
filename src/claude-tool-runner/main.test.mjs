import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startToolRunner } from "./main.mjs";

function waitForResponse(socket, id) {
  return new Promise((resolve, reject) => {
    let pending = "";
    const onData = (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === id) {
            socket.off("data", onData);
            resolve(message);
          }
        } catch (error) {
          socket.off("data", onData);
          reject(error);
        }
      }
    };
    socket.on("data", onData);
  });
}

test("serves only the bounded run_command MCP tool over its private socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reevo-claude-mcp-"));
  const socketPath = join(directory, "runner.sock");
  const server = await startToolRunner(socketPath);
  const socket = net.createConnection(socketPath);
  try {
    await once(socket, "connect");
    const initialized = waitForResponse(socket, 1);
    socket.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
      })}\n`,
    );
    const init = await initialized;
    assert.equal(init.result.serverInfo.name, "reevo_tools");

    socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const listed = waitForResponse(socket, 2);
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const tools = await listed;
    assert.deepEqual(tools.result.tools.map((tool) => tool.name), ["run_command"]);
  } finally {
    socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
