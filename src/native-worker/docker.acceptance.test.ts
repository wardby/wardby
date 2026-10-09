/**
 * Native sandbox acceptance on a real local Docker engine (npm run test:native-docker):
 * a real model (claude-haiku-4-5, cents per run), the built worker image, and a
 * `wardby native-gateway` container from the runtime image, against the local
 * Postgres. Opt-in only: WARDBY_NATIVE_DOCKER_TEST=1, plus
 *   NATIVE_TEST_RUNTIME_IMAGE   (default wardby-runtime:native-p4)
 *   NATIVE_TEST_WORKER_IMAGE    (default wardby-native-worker:local)
 *   NATIVE_TEST_DOCKER_NETWORK  (default local_default — the compose network Postgres is on)
 *   NATIVE_TEST_DATABASE_URL    (default postgresql://wardby:wardby@local-postgres-1:5432/wardby — as the gateway sees it)
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../core/db.js";
import { NativeEngine } from "../core/engine-native.js";
import type { NativeRunProviders } from "../core/runner.js";
import { loadProviderConfig } from "../config/providers.js";
import { PostgresDatastore } from "../providers/datastore/index.js";
import { RoutingLlmProvider, resolveLlmRegistrations } from "../providers/llm/index.js";
import { startModelCatalog } from "../providers/llm/catalog-store.js";
import { PostgresAgentMemory } from "../providers/memory/index.js";
import { buildSecretCipher } from "../providers/secrets/index.js";
import {
  buildGatewayConnectArgs,
  buildNativeNetworkCreateArgs,
  buildNativeWorkerRunArgs,
  DEFAULT_NATIVE_WORKER_LIMITS,
  nativeGatewayUrl,
  nativeIsolationNames,
  nativeRunLabel,
} from "./docker-isolation.js";
import { DockerNativeWorkerLauncher } from "./docker-launcher.js";
import { NativeSandboxExecutor } from "./sandbox-executor.js";
import { WARM_INPUT_DIR, WARM_WORKER_UNCLAIMED_EXIT } from "./warm-delivery.js";
import { PooledWorkerLauncher } from "./warm-pool.js";
import { PrismaWarmPoolLedger } from "./warm-pool-ledger.js";

const enabled = process.env.WARDBY_NATIVE_DOCKER_TEST === "1";
const RUNTIME_IMAGE = process.env.NATIVE_TEST_RUNTIME_IMAGE ?? "wardby-runtime:native-p4";
const WORKER_TAG = process.env.NATIVE_TEST_WORKER_IMAGE ?? "wardby-native-worker:local";
const NETWORK = process.env.NATIVE_TEST_DOCKER_NETWORK ?? "local_default";
const GATEWAY_DB = process.env.NATIVE_TEST_DATABASE_URL ?? "postgresql://wardby:wardby@local-postgres-1:5432/wardby";
const MODEL = "claude-haiku-4-5";

const docker = (args: string[], input?: string) =>
  execFileSync("docker", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
const dockerOk = (args: string[]) => {
  try {
    return docker(args);
  } catch {
    return null;
  }
};

describe.skipIf(!enabled)("native sandbox on Docker (acceptance)", () => {
  const tag = randomUUID().slice(0, 8);
  const gateway = `wardby-native-gw-${tag}`;
  const ownerId = `nda-owner-${tag}`;
  const agents = { quick: `nda-quick-${tag}`, slow: `nda-slow-${tag}` };
  const secretId = `nda-secret-${tag}`;
  let workerImage = "";
  let providers: NativeRunProviders;
  let launcher: DockerNativeWorkerLauncher;
  let executor: NativeSandboxExecutor;
  const newExecutor = () =>
    new NativeSandboxExecutor({ db: prisma, providers, launcher, gatewayUrl: nativeGatewayUrl() });

  beforeAll(async () => {
    workerImage = docker(["image", "inspect", "--format", "{{.Id}}", WORKER_TAG]);
    const env = {
      DATABASE_URL: GATEWAY_DB,
      NATIVE_GATEWAY_LISTEN: "0.0.0.0:8790",
      LOG_LEVEL: "warn",
      SECRET_APP_KEY: process.env.SECRET_APP_KEY ?? "",
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
    };
    docker([
      "run",
      "-d",
      "--name",
      gateway,
      "--network",
      NETWORK,
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      RUNTIME_IMAGE,
      "node",
      "dist/cli.js",
      "native-gateway",
    ]);
    // Ready when /healthz answers inside the gateway's own network namespace.
    for (let i = 0; i < 60; i += 1) {
      if (
        dockerOk([
          "exec",
          gateway,
          "node",
          "-e",
          "fetch('http://127.0.0.1:8790/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))",
        ]) !== null
      )
        break;
      await new Promise((r) => setTimeout(r, 500));
    }

    await startModelCatalog(prisma);
    const regs = resolveLlmRegistrations();
    if (regs.kind !== "registrations") throw new Error("no LLM credentials");
    const secrets = buildSecretCipher(loadProviderConfig());
    providers = {
      llm: new RoutingLlmProvider(regs.registrations),
      engine: new NativeEngine(),
      datastore: new PostgresDatastore(prisma, secrets),
      secrets,
      memory: new PostgresAgentMemory(prisma),
    };
    launcher = new DockerNativeWorkerLauncher({
      image: workerImage,
      gatewayContainer: gateway,
      limits: DEFAULT_NATIVE_WORKER_LIMITS,
    });
    executor = newExecutor();

    await prisma.principal.create({ data: { id: ownerId, subject: ownerId } });
    await prisma.secret.create({
      data: {
        id: secretId,
        name: "api",
        ciphertext: await secrets.encrypt("acceptance-secret-77"),
        keyId: secrets.keyId(),
        ownerId,
      },
    });
    const tools = {
      quick: `const note = await datastore.get(params.key);
const key = await secrets.get("api");
console.log("lookup", params.key, key);
return { note, keyLength: key.length };`,
      slow: `await new Promise((r) => setTimeout(r, 7000));
return { note: await datastore.get(params.key) };`,
    };
    for (const kind of ["quick", "slow"] as const) {
      const agentId = agents[kind];
      // Tool names are unique per owner.
      const toolName = kind === "quick" ? "lookup" : "slow_lookup";
      await prisma.agent.create({
        data: {
          id: agentId,
          name: agentId,
          model: MODEL,
          budgetUsd: 0.05,
          maxTurns: 4,
          ownerId,
          nativeExecutionMode: "sandbox",
          systemPrompt: `Call the ${toolName} tool once with key "notes/a". Then answer in one short sentence with what the note says.`,
        },
      });
      const toolId = `${agentId}-tool`;
      await prisma.tool.create({
        data: {
          id: toolId,
          name: toolName,
          ownerId,
          description: "Reads a note by key.",
          code: tools[kind],
          paramsZod: "z.object({ key: z.string() })",
          jsonSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
        },
      });
      await prisma.agentTool.create({
        data: {
          agentId,
          toolId,
          allowedSecrets: ["api"],
          allowedDatastorePrefixes: ["notes/"],
          capabilitiesGrantedById: ownerId,
        },
      });
      await prisma.agentSecret.create({ data: { agentId, secretId, boundName: "api" } });
      await providers.datastore.set(agentId, "notes/a", "The launch moved to Friday.");
    }
  }, 120_000);

  afterAll(async () => {
    dockerOk(["rm", "-f", gateway]);
    const runs = await prisma.run.findMany({ where: { agentId: { in: Object.values(agents) } }, select: { id: true } });
    for (const { id } of runs) await launcher?.remove(id).catch(() => {});
    const ids = runs.map((r) => r.id);
    await prisma.runModelUsage.deleteMany({ where: { runId: { in: ids } } });
    await prisma.runAttribution.deleteMany({ where: { runId: { in: ids } } });
    await prisma.run.deleteMany({ where: { id: { in: ids } } });
    await prisma.agentTool.deleteMany({ where: { agentId: { in: Object.values(agents) } } });
    await prisma.agentSecret.deleteMany({ where: { agentId: { in: Object.values(agents) } } });
    await prisma.tool.deleteMany({ where: { id: { in: Object.values(agents).map((a) => `${a}-tool`) } } });
    await prisma.datastoreEntry.deleteMany({ where: { agentId: { in: Object.values(agents) } } });
    await prisma.agent.deleteMany({ where: { id: { in: Object.values(agents) } } });
    await prisma.secret.deleteMany({ where: { id: secretId } });
    await prisma.principal.deleteMany({ where: { id: ownerId } });
  });

  const newRun = (kind: "quick" | "slow") =>
    prisma.run.create({ data: { agentId: agents[kind], nativeExecutionMode: "sandbox", executionManaged: true } });
  const waitFor = async (runId: string, done: (status: string) => boolean, timeoutMs = 90_000) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
      if (done(run.status)) return run;
      if (Date.now() > until) throw new Error(`run ${runId} still ${run.status}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  const terminal = (s: string) => !["pending", "running"].includes(s);
  const containerExists = (runId: string) =>
    dockerOk(["container", "inspect", nativeIsolationNames(runId).worker]) !== null;
  const waitForContainer = async (runId: string) => {
    for (let i = 0; i < 60 && !containerExists(runId); i += 1) await new Promise((r) => setTimeout(r, 250));
  };

  it("runs a sandboxed agent end to end in a worker container, then removes it", async () => {
    const run = await newRun("quick");
    await executor.start(run.id);
    const done = await waitFor(run.id, terminal);
    expect(done.status).toBe("succeeded");
    expect(done.finalText).toMatch(/Friday/);
    expect(done.executionBackend).toBe("native-sandbox");
    expect(Number(done.costUsd)).toBeGreaterThan(0);
    // The secret the tool logged was redacted in the gateway's logs.
    const logs = docker(["logs", gateway]);
    expect(logs).not.toContain("acceptance-secret-77");
    for (let i = 0; i < 40 && containerExists(run.id); i += 1) await new Promise((r) => setTimeout(r, 250));
    expect(containerExists(run.id)).toBe(false);
  }, 120_000);

  it("gives a worker no route anywhere but the gateway", async () => {
    const probeRun = `probe-${tag}`;
    const names = nativeIsolationNames(probeRun);
    docker(buildNativeNetworkCreateArgs(probeRun));
    docker(buildGatewayConnectArgs(probeRun, gateway));
    try {
      const args = buildNativeWorkerRunArgs({
        runId: probeRun,
        image: workerImage,
        limits: DEFAULT_NATIVE_WORKER_LIMITS,
      }).filter((a) => a !== "-i");
      args.splice(args.length - 1, 0, "--rm", "--entrypoint", "node");
      const script = `
        const net = await import("node:net");
        const tcp = (host, port) => new Promise((ok) => { const s = net.connect({ host, port, timeout: 3000 }); s.on("connect", () => { s.destroy(); ok(true); }); s.on("error", () => ok(false)); s.on("timeout", () => { s.destroy(); ok(false); }); });
        const out = {
          gateway: await fetch("http://wardby-native-gateway:8790/healthz").then((r) => r.ok, () => false),
          internet: await fetch("https://example.com", { signal: AbortSignal.timeout(4000) }).then(() => true, () => false),
          postgres: await tcp("local-postgres-1", 5432),
          dockerSocket: (await import("node:fs")).existsSync("/var/run/docker.sock"),
        };
        console.log(JSON.stringify(out));`;
      const output = docker([...args, "--input-type=module", "-e", script]);
      expect(JSON.parse(output.split("\n").at(-1)!)).toEqual({
        gateway: true,
        internet: false,
        postgres: false,
        dockerSocket: false,
      });
    } finally {
      dockerOk(["network", "disconnect", "--force", names.network, gateway]);
      dockerOk(["network", "rm", names.network]);
    }
  }, 60_000);

  it("fails a run whose worker is killed mid-run, and never relaunches it", async () => {
    const run = await newRun("slow");
    await executor.start(run.id);
    await waitForContainer(run.id);
    await new Promise((r) => setTimeout(r, 3000));
    docker(["kill", nativeIsolationNames(run.id).worker]);
    const done = await waitFor(run.id, terminal);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/^native_sandbox_worker_exited/);
  }, 120_000);

  it("finishes a run while its gateway container restarts mid-run", async () => {
    const run = await newRun("slow");
    await executor.start(run.id);
    await waitForContainer(run.id);
    await new Promise((r) => setTimeout(r, 2500)); // inside the tool's 7 s sleep: no gateway call in flight
    docker(["restart", "--time", "1", gateway]);
    const done = await waitFor(run.id, terminal);
    expect(done.status).toBe("succeeded");
    expect(done.finalText).toMatch(/Friday/);
  }, 150_000);

  it("finishes a run across a server restart: a fresh executor re-attaches instead of relaunching", async () => {
    const run = await newRun("slow");
    await executor.start(run.id);
    await waitForContainer(run.id);
    const restarted = newExecutor();
    expect(await restarted.recover({ runId: run.id, backend: "native-sandbox", id: run.id })).toEqual({
      state: "active",
    });
    const done = await waitFor(run.id, terminal);
    expect(done.status).toBe("succeeded");
  }, 150_000);

  it("stops a run mid tool call: cancelled, worker gone", async () => {
    const run = await newRun("slow");
    await executor.start(run.id);
    await waitForContainer(run.id);
    await new Promise((r) => setTimeout(r, 3000));
    await executor.stop(run.id, "operator cancelled");
    const done = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(done).toMatchObject({ status: "cancelled", error: "operator cancelled" });
    expect(containerExists(run.id)).toBe(false);
  }, 120_000);

  it("starts one worker for a duplicate dispatch", async () => {
    const run = await newRun("quick");
    await Promise.all([executor.start(run.id), executor.start(run.id)]);
    await waitFor(run.id, terminal);
    expect(await prisma.nativeGatewaySession.count({ where: { runId: run.id } })).toBe(1);
  }, 120_000);

  it("reports a run lost when its container vanishes, and sweeps an orphan away", async () => {
    const run = await newRun("slow");
    const isolated = newExecutor();
    await isolated.start(run.id);
    await waitForContainer(run.id);
    docker(["rm", "-f", nativeIsolationNames(run.id).worker]);
    // A fresh executor (no in-process watcher) asks the reconciler question.
    const answer = await newExecutor().recover({ runId: run.id, backend: "native-sandbox", id: run.id });
    expect(["lost", "terminal"]).toContain(answer.state);

    // An orphan: a labelled worker container for a run that already ended.
    const ended = await newRun("quick");
    await prisma.run.update({ where: { id: ended.id }, data: { status: "succeeded" } });
    await prisma.nativeGatewaySession.create({
      data: {
        runId: ended.id,
        capabilityHash: `h-${randomUUID()}`,
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
        snapshot: {},
      },
    });
    const orphan = nativeIsolationNames(ended.id).worker;
    docker([
      "create",
      "--name",
      orphan,
      "--label",
      "io.wardby.managed=true",
      "--label",
      "io.wardby.component=native-worker",
      "--label",
      `io.wardby.run-sha256=${nativeRunLabel(ended.id)}`,
      workerImage,
    ]);
    expect(await newExecutor().sweep()).toBeGreaterThanOrEqual(1);
    expect(dockerOk(["container", "inspect", orphan])).toBeNull();
  }, 150_000);

  describe("warm pool", () => {
    const probeScript = `
      const net = await import("node:net");
      const tcp = (host, port) => new Promise((ok) => { const s = net.connect({ host, port, timeout: 3000 }); s.on("connect", () => { s.destroy(); ok(true); }); s.on("error", () => ok(false)); s.on("timeout", () => { s.destroy(); ok(false); }); });
      console.log(JSON.stringify({
        gateway: await fetch("http://wardby-native-gateway:8790/healthz").then((r) => r.ok, () => false),
        internet: await fetch("https://example.com", { signal: AbortSignal.timeout(4000) }).then(() => true, () => false),
        postgres: await tcp("local-postgres-1", 5432),
        input: (await import("node:fs")).existsSync(${JSON.stringify(WARM_INPUT_DIR)}),
      }));`;
    let pool: PooledWorkerLauncher;
    const idleTokens = async () =>
      (await prisma.nativeWarmWorker.findMany({ where: { specHash: pool.specHash, status: "idle" } })).map((r) => r.id);

    beforeAll(async () => {
      pool = new PooledWorkerLauncher({
        ledger: new PrismaWarmPoolLedger(prisma),
        launcher,
        size: 1,
        maxAgeMs: 600_000,
        warmTimeoutMs: 120_000,
      });
      await pool.tick();
      await pool.settled();
    }, 120_000);
    afterAll(async () => {
      pool?.stop();
      await pool?.settled();
      const rows = await prisma.nativeWarmWorker.findMany({ where: { specHash: pool?.specHash } });
      for (const row of rows) await launcher.removeWarm(row.id);
      await prisma.nativeWarmWorker.deleteMany({ where: { specHash: pool?.specHash } });
    });

    it("keeps an idle worker isolated, holding no input, until a run claims it", async () => {
      const [token] = await idleTokens();
      expect(token).toBeDefined();
      const output = docker(["exec", `wardby-nwarm-${token}`, "node", "--input-type=module", "-e", probeScript]);
      expect(JSON.parse(output.split("\n").at(-1)!)).toEqual({
        gateway: true,
        internet: false,
        postgres: false,
        input: false,
      });
    }, 60_000);

    it("runs each run on its own claimed warm worker, removes it after, and warms a new one", async () => {
      const used = new Set<string>();
      for (let i = 0; i < 2; i += 1) {
        const [token] = await idleTokens();
        expect(token).toBeDefined();
        expect(used.has(token)).toBe(false);
        used.add(token);
        const run = await newRun("quick");
        const pooled = new NativeSandboxExecutor({
          db: prisma,
          providers,
          launcher: pool,
          gatewayUrl: nativeGatewayUrl(),
        });
        await pooled.start(run.id);
        expect((await prisma.nativeWarmWorker.findUnique({ where: { id: token } }))?.runId).toBe(run.id);
        expect(containerExists(run.id)).toBe(false); // no cold worker
        const done = await waitFor(run.id, terminal);
        expect(done.status).toBe("succeeded");
        expect(done.finalText).toMatch(/Friday/);
        // The worker goes first, then its network, then its row.
        for (let j = 0; j < 60 && (await prisma.nativeWarmWorker.findUnique({ where: { id: token } })); j += 1) {
          await new Promise((r) => setTimeout(r, 250));
        }
        expect(dockerOk(["container", "inspect", `wardby-nwarm-${token}`])).toBeNull();
        expect(await prisma.nativeWarmWorker.findUnique({ where: { id: token } })).toBeNull();
        await pool.tick();
        await pool.settled();
      }
      expect(docker(["logs", gateway])).not.toContain("acceptance-secret-77");
    }, 240_000);

    it("lets an unclaimed warm worker exit on its own after its wait", async () => {
      const token = randomUUID().replace(/-/g, "").slice(0, 20);
      await launcher.startWarm(token, 2_000);
      try {
        for (let i = 0; i < 40 && (await launcher.inspectWarm(token)).state === "running"; i += 1) {
          await new Promise((r) => setTimeout(r, 250));
        }
        expect(await launcher.inspectWarm(token)).toEqual({ state: "exited", exitCode: WARM_WORKER_UNCLAIMED_EXIT });
      } finally {
        await launcher.removeWarm(token);
      }
    }, 60_000);
  });
});
