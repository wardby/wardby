import { describe, expect, it } from "vitest";
import type { Datastore } from "../providers/datastore/types.js";
import type { AgentMemoryStore } from "../providers/memory/types.js";
import type { LlmProvider, LlmRequest, LlmStreamEvent } from "../providers/llm/types.js";
import type { SecretCipher } from "../providers/secrets/types.js";
import { NativeEngine } from "./engine-native.js";
import { executeRun, type RunnerDb } from "./runner.js";

// End-to-end coverage of the delegate_to_<boundName> dispatch tool: a real
// NativeEngine driven by a scripted LLM, actually exercising runSandboxTool
// rather than a canned engine result (unlike most of runner.test.ts, which
// deliberately abstracts the engine away). This is the only place the full
// parent -> child -> parent round trip is exercised together.

interface FakeCodingProfile {
  provider: string;
  repository: string;
  baseRef: string;
  defaultTask: string | null;
  allowWebhookTaskOverride: boolean;
  timeoutSec: number;
  allowedEgress: string[];
  protectedPaths: string[];
  toolchain: string;
  toolchainVersion: string | null;
  workerImageRef: string | null;
}

interface FakeAgent {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  budgetUsd: number;
  maxTurns: number;
  budgetGroupId?: string | null;
  kind?: "native" | "coding";
  codingProfile?: FakeCodingProfile;
}

interface FakeRun {
  id: string;
  agentId: string;
  status: string;
  trigger: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  heartbeatAt: Date | null;
  finalText: string | null;
  turns: number;
  parentRunId: string | null;
  grantedParentMemoryKeys: string[];
  taskOverride: string | null;
}

interface FakeEdge {
  parentAgentId: string;
  childAgentId: string;
  boundName: string;
}

function fakeDb(
  agents: FakeAgent[],
  edges: FakeEdge[],
  priorRuns: FakeRun[] = [],
  seedCodingRuns: Record<string, any>[] = [],
): RunnerDb {
  const agentsById = new Map(agents.map((a) => [a.id, a]));
  const runs = new Map(priorRuns.map((r) => [r.id, r]));
  const codingRuns = new Map(seedCodingRuns.map((r) => [r.runId, r]));
  let counter = 0;

  const db: any = {
    agent: {
      findUnique: (async ({ where }: any) => agentsById.get(where.id) ?? null) as any,
      findUniqueOrThrow: (async ({ where }: any) => {
        const a = agentsById.get(where.id);
        if (!a) throw new Error(`fakeDb: no agent "${where.id}"`);
        return a;
      }) as any,
    },
    codingRun: {
      create: (async ({ data }: any) => {
        codingRuns.set(data.runId, data);
        return data;
      }) as any,
      findUnique: (async ({ where }: any) => codingRuns.get(where.runId) ?? null) as any,
    },
    run: {
      create: (async ({ data }: any) => {
        const id = data.id ?? `run_${++counter}`;
        const record: FakeRun = {
          id,
          status: "pending",
          trigger: "manual",
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          error: null,
          startedAt: new Date(),
          finishedAt: null,
          heartbeatAt: null,
          finalText: null,
          turns: 0,
          parentRunId: null,
          grantedParentMemoryKeys: [],
          taskOverride: null,
          ...data,
        };
        runs.set(id, record);
        return record;
      }) as any,
      findUnique: (async ({ where }: any) => runs.get(where.id) ?? null) as any,
      findUniqueOrThrow: (async ({ where }: any) => {
        const record = runs.get(where.id);
        if (!record) throw new Error(`fakeDb: no run "${where.id}"`);
        return record;
      }) as any,
      update: (async ({ where, data }: any) => {
        const record = { ...runs.get(where.id), ...data };
        runs.set(where.id, record);
        return record;
      }) as any,
      updateMany: (async ({ where, data }: any) => {
        const record = runs.get(where.id);
        if (!record) return { count: 0 };
        if (where.status !== undefined) {
          const allowed = typeof where.status === "string" ? [where.status] : where.status.in;
          if (!allowed.includes(record.status)) return { count: 0 };
        }
        runs.set(where.id, { ...record, ...data });
        return { count: 1 };
      }) as any,
      findMany: (async ({ where }: any) => {
        const all = [...runs.values()];
        if (where.agentId) {
          return all.filter((r) => where.agentId.in.includes(r.agentId) && r.startedAt >= where.startedAt.gte);
        }
        if (where.parentRunId) {
          return all.filter((r) => where.parentRunId.in.includes(r.parentRunId));
        }
        if (where.id) {
          return all.filter((r) => where.id.in.includes(r.id));
        }
        return [];
      }) as any,
    },
    agentTool: { findMany: (async () => []) as any },
    agentSecret: { findFirst: (async () => null) as any },
    agentDatastore: { findFirst: (async () => null) as any },
    budgetGroup: { findUnique: (async () => null) as any },
    agentSubAgent: {
      findFirst: (async ({ where }: any) => edges.find((e) => e.parentAgentId === where.parentAgentId) ?? null) as any,
      findMany: (async ({ where }: any) => edges.filter((e) => e.parentAgentId === where.parentAgentId)) as any,
    },
  };
  // dispatchRun wraps everything in one transaction — the fake just runs the
  // callback against this same object rather than modeling real isolation.
  db.$transaction = async (callback: (tx: unknown) => unknown) => callback(db);
  return db;
}

/** A fake Executor whose start() immediately resolves the run to a fixed terminal state, simulating a container finishing. */
function fakeCodingExecutor(db: RunnerDb, result: { status: string; finalText: string; costUsd: number }) {
  return {
    async start(runId: string) {
      await (db as any).run.update({
        where: { id: runId },
        data: { status: result.status, finalText: result.finalText, costUsd: result.costUsd, finishedAt: new Date() },
      });
    },
    async stop() {},
  };
}

function fakeDatastore(): Datastore {
  return {
    async get() {
      return undefined;
    },
    async set() {},
    async delete() {},
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

function fakeMemory(): AgentMemoryStore {
  return {
    async get() {
      return undefined;
    },
    async set() {},
    async list() {
      return [];
    },
    async search() {
      return [];
    },
    async delete() {},
  };
}

const finalAnswer = (text: string): LlmStreamEvent[] => [
  { type: "text", delta: text },
  { type: "done", stopReason: "stop", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } },
];
const toolCall = (name: string, argsJson: string): LlmStreamEvent[] => [
  { type: "tool_call", id: "c1", name, argsJson },
  { type: "done", stopReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 } },
];

/** One shared counter across both the parent's and child's `executeRun` calls — each is its own "turn" in sequence. */
function scriptedLlm(scripts: LlmStreamEvent[][]): LlmProvider & { calls: LlmRequest[] } {
  let index = 0;
  const calls: LlmRequest[] = [];
  return {
    calls,
    async *stream(req) {
      calls.push(req);
      const turn = ++index;
      for (const event of scripts[turn - 1] ?? []) yield event;
    },
    async countTokens() {
      return 10;
    },
    priceUsd(_model, usage) {
      return (usage.inputTokens + usage.outputTokens) / 1000;
    },
  };
}

function providers(llm: LlmProvider, executor?: { start(runId: string): Promise<void>; stop(): Promise<void> }) {
  return {
    llm,
    engine: new NativeEngine(),
    datastore: fakeDatastore(),
    secrets: {} as SecretCipher,
    memory: fakeMemory(),
    executor: executor as never,
  };
}

describe("delegate_to_<boundName> dispatch tool", () => {
  it("dispatches to the bound child, runs it to completion, and returns its result to the parent", async () => {
    const orchestrator: FakeAgent = {
      id: "parent-agent",
      name: "orchestrator",
      systemPrompt: "You orchestrate.",
      model: "m",
      budgetUsd: 10,
      maxTurns: 10,
    };
    const researcher: FakeAgent = {
      id: "child-agent",
      name: "researcher",
      systemPrompt: "You research.",
      model: "m",
      budgetUsd: 10,
      maxTurns: 10,
    };
    const db = fakeDb(
      [orchestrator, researcher],
      [{ parentAgentId: "parent-agent", childAgentId: "child-agent", boundName: "researcher" }],
    );
    const parentRun = await db.run.create({ data: { agentId: "parent-agent" } });

    const llm = scriptedLlm([
      toolCall("delegate_to_researcher", JSON.stringify({ task: "find the answer" })),
      finalAnswer("the child found it"),
      finalAnswer("done, thanks to researcher"),
    ]);

    const result = await executeRun(parentRun.id, providers(llm), db);

    expect(result.status).toBe("succeeded");
    expect(result.finalText).toBe("done, thanks to researcher");

    // Exactly one child run was created, correctly linked and dispatched.
    const childRun = (await db.run.findMany({ where: { parentRunId: { in: [parentRun.id] } } })) as Array<{
      agentId: string;
      trigger: string;
      parentRunId: string;
      taskOverride: string | null;
      status: string;
      finalText: string | null;
    }>;
    expect(childRun).toHaveLength(1);
    expect(childRun[0].agentId).toBe("child-agent");
    expect(childRun[0].trigger).toBe("subagent");
    expect(childRun[0].parentRunId).toBe(parentRun.id);
    expect(childRun[0].taskOverride).toBe("find the answer");
    expect(childRun[0].status).toBe("succeeded");
    expect(childRun[0].finalText).toBe("the child found it");
  });

  it("folds a datastoreRef into the child's taskOverride as a note, not a silent extra mechanism", async () => {
    const orchestrator: FakeAgent = {
      id: "parent-agent",
      name: "orchestrator",
      systemPrompt: "sys",
      model: "m",
      budgetUsd: 10,
      maxTurns: 10,
    };
    const researcher: FakeAgent = {
      id: "child-agent",
      name: "researcher",
      systemPrompt: "sys",
      model: "m",
      budgetUsd: 10,
      maxTurns: 10,
    };
    const db = fakeDb(
      [orchestrator, researcher],
      [{ parentAgentId: "parent-agent", childAgentId: "child-agent", boundName: "researcher" }],
    );
    const parentRun = await db.run.create({ data: { agentId: "parent-agent" } });

    const llm = scriptedLlm([
      toolCall(
        "delegate_to_researcher",
        JSON.stringify({ task: "summarize it", datastoreRef: { name: "notes", key: "doc1" } }),
      ),
      finalAnswer("summarized"),
      finalAnswer("done"),
    ]);
    await executeRun(parentRun.id, providers(llm), db);

    const childRun = (await db.run.findMany({ where: { parentRunId: { in: [parentRun.id] } } })) as Array<{
      taskOverride: string | null;
    }>;
    expect(childRun[0].taskOverride).toContain("summarize it");
    expect(childRun[0].taskOverride).toContain('name="notes"');
    expect(childRun[0].taskOverride).toContain('key="doc1"');
  });

  it("fails closed for a boundName with no AgentSubAgent edge, even if the model calls it directly", async () => {
    const orchestrator: FakeAgent = {
      id: "parent-agent",
      name: "orchestrator",
      systemPrompt: "sys",
      model: "m",
      budgetUsd: 10,
      maxTurns: 10,
    };
    const db = fakeDb([orchestrator], []); // no edges at all
    const parentRun = await db.run.create({ data: { agentId: "parent-agent" } });

    const llm = scriptedLlm([
      toolCall("delegate_to_ghost", JSON.stringify({ task: "anything" })),
      finalAnswer("noticed the error and stopped"),
    ]);
    const result = await executeRun(parentRun.id, providers(llm), db);

    expect(result.status).toBe("succeeded");
    // No child run was ever created.
    const childRuns = await db.run.findMany({ where: { parentRunId: { in: [parentRun.id] } } });
    expect(childRuns).toHaveLength(0);
  });

  it("bounds the child's budget by the run tree's shared ceiling, not just its own budgetUsd", async () => {
    const orchestrator: FakeAgent = {
      id: "parent-agent",
      name: "orchestrator",
      systemPrompt: "sys",
      model: "m",
      budgetUsd: 1, // tight root budget
      maxTurns: 10,
    };
    const researcher: FakeAgent = {
      id: "child-agent",
      name: "researcher",
      systemPrompt: "sys",
      model: "m",
      budgetUsd: 100, // the child's own budget is far looser
      maxTurns: 10,
    };
    const db = fakeDb(
      [orchestrator, researcher],
      [{ parentAgentId: "parent-agent", childAgentId: "child-agent", boundName: "researcher" }],
    );
    // The root run has already spent nearly all of its own $1 ceiling.
    const parentRun = await db.run.create({ data: { agentId: "parent-agent", costUsd: 0.99 } });

    const llm = scriptedLlm([
      toolCall("delegate_to_researcher", JSON.stringify({ task: "go" })),
      // The child should be refused pre-flight (run-tree remaining ~= 0.01),
      // so it never actually streams a response — if it did, the engine
      // would consume this and something is wrong with the budget wiring.
      finalAnswer("should not run"),
      finalAnswer("parent wraps up"),
    ]);
    await executeRun(parentRun.id, providers(llm), db);

    const childRun = (await db.run.findMany({ where: { parentRunId: { in: [parentRun.id] } } })) as Array<{
      status: string;
    }>;
    expect(childRun).toHaveLength(1);
    expect(childRun[0].status).toBe("refused");
  });

  const codingProfile: FakeCodingProfile = {
    provider: "codex",
    repository: "chfields/knock-knock-jokes",
    baseRef: "main",
    defaultTask: null,
    allowWebhookTaskOverride: true,
    timeoutSec: 900,
    allowedEgress: [],
    protectedPaths: ["tests/**"],
    toolchain: "node-python",
    toolchainVersion: "3.12",
    workerImageRef: null,
  };

  it("dispatches to a coding-kind child via dispatchRun/Executor, since executeRun cannot drive one itself", async () => {
    const dispatcher: FakeAgent = {
      id: "dispatcher-agent",
      name: "knock-knock-delivery",
      systemPrompt: "You classify and delegate.",
      model: "m",
      budgetUsd: 5,
      maxTurns: 10,
    };
    const implementer: FakeAgent = {
      id: "implement-agent",
      name: "knock-knock-implement",
      systemPrompt: "unused for coding agents",
      model: "gpt-5.6-luna",
      budgetUsd: 5,
      maxTurns: 10,
      kind: "coding",
      codingProfile,
    };
    const db = fakeDb(
      [dispatcher, implementer],
      [{ parentAgentId: "dispatcher-agent", childAgentId: "implement-agent", boundName: "implement" }],
    );
    const parentRun = await db.run.create({ data: { agentId: "dispatcher-agent" } });
    const executor = fakeCodingExecutor(db, {
      status: "succeeded",
      finalText: "Implemented the requested change.",
      costUsd: 0.02,
    });

    const llm = scriptedLlm([
      toolCall("delegate_to_implement", JSON.stringify({ task: "add the feature" })),
      finalAnswer("delegated to implement, done"),
    ]);
    const result = await executeRun(parentRun.id, providers(llm, executor), db);

    expect(result.status).toBe("succeeded");
    expect(result.finalText).toBe("delegated to implement, done");

    const childRuns = (await db.run.findMany({ where: { parentRunId: { in: [parentRun.id] } } })) as Array<{
      agentId: string;
      trigger: string;
      status: string;
      finalText: string | null;
      executionManaged: boolean;
    }>;
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0].agentId).toBe("implement-agent");
    expect(childRuns[0].trigger).toBe("subagent");
    expect(childRuns[0].status).toBe("succeeded");
    expect(childRuns[0].finalText).toBe("Implemented the requested change.");
    // Unlike native dispatch, the coding child IS executionManaged: true —
    // a long-running container crash mid-dispatch is exactly what the
    // reconciler exists for.
    expect(childRuns[0].executionManaged).toBe(true);
  });

  it("revision-in-place: continuePriorRun threads through dispatchRun to the child's CodingRun, even to a different bound sub-agent", async () => {
    const dispatcher: FakeAgent = {
      id: "dispatcher-agent",
      name: "knock-knock-delivery",
      systemPrompt: "You classify and delegate.",
      model: "m",
      budgetUsd: 5,
      maxTurns: 10,
    };
    const implementer: FakeAgent = {
      id: "implement-agent",
      name: "knock-knock-implement",
      systemPrompt: "unused for coding agents",
      model: "gpt-5.6-luna",
      budgetUsd: 5,
      maxTurns: 10,
      kind: "coding",
      codingProfile,
    };
    const db = fakeDb(
      [dispatcher, implementer],
      [{ parentAgentId: "dispatcher-agent", childAgentId: "implement-agent", boundName: "implement" }],
      [],
      [
        {
          runId: "plan-run-1",
          repository: codingProfile.repository,
          baseRef: codingProfile.baseRef,
          headRef: "wardby/run-plan-run-1",
          rootCodingRunId: null,
          result: {
            schemaVersion: 1,
            outcome: "pull_request_opened",
            repository: codingProfile.repository,
            baseRef: codingProfile.baseRef,
            headRef: "wardby/run-plan-run-1",
            commitSha: "a".repeat(40),
            pullRequestUrl: `https://github.com/${codingProfile.repository}/pull/22`,
            pullRequestNumber: 22,
            summary: "Posted the plan",
            tests: [],
            usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
          },
        },
      ],
    );
    const parentRun = await db.run.create({ data: { agentId: "dispatcher-agent" } });
    const executor = fakeCodingExecutor(db, {
      status: "succeeded",
      finalText: "Implemented the requested change.",
      costUsd: 0.02,
    });

    const llm = scriptedLlm([
      toolCall(
        "delegate_to_implement",
        JSON.stringify({ task: "implement the approved plan", continuePriorRun: "plan-run-1" }),
      ),
      finalAnswer("delegated to implement, done"),
    ]);
    const result = await executeRun(parentRun.id, providers(llm, executor), db);

    expect(result.status).toBe("succeeded");
    const childRuns = (await db.run.findMany({ where: { parentRunId: { in: [parentRun.id] } } })) as Array<{
      id: string;
    }>;
    expect(childRuns).toHaveLength(1);
    const childCodingRun = await (db as any).codingRun.findUnique({ where: { runId: childRuns[0].id } });
    // Same branch/PR the plan agent opened -- a DIFFERENT sub-agent continuing it (cross-role, allowed by design).
    expect(childCodingRun).toMatchObject({ rootCodingRunId: "plan-run-1", headRef: "wardby/run-plan-run-1" });
  });

  it("refuses a second delegate_to_* call in the same run, even to a different bound sub-agent", async () => {
    const dispatcher: FakeAgent = {
      id: "dispatcher-agent",
      name: "knock-knock-delivery",
      systemPrompt: "sys",
      model: "m",
      budgetUsd: 5,
      maxTurns: 10,
    };
    const planAgent: FakeAgent = {
      id: "plan-agent",
      name: "knock-knock-plan",
      systemPrompt: "unused",
      model: "gpt-6-astra",
      budgetUsd: 5,
      maxTurns: 10,
      kind: "coding",
      codingProfile,
    };
    const implementAgent: FakeAgent = {
      id: "implement-agent",
      name: "knock-knock-implement",
      systemPrompt: "unused",
      model: "gpt-5.6-luna",
      budgetUsd: 5,
      maxTurns: 10,
      kind: "coding",
      codingProfile,
    };
    const db = fakeDb(
      [dispatcher, planAgent, implementAgent],
      [
        { parentAgentId: "dispatcher-agent", childAgentId: "plan-agent", boundName: "plan" },
        { parentAgentId: "dispatcher-agent", childAgentId: "implement-agent", boundName: "implement" },
      ],
    );
    const parentRun = await db.run.create({ data: { agentId: "dispatcher-agent" } });
    const executor = fakeCodingExecutor(db, { status: "succeeded", finalText: "planned", costUsd: 0.01 });

    // A misbehaving classifier tries to call both — the second must be refused.
    const llm = scriptedLlm([
      toolCall("delegate_to_plan", JSON.stringify({ task: "figure out the approach" })),
      toolCall("delegate_to_implement", JSON.stringify({ task: "do it anyway" })),
      finalAnswer("noticed the refusal and stopped"),
    ]);
    await executeRun(parentRun.id, providers(llm, executor), db);

    const childRuns = await db.run.findMany({ where: { parentRunId: { in: [parentRun.id] } } });
    expect(childRuns).toHaveLength(1); // only the plan dispatch went through
  });
});
