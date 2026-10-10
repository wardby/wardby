import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { NativeEngine } from "../core/engine-native.js";
import { executeRun, type NativeRunProviders } from "../core/runner.js";
import type { Executor } from "../providers/executor/types.js";
import type { LlmStreamEvent } from "../providers/llm/types.js";
import {
  identityCipher,
  memoryDatastore,
  MODEL,
  noMemory,
  script,
  scriptedModel,
  TOOL_CODE,
  usage,
} from "./fixtures.test-support.js";
import { createGatewayServer, NATIVE_GATEWAY_PATH } from "./http-server.js";
import { processWorkerLauncher, startSandboxRun } from "./launch.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const worker = processWorkerLauncher({
  command: process.execPath,
  args: ["--import", "tsx", "src/native-worker/main.ts"],
  env: {},
  cwd: REPO_ROOT,
});

const listen = (server: Server) =>
  new Promise<string>((done) =>
    server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );

/** Stands in for a cluster Service in front of gateway replicas: forwards to the current target. */
function serviceProxy(initialTarget: string) {
  let target = initialTarget;
  const server = createServer((req, res) => {
    const upstream = httpRequest(
      `${target}${req.url}`,
      { method: req.method, headers: req.headers, agent: false },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    // An unreachable replica looks like a dropped connection to the worker, which retries.
    upstream.on("error", () => req.socket.destroy());
    req.pipe(upstream);
  });
  return { server, setTarget: (t: string) => (target = t) };
}

describe.skipIf(!process.env.DATABASE_URL)("native sandbox gateway over HTTP (database)", () => {
  const db = createPrismaClient();
  const tag = randomUUID().slice(0, 8);
  const ownerId = `http-owner-${tag}`;
  const agentId = `http-agent-${tag}`;
  const childId = `http-child-${tag}`;
  const toolId = `http-tool-${tag}`;
  const secretId = `http-secret-${tag}`;
  const servers: Server[] = [];

  // Swapped per test: the gateway replicas and the in-process path share the same providers object.
  let current = scriptedModel(script());
  let datastore = memoryDatastore({});
  const providers: NativeRunProviders = {
    get llm() {
      return current.llm;
    },
    engine: new NativeEngine(),
    get datastore() {
      return datastore;
    },
    secrets: identityCipher,
    memory: noMemory,
  };
  // Children run in this process, as a control-plane executor would run them.
  const executor: Executor = {
    start: async (runId) => void (await executeRun(runId, providers, db)),
    stop: async () => {},
  };
  providers.executor = executor;
  const deps = { db, providers, pollWindowMs: 200 };

  let replicaA: Server;
  let replicaB: Server;
  let urlA: string;
  let urlB: string;
  let service: ReturnType<typeof serviceProxy>;
  let serviceUrl: string;

  beforeAll(async () => {
    await db.principal.create({ data: { id: ownerId, subject: ownerId } });
    for (const id of [agentId, childId]) {
      await db.agent.create({
        data: { id, name: id, systemPrompt: "Answer from notes.", model: MODEL, budgetUsd: 1, maxTurns: 4, ownerId },
      });
    }
    await db.tool.create({
      data: {
        id: toolId,
        name: "lookup",
        description: "Reads a note.",
        paramsZod: "z.object({ key: z.string() })",
        jsonSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
        code: TOOL_CODE,
        ownerId,
      },
    });
    await db.agentTool.create({
      data: {
        agentId,
        toolId,
        allowedSecrets: ["api"],
        allowedDatastorePrefixes: ["notes/"],
        capabilitiesGrantedById: ownerId,
      },
    });
    await db.secret.create({
      data: { id: secretId, name: "api", ciphertext: "s3cret-value-123", keyId: "test", ownerId },
    });
    await db.agentSecret.create({ data: { agentId, secretId, boundName: "api" } });

    replicaA = createGatewayServer(deps);
    replicaB = createGatewayServer(deps);
    urlA = await listen(replicaA);
    urlB = await listen(replicaB);
    service = serviceProxy(urlA);
    serviceUrl = `${await listen(service.server)}${NATIVE_GATEWAY_PATH}`;
    servers.push(replicaA, replicaB, service.server);
  });

  afterAll(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    const runs = await db.run.findMany({ where: { agentId: { in: [agentId, childId] } }, select: { id: true } });
    const ids = runs.map((r) => r.id);
    await db.runModelUsage.deleteMany({ where: { runId: { in: ids } } });
    await db.runAttribution.deleteMany({ where: { runId: { in: ids } } });
    await db.run.updateMany({ where: { id: { in: ids } }, data: { parentRunId: null } });
    await db.run.deleteMany({ where: { id: { in: ids } } });
    await db.agentSubAgent.deleteMany({ where: { parentAgentId: agentId } });
    await db.agentTool.deleteMany({ where: { agentId } });
    await db.agentSecret.deleteMany({ where: { agentId } });
    await db.secret.deleteMany({ where: { id: secretId } });
    await db.tool.deleteMany({ where: { id: toolId } });
    await db.agent.deleteMany({ where: { id: { in: [agentId, childId] } } });
    await db.principal.deleteMany({ where: { id: ownerId } });
    await db.$disconnect();
  });

  function freshRun(turns: LlmStreamEvent[][] = script()) {
    current = scriptedModel(turns);
    datastore = memoryDatastore({ [`${agentId}:notes/a`]: "hello" });
    return { model: current, datastore };
  }

  async function runSandboxed(turns?: LlmStreamEvent[][]) {
    const fixtures = freshRun(turns);
    const run = await db.run.create({
      data: { agentId, trigger: "manual", nativeExecutionMode: "sandbox", executionManaged: true },
    });
    const started = await startSandboxRun({ runId: run.id, providers, db, gatewayUrl: serviceUrl, launcher: worker });
    if (started.kind !== "launched") throw new Error(`run ended before launch: ${started.run.status}`);
    const exitCode = await started.handle.exited;
    const finished = await db.run.findUniqueOrThrow({ where: { id: run.id } });
    return { finished, exitCode, ...fixtures };
  }

  async function runInProcess(turns?: LlmStreamEvent[][]) {
    const fixtures = freshRun(turns);
    const run = await db.run.create({ data: { agentId, trigger: "manual", nativeExecutionMode: "control_plane" } });
    const finished = await executeRun(run.id, providers, db);
    return { finished, exitCode: 0, ...fixtures };
  }

  const summary = (r: Awaited<ReturnType<typeof runSandboxed>>) => ({
    status: r.finished.status,
    finalText: r.finished.finalText,
    turns: r.finished.turns,
    tokensIn: r.finished.tokensIn,
    tokensOut: r.finished.tokensOut,
    costUsd: Number(r.finished.costUsd),
    error: r.finished.error,
  });

  it("runs a sandboxed run through a worker process over HTTP with the same result as in process", async () => {
    const inProcess = await runInProcess();
    const sandboxed = await runSandboxed();
    expect(sandboxed.exitCode).toBe(0);
    expect(summary(sandboxed)).toEqual(summary(inProcess));
    expect(sandboxed.model.requests).toEqual(inProcess.model.requests);
    expect(sandboxed.datastore.store.get(`${agentId}:notes/seen`)).toEqual({ key: "notes/a", keyLength: 16 });
    expect(sandboxed.finished.executionBackend).toBe("native-sandbox");
    const usageRows = await db.runModelUsage.findMany({ where: { runId: sandboxed.finished.id } });
    expect(usageRows).toHaveLength(1);
    const session = await db.nativeGatewaySession.findUniqueOrThrow({ where: { runId: sandboxed.finished.id } });
    expect(session.status).toBe("finished");
    expect(JSON.stringify(session.snapshot)).not.toContain("s3cret-value-123");
    // The worker read the "api" secret through host.call; its value must not be in the ledger.
    const calls = await db.nativeGatewayCall.findMany({
      where: { session: { runId: sandboxed.finished.id } },
      select: { result: true },
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(calls)).not.toContain("s3cret-value-123");
  });

  it("finishes the run when the gateway replica serving it stops mid-run", async () => {
    // After replica A answers its first model stream, it stops and the Service moves to replica B.
    let stopped = false;
    replicaA.on("request", (_req, res) => {
      res.on("finish", () => {
        if (stopped || !String(res.getHeader("content-type")).includes("ndjson")) return;
        stopped = true;
        service.setTarget(urlB);
        replicaA.closeAllConnections();
        replicaA.close();
      });
    });
    const inProcess = await runInProcess();
    const sandboxed = await runSandboxed();
    expect(stopped).toBe(true);
    expect(sandboxed.exitCode).toBe(0);
    expect(summary(sandboxed)).toEqual(summary(inProcess));
  });

  it("refuses requests without a valid capability for that run", async () => {
    const post = (headers: Record<string, string>, body: unknown) =>
      fetch(`${urlB}${NATIVE_GATEWAY_PATH}`, { method: "POST", headers, body: JSON.stringify(body) });
    const finishBody = (runId: string) => ({
      v: 1,
      runId,
      callId: "x-1",
      method: "finish",
      params: { status: "succeeded", finalText: "", turns: 0 },
    });
    expect((await post({}, finishBody("r"))).status).toBe(401);
    expect(
      (await post({ authorization: "Bearer not-a-real-capability-not-a-real-capability" }, finishBody("r"))).status,
    ).toBe(401);

    // A finished run's capability is revoked, and a capability never reaches another run.
    const done = await runSandboxed();
    const session = await db.nativeGatewaySession.findUniqueOrThrow({ where: { runId: done.finished.id } });
    expect(session.status).toBe("finished");
    const other = await db.run.create({ data: { agentId, nativeExecutionMode: "sandbox", status: "running" } });
    const { createSandboxSession } = await import("../core/runner.js");
    const { PrismaGatewayLedger } = await import("./ledger.js");
    const live = await createSandboxSession({
      runId: other.id,
      providers,
      db,
      ledger: new PrismaGatewayLedger(db),
      gatewayUrl: serviceUrl,
    });
    if (live.kind !== "started") throw new Error("expected a session");
    const auth = { authorization: `Bearer ${live.capability}`, "content-type": "application/json" };
    const foreign = await post(auth, finishBody(done.finished.id));
    expect(foreign.status).toBe(403);
    const oversized = await fetch(`${urlB}${NATIVE_GATEWAY_PATH}`, {
      method: "POST",
      headers: auth,
      body: "x".repeat(17 * 1024 * 1024),
    }).catch(() => null);
    expect(oversized === null || oversized.status === 400).toBe(true);
  });

  it("ends a run budget_exhausted when the gateway refuses a model call it cannot cover", async () => {
    // Enough for the engine's own pre-flight estimate, not for the gateway's worst-case reservation.
    await db.agent.update({ where: { id: agentId }, data: { budgetUsd: 0.005 } });
    try {
      const sandboxed = await runSandboxed();
      expect(sandboxed.finished.status).toBe("budget_exhausted");
      expect(sandboxed.model.requests).toHaveLength(0);
      expect(Number(sandboxed.finished.costUsd)).toBe(0);
    } finally {
      await db.agent.update({ where: { id: agentId }, data: { budgetUsd: 1 } });
    }
  });

  it("delegates over HTTP: the worker long-polls the same call until the managed child finishes", async () => {
    await db.agentSubAgent.create({ data: { parentAgentId: agentId, childAgentId: childId, boundName: "helper" } });
    try {
      const turns: LlmStreamEvent[][] = [
        [
          { type: "tool_call", id: "d1", name: "delegate_to_helper", argsJson: JSON.stringify({ task: "say hi" }) },
          { type: "done", stopReason: "tool_use", usage: usage(300, 20) },
        ],
        [
          { type: "text", delta: "hi from child" },
          { type: "done", stopReason: "end_turn", usage: usage(200, 5) },
        ],
        [
          { type: "text", delta: "The helper said hi." },
          { type: "done", stopReason: "end_turn", usage: usage(450, 8) },
        ],
      ];
      const sandboxed = await runSandboxed(turns);
      expect(sandboxed.finished).toMatchObject({ status: "succeeded", finalText: "The helper said hi." });
      const [child] = await db.run.findMany({ where: { parentRunId: sandboxed.finished.id } });
      expect(child).toMatchObject({
        status: "succeeded",
        finalText: "hi from child",
        executionManaged: true,
        taskOverride: "say hi",
      });
    } finally {
      await db.agentSubAgent.deleteMany({ where: { parentAgentId: agentId } });
    }
  });
});
