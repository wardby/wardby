import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseToolSetup } from "../claude-tool-runner/command.mjs";
import { claudeToolSetup } from "../providers/jobs/claude-tool-setup.js";
import { deriveRegistryToken } from "../coding/registry/token.js";
import type { JobSpec } from "../providers/jobs/types.js";
import { BLOB, substrateRunToken, toolActorSubject } from "../providers/jobs/substrate/names.js";
import { capabilityHash } from "../providers/coding-proxy/capability-hash.js";
import { MemoryRelayStore } from "../providers/coding-proxy/substrate/memory-relay-store.js";
import { createSubstrateRoutes } from "../providers/coding-proxy/substrate/routes.js";
import { LocalBlobStore } from "../providers/storage/local.js";
import type { ProxySession } from "../providers/coding-proxy/types.js";
import { run as runAgent, spawnWorker, type AgentHandle } from "./agent.js";
import { INJECTED_MCP_TOKEN_PLACEHOLDER, PLACEHOLDER_CAPABILITY } from "./constants.js";
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
const args = process.argv.slice(2).filter((a) => a !== "--anchored" && a !== "--no-anchored" && a !== "--delay-directory-restore" && a !== "--no-overwrite-dir");
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
  let routeWarns: unknown[][];
  let proxyOverride: ((url: string) => number | undefined) | undefined;
  let proxyDelay: ((url: string) => number) | undefined;
  /** The session's MCP tools (harness parameter): pinned tools turn the input's MCP flag on. */
  let mcpTools: ProxySession["mcpTools"] | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridge-it-"));
    blobs = new LocalBlobStore(join(dir, "blobs"));
    relay = new MemoryRelayStore();
    relay.register(TOKEN, 1 << 20);
    logs = [];
    sockets = [];
    routeLogs = [];
    routeWarns = [];
    proxyOverride = undefined;
    proxyDelay = undefined;
    mcpTools = undefined;
    const routes = createSubstrateRoutes({
      atespace: ATESPACE,
      relay,
      blobs,
      ledger: {
        findSessionByCapabilityHash: async (hash) =>
          hash === capabilityHash(PLACEHOLDER_CAPABILITY)
            ? ({
                runId: "run-1",
                deadlineAt: new Date(Date.now() + 60_000),
                status: "active",
                ...(mcpTools !== undefined ? { mcpTools } : {}),
              } as ProxySession)
            : null,
      },
      verifyActor: async (actorJwt, subject) =>
        actorJwt === "placeholder" && subject === toolActorSubject(ATESPACE, TOKEN)
          ? { ok: true, subject }
          : { ok: false, code: "invalid" },
      tokenForRun: substrateRunToken,
      limits: { resultBytes: 1 << 20, transcriptBytes: 1 << 20, workspaceBytes: 1 << 24 },
      pollWaitMs: 200,
      log: { info: (...args) => void routeLogs.push(args), warn: (...args) => void routeWarns.push(args) },
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

  async function stage(
    options: { collectExclude?: unknown; collectResultBundle?: true } = {},
  ): Promise<{ workspace: string; toolSetup: string }> {
    const seedDir = join(dir, "seed");
    await mkdir(join(seedDir, "src"), { recursive: true });
    await writeFile(join(seedDir, "src", "hello.txt"), "hello from the seed\n");
    await mkdir(join(seedDir, "src", "skipped"), { recursive: true });
    await writeFile(join(seedDir, "src", "skipped", "big.bin"), "excluded by path\n");
    await mkdir(join(seedDir, "node_modules"), { recursive: true });
    await writeFile(join(seedDir, "node_modules", "dep.js"), "skip me\n");
    // COPYFILE_DISABLE as in hostTarArchive: macOS tar would add `._*` entries that are not under "./".
    await exec("tar", ["-c", "-C", seedDir, "-f", join(dir, "seed.tar"), "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
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
          ...(options.collectResultBundle ? { collectResultBundle: true } : {}),
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

  async function startTool(
    workspace: string,
    toolSetup: string,
    extra: Partial<Parameters<typeof runTool>[0]> & { onStop?: (signal: "stop" | "kill") => void } = {},
  ): Promise<ToolHandle> {
    const { onStop, ...overrides } = extra;
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
          ...(onStop ? { stop: () => onStop("stop"), kill: () => onStop("kill") } : {}),
        };
      },
      ...overrides,
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

  /** A worker that leaves a root .git (history, objects, and optionally the result bundle) and exits. */
  const historyWorker = (workspace: string, bundle: "file" | "symlink" | "none") => ({
    exited: (async () => {
      await mkdir(join(workspace, ".git", "objects", "ab"), { recursive: true });
      await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(workspace, ".git", "objects", "ab", "cdef"), "a history object\n");
      await writeFile(join(dir, "outside.bundle"), "not the run's bundle\n");
      if (bundle === "file") await writeFile(join(workspace, ".git", "wardby-result.bundle"), "the result bundle\n");
      if (bundle === "symlink")
        await symlink(join(dir, "outside.bundle"), join(workspace, ".git", "wardby-result.bundle"));
      return 2;
    })(),
  });

  async function collectedEntries(): Promise<string[]> {
    expect(await tool!.collected).toBe("ok");
    await waitFor(async () => ((await blobs.head(BLOB.done(TOKEN))) ? true : undefined));
    const tarPath = join(dir, "check.tar");
    await writeFile(tarPath, await readBlob(BLOB.workspace(TOKEN)));
    return (await exec("tar", ["-t", "-f", tarPath])).stdout.split("\n").filter(Boolean);
  }

  it("uploads only the result bundle from .git on a git-history run (#536)", async () => {
    const { workspace, toolSetup } = await stage({ collectResultBundle: true });
    tool = await startTool(workspace, toolSetup);
    agent = await runAgent(await workerOptions({ launchWorker: () => historyWorker(workspace, "file") }));
    await agent.uploaded;
    const entries = await collectedEntries();
    expect(entries.filter((entry) => entry.includes(".git"))).toEqual(["./.git/wardby-result.bundle"]);
    expect(entries).toContain("./src/hello.txt");
    expect(entries.some((entry) => entry.includes("node_modules") || entry.includes("src/skipped"))).toBe(false);
    const tarPath = join(dir, "check.tar");
    expect((await exec("tar", ["-x", "-O", "-f", tarPath, "./.git/wardby-result.bundle"])).stdout).toBe(
      "the result bundle\n",
    );
  });

  it("uploads no .git at all on a git-history run that wrote no bundle", async () => {
    const { workspace, toolSetup } = await stage({ collectResultBundle: true });
    tool = await startTool(workspace, toolSetup);
    agent = await runAgent(await workerOptions({ launchWorker: () => historyWorker(workspace, "none") }));
    await agent.uploaded;
    const entries = await collectedEntries();
    expect(entries.filter((entry) => entry.includes(".git"))).toEqual([]);
    expect(entries).toContain("./src/hello.txt");
  });

  it("fails the run when the bundle is a symlink", async () => {
    const result = await historyCollect(async (workspace) => {
      await mkdir(join(workspace, ".git"), { recursive: true });
      await writeFile(join(dir, "outside.bundle"), "not the run's bundle\n");
      await symlink(join(dir, "outside.bundle"), join(workspace, ".git", "wardby-result.bundle"));
    });
    expect(result.skipped).toEqual(["bundle_symlink"]);
    await expectFailedCollect(result);
  });

  it("ends the runner's process group before a git-history run's workspace is read", async () => {
    const { workspace, toolSetup } = await stage({ collectResultBundle: true });
    const signals: string[] = [];
    tool = await startTool(workspace, toolSetup, {
      onStop: (signal) => void signals.push(signal),
      beforeResultBundleRecheck: () => void signals.push("bundle_read"),
    });
    agent = await runAgent(await workerOptions({ launchWorker: () => historyWorker(workspace, "file") }));
    await agent.uploaded;
    const entries = await collectedEntries();
    expect(signals).toEqual(["stop", "kill", "bundle_read"]);
    expect(entries.filter((entry) => entry.includes(".git"))).toEqual(["./.git/wardby-result.bundle"]);
  }, 20_000);

  /** Runs a git-history collect after `prepare` changes the workspace's .git; returns the collect's outcome and logs. */
  async function historyCollect(
    prepare: (workspace: string) => Promise<void>,
    extra: Partial<Parameters<typeof runTool>[0]> = {},
  ): Promise<{ outcome: string; skipped: string[] }> {
    const { workspace, toolSetup } = await stage({ collectResultBundle: true });
    tool = await startTool(workspace, toolSetup, extra);
    agent = await runAgent(
      await workerOptions({
        launchWorker: () => ({
          exited: (async () => {
            await prepare(workspace);
            return 2;
          })(),
        }),
      }),
    );
    await agent.uploaded;
    const outcome = await tool.collected;
    const skipped = logs
      .map((line) => JSON.parse(line) as { event: string; reason?: string })
      .filter((entry) => entry.event === "substrate_bridge_result_bundle_skipped")
      .map((entry) => entry.reason ?? "");
    return { outcome, skipped };
  }

  /** The run fails: no workspace upload, workspace-failed is what the launcher sees. */
  async function expectFailedCollect(result: { outcome: string }): Promise<void> {
    expect(result.outcome).toBe("failed");
    await waitFor(async () => ((await blobs.head(BLOB.done(TOKEN))) ? true : undefined));
    expect(JSON.parse((await readBlob(BLOB.done(TOKEN))).toString())).toEqual({ workspace: "failed" });
    expect(await blobs.head(BLOB.workspace(TOKEN))).toBeNull();
  }

  it("fails the run when .git is a symlink to a folder holding a bundle", async () => {
    const result = await historyCollect(async (workspace) => {
      const elsewhere = join(dir, "elsewhere-git");
      await mkdir(elsewhere, { recursive: true });
      await writeFile(join(elsewhere, "wardby-result.bundle"), "not the run's bundle\n");
      await symlink(elsewhere, join(workspace, ".git"));
    });
    expect(result.skipped).toEqual(["git_not_directory"]);
    await expectFailedCollect(result);
  });

  it("fails the run, without hanging, when the bundle is a FIFO", async () => {
    const result = await historyCollect(async (workspace) => {
      await mkdir(join(workspace, ".git"), { recursive: true });
      await exec("mkfifo", [join(workspace, ".git", "wardby-result.bundle")]);
    });
    expect(result.skipped).toEqual(["not_regular_file"]);
    await expectFailedCollect(result);
  });

  it("fails the run when .git is swapped for another folder between the checks", async () => {
    const result = await historyCollect(
      async (workspace) => {
        await mkdir(join(workspace, ".git"), { recursive: true });
        await writeFile(join(workspace, ".git", "wardby-result.bundle"), "the result bundle\n");
      },
      {
        beforeResultBundleRecheck: async () => {
          const workspace = join(dir, "workspace");
          await rename(join(workspace, ".git"), join(dir, "old-git"));
          await mkdir(join(workspace, ".git"));
          await writeFile(join(workspace, ".git", "wardby-result.bundle"), "a swapped bundle\n");
        },
      },
    );
    expect(result.skipped).toEqual(["git_changed"]);
    await expectFailedCollect(result);
  });

  it("keeps a bundle of any size: the launcher's run limit and the proxy's upload limit bound it", async () => {
    const { workspace, toolSetup } = await stage({ collectResultBundle: true });
    tool = await startTool(workspace, toolSetup);
    const big = "x".repeat(3 * 1024 * 1024 + 17);
    agent = await runAgent(
      await workerOptions({
        launchWorker: () => ({
          exited: (async () => {
            await mkdir(join(workspace, ".git"), { recursive: true });
            await writeFile(join(workspace, ".git", "wardby-result.bundle"), big);
            return 2;
          })(),
        }),
      }),
    );
    await agent.uploaded;
    const entries = await collectedEntries();
    expect(entries.filter((entry) => entry.includes(".git"))).toEqual(["./.git/wardby-result.bundle"]);
    const listing = (await exec("tar", ["-tv", "-f", join(dir, "check.tar"), "./.git/wardby-result.bundle"])).stdout;
    expect(listing).toContain(` ${big.length} `);
  });

  it("uploads the workspace's .git unchanged on a run without git history", async () => {
    const { workspace, toolSetup } = await stage();
    tool = await startTool(workspace, toolSetup);
    agent = await runAgent(await workerOptions({ launchWorker: () => historyWorker(workspace, "file") }));
    await agent.uploaded;
    const entries = await collectedEntries();
    expect(entries).toEqual(
      expect.arrayContaining(["./.git/HEAD", "./.git/objects/ab/cdef", "./.git/wardby-result.bundle"]),
    );
  });

  it("uploads the transcript before the result or exit report that ends the run", async () => {
    const { workspace, toolSetup } = await stage();
    tool = await startTool(workspace, toolSetup);
    const posts: string[] = [];
    proxyDelay = (request) => {
      const match = /^POST \/substrate\/runs\/[^/]+\/(transcript|result|exit|diagnostics)$/.exec(request);
      if (match) posts.push(match[1]);
      return 0;
    };
    const worker = (withResult: boolean) => () => ({
      exited: (async () => {
        await mkdir(join(dir, "out"), { recursive: true });
        await writeFile(join(dir, "out", "session.jsonl"), '{"type":"user"}\n');
        if (withResult) await writeFile(join(dir, "out", "result.json"), "{}");
        return withResult ? 0 : 2;
      })(),
    });
    agent = await runAgent(await workerOptions({ launchWorker: worker(false) }));
    await agent.uploaded;
    // No result file: the exit report ends the run, and nothing is sent after it.
    expect(posts.filter((p) => p !== "diagnostics")).toEqual(["transcript", "exit"]);
    expect(posts.at(-1)).toBe("exit");
    expect(await tool.collected).toBe("ok");
    await agent.close();
    await tool.close();
    agent = tool = undefined;

    // With a result: transcript, then result.
    await rm(join(dir, "out"), { recursive: true, force: true });
    const staged = await stage();
    tool = await startTool(staged.workspace, staged.toolSetup);
    posts.length = 0;
    agent = await runAgent(await workerOptions({ launchWorker: worker(true) }));
    await agent.uploaded;
    expect(posts).toEqual(["transcript", "result"]);
    // The result asks the tool for the workspace: let that collect finish before teardown (its
    // outcome is not the point here: the first part already stored this token's workspace).
    await tool.collected;
  });

  it("does not let a stuck transcript upload hold back the exit report", async () => {
    const { workspace, toolSetup } = await stage();
    tool = await startTool(workspace, toolSetup);
    proxyDelay = (request) => (/^POST \/substrate\/runs\/[^/]+\/transcript$/.test(request) ? 60_000 : 0);
    agent = await runAgent(
      await workerOptions({
        transcriptDeadlineMs: 200,
        launchWorker: () => ({
          exited: (async () => {
            await mkdir(join(dir, "out"), { recursive: true });
            await writeFile(join(dir, "out", "session.jsonl"), '{"type":"user"}\n');
            return 2;
          })(),
        }),
      }),
    );
    await agent.uploaded;
    expect(JSON.parse((await readBlob(BLOB.exit(TOKEN))).toString())).toEqual({ code: 2 });
    expect(logs.join("\n")).toContain('"what":"transcript"');
    expect(await tool.collected).toBe("ok");
  });

  it("reports the worker's own diagnostic line with its exit code, and nothing else of its output", async () => {
    const { workspace, toolSetup } = await stage();
    tool = await startTool(workspace, toolSetup);
    agent = await runAgent(
      await workerOptions({
        launchWorker: () => {
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          return {
            stdout,
            stderr,
            exited: (async () => {
              stderr.write('{"error":"coding_stream_failed"}\n');
              stdout.write("model said: rrp_fake_capability_value_000001\n");
              stderr.write('{"error":"coding_tu');
              stderr.write('rn_limit"}\n{"error":"provider said sk-SECRET"}\nnot json\n');
              stdout.end();
              stderr.end();
              return 1;
            })(),
          };
        },
      }),
    );
    await agent.uploaded;
    expect(JSON.parse((await readBlob(BLOB.exit(TOKEN))).toString())).toEqual({
      code: 1,
      diagnostic: "coding_turn_limit",
    });
    expect(await tool.collected).toBe("ok");
  });

  it("reports only the exit code when the worker printed no safe diagnostic", async () => {
    const { workspace, toolSetup } = await stage();
    tool = await startTool(workspace, toolSetup);
    agent = await runAgent(
      await workerOptions({
        launchWorker: () => {
          const stderr = new PassThrough();
          return {
            stderr,
            exited: (async () => {
              stderr.end('{"error":"provider said sk-SECRET"}\n{"error":"coding_x","issues":["bad issue"]}garbage\n');
              return 3;
            })(),
          };
        },
      }),
    );
    await agent.uploaded;
    expect(JSON.parse((await readBlob(BLOB.exit(TOKEN))).toString())).toEqual({ code: 3 });
    // The exit report asks the tool for the workspace: let that collect finish before the test's
    // directory (and the tar shim in it) is removed, or the tar it runs cannot be found.
    expect(await tool.collected).toBe("ok");
  });

  /** The tail the proxy logged at warn for one side (CLAUDE.md operator diagnostics), or undefined. */
  const diagnosticsTail = (side: "agent" | "tool"): string | undefined => {
    const found = routeWarns.find(
      ([fields]) =>
        (fields as { event?: string; side?: string }).event === "substrate.diagnostics" &&
        (fields as { side?: string }).side === side,
    );
    return found ? (found[0] as { tail: string }).tail : undefined;
  };

  /** Every blob's bytes, as text: the tail must never be stored. */
  async function everyBlobText(): Promise<string> {
    const root = join(dir, "blobs");
    const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
    const texts: string[] = [];
    for (const entry of entries) {
      if (entry.isFile()) texts.push(await readFile(join(entry.parentPath, entry.name), "latin1"));
    }
    return texts.join("\n");
  }

  it("sends the worker's redacted stderr tail to the operator log on a failure, and stores none of it", async () => {
    const { workspace, toolSetup } = await stage();
    tool = await startTool(workspace, toolSetup);
    agent = await runAgent(
      await workerOptions({
        launchWorker: () => {
          const stderr = new PassThrough();
          return {
            stderr,
            exited: (async () => {
              stderr.end(`worker says boom\nusing key ${PLACEHOLDER_CAPABILITY}\n{"error":"coding_turn_limit"}\n`);
              return 1;
            })(),
          };
        },
      }),
    );
    await agent.uploaded;
    const tail = await waitFor(() => diagnosticsTail("agent"));
    expect(tail).toContain("worker says boom");
    expect(tail).toContain("using key [redacted]");
    expect(tail).not.toContain(PLACEHOLDER_CAPABILITY);
    expect(await everyBlobText()).not.toContain("worker says boom");
    expect(JSON.stringify(routeLogs)).not.toContain("worker says boom");
    expect(diagnosticsTail("tool")).toBeUndefined();
    expect(await tool.collected).toBe("ok");
  });

  describe("MCP tools", () => {
    const PIN = {
      exposedName: "docs__search",
      toolName: "search",
      serverId: "server-1",
      serverName: "docs",
      definition: { description: "d", inputSchema: { type: "object" } },
    };
    /** Starts the agent with a worker that records its env and exits without a result. */
    async function capturedEnv(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
      const { workspace, toolSetup } = await stage();
      tool = await startTool(workspace, toolSetup);
      let workerEnv: NodeJS.ProcessEnv | undefined;
      agent = await runAgent(
        await workerOptions({
          env,
          launchWorker: (launched) => {
            workerEnv = launched;
            return { exited: Promise.resolve(2) };
          },
        }),
      );
      await agent.uploaded;
      expect(await tool.collected).toBe("ok");
      return workerEnv!;
    }

    it("starts the Claude worker in MCP header mode when the run has MCP tools", async () => {
      mcpTools = [PIN];
      const env = await capturedEnv({ PATH: "/usr/bin" });
      expect(env.WARDBY_MCP_TOKEN).toBe("rmt_placeholder_injected_by_gateway");
      expect(env.WARDBY_MCP_TOKEN_HEADER).toBe("x-wardby-mcp-token");
      expect(env.WARDBY_RUN_CAPABILITY).toBe(PLACEHOLDER_CAPABILITY);
    });

    it("without MCP tools the worker gets neither variable, even one inherited", async () => {
      mcpTools = [];
      const env = await capturedEnv({
        ...process.env,
        WARDBY_MCP_TOKEN: "rmt_STALE_FAKE_NOT_REAL",
        WARDBY_MCP_TOKEN_HEADER: "x-wardby-mcp-token",
      });
      expect(env).not.toHaveProperty("WARDBY_MCP_TOKEN");
      expect(env).not.toHaveProperty("WARDBY_MCP_TOKEN_HEADER");
      expect(JSON.stringify(env)).not.toContain("rmt_STALE_FAKE_NOT_REAL");
    });

    it("redacts the MCP placeholder from the tail and the passed-on output", async () => {
      mcpTools = [PIN];
      const { workspace, toolSetup } = await stage();
      tool = await startTool(workspace, toolSetup);
      const entry = join(dir, "mcp-worker.mjs");
      await writeFile(
        entry,
        `process.stderr.write("mcp header " + process.env.WARDBY_MCP_TOKEN + "\\n");\nsetTimeout(() => process.exit(1), 20);\n`,
      );
      let passedOn = "";
      const sink = { write: (text: string) => void (passedOn += text) };
      agent = await runAgent(
        await workerOptions({
          env: { PATH: process.env.PATH },
          // The default secrets: the bridge's own placeholders.
          launchWorker: (env) => spawnWorker(env, undefined, entry, { stdout: sink, stderr: sink }),
        }),
      );
      expect(await agent.workerExited).toBe(1);
      await agent.uploaded;
      const tail = await waitFor(() => diagnosticsTail("agent"));
      expect(tail).toContain("mcp header [redacted]");
      expect(tail).not.toContain(INJECTED_MCP_TOKEN_PLACEHOLDER);
      await waitFor(() => (passedOn.includes("mcp header") ? true : undefined));
      expect(passedOn).toContain("mcp header [redacted]");
      expect(passedOn).not.toContain(INJECTED_MCP_TOKEN_PLACEHOLDER);
      expect(JSON.stringify([routeLogs, routeWarns])).not.toContain(INJECTED_MCP_TOKEN_PLACEHOLDER);
      expect(await tool.collected).toBe("ok");
    });
  });

  it("sends no diagnostics when the worker succeeded", async () => {
    const { workspace, toolSetup } = await stage();
    tool = await startTool(workspace, toolSetup);
    agent = await runAgent(
      await workerOptions({
        launchWorker: () => {
          const stderr = new PassThrough();
          return {
            stderr,
            exited: (async () => {
              stderr.end("all fine\n");
              await mkdir(join(dir, "out"), { recursive: true });
              await writeFile(join(dir, "out", "result.json"), "{}");
              return 0;
            })(),
          };
        },
      }),
    );
    await agent.uploaded;
    await tool.collected;
    expect(routeWarns).toEqual([]);
  });

  it("sends no tool-side diagnostics tail when the tool runner fails to start, and still fails the run now", async () => {
    const { workspace } = await stage();
    const derived = deriveRegistryToken(CAPABILITY);
    const posts: string[] = [];
    proxyDelay = (request) => (posts.push(request), 0);
    await expect(
      runTool({
        proxyUrl,
        metadataDir: await names("tool"),
        workspace,
        socketPath: join(dir, "tool", "runner.sock"),
        readyPort: 0,
        tempRoot: dir,
        tarCommand: await tarForTests(dir),
        policy: FAST,
        log,
        launchRunner: () => {
          const stderr = new PassThrough();
          stderr.end(
            `npm notice auth ${REGISTRY_TOKEN}\nregistry url http://wardby:${derived}@proxy/\nrunner: EADDRINUSE\n`,
          );
          return { stderr, ready: Promise.reject(new Error("exited")), exited: Promise.resolve(1) };
        },
      }),
    ).rejects.toMatchObject({ code: "substrate_bridge_runner_failed" });
    await waitFor(async () => ((await blobs.head(BLOB.done(TOKEN))) ? true : undefined));
    expect(JSON.parse((await readBlob(BLOB.done(TOKEN))).toString())).toEqual({ workspace: "failed" });
    expect(posts.some((request) => request.endsWith("/diagnostics"))).toBe(false);
    expect(diagnosticsTail("tool")).toBeUndefined();
    const logged = JSON.stringify([routeWarns, routeLogs, logs]);
    for (const secret of [REGISTRY_TOKEN, derived, CAPABILITY, "EADDRINUSE"]) expect(logged).not.toContain(secret);
  });

  it("sends no tool-side diagnostics tail when the tool runner exits mid-run", async () => {
    const { workspace } = await stage();
    let exit!: (code: number) => void;
    const stderr = new PassThrough();
    const posts: string[] = [];
    proxyDelay = (request) => (posts.push(request), 0);
    tool = await runTool({
      proxyUrl,
      metadataDir: await names("tool"),
      workspace,
      socketPath: join(dir, "tool", "runner.sock"),
      readyPort: 0,
      tempRoot: dir,
      tarCommand: await tarForTests(dir),
      policy: FAST,
      log,
      launchRunner: () => ({ stderr, ready: Promise.resolve(), exited: new Promise<number>((r) => (exit = r)) }),
    });
    stderr.end(`runner crashed: out of memory ${REGISTRY_TOKEN}\n`);
    exit(137);
    expect(await tool.runnerExited).toBe(137);
    expect(logs.join("\n")).toContain("substrate_bridge_runner_exited");
    expect(posts.some((request) => request.endsWith("/diagnostics"))).toBe(false);
    expect(JSON.stringify([routeWarns, routeLogs, logs])).not.toContain(REGISTRY_TOKEN);
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
const args = process.argv.slice(2).filter((a) => a !== "--anchored" && a !== "--no-anchored" && a !== "--delay-directory-restore" && a !== "--no-overwrite-dir");
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

  it("refuses an actor named for the other role, and keeps waiting on a name that is not a run name", async () => {
    const metadata = join(dir, "bad");
    await mkdir(metadata, { recursive: true });
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
    await writeFile(join(metadata, "name"), `${TOKEN}-agent\n`);
    await expect(
      runTool({
        proxyUrl,
        metadataDir: metadata,
        readyPort: 0,
        log,
        policy: FAST,
        tempRoot: dir,
        socketPath: join(dir, "s", "y.sock"),
      }),
    ).rejects.toMatchObject({ code: "substrate_bridge_identity_invalid" });
    // Not a run name at all (a golden actor's, or a malformed one): the bridge waits, until stopped.
    await writeFile(join(metadata, "name"), "wr-nothex-agent\n");
    const stop = new AbortController();
    const waiting = runAgent({
      proxyUrl,
      metadataDir: metadata,
      readyPort: 0,
      log,
      policy: FAST,
      identityPollMs: 10,
      signal: stop.signal,
      socketPath: join(dir, "s", "x.sock"),
    });
    await waitFor(() => (logs.some((l) => l.includes("substrate_bridge_waiting_for_identity")) ? true : undefined));
    stop.abort();
    await expect(waiting).rejects.toMatchObject({ code: "substrate_bridge_stopped" });
  });

  for (const role of ["agent", "tool"] as const) {
    it(`${role} bridge: answers readyz before its identity is known, then proceeds once the name becomes a run name`, async () => {
      const { workspace } = await stage();
      const metadata = join(dir, `golden-${role}`);
      await mkdir(metadata, { recursive: true });
      // A golden actor's name: Substrate snapshots the actor while the bridge waits on it.
      await writeFile(join(metadata, "name"), "d0275793-6b1a-4c1e-9f3e-0123456789ab\n");
      let readyPort: number | undefined;
      const common = {
        proxyUrl,
        metadataDir: metadata,
        readyPort: 0,
        log,
        policy: FAST,
        identityPollMs: 10,
        onReady: (port: number) => {
          readyPort = port;
        },
      };
      const started =
        role === "agent"
          ? runAgent({
              ...common,
              inputPath: join(dir, "in", "input.json"),
              resultPath: join(dir, "out", "result.json"),
              transcriptPath: join(dir, "out", "session.jsonl"),
              socketPath: join(dir, "agent", "runner.sock"),
              launchWorker: () => ({ exited: new Promise<number>(() => undefined) }),
            })
          : runTool({
              ...common,
              workspace,
              socketPath: join(dir, "tool", "runner.sock"),
              tempRoot: dir,
              tarCommand: await tarForTests(dir),
              launchRunner: () => ({ ready: Promise.resolve(), exited: new Promise<number>(() => undefined) }),
            });
      const port = await waitFor(() => readyPort);
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
      await waitFor(() => (logs.some((l) => l.includes("substrate_bridge_waiting_for_identity")) ? true : undefined));
      // Nothing fetched while waiting.
      expect(logs.filter((l) => /input_ready|setup_ready/.test(l))).toEqual([]);
      await writeFile(join(metadata, "name"), `${TOKEN}-${role}\n`);
      const handle = await started;
      if (role === "agent") agent = handle as AgentHandle;
      else tool = handle as ToolHandle;
      expect(handle.runToken).toBe(TOKEN);
      expect(handle.readyPort).toBe(port);
      expect(logs.filter((l) => l.includes("substrate_bridge_waiting_for_identity"))).toHaveLength(1);
      expect(logs.some((l) => /input_ready|setup_ready/.test(l))).toBe(true);
    });
  }

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
    expect(logs.some((l) => l.includes("substrate_bridge_posted") && l.includes("workspace-failed"))).toBe(true);
  });

  it("extracts with --no-overwrite-dir and tells the run when the extraction fails", async () => {
    const { workspace } = await stage();
    const argvFile = join(dir, "extract-argv.json");
    const shim = join(dir, "recording-tar.mjs");
    await writeFile(
      shim,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
process.stderr.write("tar: cannot extract ./src (token ${REGISTRY_TOKEN})\\n");
process.exit(2);
`,
      { mode: 0o755 },
    );
    await expect(
      runTool({
        proxyUrl,
        metadataDir: await names("tool"),
        workspace,
        socketPath: join(dir, "tool", "runner.sock"),
        readyPort: 0,
        tempRoot: dir,
        tarCommand: shim,
        policy: FAST,
        log,
        launchRunner: () => ({ ready: Promise.resolve(), exited: new Promise<number>(() => undefined) }),
      }),
    ).rejects.toMatchObject({ code: "substrate_bridge_seed_failed" });
    const argv = JSON.parse(await readFile(argvFile, "utf8")) as string[];
    expect(argv).toContain("--no-overwrite-dir");
    expect(argv).toContain("--strip-components=1");
    expect(argv).toContain("--no-same-owner");
    expect(logs.filter((l) => l.includes("substrate_bridge_posted") && l.includes("workspace-failed"))).toHaveLength(1);
    // No tool-side tail reaches the proxy's log (tar's stderr stays in the actor's own log).
    expect(diagnosticsTail("tool")).toBeUndefined();
    expect(JSON.stringify([routeWarns, routeLogs, logs])).not.toContain(REGISTRY_TOKEN);
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
