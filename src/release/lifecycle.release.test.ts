/**
 * Release invariant 5: lifecycle races, against the real database (skipped without DATABASE_URL,
 * like every *.database.test.ts). Two writers race to end one run; the interleaving harness
 * (interleave.test-support.ts) runs the competitor right before each database call the other one
 * makes, for every call of an uninterrupted run. After each interleaving:
 *
 * - exactly one terminal write landed, and the row still holds it (the first writer wins and is
 *   never rewritten);
 * - a stop's row carries the stop's reason;
 * - no model call started after the run's row went terminal;
 * - a writer told it changed the row (terminate's boolean) is the one the row shows;
 * - the agent's secret, which the model echoes and a failure quotes, reaches no stored text or log.
 *
 * Races: a native run (InProcessExecutor) finishing vs stop_run, failing vs stop_run; a coding
 * run's store finishing (complete) vs a stop or a failure (terminate), both ways round. The DBOS
 * takeover and fork races are in lifecycle-dbos.release.test.ts.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { NativeEngine } from "../core/engine-native.js";
import type { NativeRunProviders } from "../core/runner.js";
import { stopRun, stopRunReason } from "../core/stop-run.js";
import { InProcessExecutor } from "../providers/executor/in-process.js";
import { PrismaContainerExecutionStore } from "../providers/executor/container.js";
import type { LlmStreamEvent } from "../providers/llm/types.js";
import {
  MODEL,
  identityCipher,
  memoryDatastore,
  noMemory,
  scriptedModel,
  usage,
} from "../native-worker/fixtures.test-support.js";
import { interleave } from "./interleave.test-support.js";
import { secretSweep } from "./secret-sweep.test-support.js";

const TERMINAL = ["succeeded", "failed", "refused", "lost", "budget_exhausted", "cancelled"];

describe.skipIf(!process.env.DATABASE_URL)("lifecycle races (database)", () => {
  const db = createPrismaClient();
  const tag = randomUUID().slice(0, 8);
  const ownerId = `rel-owner-${tag}`;
  const nativeAgentId = `rel-native-${tag}`;
  const codingAgentId = `rel-coding-${tag}`;
  const sweep = secretSweep(0x5ec);
  const secretValue = sweep.plant("agent secret", "password");

  beforeAll(async () => {
    await db.principal.create({ data: { id: ownerId, subject: ownerId } });
    await db.agent.create({
      data: {
        id: nativeAgentId,
        name: nativeAgentId,
        systemPrompt: "s",
        model: MODEL,
        budgetUsd: 1,
        maxTurns: 5,
        ownerId,
      },
    });
    await db.agent.create({
      data: {
        id: codingAgentId,
        name: codingAgentId,
        systemPrompt: "c",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        kind: "coding",
        ownerId,
      },
    });
    const secret = await db.secret.create({
      data: { name: `rel-secret-${tag}`, ciphertext: secretValue, keyId: identityCipher.keyId(), ownerId },
    });
    await db.agentSecret.create({ data: { agentId: nativeAgentId, secretId: secret.id, boundName: "TOKEN" } });
  });

  afterAll(async () => {
    await db.codingRun.deleteMany({ where: { run: { agentId: codingAgentId } } });
    await db.run.deleteMany({ where: { agentId: { in: [nativeAgentId, codingAgentId] } } });
    await db.agentSecret.deleteMany({ where: { agentId: nativeAgentId } });
    await db.secret.deleteMany({ where: { ownerId } });
    await db.agent.deleteMany({ where: { id: { in: [nativeAgentId, codingAgentId] } } });
    await db.principal.deleteMany({ where: { id: ownerId } });
    sweep.dispose();
    await db.$disconnect();
  });

  const providersWith = (llm: NativeRunProviders["llm"]): NativeRunProviders => ({
    llm,
    engine: new NativeEngine(),
    datastore: memoryDatastore({}),
    secrets: identityCipher,
    memory: noMemory,
  });

  /** Turn 1 calls a tool the agent does not have; turn 2 answers, echoing the agent's secret. */
  const turns = (): LlmStreamEvent[][] => [
    [
      { type: "tool_call", id: "call_1", name: "nope", argsJson: "{}" },
      { type: "done", stopReason: "tool_use", usage: usage(400, 30) },
    ],
    [
      { type: "text", delta: `done; the token is ${secretValue}` },
      { type: "done", stopReason: "end_turn", usage: usage(520, 12) },
    ],
  ];

  /**
   * One native run racing stop_run at call `injectAt` of the run's own database calls. `fails`:
   * the model's second call fails (quoting the secret) instead of answering.
   */
  async function nativeRace(injectAt: number, fails: boolean) {
    const run = await db.run.create({ data: { agentId: nativeAgentId } });
    /** Model calls that started with the run's row already terminal. */
    const startedAfterTerminal: number[] = [];
    const model = scriptedModel(turns(), async (call) => {
      const current = await db.run.findUniqueOrThrow({ where: { id: run.id }, select: { status: true } });
      if (TERMINAL.includes(current.status)) startedAfterTerminal.push(call);
      if (fails && call === 2) throw new Error(`upstream rejected the request carrying ${secretValue}`);
    });
    const reason = "release race";
    const race = interleave(db, injectAt, async () => {
      const competitor = new InProcessExecutor(providersWith(model.llm), race.competitorDb, 3_600_000);
      await stopRun({ db: race.competitorDb, executor: competitor, runId: run.id, stoppedBy: ownerId, reason });
    });
    const executor = new InProcessExecutor(providersWith(model.llm), race.actorDb, 3_600_000);
    await executor.start(run.id).catch(() => undefined);
    await race.settled();
    const row = await db.run.findUniqueOrThrow({ where: { id: run.id } });
    return { race, row, reason: stopRunReason(ownerId, reason), startedAfterTerminal };
  }

  async function sweepNative(fails: boolean) {
    const dry = await nativeRace(Number.POSITIVE_INFINITY, fails);
    expect(dry.row.status).toBe(fails ? "failed" : "succeeded");
    const calls = dry.race.calls();
    expect(calls).toBeGreaterThan(5);
    let checked = 0;
    for (let k = 0; k <= calls; k++) {
      const { race, row, reason, startedAfterTerminal } = await nativeRace(k, fails);
      const at = `stop before call ${k} of ${calls}`;
      expect(TERMINAL, at).toContain(row.status);
      // Exactly one terminal write, and the row still holds it.
      expect(
        race.claims.map((c) => `${c.actor}:${c.status}`),
        at,
      ).toHaveLength(1);
      expect(row.status, at).toBe(race.claims[0].status);
      expect(startedAfterTerminal, `${at}: model calls started after the row went terminal`).toEqual([]);
      if (row.status === "cancelled") {
        expect(row.error, at).toBe(reason);
        expect(row.stopRequestReason, at).toBe(reason);
      } else {
        expect(row.status, at).toBe(fails ? "failed" : "succeeded");
      }
      sweep.record(`run row (${at})`, { finalText: row.finalText, error: row.error });
      checked += 1;
    }
    return checked;
  }

  it("a native run finishing races stop_run at every database call: one terminal write, the first one", async () => {
    expect(await sweepNative(false)).toBeGreaterThan(5);
    sweep.assertClean();
  });

  it("a native run failing races stop_run at every database call: one terminal write, the first one", async () => {
    expect(await sweepNative(true)).toBeGreaterThan(5);
    sweep.assertClean();
  });

  it("no model call starts once a stop has made the row terminal", async () => {
    // Stop from inside turn 1's model call: turn 2 must never start.
    const run = await db.run.create({ data: { agentId: nativeAgentId } });
    const ref: { executor?: InProcessExecutor } = {};
    const model = scriptedModel(turns(), async (call) => {
      if (call === 1) {
        await stopRun({ db, executor: ref.executor!, runId: run.id, stoppedBy: ownerId, reason: "mid-turn" });
      }
    });
    ref.executor = new InProcessExecutor(providersWith(model.llm), db, 3_600_000);
    await ref.executor.start(run.id).catch(() => undefined);
    const row = await db.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("cancelled");
    expect(model.requests).toHaveLength(1);
  });

  // ---- coding runs: the container store's terminal writes ----------------------------------------

  async function codingRun(): Promise<string> {
    const runId = `rel-coding-${randomUUID()}`;
    await db.run.create({ data: { id: runId, agentId: codingAgentId, executionManaged: true, status: "running" } });
    await db.codingRun.create({
      data: {
        runId,
        task: "Fix it.",
        repository: "your-org/your-repo",
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        provider: "codex",
        model: "gpt-5.6-luna",
        timeoutSec: 900,
        allowedEgress: [],
        protectedPaths: [],
        budgetReservedUsd: 1,
      },
    });
    return runId;
  }

  const result = { summary: "done", changedFiles: [], commits: [] } as never;
  type Writer = { name: string; write: (store: PrismaContainerExecutionStore, runId: string) => Promise<unknown> };
  const WRITERS: Writer[] = [
    { name: "complete(succeeded)", write: (store, runId) => store.complete(runId, "succeeded", result) },
    { name: "complete(budget_exhausted)", write: (store, runId) => store.complete(runId, "budget_exhausted", result) },
    { name: "terminate(cancelled)", write: (store, runId) => store.terminate(runId, "cancelled", "stopped") },
    { name: "terminate(failed)", write: (store, runId) => store.terminate(runId, "failed", "coding_failure_job") },
  ];

  async function codingRace(actor: Writer, competitor: Writer, injectAt: number) {
    const runId = await codingRun();
    let competitorOutcome: unknown;
    const race = interleave(db, injectAt, async () => {
      competitorOutcome = await competitor
        .write(new PrismaContainerExecutionStore(race.competitorDb), runId)
        .catch((err: unknown) => err);
    });
    const actorOutcome = await actor
      .write(new PrismaContainerExecutionStore(race.actorDb), runId)
      .catch((err: unknown) => err);
    await race.settled();
    const row = await db.run.findUniqueOrThrow({ where: { id: runId } });
    return { race, row, actorOutcome, competitorOutcome: () => competitorOutcome };
  }

  /** Every ordered pair of writers that end a run differently, at every call of the first. */
  async function sweepCoding(pairs: Array<[Writer, Writer]>) {
    let checked = 0;
    for (const [actor, competitor] of pairs) {
      const dry = await codingRace(actor, competitor, Number.POSITIVE_INFINITY);
      const calls = dry.race.calls();
      for (let k = 0; k <= calls; k++) {
        const { race, row, actorOutcome, competitorOutcome } = await codingRace(actor, competitor, k);
        const at = `${competitor.name} before call ${k} of ${actor.name}'s ${calls}`;
        expect(
          race.claims.map((c) => `${c.actor}:${c.status}`),
          at,
        ).toHaveLength(1);
        expect(row.status, at).toBe(race.claims[0].status);
        // terminate's boolean says whether it made the row terminal: the row must agree.
        for (const [writer, outcome] of [
          [actor, actorOutcome],
          [competitor, competitorOutcome()],
        ] as const) {
          if (outcome === true)
            expect(row.status, `${at}: ${writer.name} reported it ended the run`).toBe(writer.name.slice(10, -1));
        }
        checked += 1;
      }
    }
    return checked;
  }

  const [completeOk, completeBudget, cancel, fail] = WRITERS;

  it("a coding run's stop or failure racing its finish, with the stop first: one terminal write, the first one", async () => {
    expect(
      await sweepCoding([
        [cancel, completeOk],
        [fail, completeOk],
        [cancel, completeBudget],
        [cancel, fail],
      ]),
    ).toBeGreaterThan(4);
  });

  // FINDING: L1, unconfirmed; see regression-phase1-report.md. PrismaContainerExecutionStore.complete reads the run, checks
  // it is not terminal, then writes it with an unconditional update, in one READ COMMITTED
  // transaction that takes no row lock first. A terminate (stop_run, a failure, the reconciler)
  // that commits between the read and the write is overwritten: the row ends `succeeded`, while
  // terminate reported it ended the run, so ContainerExecutor.stop goes on to emit `cancelled`,
  // kill the job and mark the pull request's check failed.
  // Known finding, expected to fail until fixed in the order of docs/private/2026-10-26-regression-findings-fix-order.md;
  // the fixing PR turns this into a normal `it`.
  it.fails(
    "a coding run's finish racing a stop or a failure, with the finish first: one terminal write, the first one",
    async () => {
      await sweepCoding([
        [completeOk, cancel],
        [completeOk, fail],
        [completeBudget, cancel],
      ]);
    },
  );
});
