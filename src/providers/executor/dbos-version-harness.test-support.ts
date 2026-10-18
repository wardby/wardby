/**
 * Child-process entry for dbos.cross-version.database.test.ts. DBOS is a process singleton, so
 * each application version is its own process: the test spawns this file under
 * `DBOS__APPVERSION=<version>` (the SDK's one source of the application version) and drives it
 * over stdout lines prefixed `XVER ` (wardby's logger writes to stderr).
 *
 * Modes (argv: `<mode> <json HarnessArgs>`):
 * - `start`: launch, start the lead in the background, print `XVER ready` once it is waiting where
 *   the case wants it (inside its delegations, or inside its first model turn), then block until
 *   the test SIGKILLs this process.
 * - `recover`: launch under a new executor id, backdate the lead's heartbeat, run one reconciler
 *   pass, print `XVER recovered`, wait for the lead to end, and print `XVER summary <json>`.
 *
 * `XVER_EXTRA_STEP=1` (recover only) makes the new code take a step the recorded run does not
 * have ahead of everything else, the shape of a release whose steps changed.
 */
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { PrismaClient } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { NativeEngine } from "../../core/engine-native.js";
import { reconcileOnce } from "../../core/reconciler.js";
import { HEARTBEAT_TIMEOUT_MS } from "../../core/timing.js";
import { DRIVABLE } from "../../core/run-status.js";
import type { LlmProvider, LlmRequest, LlmStreamEvent } from "../llm/types.js";
import type { Datastore, DatastoreValue } from "../datastore/types.js";
import type { SecretCipher } from "../secrets/types.js";
import type { AgentMemoryStore } from "../memory/types.js";
import type { Executor } from "./types.js";
import { DbosExecutor, dbosStep } from "./dbos.js";

export interface HarnessArgs {
  leadRunId: string;
  /** Every agent the case created; the reconciler pass only sees runs of these. */
  agentIds: string[];
  /** The lead's turn-1 delegate calls, in order: `[callId, toolName]`. */
  delegations: Array<[string, string]>;
  /** `start` only: hold turn 1 inside the model stream instead of delegating. */
  midTurn?: boolean;
}

export interface HarnessSummary {
  status: string;
  error: string | null;
  finalText: string | null;
  llmCalls: number;
  /** The tool results the new process's model saw. */
  toolResults: string[];
  children: Array<{ id: string; status: string; error: string | null; parentCallId: string | null }>;
  executionWorkflowId: string | null;
  /** Child run ids the new process's fake executor was asked to start. */
  startedChildren: string[];
}

const say = (line: string) => process.stdout.write(`XVER ${line}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeDatastore(): Datastore {
  const store = new Map<string, DatastoreValue>();
  return {
    async get(agentId, key) {
      return store.get(`${agentId}:${key}`);
    },
    async set(agentId, key, value) {
      store.set(`${agentId}:${key}`, value);
    },
    async delete(agentId, key) {
      store.delete(`${agentId}:${key}`);
    },
    async list() {
      return [];
    },
    async getShared() {
      return undefined;
    },
    async setShared() {},
    async deleteShared() {},
    async listShared() {
      return [];
    },
  };
}
const fakeCipher: SecretCipher = { keyId: () => "t", encrypt: async (s) => s, decrypt: async (s) => s };

const usage = { inputTokens: 10, outputTokens: 2, costUsd: 0.012 };

/** Counts its calls in this process; `respond` builds each reply from the request. */
function countingLlm(respond: (req: LlmRequest, call: number) => AsyncIterable<LlmStreamEvent>) {
  const calls: LlmRequest[] = [];
  const llm: LlmProvider & { calls: LlmRequest[] } = {
    calls,
    stream(req) {
      calls.push(req);
      return respond(req, calls.length);
    },
    async countTokens() {
      return 10;
    },
    priceUsd(_model, u) {
      return (u.inputTokens + u.outputTokens) / 1000;
    },
  };
  return llm;
}

/** A coding executor that never runs anything: its children stay pending until the test settles them. */
function fakeCodingExecutor(db: PrismaClient, onStart: (runId: string) => void) {
  const started: string[] = [];
  const executor: Executor = {
    async start(runId) {
      started.push(runId);
      onStart(runId);
    },
    async stop(runId, reason) {
      await db.run.updateMany({
        where: { id: runId, status: { in: [...DRIVABLE] } },
        data: { status: "cancelled", error: reason ?? "stopped", finishedAt: new Date() },
      });
    },
  };
  return { executor, started };
}

function buildExecutor(llm: LlmProvider, childExecutor: Executor, executorId: string, db: PrismaClient) {
  return new DbosExecutor(
    {
      llm,
      engine: new NativeEngine(),
      datastore: fakeDatastore(),
      secrets: fakeCipher,
      memory: {} as AgentMemoryStore,
      executor: childExecutor,
    },
    { systemDatabaseUrl: process.env.DATABASE_URL, schemaName: process.env.DBOS_SCHEMA ?? "dbos_xver", executorId },
    db,
    /* heartbeatIntervalMs */ 50,
  );
}

/**
 * The run's database as new code with one more leading step sees it: the first read executeRun
 * makes inside a workflow body (outside any step) first takes a step named "extra", so a replay
 * meets it at function id 0 where the recorded run has another step.
 */
function withExtraLeadingStep(db: PrismaClient): PrismaClient {
  const taken = new Set<string>();
  const run = new Proxy(db.run, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (key !== "findUnique" || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const workflowId = DBOS.workflowID;
        if (workflowId && !DBOS.isInStep() && !taken.has(workflowId)) {
          taken.add(workflowId);
          await dbosStep("extra", async () => "extra");
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return new Proxy(db, { get: (target, key) => (key === "run" ? run : Reflect.get(target, key)) });
}

/** The reconciler pass sees only this case's runs: it sweeps the whole database, which other test files share. */
function scopedToAgents(db: PrismaClient, agentIds: string[]): PrismaClient {
  const run = new Proxy(db.run, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (key !== "findMany" || typeof value !== "function") return value;
      return (args: { where?: object } = {}) =>
        (value as (a: unknown) => unknown).call(target, {
          ...args,
          where: { AND: [args.where ?? {}, { agentId: { in: agentIds } }] },
        });
    },
  });
  return new Proxy(db, { get: (target, key) => (key === "run" ? run : Reflect.get(target, key)) });
}

async function start(db: PrismaClient, args: HarnessArgs): Promise<void> {
  const delegate: LlmStreamEvent[] = [
    ...args.delegations.map(([id, name]): LlmStreamEvent => ({
      type: "tool_call",
      id,
      name,
      argsJson: JSON.stringify({ task: "build" }),
    })),
    { type: "done", stopReason: "tool_calls", usage },
  ];
  const llm = countingLlm(async function* () {
    if (args.midTurn) {
      say("ready");
      await new Promise(() => {}); // held inside the model turn until the process dies
    }
    yield* delegate;
  });
  const children = fakeCodingExecutor(db, (childId) => {
    say(`child ${childId}`);
    if (children.started.length === args.delegations.length) say("ready");
  });
  const executor = buildExecutor(llm, children.executor, `xver-start-${args.leadRunId}`, db);
  await executor.launch();
  void executor.start(args.leadRunId).catch((err: unknown) => say(`start-failed ${String(err)}`));
  // Until SIGKILL; the timer also keeps the process alive, and bounds an orphan whose test died.
  await new Promise(() => setTimeout(() => process.exit(2), 120_000));
}

async function recover(db: PrismaClient, args: HarnessArgs): Promise<void> {
  const llm = countingLlm(async function* (req) {
    const results = req.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    yield { type: "text", delta: `lead saw: ${results.join(" | ")}` };
    yield { type: "done", stopReason: "stop", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.015 } };
  });
  const children = fakeCodingExecutor(db, () => {});
  const runnerDb = process.env.XVER_EXTRA_STEP === "1" ? withExtraLeadingStep(db) : db;
  const executor = buildExecutor(llm, children.executor, `xver-recover-${args.leadRunId}`, runnerDb);
  await executor.launch();

  // The old process died: its heartbeat is long past the reconciler's cut-off.
  await db.run.update({
    where: { id: args.leadRunId },
    data: { heartbeatAt: new Date(Date.now() - HEARTBEAT_TIMEOUT_MS - 60_000) },
  });
  await reconcileOnce(scopedToAgents(db, args.agentIds), new Date(), HEARTBEAT_TIMEOUT_MS, executor);
  say("recovered");

  const deadline = Date.now() + 40_000;
  const lead = async () => db.run.findUniqueOrThrow({ where: { id: args.leadRunId } });
  while (DRIVABLE.includes((await lead()).status as (typeof DRIVABLE)[number]) && Date.now() < deadline) {
    await sleep(100);
  }
  // A lost lead's children are stopped after its row goes lost: give that a moment to land.
  const kids = () => db.run.findMany({ where: { parentRunId: args.leadRunId }, orderBy: { parentCallId: "asc" } });
  if ((await lead()).status === "lost") {
    const stopDeadline = Date.now() + 5_000;
    while (
      (await kids()).some((k) => DRIVABLE.includes(k.status as (typeof DRIVABLE)[number])) &&
      Date.now() < stopDeadline
    ) {
      await sleep(100);
    }
  }

  const row = await lead();
  const toolResults = (llm.calls.at(-1)?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
  const summary: HarnessSummary = {
    status: row.status,
    error: row.error,
    finalText: row.finalText,
    llmCalls: llm.calls.length,
    toolResults,
    children: (await kids()).map((k) => ({ id: k.id, status: k.status, error: k.error, parentCallId: k.parentCallId })),
    executionWorkflowId: row.executionWorkflowId,
    startedChildren: children.started,
  };
  say(`summary ${JSON.stringify(summary)}`);
  await executor.close();
}

async function main(): Promise<void> {
  const [mode, json] = process.argv.slice(2);
  const args = JSON.parse(json ?? "{}") as HarnessArgs;
  const db = createPrismaClient();
  if (mode === "start") await start(db, args);
  else if (mode === "recover") await recover(db, args);
  else throw new Error(`unknown harness mode "${mode}"`);
  await db.$disconnect();
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`harness failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
