#!/usr/bin/env node
// Task 0 only: local control-plane probes. It never contacts an external model.
import { mkdtemp, writeFile, chmod, access, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const timeoutMs = 8_000;
const root = await mkdtemp(join(tmpdir(), "wardby-codex-task0-"));
const workspace = join(root, "workspace");
const outsideFile = join(root, "outside-write-must-fail");
const tokenPath = join(root, "proxy-token.sh");
const capability = "wardby-task0-capability";
const execFileAsync = promisify(execFile);

const result = {
  auth: "not checked by this script",
  endpointConfigurationHonored: false,
  noFallbackCanary: false,
  authoritativeUsageBeforeNextRequest: false,
  rejectionTerminates: false,
  rejectionMs: null,
  cancellation: false,
  processStopped: false,
  workspaceOnly: false,
  directNetworkBlocked: false,
  details: [],
};

function fail(message) {
  throw new Error(message);
}

function eventually(check, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`timed out: ${label}`));
      }
    }, 25);
  });
}

function waitForExit(child, graceMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (forced) => {
      if (!settled) {
        settled = true;
        resolve(forced);
      }
    };
    child.once("exit", () => finish(false));
    setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
        finish(true);
      }
    }, graceMs);
  });
}

class RpcClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_000);
    });
    child.once("exit", (code, signal) => {
      const detail = this.stderr.replaceAll(capability, "[redacted]").trim();
      const error = new Error(`app server exited (${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    });
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id && this.pending.has(message.id)) {
          const { resolve, reject } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        } else if (message.method) {
          this.events.push(message);
        }
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async event(method, predicate = () => true) {
    await eventually(() => this.events.some((event) => event.method === method && predicate(event.params)), method);
    return this.events.find((event) => event.method === method && predicate(event.params));
  }
}

async function startAppServer(port) {
  const child = spawn(
    "codex",
    [
      "-c",
      'model_provider="wardby_proxy"',
      "-c",
      'model_providers.wardby_proxy.name="Wardby Task 0 Proxy"',
      "-c",
      `model_providers.wardby_proxy.base_url=\"http://127.0.0.1:${port}/v1\"`,
      "-c",
      'model_providers.wardby_proxy.wire_api="responses"',
      "-c",
      `model_providers.wardby_proxy.auth.command=\"${tokenPath}\"`,
      "-c",
      "model_providers.wardby_proxy.request_max_retries=0",
      "-c",
      "model_providers.wardby_proxy.stream_max_retries=0",
      "app-server",
      "--stdio",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const rpc = new RpcClient(child);
  await rpc.request("initialize", {
    clientInfo: { name: "wardby-task0-spike", version: "0" },
    capabilities: {},
  });
  rpc.notify("initialized", {});
  return { child, rpc };
}

async function startThread(rpc) {
  const response = await rpc.request("thread/start", {
    model: "gpt-5.6-terra",
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    ephemeral: true,
  });
  return response.thread.id;
}

async function startTurn(rpc, threadId, prompt) {
  return rpc.request("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt }],
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [workspace],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  });
}

await writeFile(tokenPath, `#!/bin/sh\nprintf '%s\\n' '${capability}'\n`, { mode: 0o700 });
await chmod(tokenPath, 0o700);
await mkdir(workspace);
await writeFile(join(workspace, ".gitkeep"), "");
await execFileAsync("git", ["init", "--quiet", workspace]);

let mode = "reject";
let requests = 0;
let loopbackHits = 0;
const proxy = createServer((request, response) => {
  if (request.url === "/egress-canary") {
    loopbackHits += 1;
    response.writeHead(204).end();
    return;
  }

  requests += 1;
  const validCapability = request.headers.authorization === `Bearer ${capability}`;
  if (!validCapability) {
    response.writeHead(401).end(JSON.stringify({ error: { message: "missing capability" } }));
    return;
  }
  if (mode === "hold") return;
  response.writeHead(429, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: "budget exhausted" } }));
});

await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const address = proxy.address();
if (!address || typeof address === "string") fail("could not bind proxy");

let server;
try {
  server = await startAppServer(address.port);
  const threadId = await startThread(server.rpc);
  const rejectionStarted = Date.now();
  const firstTurn = await startTurn(server.rpc, threadId, "Reply only with OK.");
  const rejected = await server.rpc.event(
    "turn/completed",
    (params) => params.turn?.id === firstTurn.turn.id && params.turn?.status === "failed",
  );

  result.rejectionMs = Date.now() - rejectionStarted;
  result.endpointConfigurationHonored = requests >= 1;
  result.rejectionTerminates = Boolean(rejected);
  result.details.push(`reject request count=${requests}`);

  mode = "hold";
  const secondTurn = await startTurn(server.rpc, threadId, "Reply only with OK.");
  await eventually(() => requests === 2, "second request reached proxy");
  await server.rpc.request("turn/interrupt", { threadId, turnId: secondTurn.turn.id });
  const interrupted = await server.rpc.event(
    "turn/completed",
    (params) => params.turn?.id === secondTurn.turn.id && params.turn?.status === "interrupted",
  );
  result.cancellation = Boolean(interrupted);

  const outside = await server.rpc.request("command/exec", {
    command: ["/usr/bin/touch", outsideFile],
    cwd: workspace,
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [workspace],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
    timeoutMs: 1_000,
  });
  let outsideWritten = true;
  try {
    await access(outsideFile, constants.F_OK);
  } catch {
    outsideWritten = false;
  }
  result.workspaceOnly = outside.exitCode !== 0 && !outsideWritten;

  const network = await server.rpc.request("command/exec", {
    command: ["/usr/bin/curl", "--connect-timeout", "1", `http://127.0.0.1:${address.port}/egress-canary`],
    cwd: workspace,
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [workspace],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
    timeoutMs: 2_000,
  });
  result.directNetworkBlocked = network.exitCode !== 0 && loopbackHits === 0;
  result.details.push(`sandbox exits: outside=${outside.exitCode} network=${network.exitCode}`);
} finally {
  if (server) {
    server.child.kill("SIGTERM");
    const forced = await waitForExit(server.child, 1_000);
    result.processStopped = !forced;
  }
  await new Promise((resolve) => proxy.close(resolve));
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify(result, null, 2));

if (
  !Object.entries(result)
    .filter(([key]) => !["auth", "details", "rejectionMs"].includes(key))
    .every(([, value]) => value === true)
) {
  process.exitCode = 1;
}
