/**
 * Release invariant 5, durable runs: lifecycle races under DBOS against the real database
 * (skipped without DATABASE_URL). DBOS keeps its own tables in a schema named for this run, so
 * parallel runs never share one; it is dropped afterwards.
 *
 * - stop vs finish: stop_run lands before each database call of a DBOS run;
 * - takeover vs the original finishing: a "deploy" takes the run over (the original recorded under
 *   an older application version, owned by a stalled executor, its heartbeat lapsed) before each
 *   database call of a lead that delegates and then finishes;
 * - fork vs stop: stop_run on a run whose takeover forked it.
 *
 * After each: exactly one terminal write, kept; a stop's reason on a cancelled row; no model call
 * started after the row went terminal; the lead's final turn paid at most once across both
 * attempts; and no workflow left running under the terminal row.
 */
import { randomUUID } from "node:crypto";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "#prisma";
import { createPrismaClient } from "../core/db.js";
import { NativeEngine } from "../core/engine-native.js";
import { stopRun, stopRunReason } from "../core/stop-run.js";
import { DBOS_BACKEND, DbosExecutor } from "../providers/executor/dbos.js";
import type { Executor } from "../providers/executor/types.js";
import type { LlmProvider, LlmStreamEvent } from "../providers/llm/types.js";
import { identityCipher, memoryDatastore, noMemory } from "../native-worker/fixtures.test-support.js";
import { interleave, type Interleaving } from "./interleave.test-support.js";
import { secretSweep } from "./secret-sweep.test-support.js";

const TERMINAL = ["succeeded", "failed", "refused", "lost", "budget_exhausted", "cancelled"];
const FINISHED_WORKFLOW = ["SUCCESS", "ERROR", "CANCELLED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED"];

const usage = { inputTokens: 10, outputTokens: 2, costUsd: 0.012 };
const toolCall = (name: string, args = "{}"): LlmStreamEvent[] => [
  { type: "tool_call", id: "c1", name, argsJson: args },
  { type: "done", stopReason: "tool_calls", usage },
];
const finalAnswer = (text: string): LlmStreamEvent[] => [
  { type: "text", delta: text },
  { type: "done", stopReason: "stop", usage },
];

describe.skipIf(!process.env.DATABASE_URL)("lifecycle races under DBOS (database)", () => {
  const db = createPrismaClient();
  const tag = randomUUID().slice(0, 8);
  const schema = `dbos_release_${tag}`;
  const leadId = `rel-dbos-lead-${tag}`;
  const kidId = `rel-dbos-kid-${tag}`;
  const ownerId = `rel-dbos-owner-${tag}`;
  const sweep = secretSweep(0xdb05);
  /** The lead's secret: its final answer echoes it, so the stored text must not. */
  const secretValue = sweep.plant("lead secret", "password");
  const finalWithSecret = (text: string) => finalAnswer(`${text} (token ${secretValue})`);

  /** The database every executor call goes through: each case points it at its own interleaving. */
  const route: { db: PrismaClient } = { db: db };
  const routed = new Proxy({} as PrismaClient, { get: (_target, prop) => Reflect.get(route.db, prop) });

  /** Model calls, in order, with whether the run's row was already terminal when each started. */
  const calls: Array<{ runId: string; turn: number; afterTerminal: boolean }> = [];
  /** The tool results the latest model call of each run saw. */
  const toolResults = new Map<string, string>();
  const current: { runId?: string; script: LlmStreamEvent[][] } = { script: [] };
  const llm: LlmProvider = {
    async *stream(req) {
      const runId = current.runId!;
      const row = await db.run.findUniqueOrThrow({ where: { id: runId }, select: { status: true } });
      const turn = req.messages.filter((m) => m.role === "assistant").length + 1;
      calls.push({ runId, turn, afterTerminal: TERMINAL.includes(row.status) });
      toolResults.set(runId, JSON.stringify(req.messages.filter((m) => m.role === "tool")));
      for (const event of current.script[turn - 1] ?? []) yield event;
    },
    countTokens: async () => 10,
    priceUsd: (_model, u) => (u.inputTokens + u.outputTokens) / 1000,
  };

  /** Sub-agent runs, started by the lead's delegate step and finished at once ("on-start") or by the test ("manual"). */
  const children = { started: [] as string[], mode: "on-start" as "on-start" | "manual" };
  const finishChildrenOf = (parentRunId: string) =>
    db.run.updateMany({
      where: { parentRunId, status: { in: ["pending", "running"] } },
      data: { status: "succeeded", finalText: "kid done", finishedAt: new Date() },
    });
  const childExecutor: Executor = {
    async start(runId) {
      children.started.push(runId);
      if (children.mode === "on-start") {
        await db.run.updateMany({
          where: { id: runId },
          data: { status: "succeeded", finalText: "kid done", finishedAt: new Date() },
        });
      }
    },
    async stop(runId, reason) {
      await db.run.updateMany({
        where: { id: runId, status: { in: ["pending", "running"] } },
        data: { status: "cancelled", error: reason ?? "stopped", finishedAt: new Date() },
      });
    },
  };

  const executor = new DbosExecutor(
    {
      llm,
      engine: new NativeEngine(),
      datastore: memoryDatastore({}),
      secrets: identityCipher,
      memory: noMemory,
      executor: childExecutor,
    },
    { systemDatabaseUrl: process.env.DATABASE_URL, schemaName: schema, executorId: `release-${tag}` },
    routed,
    /* heartbeatIntervalMs */ 3_600_000,
  );

  beforeAll(async () => {
    // An agent's secrets are the ones its owner owns.
    await db.principal.create({ data: { id: ownerId, subject: ownerId } });
    await db.agent.create({
      data: { id: leadId, name: leadId, systemPrompt: "LEAD", model: "m", budgetUsd: 1, maxTurns: 5, ownerId },
    });
    // A sandbox-mode child goes through the Executor (the fake above), so it is durable on its own.
    await db.agent.create({
      data: {
        id: kidId,
        name: kidId,
        systemPrompt: "CHILD",
        model: "m",
        budgetUsd: 0.1,
        maxTurns: 3,
        nativeExecutionMode: "sandbox",
        ownerId,
      },
    });
    await db.agentSubAgent.create({ data: { parentAgentId: leadId, childAgentId: kidId, boundName: "kid" } });
    const secret = await db.secret.create({
      data: { name: `rel-dbos-secret-${tag}`, ciphertext: secretValue, keyId: identityCipher.keyId(), ownerId },
    });
    await db.agentSecret.create({ data: { agentId: leadId, secretId: secret.id, boundName: "TOKEN" } });
    await executor.launch();
  }, 60_000);

  afterAll(async () => {
    await executor.close();
    await db.run.updateMany({ where: { agentId: { in: [leadId, kidId] } }, data: { parentRunId: null } });
    await db.run.deleteMany({ where: { agentId: { in: [leadId, kidId] } } });
    await db.agentSubAgent.deleteMany({ where: { parentAgentId: leadId } });
    await db.agentSecret.deleteMany({ where: { agentId: leadId } });
    await db.secret.deleteMany({ where: { ownerId } });
    await db.agent.deleteMany({ where: { id: { in: [leadId, kidId] } } });
    await db.principal.deleteMany({ where: { id: ownerId } });
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    sweep.dispose();
    await db.$disconnect();
  }, 60_000);

  async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** No workflow of the run (the original, and a fork if one was made) is still running. */
  async function workflowsEnded(runId: string) {
    const ids = [runId, `${runId}@${DBOS.applicationVersion}`];
    await waitFor(`the workflows of ${runId} to end`, async () => {
      const statuses = await Promise.all(ids.map((id) => DBOS.getWorkflowStatus(id)));
      return statuses.every((s) => !s || FINISHED_WORKFLOW.includes(s.status));
    });
  }

  /** What a deploy does to a recorded workflow: an older version, owned by a stalled executor. */
  async function takeOver(runId: string) {
    await db.$executeRawUnsafe(
      `UPDATE "${schema}".workflow_status SET application_version = $1, executor_id = 'stalled-owner' WHERE workflow_uuid = $2`,
      `older-than-${DBOS.applicationVersion}`,
      runId,
    );
    await db.run.update({ where: { id: runId }, data: { heartbeatAt: new Date(0) } });
    return executor.recover({ runId, backend: DBOS_BACKEND, id: runId });
  }

  /** The checks every case shares. */
  function checkOutcome(at: string, race: Interleaving<PrismaClient>, row: { status: string; error: string | null }) {
    expect(TERMINAL, at).toContain(row.status);
    expect(
      race.claims.map((c) => `${c.actor}:${c.status}`),
      at,
    ).toHaveLength(1);
    expect(row.status, at).toBe(race.claims[0].status);
    expect(
      calls.filter((c) => c.runId === current.runId && c.afterTerminal),
      `${at}: model calls started after the row went terminal`,
    ).toEqual([]);
  }

  async function runCase(
    injectAt: number,
    script: LlmStreamEvent[][],
    competitor: (runId: string) => Promise<unknown>,
  ) {
    const run = await db.run.create({ data: { agentId: leadId, executionManaged: true } });
    current.runId = run.id;
    current.script = script;
    const race = interleave(db, injectAt, () => competitor(run.id));
    route.db = race.actorDb;
    try {
      await executor.start(run.id).catch(() => undefined);
      await race.settled();
      await waitFor("the run to end", async () =>
        TERMINAL.includes((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status),
      );
      await workflowsEnded(run.id);
    } finally {
      route.db = db;
    }
    const row = await db.run.findUniqueOrThrow({ where: { id: run.id } });
    sweep.record(`run ${injectAt}`, { finalText: row.finalText, error: row.error });
    return { race, row, runId: run.id };
  }

  it("stop_run before every database call of a DBOS run: one terminal write, the first one, and no workflow left running", async () => {
    const script = [toolCall("nope"), finalWithSecret("done")];
    const reason = stopRunReason("release", "race");
    const stop = (runId: string) =>
      stopRun({
        db: route.db === db ? db : route.db,
        executor,
        runId,
        stoppedBy: "release",
        reason: "race",
      });
    const dry = await runCase(Number.POSITIVE_INFINITY, script, stop);
    expect(dry.row.status).toBe("succeeded");
    const total = dry.race.calls();
    expect(total).toBeGreaterThan(5);
    for (let k = 0; k <= total; k++) {
      const { race, row } = await runCase(k, script, stop);
      const at = `stop before call ${k} of ${total}`;
      checkOutcome(at, race, row);
      if (row.status === "cancelled") expect(row.error, at).toContain(reason);
      else expect(row.status, at).toBe("succeeded");
    }
    sweep.assertClean();
  }, 300_000);

  /** A takeover before each database call of a lead that delegates (its child finishes at once) and then finishes. */
  async function takeoverSweep(
    each: (k: number, outcome: string, row: { status: string; error: string | null }) => void,
  ) {
    const script = [toolCall("delegate_to_kid", JSON.stringify({ task: "x" })), finalWithSecret("lead done")];
    children.mode = "on-start";
    const dry = await runCase(Number.POSITIVE_INFINITY, script, takeOver);
    expect(dry.row.status).toBe("succeeded");
    // The lead really delegated: one child, and its result reached the final turn.
    expect(await db.run.count({ where: { parentRunId: dry.runId, status: "succeeded" } })).toBe(1);
    expect(toolResults.get(dry.runId)).toContain("kid done");
    const total = dry.race.calls();
    try {
      for (let k = 0; k <= total; k++) {
        const { race, row, runId } = await runCase(k, script, async (id) => takeOver(id).catch((err: unknown) => err));
        const at = `takeover before call ${k} of ${total}`;
        checkOutcome(at, race, row);
        expect(["succeeded", "lost"], at).toContain(row.status);
        if (row.status === "succeeded") expect(row.finalText, at).toContain("lead done");
        const finalTurns = calls.filter((c) => c.runId === runId && c.turn === 2);
        expect(finalTurns.length, `${at}: the final turn's model calls`).toBeLessThanOrEqual(1);
        // One child: the takeover re-attaches the original's, never starts another.
        expect(await db.run.count({ where: { parentRunId: runId } }), at).toBeLessThanOrEqual(1);
        const forked = row.executionWorkflowId !== null && row.executionWorkflowId !== runId;
        each(k, `${row.status}${forked ? " (forked)" : ""}`, row);
      }
    } finally {
      children.mode = "on-start";
    }
  }

  it("a takeover before every database call of a lead that delegates and finishes: one terminal write, the final turn paid at most once", async () => {
    const outcomes = new Set<string>();
    await takeoverSweep((_k, outcome) => outcomes.add(outcome));
    // The sweep reached points where the takeover forked the run (the mid-wait fork itself is the
    // fork-vs-stop case below and dbos.database.test.ts) and points it left the run alone.
    expect([...outcomes].some((o) => o.endsWith("(forked)"))).toBe(true);
    expect(outcomes).toContain("succeeded");
    sweep.assertClean();
  }, 600_000);

  // FINDING: L2, unconfirmed; see regression-phase1-report.md. a takeover that lands right after the lead's model turn
  // was recorded, before its delegate step starts (the run's progress write and the step check
  // that follow the turn), forks the run, and the fork fails as "the run's steps changed in the
  // new version" although the code is the same: the run ends lost, and a stalled-but-alive
  // original that would have finished is cancelled.
  // Known finding, expected to fail until fixed in the order of docs/private/2026-10-26-regression-findings-fix-order.md;
  // the fixing PR turns this into a normal `it`.
  it.fails(
    "a takeover never forks a run it then loses as 'steps changed' when nothing changed",
    async () => {
      const lostForks: string[] = [];
      await takeoverSweep((k, outcome, row) => {
        if (outcome === "lost (forked)") lostForks.push(`call ${k}: ${row.error}`);
      });
      expect(lostForks).toEqual([]);
    },
    600_000,
  );

  it("stop_run on a lead whose takeover forked it: cancelled with the stop's reason, the fork stops, nothing more is paid", async () => {
    children.mode = "manual";
    try {
      const run = await db.run.create({ data: { agentId: leadId, executionManaged: true } });
      current.runId = run.id;
      current.script = [toolCall("delegate_to_kid", JSON.stringify({ task: "x" })), finalAnswer("never")];
      const original = executor.start(run.id).catch(() => undefined);
      await waitFor("the lead to dispatch its child", async () => {
        const row = await db.run.findUniqueOrThrow({ where: { id: run.id } });
        if (TERMINAL.includes(row.status)) throw new Error(`the lead ended ${row.status} before delegating`);
        return (await db.run.count({ where: { parentRunId: run.id } })) === 1;
      });
      expect(await takeOver(run.id)).toEqual({ state: "active" });
      const reason = stopRunReason("release", "fork race");
      await stopRun({ db, executor, runId: run.id, stoppedBy: "release", reason: "fork race" });
      await finishChildrenOf(run.id);
      await original;
      await workflowsEnded(run.id);
      const row = await db.run.findUniqueOrThrow({ where: { id: run.id } });
      expect({ status: row.status, error: row.error }).toEqual({ status: "cancelled", error: reason });
      expect(calls.filter((c) => c.runId === run.id && c.turn === 2)).toEqual([]);
    } finally {
      children.mode = "on-start";
    }
  }, 60_000);
});
