#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const timeoutMs = 90_000;
const proxyBaseUrl = process.env.REEVO_PROXY_URL ?? "http://proxy:8080";
const capability = process.env.REEVO_RUN_CAPABILITY ?? "";
const workspace = "/workspace";
const result = {
  proxyReachable: false,
  directInternetBlocked: false,
  workerHasNoUpstreamSecret: !process.env.OPENAI_API_KEY,
  calibrationBlocked: false,
  liveRequestCompleted: false,
  authoritativeUsagePersisted: false,
  secondRequestBudgetBlocked: false,
  everyModelRequestReachedProxy: false,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(check, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out: ${label}`);
}

class RpcClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-4_000); });
    child.once("exit", (code, signal) => {
      const error = new Error(`app server exited (${code ?? signal ?? "unknown"}): ${this.stderr}`);
      for (const pending of this.pending.values()) pending.reject(error);
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
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message));
          else pending.resolve(message.result);
        } else if (message.method) {
          this.events.push(message);
        }
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  event(method, predicate) {
    return eventually(
      () => this.events.find((event) => event.method === method && predicate(event.params)),
      method,
    );
  }
}

function startServer() {
  const child = spawn("codex", [
    "-c", "model_provider=\"reevo_proxy\"",
    "-c", "model_providers.reevo_proxy.name=\"Reevo Task 0B Proxy\"",
    "-c", `model_providers.reevo_proxy.base_url=\"${proxyBaseUrl}/v1\"`,
    "-c", "model_providers.reevo_proxy.wire_api=\"responses\"",
    "-c", "model_providers.reevo_proxy.auth.command=\"/usr/local/bin/reevo-token\"",
    "-c", "model_providers.reevo_proxy.request_max_retries=0",
    "-c", "model_providers.reevo_proxy.stream_max_retries=0",
    "app-server", "--stdio",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  return { child, rpc: new RpcClient(child) };
}

async function initialize(rpc) {
  await rpc.request("initialize", { clientInfo: { name: "reevo-task0b", version: "0" }, capabilities: {} });
  rpc.notify("initialized", {});
  const started = await rpc.request("thread/start", {
    model: "gpt-5.6-luna",
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    ephemeral: true,
  });
  return started.thread.id;
}

async function turn(rpc, threadId) {
  const started = await rpc.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply only with OK." }],
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [workspace],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  });
  return rpc.event("turn/completed", (params) => params.turn?.id === started.turn.id);
}

async function stop(server) {
  server.child.kill("SIGTERM");
  await eventually(() => server.child.exitCode !== null || server.child.signalCode !== null, "app server stop");
}

async function status() {
  const response = await fetch(`${proxyBaseUrl}/status`, { headers: { authorization: `Bearer ${capability}` } });
  if (!response.ok) throw new Error(`proxy status failed: ${response.status}`);
  return response.json();
}

await mkdir(workspace, { recursive: true });
await writeFile(`${workspace}/.gitkeep`, "");
result.proxyReachable = (await fetch(`${proxyBaseUrl}/health`)).ok;
try {
  await fetch("https://api.openai.com/v1/models", { signal: AbortSignal.timeout(2_000) });
} catch {
  result.directInternetBlocked = true;
}

let server = startServer();
let threadId = await initialize(server.rpc);
let completed = await turn(server.rpc, threadId);
result.calibrationBlocked = completed.params.turn?.status === "failed";
await stop(server);

server = startServer();
threadId = await initialize(server.rpc);
completed = await turn(server.rpc, threadId);
result.liveRequestCompleted = completed.params.turn?.status === "completed";
let proxyStatus = await status();
result.authoritativeUsagePersisted = proxyStatus.persistedResponses === 1 && proxyStatus.upstreamResponses === 1;

completed = await turn(server.rpc, threadId);
result.secondRequestBudgetBlocked = completed.params.turn?.status === "failed";
proxyStatus = await status();
result.everyModelRequestReachedProxy = proxyStatus.proxyRequests === 3 && proxyStatus.rejectedRequests === 2;
await stop(server);

console.log(JSON.stringify({ ...result, proxy: proxyStatus }, null, 2));
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
