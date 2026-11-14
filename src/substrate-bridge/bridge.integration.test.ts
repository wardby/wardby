import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseToolSetup } from "../claude-tool-runner/command.mjs";
import { claudeToolSetup } from "../providers/jobs/claude-tool-setup.js";
import type { JobSpec } from "../providers/jobs/types.js";
import { BLOB, substrateRunToken, toolActorSubject } from "../providers/jobs/substrate/names.js";
import { capabilityHash } from "../providers/coding-proxy/capability-hash.js";
import { MemoryRelayStore } from "../providers/coding-proxy/substrate/memory-relay-store.js";
import { createSubstrateRoutes } from "../providers/coding-proxy/substrate/routes.js";
import { LocalBlobStore } from "../providers/storage/local.js";
import type { ProxySession } from "../providers/coding-proxy/types.js";
import { run as runAgent, type AgentHandle } from "./agent.js";
import { PLACEHOLDER_CAPABILITY } from "./constants.js";
import { DEFAULT_POLICY } from "./http.js";
import { run as runTool, type ToolHandle } from "./tool.js";

/**
 * The images carry GNU tar. On a machine whose tar is bsdtar (macOS) the bridge runs through a shim
 * that drops GNU-only flags (--anchored, --no-anchored, --delay-directory-restore) (bsdtar's --exclude patterns already match that way).
 */
async function tarForTests(dir: string): Promise<string> {
  const version = await exec("tar", ["--version"]).then(
    (r) => r.stdout,
    () => "",
  );
  if (version.includes("GNU tar")) return "tar";
  const shim = join(dir, "tar-shim.mjs");
  await writeFile(
    shim,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2).filter((a) => a !== "--anchored" && a !== "--no-anchored" && a !== "--delay-directory-restore");
process.exit(spawnSync("tar", args, { stdio: "inherit" }).status ?? 1);
`,
    { mode: 0o755 },
  );
  return shim;
}

const exec = promisify(execFile);
const ATESPACE = "wardby-runs";
const CAPABILITY = "rrp_fake_capability_value_000001";
const REGISTRY_TOKEN = "rrg_fake_registry_token_0000001";
const TOKEN = substrateRunToken("run-1");
const FAST = { ...DEFAULT_POLICY, baseMs: 5, maxMs: 20, retryAfterCapMs: 20 };

const spec: JobSpec = {
  kind: "coding-agent",
  runId: "run-1",
  provider: "claude-code",
  image: `registry.example/wardby-claude-coding-worker@sha256:${"a".repeat(64)}`,
  toolImage: `registry.example/wardby-claude-tool-runner@sha256:${"b".repeat(64)}`,
  inputArtifact: "/tmp/input.json",
  timeoutSec: 900,
  limits: { cpus: 1, memoryMb: 2048, pids: 128, diskMb: 2048 },
  labels: {},
};

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("substrate bridges, end to end without Substrate", () => {
  let dir: string;
  let proxy: Server;
  let proxyUrl: string;
  let blobs: LocalBlobStore;
  let relay: MemoryRelayStore;
  let agent: AgentHandle | undefined;
  let tool: ToolHandle | undefined;
  let logs: string[];
  let sockets: string[];
  let routeLogs: unknown[];
  let proxyOverride: ((url: string) => number | undefined) | undefined;
  let proxyDelay: ((url: string) => number) | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridge-it-"));
    blobs = new LocalBlobStore(join(dir, "blobs"));
    relay = new MemoryRelayStore();
    relay.register(TOKEN, 1 << 20);
    logs = [];
    sockets = [];
    routeLogs = [];
    proxyOverride = undefined;
    proxyDelay = undefined;
    const routes = createSubstrateRoutes({
      atespace: ATESPACE,
      relay,
      blobs,
      ledger: {
        findSessionByCapabilityHash: async (hash) =>
          hash === capabilityHash(PLACEHOLDER_CAPABILITY)
            ? ({ runId: "run-1", deadlineAt: new Date(Date.now() + 60_000), status: "active" } as ProxySession)
            : null,
      },
      verifyActor: async (actorJwt, subject) =>
        actorJwt === "placeholder" && subject === toolActorSubject(ATESPACE, TOKEN)
          ? { ok: true, subject }
          : { ok: false, code: "invalid" },
      tokenForRun: substrateRunToken,
      limits: { resultBytes: 1 << 20, transcriptBytes: 1 << 20, workspaceBytes: 1 << 24 },
      pollWaitMs: 200,
      log: { info: (...args) => void routeLogs.push(args) },
    });
    proxy = createHttpServer((req, res) => {
      const forced = proxyOverride?.(`${req.method} ${req.url}`);
      if (forced) {
        res.writeHead(forced, { "retry-after": "0" }).end(JSON.stringify({ error: { type: "relay_busy" } }));
        req.resume();
        return;
      }
      const delay = proxyDelay?.(`${req.method} ${req.url}`) ?? 0;
      if (delay > 0) setTimeout(() => void routes(req, res), delay);
      else void routes(req, res);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await agent?.close();
    await tool?.close();
    agent = tool = undefined;
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const log = (event: string, fields: Record<string, string | number> = {}): void => {
    logs.push(JSON.stringify({ event, ...fields }));
  };

  async function stage(options: { collectExclude?: unknown } = {}): Promise<{ workspace: string; toolSetup: string }> {
    const seedDir = join(dir, "seed");
    await mkdir(join(seedDir, "src"), { recursive: true });
    await writeFile(join(seedDir, "src", "hello.txt"), "hello from the seed\n");
    await mkdir(join(seedDir, "src", "skipped"), { recursive: true });
    await writeFile(join(seedDir, "src", "skipped", "big.bin"), "excluded by path\n");
    await mkdir(join(seedDir, "node_modules"), { recursive: true });
    await writeFile(join(seedDir, "node_modules", "dep.js"), "skip me\n");
    await exec("tar", ["-c", "-C", seedDir, "-f", join(dir, "seed.tar"), "."]);
    const setup = JSON.parse(claudeToolSetup(spec, CAPABILITY)) as { env: Record<string, string> };
    setup.env.FAKE_REGISTRY_TOKEN = REGISTRY_TOKEN;
    const toolSetup = JSON.stringify(setup);
    const put = (key: string, data: Buffer) => blobs.put(key, data);
    await put(BLOB.input(TOKEN), Buffer.from(JSON.stringify({ task: "do the thing" })));
    await put(
      BLOB.toolSetup(TOKEN),
      Buffer.from(
        JSON.stringify({
          toolSetup,
          collectExclude: options.collectExclude ?? { names: ["node_modules"], paths: ["src/skipped"] },
        }),
      ),
    );
    await put(BLOB.seed(TOKEN), await readFile(join(dir, "seed.tar")));
    return { workspace: join(dir, "workspace"), toolSetup };
  }

  const names = async (role: string): Promise<string> => {
    const metadata = join(dir, `meta-${role}`);
    await mkdir(metadata, { recursive: true });
    await writeFile(join(metadata, "name"), `${TOKEN}-${role}\n`);
    return metadata;
  };

  async function startTool(workspace: string, toolSetup: string): Promise<ToolHandle> {
    const socketPath = join(dir, "tool", "runner.sock");
    sockets.push(socketPath);
    const runnerUrl = new URL("../claude-tool-runner/main.mjs", import.meta.url).href;
    const runner = (await import(/* @vite-ignore */ runnerUrl)) as {
      startToolRunner: (
        socketPath: string,
        setup: unknown,
        options: { workspacePath: string },
      ) => Promise<{ close(cb?: () => void): void }>;
    };
    return runTool({
      proxyUrl,
      metadataDir: await names("tool"),
      workspace,
      socketPath,
      readyPort: 0,
      tempRoot: dir,
      tarCommand: await tarForTests(dir),
      policy: FAST,
      log,
      launchRunner: (setupText) => {
        const server = runner.startToolRunner(socketPath, parseToolSetup(setupText), { workspacePath: workspace });
        void toolSetup;
        return {
          ready: server.then(() => undefined),
          exited: new Promise<number>(() => undefined),
        };
      },
    });
  }

  it("relays an MCP round trip, then collects the workspace", async () => {
    const { workspace, toolSetup } = await stage();
    tool = await startTool(workspace, toolSetup);
    expect(await readFile(join(workspace, "src", "hello.txt"), "utf8")).toBe("hello from the seed\n");

    const agentSocket = join(dir, "agent", "runner.sock");
    const resultPath = join(dir, "out", "result.json");
    const transcriptPath = join(dir, "out", "session.jsonl");
    let workerEnv: NodeJS.ProcessEnv | undefined;
    let toolNames: string[] = [];
    let pong: unknown;
    agent = await runAgent({
      proxyUrl,
      env: { PATH: "/usr/bin", WARDBY_BASE: "x" },
      metadataDir: await names("agent"),
      inputPath: join(dir, "in", "input.json"),
      resultPath,
      transcriptPath,
      socketPath: agentSocket,
      readyPort: 0,
      policy: FAST,
      log,
      launchWorker: (env) => {
        workerEnv = env;
        return {
          exited: (async () => {
            const socket = connect(agentSocket);
            socket.setEncoding("utf8");
            const replies = new Map<number, (m: Record<string, unknown>) => void>();
            let pending = "";
            socket.on("data", (chunk: string) => {
              pending += chunk;
              let end: number;
              while ((end = pending.indexOf("\n")) >= 0) {
                const message = JSON.parse(pending.slice(0, end)) as { id?: number };
                pending = pending.slice(end + 1);
                if (message.id !== undefined) replies.get(message.id)?.(message);
              }
            });
            const call = (id: number, method: string, params: unknown) =>
              new Promise<Record<string, unknown>>((resolve) => {
                replies.set(id, resolve);
                socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
              });
            await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
            await call(1, "initialize", {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "stub-worker", version: "1" },
            });
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
            const listed = (await call(2, "tools/list", {})) as { result: { tools: { name: string }[] } };
            toolNames = listed.result.tools.map((t) => t.name);
            pong = (await call(3, "ping", { note: REGISTRY_TOKEN })).result;
            socket.end();
            await mkdir(join(dir, "out"), { recursive: true });
            await writeFile(resultPath, JSON.stringify({ ok: true }));
            await writeFile(transcriptPath, '{"type":"user"}\n');
            return 0;
          })(),
        };
      },
    });

    expect(agent.runToken).toBe(TOKEN);
    expect(await agent.workerExited).toBe(0);
    await agent.uploaded;

    expect(toolNames).toContain("run_command");
    expect(pong).toEqual({});
    expect(workerEnv).toMatchObject({
      WARDBY_PROXY_URL: proxyUrl,
      WARDBY_RUN_CAPABILITY: PLACEHOLDER_CAPABILITY,
      WARDBY_BASE: "x",
    });
    expect(((await stat0(join(dir, "in", "input.json"))) & 0o777).toString(8)).toBe("600");
    expect(JSON.parse(await readFile(join(dir, "in", "input.json"), "utf8"))).toEqual({ task: "do the thing" });
    expect(JSON.parse(await readFile(join(dir, "blobs", ...BLOB.result(TOKEN).split("/")), "utf8"))).toEqual({
      ok: true,
    });

    expect(await tool.collected).toBe("ok");
    await waitFor(async () => ((await blobs.head(BLOB.done(TOKEN))) ? true : undefined));
    const tarPath = join(dir, "check.tar");
    await writeFile(tarPath, await readBlob(BLOB.workspace(TOKEN)));
    const listing = (await exec("tar", ["-t", "-f", tarPath])).stdout;
    expect(listing).toContain("src/hello.txt");
    expect(listing).not.toContain("node_modules");
    expect(listing).not.toContain("src/skipped");
    expect(listing).not.toContain("big.bin");
    expect(await readBlob(BLOB.transcript(TOKEN))).toEqual(Buffer.from('{"type":"user"}\n'));
    expect(await readdir(dir)).not.toContain("workspace.tar");
  });

  async function readBlob(key: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await blobs.getStream(key)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  it("never logs a line, capability, registry token or tool setup", async () => {
    const { workspace, toolSetup } = await stage();
    const stderr: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    };
    try {
      tool = await startTool(workspace, toolSetup);
      const agentSocket = join(dir, "agent", "runner.sock");
      agent = await runAgent({
        proxyUrl,
        env: {},
        metadataDir: await names("agent"),
        inputPath: join(dir, "in", "input.json"),
        resultPath: join(dir, "out", "result.json"),
        transcriptPath: join(dir, "out", "session.jsonl"),
        socketPath: agentSocket,
        readyPort: 0,
        policy: FAST,
        launchWorker: () => ({
          exited: (async () => {
            const socket = connect(agentSocket);
            await new Promise<void>((resolve) => socket.once("connect", resolve));
            socket.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { note: REGISTRY_TOKEN, k: CAPABILITY } })}\n`,
            );
            await new Promise<void>((resolve) => socket.once("data", () => resolve()));
            // A line the proxy rejects (413): the bridge drops the connection with a fixed code.
            const oversized = new Promise<void>((resolve) => socket.once("close", () => resolve()));
            socket.write(`${REGISTRY_TOKEN}${CAPABILITY}${"\u00e9".repeat(3 * 1024 * 1024)}\n`);
            await oversized;
            await mkdir(join(dir, "out"), { recursive: true });
            // A result the proxy rejects (413) while carrying the fake values.
            await writeFile(join(dir, "out", "result.json"), `${REGISTRY_TOKEN}${CAPABILITY}`.repeat(70_000));
            return 0;
          })(),
        }),
      });
      await agent.uploaded;
      await tool.collected;
    } finally {
      process.stderr.write = realWrite;
    }
    const everything = [...logs, ...stderr, ...routeLogs.map((l) => JSON.stringify(l))].join("\n");
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [CAPABILITY, REGISTRY_TOKEN, toolSetup, "do the thing"])
      expect(everything).not.toContain(secret);
    expect(everything).not.toContain("ping");
    // The agent bridge logs to stderr (no logger injected), so the rejections show up there.
    expect(stderr.join("")).toContain("substrate_bridge_send_rejected");
    expect(stderr.join("")).toContain("substrate_bridge_upload_rejected");
  });

  const workerOptions = async (extra: Partial<Parameters<typeof runAgent>[0]> = {}) => ({
    proxyUrl,
    env: {},
    metadataDir: await names("agent"),
    inputPath: join(dir, "in", "input.json"),
    resultPath: join(dir, "out", "result.json"),
    transcriptPath: join(dir, "out", "session.jsonl"),
    socketPath: join(dir, "agent", "runner.sock"),
    readyPort: 0,
    policy: FAST,
    log,
    ...extra,
  });

  it("reports a worker that exits without a result and still collects the workspace", async () => {
    const { workspace, toolSetup } = await stage();
    tool = await startTool(workspace, toolSetup);
    agent = await runAgent(await workerOptions({ launchWorker: () => ({ exited: Promise.resolve(2) }) }));
    await agent.uploaded;
    expect(JSON.parse((await readBlob(BLOB.exit(TOKEN))).toString())).toEqual({ code: 2 });
    expect(await blobs.head(BLOB.result(TOKEN))).toBeNull();
    expect(await tool.collected).toBe("ok");
    await waitFor(async () => ((await blobs.head(BLOB.done(TOKEN))) ? true : undefined));
    expect(JSON.parse((await readBlob(BLOB.done(TOKEN))).toString())).toEqual({ workspace: "ok" });
  });

  it("reports a rejected result upload as an exit", async () => {
    const { workspace, toolSetup } = await stage();
    tool = await startTool(workspace, toolSetup);
    agent = await runAgent(
      await workerOptions({
        launchWorker: () => ({
          exited: (async () => {
            await mkdir(join(dir, "out"), { recursive: true });
            await writeFile(join(dir, "out", "result.json"), "r".repeat(2 << 20));
            return 0;
          })(),
        }),
      }),
    );
    await agent.uploaded;
    expect(JSON.parse((await readBlob(BLOB.exit(TOKEN))).toString())).toEqual({ code: 0 });
    expect(await tool.collected).toBe("ok");
  });

  it("does not post an exit when the result was stored", async () => {
    const { workspace, toolSetup } = await stage();
    tool = await startTool(workspace, toolSetup);
    agent = await runAgent(
      await workerOptions({
        launchWorker: () => ({
          exited: (async () => {
            await mkdir(join(dir, "out"), { recursive: true });
            await writeFile(join(dir, "out", "result.json"), "{}");
            return 1;
          })(),
        }),
      }),
    );
    await agent.uploaded;
    expect(await blobs.head(BLOB.exit(TOKEN))).toBeNull();
    expect(await blobs.head(BLOB.result(TOKEN))).not.toBeNull();
    expect(await tool.collected).toBe("ok");
  });

  it("posts workspace-failed when the workspace cannot be archived", async () => {
    const { workspace } = await stage();
    const shim = join(dir, "failing-tar.mjs");
    await writeFile(
      shim,
      `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2).filter((a) => a !== "--anchored" && a !== "--no-anchored" && a !== "--delay-directory-restore");
if (args.includes("-c")) process.exit(2);
process.exit(spawnSync("tar", args, { stdio: "inherit" }).status ?? 1);
`,
      { mode: 0o755 },
    );
    const socketPath = join(dir, "tool", "runner.sock");
    tool = await runTool({
      proxyUrl,
      metadataDir: await names("tool"),
      workspace,
      socketPath,
      readyPort: 0,
      tempRoot: dir,
      tarCommand: shim,
      policy: FAST,
      log,
      launchRunner: () => ({ ready: Promise.resolve(), exited: new Promise<number>(() => undefined) }),
    });
    agent = await runAgent(
      await workerOptions({
        launchWorker: () => ({
          exited: (async () => {
            await mkdir(join(dir, "out"), { recursive: true });
            await writeFile(join(dir, "out", "result.json"), "{}");
            return 0;
          })(),
        }),
      }),
    );
    await agent.uploaded;
    expect(await tool.collected).toBe("failed");
    expect(JSON.parse((await readBlob(BLOB.done(TOKEN))).toString())).toEqual({ workspace: "failed" });
    expect(await blobs.head(BLOB.workspace(TOKEN))).toBeNull();
  });

  it("closes a channel whose socket went away while the open was in flight", async () => {
    await stage();
    proxyDelay = (request) => (request === "POST /substrate/runs/" + TOKEN + "/channels" ? 150 : 0);
    const socketPath = join(dir, "agent", "runner.sock");
    agent = await runAgent(
      await workerOptions({ launchWorker: () => ({ exited: new Promise<number>(() => undefined) }) }),
    );
    const socket = connect(socketPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.destroy();
    const types = await waitFor(async () => {
      const events = await relay.pollTool(TOKEN, 0, 0);
      return events.some((e) => e.type === "close") ? events.map((e) => e.type) : undefined;
    });
    expect(types).toEqual(["open", "close"]);
  });

  it("retries a busy proxy with the same sequence number", async () => {
    const { workspace, toolSetup } = await stage();
    tool = await startTool(workspace, toolSetup);
    let busy = 2;
    proxyOverride = (request) =>
      request.startsWith("POST") && request.includes("/lines") && busy-- > 0 ? 503 : undefined;
    const agentSocket = join(dir, "agent", "runner.sock");
    let reply = "";
    agent = await runAgent({
      proxyUrl,
      env: {},
      metadataDir: await names("agent"),
      inputPath: join(dir, "in", "input.json"),
      resultPath: join(dir, "out", "result.json"),
      transcriptPath: join(dir, "out", "session.jsonl"),
      socketPath: agentSocket,
      readyPort: 0,
      policy: FAST,
      log,
      launchWorker: () => ({
        exited: (async () => {
          const socket = connect(agentSocket);
          socket.setEncoding("utf8");
          await new Promise<void>((resolve) => socket.once("connect", resolve));
          socket.write('{"jsonrpc":"2.0","id":9,"method":"ping"}\n');
          reply = await new Promise<string>((resolve) => socket.once("data", (d: string) => resolve(d)));
          socket.end();
          return 0;
        })(),
      }),
    });
    await agent.workerExited;
    await agent.uploaded;
    await tool.collected;
    expect(JSON.parse(reply)).toMatchObject({ id: 9, result: {} });
    expect(busy).toBeLessThan(0);
  });

  it("refuses a run whose actor name is not a run token", async () => {
    const metadata = join(dir, "bad");
    await mkdir(metadata, { recursive: true });
    await writeFile(join(metadata, "name"), "wr-nothex-agent\n");
    await expect(
      runAgent({
        proxyUrl,
        metadataDir: metadata,
        readyPort: 0,
        log,
        policy: FAST,
        socketPath: join(dir, "s", "x.sock"),
      }),
    ).rejects.toMatchObject({ code: "substrate_bridge_identity_invalid" });
    await writeFile(join(metadata, "name"), `${TOKEN}-tool\n`);
    await expect(
      runAgent({
        proxyUrl,
        metadataDir: metadata,
        readyPort: 0,
        log,
        policy: FAST,
        socketPath: join(dir, "s", "x.sock"),
      }),
    ).rejects.toMatchObject({ code: "substrate_bridge_identity_invalid" });
  });

  it("refuses an unsafe seed", async () => {
    await stage();
    const entry = Buffer.alloc(512);
    entry.write("/etc/evil", 0);
    entry.write("0000644\0", 100);
    entry.write("00000000000\0", 124);
    entry.write("0", 156);
    const seed = Buffer.concat([entry, Buffer.alloc(1024)]);
    await blobs.put(BLOB.seed(TOKEN), seed);
    await expect(
      runTool({
        proxyUrl,
        metadataDir: await names("tool"),
        workspace: join(dir, "workspace"),
        socketPath: join(dir, "tool", "runner.sock"),
        readyPort: 0,
        tempRoot: dir,
        policy: FAST,
        log,
        launchRunner: () => ({ ready: Promise.resolve(), exited: new Promise<number>(() => undefined) }),
      }),
    ).rejects.toMatchObject({ code: "substrate_bridge_seed_unsafe" });
  });

  it("answers the readiness probe", async () => {
    const { workspace, toolSetup } = await stage();
    tool = await startTool(workspace, toolSetup);
    const response = await fetch(`http://127.0.0.1:${tool.readyPort}/readyz`);
    expect(response.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${tool.readyPort}/other`)).status).toBe(404);
  });
});

async function stat0(path: string): Promise<number> {
  const { stat } = await import("node:fs/promises");
  return (await stat(path)).mode;
}
