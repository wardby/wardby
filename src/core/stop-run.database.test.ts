import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./db.js";
import { NativeEngine } from "./engine-native.js";
import type { NativeRunProviders } from "./runner.js";
import { stopRun } from "./stop-run.js";
import { InProcessExecutor } from "../providers/executor/in-process.js";
import {
  identityCipher,
  memoryDatastore,
  MODEL,
  noMemory,
  script,
  scriptedModel,
} from "../native-worker/fixtures.test-support.js";

describe.skipIf(!process.env.DATABASE_URL)("stopRun (database)", () => {
  const db = createPrismaClient();
  const tag = randomUUID().slice(0, 8);
  const ownerId = `stop-owner-${tag}`;
  const agentId = `stop-agent-${tag}`;
  const providersWith = (llm: NativeRunProviders["llm"]): NativeRunProviders => ({
    llm,
    engine: new NativeEngine(),
    datastore: memoryDatastore({}),
    secrets: identityCipher,
    memory: noMemory,
  });

  beforeAll(async () => {
    await db.principal.create({ data: { id: ownerId, subject: ownerId } });
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "s", model: MODEL, budgetUsd: 1, maxTurns: 5, ownerId },
    });
  });
  afterAll(async () => {
    await db.run.updateMany({ where: { agentId }, data: { parentRunId: null } });
    await db.run.deleteMany({ where: { agentId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: ownerId } });
    await db.$disconnect();
  });

  const row = (id: string) => db.run.findUniqueOrThrow({ where: { id } });

  it("stops an executing native run at its next step: cancelled with the reason, its in-flight turn's spend kept", async () => {
    const run = await db.run.create({ data: { agentId } });
    const ref: { executor?: InProcessExecutor } = {};
    // The stop lands while turn 1 (which asks for a tool) is in flight.
    const { llm, requests } = scriptedModel(script(), async (call) => {
      if (call === 1) {
        await stopRun({ db, executor: ref.executor!, runId: run.id, stoppedBy: ownerId, reason: "not wanted" });
      }
    });
    const executor = (ref.executor = new InProcessExecutor(providersWith(llm), db));
    await executor.start(run.id);

    const after = await row(run.id);
    expect(after).toMatchObject({
      status: "cancelled",
      error: `Stopped by ${ownerId} with stop_run: not wanted`,
      stopRequestReason: `Stopped by ${ownerId} with stop_run: not wanted`,
      stopRequestedAt: null,
    });
    expect(after.finishedAt).toBeInstanceOf(Date);
    // Neither the tool call nor turn 2 ran.
    expect(requests).toHaveLength(1);
    expect(after.tokensIn).toBe(400);
    expect(Number(after.costUsd)).toBeGreaterThan(0);
  });

  it("stops a parent and its in-flight children, never touching a finished child; a second call changes nothing", async () => {
    const executor = new InProcessExecutor(providersWith(scriptedModel([]).llm), db);
    const parent = await db.run.create({ data: { agentId, status: "running" } });
    const child = await db.run.create({
      data: { agentId, status: "running", parentRunId: parent.id, trigger: "subagent" },
    });
    const queued = await db.run.create({ data: { agentId, parentRunId: parent.id, trigger: "subagent" } });
    const done = await db.run.create({
      data: { agentId, status: "succeeded", parentRunId: parent.id, trigger: "subagent", finishedAt: new Date() },
    });

    const result = await stopRun({ db, executor, runId: parent.id, stoppedBy: ownerId });
    expect(result).toMatchObject({ previousStatus: "running", status: "cancelled", stopRequested: true });
    expect(new Set(result.stoppedChildRunIds)).toEqual(new Set([child.id, queued.id]));
    for (const id of [parent.id, child.id, queued.id]) expect((await row(id)).status).toBe("cancelled");
    expect((await row(child.id)).error).toBe(
      `Parent run ${parent.id} was stopped. Stopped by ${ownerId} with stop_run.`,
    );
    expect(await row(done.id)).toMatchObject({ status: "succeeded", error: null, stopRequestReason: null });

    const again = await stopRun({ db, executor, runId: parent.id, stoppedBy: "someone-else", reason: "again" });
    expect(again).toMatchObject({ status: "cancelled", stopRequested: false, stoppedChildRunIds: [] });
    expect((await row(parent.id)).stopRequestReason).toBe(`Stopped by ${ownerId} with stop_run.`);
  });

  it("never overwrites a run that finished first", async () => {
    const executor = new InProcessExecutor(providersWith(scriptedModel([]).llm), db);
    const run = await db.run.create({ data: { agentId, status: "failed", error: "boom", finishedAt: new Date() } });
    const result = await stopRun({ db, executor, runId: run.id, stoppedBy: ownerId });
    expect(result).toMatchObject({ previousStatus: "failed", status: "failed", stopRequested: false });
    expect(await row(run.id)).toMatchObject({ status: "failed", error: "boom", stopRequestReason: null });
  });
});
