import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { NativeEngine } from "../core/engine-native.js";
import { durableDelegate, loadNativeRun, type LoadedNativeRun, type NativeRunProviders } from "../core/runner.js";
import type { Executor } from "../providers/executor/types.js";
import { buildCatalog } from "../providers/llm/catalog.js";
import { SHIPPED_CATALOG } from "../providers/llm/catalog-shipped.js";
import { RoutingLlmProvider, type CatalogLlmAdapter } from "../providers/llm/routing.js";
import type { AgentMemoryStore } from "../providers/memory/types.js";
import type { SecretCipher } from "../providers/secrets/types.js";
import type { Datastore } from "../providers/datastore/types.js";
import { PrismaGatewayLedger } from "./ledger.js";

// Passes through to the real dispatchRun unless a test queues a rejection.
vi.mock("../core/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/dispatch.js")>();
  return { ...actual, dispatchRun: vi.fn(actual.dispatchRun) };
});
const { dispatchRun } = await import("../core/dispatch.js");

const MODEL = "claude-haiku-4-5";

describe.skipIf(!process.env.DATABASE_URL)("durableDelegate (database)", () => {
  const db = createPrismaClient();
  const ledger = new PrismaGatewayLedger(db);
  const tag = randomUUID().slice(0, 8);
  const ownerId = `dd-owner-${tag}`;
  const leadId = `dd-lead-${tag}`;
  const childA = `dd-child-a-${tag}`;
  const childB = `dd-child-b-${tag}`;
  const agentIds = [leadId, childA, childB];

  const adapter: CatalogLlmAdapter = {
    async *stream() {},
    countTokens: async () => 1,
    priceUsd: () => 0,
    withEntry: () => adapter,
  };
  const llm = new RoutingLlmProvider([{ provider: "anthropic", adapter }], () =>
    buildCatalog(SHIPPED_CATALOG, [], "dd"),
  );

  /** An Executor whose runs finish only when the test says so, like a real child running elsewhere. */
  function controlledExecutor() {
    const started: string[] = [];
    const stopped: string[] = [];
    const executor: Executor = {
      async start(runId) {
        started.push(runId);
      },
      async stop(runId) {
        stopped.push(runId);
      },
    };
    const finishChild = (runId: string, finalText: string) =>
      db.run.update({ where: { id: runId }, data: { status: "succeeded", finalText, finishedAt: new Date() } });
    return { executor, started, stopped, finishChild };
  }

  const providersWith = (executor: Executor): NativeRunProviders => ({
    llm,
    engine: new NativeEngine(),
    datastore: {} as Datastore,
    secrets: {} as SecretCipher,
    memory: {} as AgentMemoryStore,
    executor,
  });

  beforeAll(async () => {
    await db.principal.create({ data: { id: ownerId, subject: ownerId } });
    for (const id of agentIds) {
      await db.agent.create({
        data: { id, name: id, systemPrompt: "s", model: MODEL, budgetUsd: 1, maxTurns: 3, ownerId },
      });
    }
    await db.agentSubAgent.createMany({
      data: [
        { parentAgentId: leadId, childAgentId: childA, boundName: "a" },
        { parentAgentId: leadId, childAgentId: childB, boundName: "b" },
      ],
    });
  });

  afterAll(async () => {
    const runs = await db.run.findMany({ where: { agentId: { in: agentIds } }, select: { id: true } });
    const ids = runs.map((r) => r.id);
    await db.runAttribution.deleteMany({ where: { runId: { in: ids } } });
    await db.run.updateMany({ where: { id: { in: ids } }, data: { parentRunId: null } });
    await db.run.deleteMany({ where: { id: { in: ids } } });
    await db.agentSubAgent.deleteMany({ where: { parentAgentId: leadId } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.principal.deleteMany({ where: { id: ownerId } });
    await db.$disconnect();
  });

  /** A running sandboxed lead with its gateway session and loaded snapshot. */
  async function lead(
    overrides: { maxDelegationsPerRun?: number; parallelDelegations?: boolean; budgetUsd?: number } = {},
  ) {
    await db.agent.update({
      where: { id: leadId },
      data: { maxDelegationsPerRun: 1, parallelDelegations: false, budgetUsd: 1, ...overrides },
    });
    const run = await db.run.create({
      data: { agentId: leadId, status: "running", nativeExecutionMode: "sandbox", executionManaged: true },
    });
    const loaded = (await loadNativeRun({
      runId: run.id,
      existingRun: run,
      providers: providersWith(controlledExecutor().executor),
      db,
      step: (_name, fn) => fn(),
      reviewHosts: undefined,
      issueTrackers: undefined,
    })) as LoadedNativeRun;
    const session = await ledger.createSession({
      runId: run.id,
      capabilityHash: `h-${randomUUID()}`,
      deadlineAt: new Date(Date.now() + 600_000),
      budgetUsd: 1,
      snapshot: {},
    });
    return { run, loaded, session };
  }

  const ctxFor = (l: Awaited<ReturnType<typeof lead>>, executor: Executor) => ({
    runId: l.run.id,
    existingRun: l.run,
    loaded: l.loaded,
    providers: providersWith(executor),
    db,
    issueTrackers: undefined,
    ledger,
    sessionId: l.session.id,
    pollWindowMs: 50,
    pollIntervalMs: 10,
  });

  it("dispatches a managed child, answers pending while it runs, then its result, and replays it", async () => {
    const l = await lead();
    const ex = controlledExecutor();
    const ctx = ctxFor(l, ex.executor);
    const args = JSON.stringify({ task: "do a thing" });

    expect(await durableDelegate(ctx, "d-1", "delegate_to_a", args)).toEqual({ pending: true });
    expect(ex.started).toHaveLength(1);
    const child = await db.run.findUniqueOrThrow({ where: { id: ex.started[0] } });
    expect(child).toMatchObject({
      parentRunId: l.run.id,
      agentId: childA,
      trigger: "subagent",
      executionManaged: true,
      taskOverride: "do a thing",
      // Keyed on the worker's callId, so the same call finds this child again.
      parentCallId: "d-1",
    });

    // The worker calls again with the same callId: still pending, and no second child.
    expect(await durableDelegate(ctx, "d-1", "delegate_to_a", args)).toEqual({ pending: true });
    await ex.finishChild(child.id, "done by a");
    const outcome = await durableDelegate(ctx, "d-1", "delegate_to_a", args);
    expect(outcome).toEqual({ result: expect.stringContaining('"finalText":"done by a"') });
    // A later repeat replays the recorded result.
    expect(await durableDelegate(ctx, "d-1", "delegate_to_a", args)).toEqual(outcome);
    expect(ex.started).toHaveLength(1);
  });

  it("adopts a child a dead replica dispatched but never recorded, instead of refusing it as a duplicate", async () => {
    const l = await lead();
    const ex = controlledExecutor();
    const ctx = ctxFor(l, ex.executor);
    // The dead replica got as far as recording intent and creating the child row.
    await ledger.claim(l.session.id, "d-1", "builtin.call");
    await ledger.setDelegation(l.session.id, "d-1", { status: "pending", childAgentId: childA });
    const orphan = await db.run.create({
      data: {
        agentId: childA,
        parentRunId: l.run.id,
        parentCallId: "d-1",
        trigger: "subagent",
        executionManaged: true,
        status: "succeeded",
        finalText: "orphan result",
      },
    });
    const outcome = await durableDelegate(ctx, "d-1", "delegate_to_a", JSON.stringify({ task: "x" }));
    expect(outcome).toEqual({ result: expect.stringContaining('"finalText":"orphan result"') });
    expect(ex.started).toEqual([]);
    expect(await db.run.count({ where: { parentRunId: l.run.id } })).toBe(1);
    expect(orphan.id).toBeTruthy();
  });

  it("adopts a still-running orphan created before children carried their call id", async () => {
    const l = await lead();
    const ex = controlledExecutor();
    const ctx = ctxFor(l, ex.executor);
    await ledger.claim(l.session.id, "d-1", "builtin.call");
    await ledger.setDelegation(l.session.id, "d-1", { status: "pending", childAgentId: childA });
    const orphan = await db.run.create({
      data: { agentId: childA, parentRunId: l.run.id, trigger: "subagent", executionManaged: true, status: "running" },
    });
    expect(await durableDelegate(ctx, "d-1", "delegate_to_a", JSON.stringify({ task: "x" }))).toEqual({
      pending: true,
    });
    await ex.finishChild(orphan.id, "legacy orphan result");
    const outcome = await durableDelegate(ctx, "d-1", "delegate_to_a", JSON.stringify({ task: "x" }));
    expect(outcome).toEqual({ result: expect.stringContaining('"finalText":"legacy orphan result"') });
    expect(ex.started).toEqual([]);
    expect(await db.run.count({ where: { parentRunId: l.run.id } })).toBe(1);
  });

  it("turns an unexpected dispatch error into a recorded result naming only its code, and replays it", async () => {
    const l = await lead();
    const ex = controlledExecutor();
    const ctx = ctxFor(l, ex.executor);
    vi.mocked(dispatchRun).mockRejectedValueOnce(new Error("coding_execution_not_configured: secret detail"));
    const args = JSON.stringify({ task: "x" });
    const outcome = await durableDelegate(ctx, "d-1", "delegate_to_a", args);
    expect(outcome).toEqual({
      result: JSON.stringify({
        error: "dispatch_failed",
        message: "The sub-agent run could not be created (coding_execution_not_configured).",
      }),
    });
    // The retried callId replays the recorded result and does not dispatch again.
    const calls = vi.mocked(dispatchRun).mock.calls.length;
    expect(await durableDelegate(ctx, "d-1", "delegate_to_a", args)).toEqual(outcome);
    expect(vi.mocked(dispatchRun).mock.calls.length).toBe(calls);
  });

  it("omits the code from the message when the dispatch error has none", async () => {
    const l = await lead();
    const ctx = ctxFor(l, controlledExecutor().executor);
    vi.mocked(dispatchRun).mockRejectedValueOnce(new Error("Connection refused to db at 10.0.0.1"));
    expect(await durableDelegate(ctx, "d-1", "delegate_to_a", JSON.stringify({ task: "x" }))).toEqual({
      result: JSON.stringify({ error: "dispatch_failed", message: "The sub-agent run could not be created." }),
    });
  });

  it("refuses a delegation past the per-run limit with the in-process message", async () => {
    const l = await lead({ maxDelegationsPerRun: 1 });
    const ex = controlledExecutor();
    const ctx = ctxFor(l, ex.executor);
    await durableDelegate(ctx, "d-1", "delegate_to_a", JSON.stringify({ task: "x" }));
    const second = await durableDelegate(ctx, "d-2", "delegate_to_b", JSON.stringify({ task: "y" }));
    expect(second).toEqual({
      result: JSON.stringify({
        error: "already_dispatched",
        message: "This run already delegated to a sub-agent; only one delegation is allowed per run.",
      }),
    });
  });

  it("never admits more than the limit when parallel delegations race on different replicas", async () => {
    const l = await lead({ maxDelegationsPerRun: 1, parallelDelegations: true });
    const ex = controlledExecutor();
    // Two "replicas": independent contexts over the same database.
    const ctxA = ctxFor(l, ex.executor);
    const ctxB = ctxFor(l, ex.executor);
    await Promise.all([
      durableDelegate(ctxA, "d-1", "delegate_to_a", JSON.stringify({ task: "x" })),
      durableDelegate(ctxB, "d-2", "delegate_to_b", JSON.stringify({ task: "y" })),
    ]);
    const children = await db.run.findMany({ where: { parentRunId: l.run.id } });
    expect(children).toHaveLength(1);

    // The loser was refused at once, or (when it checked the limit before the winner's child
    // committed) is waiting for the budget that child holds. Either way its next call is refused:
    // it can never start a second child.
    const loser =
      children[0].agentId === childA
        ? { ctx: ctxB, callId: "d-2", name: "delegate_to_b", task: "y" }
        : { ctx: ctxA, callId: "d-1", name: "delegate_to_a", task: "x" };
    const again = await durableDelegate(loser.ctx, loser.callId, loser.name, JSON.stringify({ task: loser.task }));
    expect(again).toEqual({ result: expect.stringContaining("already_dispatched") });
    expect(await db.run.count({ where: { parentRunId: l.run.id } })).toBe(1);
  });

  it("waits for a running sibling to free the run tree's budget, durably, then dispatches", async () => {
    const l = await lead({ maxDelegationsPerRun: 2, parallelDelegations: true, budgetUsd: 0.1 });
    const ex = controlledExecutor();
    const ctx = ctxFor(l, ex.executor);
    // A sibling already holds the whole tree budget while it runs.
    const sibling = await db.run.create({
      data: {
        agentId: childA,
        parentRunId: l.run.id,
        trigger: "subagent",
        executionManaged: true,
        status: "running",
        costUsd: 0.1,
        heartbeatAt: new Date(),
      },
    });
    expect(await durableDelegate(ctx, "d-2", "delegate_to_b", JSON.stringify({ task: "y" }))).toEqual({
      pending: true,
    });
    expect(await ledger.delegation(l.session.id, "d-2")).toMatchObject({
      status: "waiting_budget",
      childAgentId: childB,
    });
    expect(ex.started).toEqual([]);

    // The sibling finishes; the next call (any replica) re-evaluates and dispatches.
    await db.run.update({ where: { id: sibling.id }, data: { status: "succeeded", finishedAt: new Date() } });
    expect(await durableDelegate(ctx, "d-2", "delegate_to_b", JSON.stringify({ task: "y" }))).toEqual({
      pending: true,
    });
    expect(ex.started).toHaveLength(1);
    expect(await ledger.delegation(l.session.id, "d-2")).toMatchObject({ status: "pending" });
  });
});
