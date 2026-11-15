// Warm rounds end to end without Substrate: real routes (warm rounds on), memory relay, local blobs,
// the real tool runner, a stub worker. The "launcher" steps between rounds are done by hand here.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { getHeapSnapshot } from "node:v8";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseToolSetup } from "../claude-tool-runner/command.mjs";
import { claudeToolSetup } from "../providers/jobs/claude-tool-setup.js";
import type { JobSpec } from "../providers/jobs/types.js";
import { BLOB, roundBlob, substrateRunToken, toolActorSubject } from "../providers/jobs/substrate/names.js";
import { capabilityHash } from "../providers/coding-proxy/capability-hash.js";
import { MemoryRelayStore } from "../providers/coding-proxy/substrate/memory-relay-store.js";
import { createSubstrateRoutes } from "../providers/coding-proxy/substrate/routes.js";
import { LocalBlobStore } from "../providers/storage/local.js";
import type { ProxySession } from "../providers/coding-proxy/types.js";
import { run as runAgent, type AgentHandle } from "./agent.js";
import { PLACEHOLDER_CAPABILITY, WARM_ROUNDS_ENV } from "./constants.js";
import { DEFAULT_POLICY } from "./http.js";
import { run as runTool, spawnRunner, type ToolHandle } from "./tool.js";

const exec = promisify(execFile);
const ATESPACE = "wardby-runs";
const CAPABILITY = "rrp_fake_capability_value_000001";
const REGISTRY_TOKEN_1 = "rrg_fake_registry_token_round_1";
const REGISTRY_TOKEN_2 = "rrg_fake_registry_token_round_2";
const TOKEN = substrateRunToken("run-1");
const SESSION = "0b5f0d6c-4a43-4a1c-9b7e-2f6a1d2c3e4f";
const FAST = { ...DEFAULT_POLICY, baseMs: 5, maxMs: 20, retryAfterCapMs: 20 };

const spec: JobSpec = {
  kind: "coding-agent",
  runId: "run-1",
  provider: "claude-code",
  image: `registry.example/agent@sha256:${"a".repeat(64)}`,
  toolImage: `registry.example/tool@sha256:${"b".repeat(64)}`,
  inputArtifact: "/tmp/input.json",
  timeoutSec: 900,
  limits: { cpus: 1, memoryMb: 2048, pids: 128, diskMb: 2048 },
  labels: {},
};

/** Whether a heap snapshot of this process (taken after a full GC) contains `needle`'s bytes. */
async function heapHolds(needle: Buffer): Promise<boolean> {
  const snapshot = getHeapSnapshot();
  let carry = Buffer.alloc(0);
  for await (const chunk of snapshot) {
    const window = Buffer.concat([carry, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)]);
    if (window.includes(needle)) {
      snapshot.destroy();
      return true;
    }
    carry = window.subarray(Math.max(0, window.length - needle.length + 1));
  }
  return false;
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

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

function toolSetupBlob(registryToken: string): Buffer {
  const setup = JSON.parse(claudeToolSetup(spec, CAPABILITY)) as { env: Record<string, string> };
  setup.env.FAKE_REGISTRY_TOKEN = registryToken;
  return Buffer.from(
    JSON.stringify({ toolSetup: JSON.stringify(setup), collectExclude: { names: ["node_modules"], paths: [] } }),
  );
}

describe("substrate bridges, warm rounds", () => {
  let dir: string;
  let proxy: Server;
  let proxyUrl: string;
  let blobs: LocalBlobStore;
  let relay: MemoryRelayStore;
  let agent: AgentHandle | undefined;
  let tool: ToolHandle | undefined;
  let logs: string[];
  let routeLogs: unknown[];
  let requests: string[];
  /** The run the gateway's capability belongs to: the launcher's Secret update moves it to run-2. */
  let currentRun: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridge-warm-"));
    blobs = new LocalBlobStore(join(dir, "blobs"));
    relay = new MemoryRelayStore();
    relay.register(TOKEN, 1 << 20);
    logs = [];
    routeLogs = [];
    requests = [];
    currentRun = "run-1";
    const routes = createSubstrateRoutes({
      atespace: ATESPACE,
      relay,
      blobs,
      ledger: {
        findSessionByCapabilityHash: async (hash) =>
          hash === capabilityHash(PLACEHOLDER_CAPABILITY)
            ? ({ runId: currentRun, deadlineAt: new Date(Date.now() + 60_000), status: "active" } as ProxySession)
            : null,
      },
      verifyActor: async (actorJwt, subject) =>
        actorJwt === "placeholder" && subject === toolActorSubject(ATESPACE, TOKEN)
          ? { ok: true, subject }
          : { ok: false, code: "invalid" },
      // run-2 adopted run-1's actors: it holds the token now.
      tokenForRun: async (runId) => (runId === currentRun ? TOKEN : "wa-retired"),
      warmRounds: true,
      limits: { resultBytes: 1 << 20, transcriptBytes: 1 << 20, workspaceBytes: 1 << 24 },
      pollWaitMs: 100,
      log: { info: (...args) => void routeLogs.push(args), warn: (...args) => void routeLogs.push(args) },
    });
    proxy = createHttpServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      void routes(req, res);
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

  const names = async (role: string): Promise<string> => {
    const metadata = join(dir, `meta-${role}`);
    await mkdir(metadata, { recursive: true });
    await writeFile(join(metadata, "name"), `${TOKEN}-${role}\n`);
    return metadata;
  };

  async function stageRoundOne(): Promise<string> {
    const seedDir = join(dir, "seed");
    await mkdir(join(seedDir, "src"), { recursive: true });
    await writeFile(join(seedDir, "src", "hello.txt"), "seed\n");
    await exec("tar", ["-c", "-C", seedDir, "-f", join(dir, "seed.tar"), "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    await blobs.put(BLOB.input(TOKEN), Buffer.from(JSON.stringify({ runId: "run-1", task: "round one" })));
    await blobs.put(BLOB.toolSetup(TOKEN), toolSetupBlob(REGISTRY_TOKEN_1));
    await blobs.put(BLOB.seed(TOKEN), await readFile(join(dir, "seed.tar")));
    return join(dir, "workspace");
  }

  /** What the launcher's adoption stages: the next round's input, tool setup and round record. */
  async function stageRoundTwo(): Promise<void> {
    await blobs.delete(BLOB.seed(TOKEN));
    currentRun = "run-2";
    await blobs.put(BLOB.input(TOKEN, 2), Buffer.from(JSON.stringify({ runId: "run-2", task: "round two" })));
    await blobs.put(BLOB.toolSetup(TOKEN), toolSetupBlob(REGISTRY_TOKEN_2));
    await blobs.put(roundBlob(TOKEN), Buffer.from('{"round":2}'));
  }

  async function startBridges(
    warm: boolean,
    options: {
      /** The round whose worker exits 1 without a result. */
      failRound?: number;
      /** Called before staging round one (a cold continuation names its own run). */
      beforeStage?: () => void;
    } = {},
  ): Promise<{
    workspace: string;
    inputs: unknown[];
    setups: string[];
    toolLists: string[][];
    stops: number[];
    kills: number[];
    /** Ends the n-th runner with a code, as if it exited on its own. */
    exits: Array<(code: number) => void>;
  }> {
    options.beforeStage?.();
    const workspace = await stageRoundOne();
    const env = { PATH: "/usr/bin", ...(warm ? { [WARM_ROUNDS_ENV]: "1" } : {}) };
    const socketPath = join(dir, "tool", "runner.sock");
    const runnerUrl = new URL("../claude-tool-runner/main.mjs", import.meta.url).href;
    const runner = (await import(/* @vite-ignore */ runnerUrl)) as {
      startToolRunner: (
        socketPath: string,
        setup: unknown,
        options: { workspacePath: string },
      ) => Promise<{ close(cb?: () => void): void }>;
    };
    const setups: string[] = [];
    const stops: number[] = [];
    const kills: number[] = [];
    const exits: Array<(code: number) => void> = [];
    tool = await runTool({
      proxyUrl,
      env,
      metadataDir: await names("tool"),
      workspace,
      socketPath,
      readyPort: 0,
      tempRoot: dir,
      tarCommand: await tarForTests(dir),
      policy: FAST,
      log,
      nextRoundPollMs: 20,
      launchRunner: (setupText) => {
        setups.push(setupText);
        const server = runner.startToolRunner(socketPath, parseToolSetup(setupText), { workspacePath: workspace });
        let exit!: (code: number) => void;
        const exited = new Promise<number>((resolve) => (exit = resolve));
        exits.push((code) => void server.then((s) => s.close(() => exit(code))));
        return {
          ready: server.then(() => undefined),
          exited,
          stop: () => {
            stops.push(setups.length);
            void server.then((s) => s.close(() => exit(0)));
          },
          kill: () => void kills.push(setups.length),
        };
      },
    });
    const agentSocket = join(dir, "agent", "runner.sock");
    const inputPath = join(dir, "in", "input.json");
    const resultPath = join(dir, "out", "result.json");
    const transcriptPath = join(dir, "out", "session.jsonl");
    const inputs: unknown[] = [];
    const toolLists: string[][] = [];
    agent = await runAgent({
      proxyUrl,
      env,
      metadataDir: await names("agent"),
      inputPath,
      resultPath,
      transcriptPath,
      socketPath: agentSocket,
      readyPort: 0,
      policy: FAST,
      log,
      contextRoot: join(dir, "context"),
      nextRoundPollMs: 20,
      launchWorker: () => {
        const stderr = new PassThrough();
        return {
          stderr,
          exited: (async () => {
            const input = JSON.parse(await readFile(inputPath, "utf8")) as { runId: string };
            inputs.push(input);
            const round = inputs.length;
            stderr.end(`worker stderr of round ${round}\n`);
            // A previous round's output must be gone before this one starts.
            await expect(readFile(resultPath)).rejects.toThrow();
            const socket = connect(agentSocket);
            socket.setEncoding("utf8");
            let pending = "";
            const replies = new Map<number, (message: { result?: { tools?: { name: string }[] } }) => void>();
            socket.on("data", (chunk: string) => {
              pending += chunk;
              let end: number;
              while ((end = pending.indexOf("\n")) >= 0) {
                const message = JSON.parse(pending.slice(0, end)) as {
                  id?: number;
                  result?: { tools?: { name: string }[] };
                };
                pending = pending.slice(end + 1);
                if (message.id !== undefined) replies.get(message.id)?.(message);
              }
            });
            const call = (id: number, method: string, params: unknown) =>
              new Promise<{ result?: { tools?: { name: string }[] } }>((resolve) => {
                replies.set(id, resolve);
                socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
              });
            await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
            await call(1, "initialize", {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "stub", version: "1" },
            });
            const listed = (await call(2, "tools/list", {})).result?.tools?.map((t) => t.name) ?? [];
            toolLists.push(listed);
            socket.end();
            await mkdir(join(dir, "out"), { recursive: true });
            if (round === options.failRound) return 1;
            await writeFile(resultPath, JSON.stringify({ runId: input.runId }));
            const header = {
              type: "wardby-transcript",
              version: 1,
              provider: "claude-code",
              sessionId: SESSION,
              status: "ok",
            };
            await writeFile(transcriptPath, `${JSON.stringify(header)}\n`);
            return 0;
          })(),
        };
      },
    });
    return { workspace, inputs, setups, toolLists, stops, kills, exits };
  }

  it("runs round 2 on the same bridges: next input, resumed session, fresh tool runner, same workspace", async () => {
    const { workspace, inputs, setups, toolLists, stops, kills } = await startBridges(true);
    expect(agent!.warmRounds).toBe(true);
    expect(tool!.warmRounds).toBe(true);
    await agent!.uploaded;
    expect(await tool!.collected).toBe("ok");
    await waitFor(async () => ((await blobs.head(BLOB.transcript(TOKEN))) ? true : undefined));
    // The round-1 input asks the worker to keep its session.
    expect(inputs[0]).toEqual({ runId: "run-1", task: "round one", sessionResume: true });
    // Between rounds: the tool runner is ended; the agent keeps asking for round 2's input.
    await waitFor(() => (stops.length === 1 ? true : undefined));
    // ...and its process group force-ended after it, so nothing round 1's tools started outlives it.
    await waitFor(() => (kills.length === 1 ? true : undefined));
    expect(kills).toEqual(stops);
    await waitFor(() => (requests.some((r) => r.includes("/input?round=2")) ? true : undefined));
    // Something round 1 left in the workspace (an install, a virtualenv): kept as it is.
    await writeFile(join(workspace, "made-in-round-1.txt"), "kept\n");
    await stageRoundTwo();
    await waitFor(async () => ((await blobs.head(BLOB.done(TOKEN, 2))) ? true : undefined));
    await waitFor(async () => ((await blobs.head(BLOB.transcript(TOKEN, 2))) ? true : undefined));
    expect(inputs[1]).toEqual({ runId: "run-2", task: "round two", sessionResume: true, resumeSessionId: SESSION });
    expect(toolLists).toHaveLength(2);
    expect(toolLists[1]).toContain("run_command");
    expect(setups).toHaveLength(2);
    expect(setups[1]).toContain(REGISTRY_TOKEN_2);
    expect(JSON.parse((await blobs.get(BLOB.result(TOKEN, 2))).toString())).toEqual({ runId: "run-2" });
    expect(await blobs.head(BLOB.started(TOKEN, 2))).not.toBeNull();
    // Round 1's files were not overwritten.
    expect(JSON.parse((await blobs.get(BLOB.result(TOKEN))).toString())).toEqual({ runId: "run-1" });
    const tarPath = join(dir, "round-2.tar");
    await writeFile(tarPath, await blobs.get(BLOB.workspace(TOKEN, 2)));
    const listing = (await exec("tar", ["-t", "-f", tarPath])).stdout;
    expect(listing).toContain("made-in-round-1.txt");
    expect(listing).toContain("src/hello.txt");
    // Not seeded again.
    expect(requests.filter((r) => r.includes("/seed"))).toHaveLength(1);
    // No secret value in any bridge log or route log line.
    const logged = JSON.stringify([logs, routeLogs]);
    for (const secret of [CAPABILITY, REGISTRY_TOKEN_1, REGISTRY_TOKEN_2]) expect(logged).not.toContain(secret);
  });

  it("without the warm-rounds env, both bridges idle after round 1 exactly as before", async () => {
    const { stops } = await startBridges(false);
    expect(agent!.warmRounds).toBe(false);
    await agent!.uploaded;
    expect(await tool!.collected).toBe("ok");
    await stageRoundTwo();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requests.some((r) => r.includes("round="))).toBe(false);
    expect(await blobs.head(BLOB.result(TOKEN, 2))).toBeNull();
    expect(stops).toEqual([]);
  });

  it("without the warm-rounds env, a runner exit after the collect still ends the tool bridge, as before", async () => {
    const { exits } = await startBridges(false);
    expect(await tool!.collected).toBe("ok");
    exits[0](7);
    expect(await tool!.runnerExited).toBe(7);
    // Logged only while the bridge was still relaying (Phase A): not after its collect.
    expect(logs.some((line) => line.includes("substrate_bridge_runner_exited"))).toBe(false);
  });

  it("with warm rounds, the runner the bridge ends between rounds does not end the tool bridge", async () => {
    const { stops } = await startBridges(true);
    expect(await tool!.collected).toBe("ok");
    await waitFor(() => (stops.length === 1 ? true : undefined));
    const settled = await Promise.race([
      tool!.runnerExited.then(() => "exited"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 200)),
    ]);
    expect(settled).toBe("waiting");
  });

  it("a continuation launched cold with warm rounds on (branch_moved) runs exactly like round 1 before rounds existed", async () => {
    // The launcher did not adopt: the continuation (run-2) has fresh actors of its own, staged under
    // round 1's names with no round record.
    const { inputs } = await startBridges(true, { beforeStage: () => (currentRun = "run-2") });
    await agent!.uploaded;
    expect(await tool!.collected).toBe("ok");
    await waitFor(async () => ((await blobs.head(BLOB.done(TOKEN))) ? true : undefined));
    // The seed was fetched, and every request of the round named round 1's files: the only round
    // queries are the bridges' waits for a next round (as after any warm round 1).
    const waits = [`GET /substrate/runs/${TOKEN}/input?round=2`, `GET /substrate/runs/${TOKEN}/tool-setup?round=2`];
    expect(requests.filter((r) => r.includes("round=") && !waits.includes(r))).toEqual([]);
    expect(requests.filter((r) => r === `GET /substrate/runs/${TOKEN}/seed`)).toHaveLength(1);
    const paths = new Set(
      requests
        .filter((r) => !waits.includes(r))
        .map((r) => r.replace(/\?.*$/, "").replace(`/substrate/runs/${TOKEN}/`, "")),
    );
    for (const path of ["GET input", "GET tool-setup", "GET seed", "POST transcript", "POST result", "POST workspace"])
      expect(paths).toContain(path);
    for (const key of [BLOB.started(TOKEN), BLOB.result(TOKEN), BLOB.transcript(TOKEN), BLOB.workspace(TOKEN)])
      expect(await blobs.head(key)).not.toBeNull();
    for (const key of [BLOB.started(TOKEN, 2), BLOB.result(TOKEN, 2), BLOB.done(TOKEN, 2)])
      expect(await blobs.head(key)).toBeNull();
    // Its first worker starts no session of its own to resume.
    expect(inputs).toEqual([{ runId: "run-1", task: "round one", sessionResume: true }]);
  });

  it.each(["a runner that keeps its setup", "the real runner process"])(
    "holds no copy of a finished round's registry token while it waits for the next round (%s)",
    async (kind) => {
      // The tokens exist in this process only as Buffers (never as a JS string the test keeps), so a
      // heap snapshot finds one only if the bridge (or something it keeps alive) still holds it.
      const fresh = (): Buffer => Buffer.from(`rrg_${randomBytes(16).toString("hex")}`);
      const token1 = fresh();
      const token2 = fresh();
      const setupBlob = (token: Buffer): Buffer =>
        Buffer.concat([
          Buffer.from('{"toolSetup":"{\\"env\\":{\\"NPM_TOKEN\\":\\"'),
          token,
          Buffer.from('\\"}}","collectExclude":{"names":[],"paths":[]}}'),
        ]);
      await stageRoundOne();
      await blobs.put(BLOB.toolSetup(TOKEN), setupBlob(token1));
      // A stand-in for the tool runner's entry: ready at once, ends on SIGTERM.
      const runnerEntry = join(dir, "runner-entry.mjs");
      await writeFile(runnerEntry, 'console.log("wardby_tool_runner_ready"); setInterval(() => {}, 1000);\n');
      const started: number[] = [];
      tool = await runTool({
        proxyUrl,
        env: { PATH: process.env.PATH ?? "/usr/bin", [WARM_ROUNDS_ENV]: "1" },
        metadataDir: await names("tool"),
        workspace: join(dir, "workspace"),
        socketPath: join(dir, "tool", "runner.sock"),
        readyPort: 0,
        tempRoot: dir,
        tarCommand: await tarForTests(dir),
        policy: FAST,
        log,
        nextRoundPollMs: 20,
        onRoundStarted: (round) => void started.push(round),
        // A runner keeps its tool setup while it lives; the real one has it in its environment.
        launchRunner:
          kind === "the real runner process"
            ? (setupText, runnerEnv) => spawnRunner(setupText, runnerEnv, runnerEntry)
            : (setupText) => {
                let exit!: (code: number) => void;
                const exited = new Promise<number>((resolve) => (exit = resolve));
                return Object.assign(
                  { ready: Promise.resolve(), exited, stop: () => exit(0) },
                  { heldSetup: setupText },
                );
              },
      });
      // Round 1 runs. The fake runner holds its token, which shows the check can see one. The real
      // runner keeps its token in its own process, never this heap, so that variant has no positive
      // control of its own: it relies on the fake variant's, which proves heapHolds finds a held token.
      if (kind !== "the real runner process") expect(await heapHolds(token1)).toBe(true);
      await relay.requestCollect(TOKEN);
      expect(await tool.collected).toBe("ok");
      await waitFor(() => (requests.some((r) => r.includes("/tool-setup?round=2")) ? true : undefined));
      // Waiting for round 2 (the actor may be suspended now): round 1's token is gone.
      expect(await heapHolds(token1)).toBe(false);
      await blobs.put(BLOB.toolSetup(TOKEN), setupBlob(token2));
      await blobs.put(roundBlob(TOKEN), Buffer.from('{"round":2}'));
      await waitFor(() => (started.includes(2) ? true : undefined));
      if (kind !== "the real runner process") expect(await heapHolds(token2)).toBe(true);
      expect(await heapHolds(token1)).toBe(false);
    },
  );

  it("each round's operator-diagnostics tail is that round's alone (warm rounds)", async () => {
    const { stops } = await startBridges(true, { failRound: 2 });
    await agent!.uploaded;
    await waitFor(() => (requests.some((r) => r.includes("/input?round=2")) ? true : undefined));
    expect(await tool!.collected).toBe("ok");
    await waitFor(() => (stops.length === 1 ? true : undefined));
    await stageRoundTwo();
    await waitFor(async () => ((await blobs.head(BLOB.exit(TOKEN, 2))) ? true : undefined));
    const tails = routeLogs
      .map((entry) => (entry as [{ event?: string; tail?: string; round?: number }])[0])
      .filter((fields) => fields.event === "substrate.diagnostics");
    expect(tails).toHaveLength(1);
    expect(tails[0].round).toBe(2);
    expect(tails[0].tail).toContain("worker stderr of round 2");
    expect(tails[0].tail).not.toContain("worker stderr of round 1");
    // Round 2's tail carries round 2's bridge events only (round 1 logged its input without a round).
    // Parsed, not matched as text, so the check does not depend on the order of a log line's fields.
    const inputReady = tails[0].tail!.split("\n").flatMap((line): { event?: string; round?: number }[] => {
      try {
        const fields = JSON.parse(line.slice(line.indexOf("{"))) as { event?: string; round?: number };
        return fields.event === "substrate_bridge_input_ready" ? [fields] : [];
      } catch {
        return [];
      }
    });
    expect(inputReady.length).toBeGreaterThan(0);
    expect(inputReady.every((fields) => fields.round === 2)).toBe(true);
    expect(requests).toContain(`POST /substrate/runs/${TOKEN}/diagnostics?round=2`);
    // The exit report asks the tool for round 2's workspace: let that collect finish before teardown.
    await waitFor(async () => ((await blobs.head(BLOB.done(TOKEN, 2))) ? true : undefined));
  });
});
