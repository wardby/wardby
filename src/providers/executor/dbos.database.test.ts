import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { LlmProvider, LlmRequest, LlmStreamEvent } from "../llm/types.js";
import type { Datastore, DatastoreValue } from "../datastore/types.js";
import type { SecretCipher } from "../secrets/types.js";
import { NativeEngine } from "../../core/engine-native.js";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { DBOS_BACKEND, DbosExecutor } from "./dbos.js";

/** One scripted event list per stream() call; `gate` lets a test hold a turn open. */
function scriptedLlm(scripts: LlmStreamEvent[][], gate?: { turn: number; open: Promise<void> }) {
  let index = 0;
  const calls: LlmRequest[] = [];
  const llm: LlmProvider & { calls: LlmRequest[] } = {
    calls,
    async *stream(req) {
      const turn = ++index;
      calls.push(req);
      if (gate && gate.turn === turn) await gate.open;
      for (const event of scripts[turn - 1] ?? []) yield event;
    },
    async countTokens() {
      return 10;
    },
    priceUsd(_model, usage) {
      return (usage.inputTokens + usage.outputTokens) / 1000;
    },
  };
  return llm;
}

const finalAnswer = (text: string): LlmStreamEvent[] => [
  { type: "text", delta: text },
  { type: "done", stopReason: "stop", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.015 } },
];
const toolCall = (name: string): LlmStreamEvent[] => [
  { type: "tool_call", id: "c1", name, argsJson: "{}" },
  { type: "done", stopReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.012 } },
];

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
  };
}
const fakeCipher: SecretCipher = { keyId: () => "t", encrypt: async (s) => s, decrypt: async (s) => s };

describe.skipIf(!process.env.DATABASE_URL)("DbosExecutor (database)", () => {
  const db = new PrismaClient();
  const suffix = randomUUID();
  const agentId = `dbos-agent-${suffix}`;
  const executorId = `test-${suffix}`;
  let executor: DbosExecutor | undefined;

  beforeAll(async () => {
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "sys", model: "m", budgetUsd: 1, maxTurns: 5 },
    });
  });

  afterAll(async () => {
    await executor?.close();
    await db.run.deleteMany({ where: { agentId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  function build(llm: LlmProvider) {
    return buildWith(llm, executorId);
  }

  function buildWith(llm: LlmProvider, id: string) {
    return new DbosExecutor(
      { llm, engine: new NativeEngine(), datastore: fakeDatastore(), secrets: fakeCipher },
      { systemDatabaseUrl: process.env.DATABASE_URL, schemaName: "dbos_test", executorId: id },
      db,
      /* heartbeatIntervalMs */ 50,
    );
  }

  it("runs a native run to a terminal state under DBOS and marks the backend on the row", async () => {
    const llm = scriptedLlm([toolCall("nope"), finalAnswer("done")]);
    executor = build(llm);
    await executor.launch();
    expect(executor.executorId).toBe(DBOS.executorID);
    const run = await db.run.create({ data: { agentId, executionManaged: true } });

    await executor.start(run.id);

    const after = await db.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("succeeded");
    expect(after.finalText).toBe("done");
    expect(after.executionBackend).toBe(DBOS_BACKEND);
    expect(after.turns).toBe(2);
    expect(llm.calls).toHaveLength(2);
  });

  it("is idempotent: a second start for the same run attaches to the existing workflow", async () => {
    const llm = scriptedLlm([finalAnswer("once")]);
    executor = build(llm);
    await executor.launch();
    const run = await db.run.create({ data: { agentId, executionManaged: true } });

    await Promise.all([executor.start(run.id), executor.start(run.id)]);

    const after = await db.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("succeeded");
    expect(llm.calls).toHaveLength(1);
  });

  it("stop cancels a running workflow and the run lands failed rather than hanging", async () => {
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    const llm = scriptedLlm([toolCall("t"), toolCall("t"), finalAnswer("never")], { turn: 2, open });
    executor = build(llm);
    await executor.launch();
    const run = await db.run.create({ data: { agentId, executionManaged: true } });

    const started = executor.start(run.id);
    // Wait until turn 2 is blocked inside the LLM step.
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (llm.calls.length === 2) {
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });
    await executor.stop(run.id, "operator cancelled");
    release();
    await started.catch(() => undefined);

    const after = await db.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("failed");
    expect(after.finishedAt).not.toBeNull();
  });

  it("recover(): reports active for its own live workflow, terminal for a finished one, lost for an unknown id", async () => {
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    const llm = scriptedLlm([toolCall("t"), finalAnswer("ok")], { turn: 2, open });
    executor = build(llm);
    await executor.launch();
    const run = await db.run.create({ data: { agentId, executionManaged: true } });
    const started = executor.start(run.id);
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (llm.calls.length === 2) {
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });

    const live = await executor.recover({ runId: run.id, backend: DBOS_BACKEND, id: run.id });
    expect(live).toEqual({ state: "active" });

    release();
    await started;
    const done = await executor.recover({ runId: run.id, backend: DBOS_BACKEND, id: run.id });
    expect(done).toEqual({ state: "terminal" });

    const unknown = await executor.recover({ runId: "nope", backend: DBOS_BACKEND, id: "nope" });
    expect(unknown.state).toBe("lost");
  });

  it("recover(): marks the run failed when the workflow finished but the row never went terminal", async () => {
    const llm = scriptedLlm([finalAnswer("ok")]);
    executor = build(llm);
    await executor.launch();
    const run = await db.run.create({ data: { agentId, executionManaged: true } });
    await executor.start(run.id);
    // Simulate a lost terminal write.
    await db.run.update({ where: { id: run.id }, data: { status: "running", finishedAt: null } });

    const result = await executor.recover({ runId: run.id, backend: DBOS_BACKEND, id: run.id });

    expect(result).toEqual({ state: "terminal" });
    const after = await db.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("failed");
    expect(after.error).toContain("without persisting a terminal run state");
  });

  it("resumes an interrupted run from its last completed step without re-running earlier turns", async () => {
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    const llm = scriptedLlm([toolCall("t"), finalAnswer("resumed")], { turn: 2, open });
    executor = build(llm);
    await executor.launch();
    const run = await db.run.create({ data: { agentId, executionManaged: true } });

    const firstAttempt = executor.start(run.id).catch(() => undefined);
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (llm.calls.length === 2) {
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });
    // "Crash": tear DBOS down while turn 2 is in flight. Turn 1 and its tool
    // call are already recorded as completed steps.
    await executor.close();

    // "Restart": a fresh executor with a DIFFERENT executor id re-drives the
    // orphaned PENDING workflow via recover()'s resume branch (adoption),
    // not launch()'s same-id re-drive. Turn 2's script is now unblocked.
    release();
    await firstAttempt;
    // The resumed workflow replays turn 1 (and its tool call) from the
    // durable record without calling this LLM at all: its own call index
    // starts fresh, and its first (only) call answers the engine's turn 2,
    // so its script has one entry, not a replay of turn 1's script too.
    const resumedLlm = scriptedLlm([finalAnswer("resumed")]);
    executor = buildWith(resumedLlm, `${executorId}-restart`);
    await executor.launch();
    const resumed = await executor.recover({ runId: run.id, backend: DBOS_BACKEND, id: run.id });
    expect(["active", "terminal"]).toContain(resumed.state);
    // recover()'s resume branch fires the adopted workflow without awaiting
    // it, and the dead first attempt's own backstop write (an unconditional
    // `db.run.update`, absorbed by `firstAttempt`'s `.catch`) may have
    // already landed a transient "failed" row before the real resumed
    // workflow's write lands. Poll for `finalText`, which only the
    // successfully-resumed run ever sets, rather than the first non-active
    // status.
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        void db.run.findUnique({ where: { id: run.id } }).then((row) => {
          if (row?.finalText != null) {
            clearInterval(poll);
            resolve();
          }
        });
      }, 50);
    });

    const after = await db.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("succeeded");
    expect(after.finalText).toBe("resumed");
    // Turn 1 replayed from the record: the resumed LLM only ever served turn 2.
    expect(resumedLlm.calls).toHaveLength(1);
    expect(resumedLlm.calls[0].messages.some((m) => m.role === "tool")).toBe(true);
  }, 30_000);
});
