import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { NativeEngine } from "../core/engine-native.js";
import {
  delegateToolDef,
  durableDelegate,
  loadNativeRun,
  type LoadedNativeRun,
  type NativeRunProviders,
} from "../core/runner.js";
import type { Executor } from "../providers/executor/types.js";
import { buildCatalog } from "../providers/llm/catalog.js";
import { SHIPPED_CATALOG } from "../providers/llm/catalog-shipped.js";
import { RoutingLlmProvider, type CatalogLlmAdapter } from "../providers/llm/routing.js";
import type { AgentMemoryStore } from "../providers/memory/types.js";
import type { SecretCipher } from "../providers/secrets/types.js";
import type { Datastore } from "../providers/datastore/types.js";
import { PrismaGatewayLedger } from "./ledger.js";
import { defaultRepositoryName } from "../coding/repository-names.js";

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

  describe("masks the lead's attached secret values in the delegated task", () => {
    const FAKE = `fake-secret-value-${tag}`;
    const secretId = `dd-secret-${tag}`;
    const cipher = {
      keyId: () => "k",
      encrypt: async (v: string) => v,
      decrypt: async (v: string) => v,
    };

    async function attach() {
      await db.secret.create({ data: { id: secretId, name: `api-${tag}`, ciphertext: FAKE, keyId: "k", ownerId } });
      await db.agentSecret.create({ data: { agentId: leadId, secretId, boundName: "API_KEY" } });
    }
    async function detach() {
      await db.agentSecret.deleteMany({ where: { agentId: leadId } });
      await db.secret.deleteMany({ where: { id: secretId } });
    }

    it("stores the child's task with the value replaced", async () => {
      await attach();
      try {
        const l = await lead();
        const ex = controlledExecutor();
        const ctx = { ...ctxFor(l, ex.executor), providers: { ...providersWith(ex.executor), secrets: cipher } };
        expect(
          await durableDelegate(ctx, "m-1", "delegate_to_a", JSON.stringify({ task: `use token ${FAKE} please` })),
        ).toEqual({ pending: true });
        const child = await db.run.findUniqueOrThrow({ where: { id: ex.started[0] } });
        expect(child.taskOverride).toBe("use token [REDACTED] please");
        expect(JSON.stringify(child)).not.toContain(FAKE);
      } finally {
        await detach();
      }
    });

    it("a poll of an already dispatched child never reads the secrets, so a read failure cannot orphan it", async () => {
      await attach();
      try {
        const l = await lead();
        const ex = controlledExecutor();
        const args = JSON.stringify({ task: `use ${FAKE}` });
        const good = { ...ctxFor(l, ex.executor), providers: { ...providersWith(ex.executor), secrets: cipher } };
        expect(await durableDelegate(good, "m-3", "delegate_to_a", args)).toEqual({ pending: true });
        const broken = {
          ...cipher,
          decrypt: async () => {
            throw new Error("decrypt failed");
          },
        } as unknown as SecretCipher;
        const bad = { ...good, providers: { ...good.providers, secrets: broken } };
        expect(await durableDelegate(bad, "m-3", "delegate_to_a", args)).toEqual({ pending: true });
        await ex.finishChild(ex.started[0], "done by a");
        expect(await durableDelegate(bad, "m-3", "delegate_to_a", args)).toEqual({
          result: expect.stringContaining('"finalText":"done by a"'),
        });
        expect(ex.started).toHaveLength(1);
        expect(await db.run.count({ where: { parentRunId: l.run.id } })).toBe(1);
      } finally {
        await detach();
      }
    });

    it("a refused waiting call is completed, so the model's retry under a new callId is not refused", async () => {
      await attach();
      try {
        const l = await lead({ maxDelegationsPerRun: 2, parallelDelegations: true, budgetUsd: 0.1 });
        const ex = controlledExecutor();
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
        const good = { ...ctxFor(l, ex.executor), providers: { ...providersWith(ex.executor), secrets: cipher } };
        const args = JSON.stringify({ task: "y" });
        expect(await durableDelegate(good, "w-1", "delegate_to_b", args)).toEqual({ pending: true });
        expect(await ledger.delegation(l.session.id, "w-1")).toMatchObject({ status: "waiting_budget" });

        const broken = {
          ...cipher,
          decrypt: async () => {
            throw new Error("decrypt failed");
          },
        } as unknown as SecretCipher;
        const bad = { ...good, providers: { ...good.providers, secrets: broken } };
        expect(await durableDelegate(bad, "w-1", "delegate_to_b", args)).toEqual({
          result: expect.stringContaining("secret_check_unavailable"),
        });
        expect(await ledger.waitingDelegations(l.session.id, "w-2")).toEqual([]);

        await db.run.update({ where: { id: sibling.id }, data: { status: "succeeded", finishedAt: new Date() } });
        expect(await durableDelegate(good, "w-2", "delegate_to_b", args)).toEqual({ pending: true });
        expect(ex.started).toHaveLength(1);
      } finally {
        await detach();
      }
    });

    it("refuses with secret_check_unavailable and creates no child when the secrets cannot be read", async () => {
      await attach();
      try {
        const l = await lead();
        const ex = controlledExecutor();
        const broken = {
          ...cipher,
          decrypt: async () => {
            throw new Error(`decrypt failed for ${FAKE}`);
          },
        } as unknown as SecretCipher;
        const ctx = { ...ctxFor(l, ex.executor), providers: { ...providersWith(ex.executor), secrets: broken } };
        const outcome = await durableDelegate(ctx, "m-2", "delegate_to_a", JSON.stringify({ task: `use ${FAKE}` }));
        expect(outcome).toEqual({ result: expect.stringContaining("secret_check_unavailable") });
        expect(JSON.stringify(outcome)).not.toContain(FAKE);
        expect(ex.started).toEqual([]);
        expect(await db.run.count({ where: { parentRunId: l.run.id } })).toBe(0);
      } finally {
        await detach();
      }
    });
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

  it("words a repeat delegation to a child with no list by sub-agent", async () => {
    const l = await lead({ maxDelegationsPerRun: 2 });
    const ctx = ctxFor(l, controlledExecutor().executor);
    await durableDelegate(ctx, "d-1", "delegate_to_a", JSON.stringify({ task: "x" }));
    const second = await durableDelegate(ctx, "d-2", "delegate_to_a", JSON.stringify({ task: "y" }));
    expect(second).toEqual({
      result: JSON.stringify({
        error: "already_dispatched",
        message: 'This run already delegated to "a"; a run delegates to each sub-agent at most once.',
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

  describe("a coding child with a repository list", () => {
    const fixer = `dd-fixer-${tag}`;
    const nativeBound = "a";
    const DEFAULT = `acme/default-${tag}`;
    const SERVICE_A = `acme/service-a-${tag}`;
    const SERVICE_B = `acme/service-b-${tag}`;
    const links = (repositories: string[]) =>
      repositories.map((repository) => ({
        agentId: fixer,
        provider: "github",
        repository,
        name: defaultRepositoryName(repository),
        access: "write",
        triggers: [] as string[],
      }));
    const setLinks = async (repositories: string[]) => {
      await db.agentRepository.deleteMany({ where: { agentId: fixer } });
      await db.agentRepository.createMany({ data: links(repositories) });
    };
    const fix = (repository?: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ task: "fix", ...(repository === undefined ? {} : { repository }), ...extra });
    const repositoryOf = async (runId: string) =>
      (await db.codingRun.findUniqueOrThrow({ where: { runId } })).repository;
    const gatewayCall = (sessionId: string, callId: string) =>
      db.nativeGatewayCall.findUniqueOrThrow({ where: { sessionId_callId: { sessionId, callId } } });

    beforeAll(async () => {
      await db.agent.create({
        data: {
          id: fixer,
          name: fixer,
          systemPrompt: "s",
          model: "gpt-5.6-luna",
          budgetUsd: 0.5,
          kind: "coding",
          ownerId,
          codingProfile: { create: { provider: "codex", repository: DEFAULT, protectedPaths: [] } },
        },
      });
      await db.agentSubAgent.create({ data: { parentAgentId: leadId, childAgentId: fixer, boundName: "fixer" } });
    });

    beforeEach(() => setLinks([SERVICE_A, SERVICE_B]));

    afterAll(async () => {
      const runs = await db.run.findMany({ where: { agentId: fixer }, select: { id: true } });
      const ids = runs.map((r) => r.id);
      await db.runAttribution.deleteMany({ where: { runId: { in: ids } } });
      await db.codingRun.deleteMany({ where: { runId: { in: ids } } });
      await db.run.deleteMany({ where: { id: { in: ids } } });
      await db.agentSubAgent.deleteMany({ where: { childAgentId: fixer } });
      await db.agentRepository.deleteMany({ where: { agentId: fixer } });
      await db.agent.deleteMany({ where: { id: fixer } });
    });

    it("loads the list as an enum: default first, write links without triggers only", async () => {
      await db.agentRepository.createMany({
        data: [
          {
            agentId: fixer,
            provider: "github",
            repository: `acme/trig-${tag}`,
            name: defaultRepositoryName(`acme/trig-${tag}`),
            access: "write",
            triggers: ["mention"],
          },
          {
            agentId: fixer,
            provider: "github",
            repository: `acme/read-${tag}`,
            name: defaultRepositoryName(`acme/read-${tag}`),
            access: "read",
            triggers: [],
          },
        ],
      });
      const l = await lead();
      const tool = l.loaded.tools.find((t) => t.name === "delegate_to_fixer")!;
      expect((tool.jsonSchema.properties as Record<string, { enum?: string[] }>).repository.enum).toEqual([
        DEFAULT,
        SERVICE_A,
        SERVICE_B,
      ]);
      // A native child on the same lead gets no repository property.
      const native = l.loaded.tools.find((t) => t.name === `delegate_to_${nativeBound}`)!;
      expect(JSON.stringify(native)).not.toContain('"repository"');
    });

    it("refuses no repository and an unlisted one, leaving no child and storing nothing", async () => {
      const l = await lead({ maxDelegationsPerRun: 5 });
      const ex = controlledExecutor();
      const ctx = ctxFor(l, ex.executor);
      const required = await durableDelegate(ctx, "r-1", "delegate_to_fixer", fix());
      expect(required).toEqual({ result: expect.stringContaining("repository_required") });
      const unlisted = await durableDelegate(ctx, "r-2", "delegate_to_fixer", fix("acme/sk-fake-secret"));
      expect(unlisted).toEqual({ result: expect.stringContaining("repository_not_listed") });
      expect(JSON.stringify(unlisted)).not.toContain("sk-fake-secret");
      expect(ex.started).toEqual([]);
      expect(await db.run.count({ where: { parentRunId: l.run.id } })).toBe(0);
      expect((await gatewayCall(l.session.id, "r-2")).childRepository).toBeNull();
    });

    it("refuses repository on a native child", async () => {
      const l = await lead();
      const ex = controlledExecutor();
      const outcome = await durableDelegate(ctxFor(l, ex.executor), "r-1", "delegate_to_a", fix(SERVICE_A));
      expect(outcome).toEqual({ result: expect.stringContaining("repository_requires_coding_agent") });
      expect(JSON.stringify(outcome)).not.toContain(SERVICE_A);
      expect(await db.run.count({ where: { parentRunId: l.run.id } })).toBe(0);
    });

    it("delegates to two repositories, and refuses the same repository twice", async () => {
      const l = await lead({ maxDelegationsPerRun: 5 });
      const ex = controlledExecutor();
      const ctx = ctxFor(l, ex.executor);
      expect(await durableDelegate(ctx, "t-1", "delegate_to_fixer", fix(SERVICE_A))).toEqual({ pending: true });
      expect(await durableDelegate(ctx, "t-2", "delegate_to_fixer", fix(SERVICE_B))).toEqual({ pending: true });
      expect(vi.mocked(dispatchRun).mock.lastCall?.[0]).toMatchObject({
        codingRepository: SERVICE_B,
        requireExplicitRepository: true,
      });
      const again = await durableDelegate(ctx, "t-3", "delegate_to_fixer", fix(SERVICE_A.toUpperCase()));
      expect(again).toEqual({ result: expect.stringContaining("already_dispatched") });
      expect(ex.started).toHaveLength(2);
      expect(await Promise.all(ex.started.map(repositoryOf))).toEqual([SERVICE_A, SERVICE_B]);
    });

    it("counts each repository toward the delegation limit", async () => {
      const l = await lead({ maxDelegationsPerRun: 1 });
      const ex = controlledExecutor();
      const ctx = ctxFor(l, ex.executor);
      await durableDelegate(ctx, "t-1", "delegate_to_fixer", fix(SERVICE_A));
      const second = await durableDelegate(ctx, "t-2", "delegate_to_fixer", fix(SERVICE_B));
      expect(second).toEqual({ result: expect.stringContaining("only one delegation is allowed") });
      expect(ex.started).toHaveLength(1);
    });

    it("a single-repository child delegates as before, to its default", async () => {
      await setLinks([]);
      const l = await lead();
      const ex = controlledExecutor();
      expect(await durableDelegate(ctxFor(l, ex.executor), "t-1", "delegate_to_fixer", fix())).toEqual({
        pending: true,
      });
      expect(await repositoryOf(ex.started[0])).toBe(DEFAULT);
    });

    describe("waiting for budget", () => {
      /** A lead with a sibling that holds the whole tree budget while it runs. */
      async function leadWithSibling() {
        const l = await lead({ maxDelegationsPerRun: 5, parallelDelegations: true, budgetUsd: 0.1 });
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
        return { l, sibling };
      }

      /** The sibling finishes having spent nothing, so a coding child's reservation fits. */
      const freeBudget = (siblingId: string) =>
        db.run.update({ where: { id: siblingId }, data: { status: "succeeded", costUsd: 0, finishedAt: new Date() } });

      it("on one repository doesn't block another, and does block its own", async () => {
        const { l, sibling } = await leadWithSibling();
        const ex = controlledExecutor();
        const ctx = ctxFor(l, ex.executor);
        expect(await durableDelegate(ctx, "w-a", "delegate_to_fixer", fix(SERVICE_A))).toEqual({ pending: true });
        expect(await gatewayCall(l.session.id, "w-a")).toMatchObject({
          status: "waiting_budget",
          childRepository: SERVICE_A,
        });

        const secondA = await durableDelegate(ctx, "w-a2", "delegate_to_fixer", fix(SERVICE_A));
        expect(secondA).toEqual({ result: expect.stringContaining("for this repository") });
        expect(await durableDelegate(ctx, "w-b", "delegate_to_fixer", fix(SERVICE_B))).toEqual({ pending: true });
        expect(await gatewayCall(l.session.id, "w-b")).toMatchObject({
          status: "waiting_budget",
          childRepository: SERVICE_B,
        });

        await freeBudget(sibling.id);
        expect(await durableDelegate(ctx, "w-a", "delegate_to_fixer", fix(SERVICE_A))).toEqual({ pending: true });
        expect(ex.started).toHaveLength(1);
        expect(await repositoryOf(ex.started[0])).toBe(SERVICE_A);
      });

      it("counts a row written before repositories were recorded as the child's default", async () => {
        const { l } = await leadWithSibling();
        const ex = controlledExecutor();
        const ctx = ctxFor(l, ex.executor);
        await ledger.claim(l.session.id, "old", "builtin.call");
        await ledger.setDelegation(l.session.id, "old", { status: "waiting_budget", childAgentId: fixer });
        const toDefault = await durableDelegate(ctx, "w-d", "delegate_to_fixer", fix(DEFAULT));
        expect(toDefault).toEqual({ result: expect.stringContaining("for this repository") });
        expect(await durableDelegate(ctx, "w-a", "delegate_to_fixer", fix(SERVICE_A))).toEqual({ pending: true });
      });

      it("keeps its repository as it goes from waiting to started", async () => {
        const { l, sibling } = await leadWithSibling();
        const ex = controlledExecutor();
        const ctx = ctxFor(l, ex.executor);
        await durableDelegate(ctx, "w-a", "delegate_to_fixer", fix(SERVICE_A));
        await freeBudget(sibling.id);
        await durableDelegate(ctx, "w-a", "delegate_to_fixer", fix(SERVICE_A));
        expect(await gatewayCall(l.session.id, "w-a")).toMatchObject({
          status: "pending",
          childRunId: ex.started[0],
          childRepository: SERVICE_A,
        });
      });

      it("an unlink during the wait is the model's to report, and starts nothing", async () => {
        const { l, sibling } = await leadWithSibling();
        const ex = controlledExecutor();
        const ctx = ctxFor(l, ex.executor);
        await durableDelegate(ctx, "w-a", "delegate_to_fixer", fix(SERVICE_A));
        await setLinks([SERVICE_B]);
        await freeBudget(sibling.id);
        expect(await durableDelegate(ctx, "w-a", "delegate_to_fixer", fix(SERVICE_A))).toEqual({
          result: expect.stringContaining("repository_not_listed"),
        });
        expect(ex.started).toEqual([]);
      });
    });

    it("a repository unlinked after the pre-dispatch check is refused at dispatch, leaving no child", async () => {
      const l = await lead();
      const ex = controlledExecutor();
      const actual = await vi.importActual<typeof import("../core/dispatch.js")>("../core/dispatch.js");
      vi.mocked(dispatchRun).mockImplementationOnce(async (options) => {
        await setLinks([SERVICE_B]);
        return actual.dispatchRun(options);
      });
      const outcome = await durableDelegate(ctxFor(l, ex.executor), "t-1", "delegate_to_fixer", fix(SERVICE_A));
      expect(outcome).toEqual({ result: expect.stringContaining("repository_not_listed") });
      expect(ex.started).toEqual([]);
      expect(await db.run.count({ where: { parentRunId: l.run.id } })).toBe(0);
    });

    describe("continuing a pull request", () => {
      /** A finished run of the fixer that opened a pull request in `repository`. */
      async function openedIn(repository: string) {
        const root = await db.run.create({ data: { agentId: fixer, status: "succeeded", trigger: "manual" } });
        const headRef = `wardby/run-${root.id}`;
        await db.codingRun.create({
          data: {
            runId: root.id,
            task: "t",
            repository,
            baseRef: "main",
            headRef,
            provider: "codex",
            model: "gpt-5.6-luna",
            timeoutSec: 60,
            protectedPaths: [],
            budgetReservedUsd: 0.1,
            result: {
              schemaVersion: 1,
              outcome: "pull_request_opened",
              repository,
              baseRef: "main",
              headRef,
              commitSha: "a".repeat(40),
              pullRequestUrl: `https://github.com/${repository}/pull/22`,
              pullRequestNumber: 22,
              summary: "opened",
              tests: [],
              usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
            },
          },
        });
        return { rootId: root.id, headRef };
      }

      it("continues on a non-default repository without naming it", async () => {
        const { rootId, headRef } = await openedIn(SERVICE_A);
        const l = await lead();
        const ex = controlledExecutor();
        const outcome = await durableDelegate(
          ctxFor(l, ex.executor),
          "c-1",
          "delegate_to_fixer",
          fix(undefined, { continuePriorRun: rootId }),
        );
        expect(outcome).toEqual({ pending: true });
        expect(vi.mocked(dispatchRun).mock.lastCall?.[0]).toMatchObject({
          codingRepository: SERVICE_A,
          continuesCodingRunId: rootId,
          requireExplicitRepository: true,
        });
        expect(await db.codingRun.findUniqueOrThrow({ where: { runId: ex.started[0] } })).toMatchObject({
          repository: SERVICE_A,
          rootCodingRunId: rootId,
          headRef,
        });
        expect(await gatewayCall(l.session.id, "c-1")).toMatchObject({ childRepository: SERVICE_A });
      });

      it("refuses it once that repository's link is gone, starting nothing", async () => {
        const { rootId } = await openedIn(SERVICE_A);
        await setLinks([SERVICE_B]);
        const l = await lead();
        const ex = controlledExecutor();
        const outcome = await durableDelegate(
          ctxFor(l, ex.executor),
          "c-1",
          "delegate_to_fixer",
          fix(undefined, { continuePriorRun: rootId }),
        );
        expect(outcome).toEqual({ result: expect.stringContaining("continuation_refused") });
        expect(ex.started).toEqual([]);
        expect(await db.run.count({ where: { parentRunId: l.run.id } })).toBe(0);
      });
    });

    describe("across owners", () => {
      const foreignOwner = `dd-foreign-${tag}`;
      const hiddenNames = [DEFAULT, SERVICE_A, SERVICE_B];

      beforeAll(() => db.principal.create({ data: { id: foreignOwner, subject: foreignOwner } }).then(() => undefined));
      afterAll(() => db.principal.deleteMany({ where: { id: foreignOwner } }).then(() => undefined));

      /** Hands the fixer to another owner for one test, with or without the opt-in and the lead owner's grant. */
      async function asForeignChild(options: { optIn: boolean; grant?: boolean }, body: () => Promise<void>) {
        await db.agent.update({ where: { id: fixer }, data: { ownerId: foreignOwner } });
        await db.codingAgentProfile.update({
          where: { agentId: fixer },
          data: { allowWebhookTaskOverride: options.optIn },
        });
        if (options.grant ?? true) {
          await db.resourceGrant.create({
            data: {
              resourceType: "agent",
              resourceId: fixer,
              granteeKind: "principal",
              granteePrincipalId: ownerId,
              granteeKey: `principal:${ownerId}`,
              level: "execute",
              source: "owner",
            },
          });
        }
        try {
          await body();
        } finally {
          await db.resourceGrant.deleteMany({ where: { resourceType: "agent", resourceId: fixer } });
          await db.codingAgentProfile.update({ where: { agentId: fixer }, data: { allowWebhookTaskOverride: false } });
          await db.agent.update({ where: { id: fixer }, data: { ownerId } });
        }
      }
      const fixerTool = (l: Awaited<ReturnType<typeof lead>>) =>
        l.loaded.tools.find((t) => t.name === "delegate_to_fixer")!;

      it("loads no list for a child without the opt-in", async () => {
        await asForeignChild({ optIn: false }, async () => {
          const definition = JSON.stringify(fixerTool(await lead()));
          expect(definition).not.toContain('"repository"');
          for (const name of hiddenNames) expect(definition).not.toContain(name);
        });
      });

      it("loads no list for a child with the opt-in whose owner gave no execute access", async () => {
        await asForeignChild({ optIn: true, grant: false }, async () => {
          const definition = JSON.stringify(fixerTool(await lead()));
          expect(definition).toBe(JSON.stringify(delegateToolDef("fixer", false)));
          for (const name of hiddenNames) expect(definition).not.toContain(name);
        });
      });

      it("loads the list for a child with the opt-in", async () => {
        await asForeignChild({ optIn: true }, async () => {
          const { properties } = fixerTool(await lead()).jsonSchema as {
            properties: Record<string, { enum?: string[] }>;
          };
          expect(properties.repository.enum).toEqual([DEFAULT, SERVICE_A, SERVICE_B]);
        });
      });

      it("loads the list for a child of the same owner, opt-in or not", async () => {
        const { properties } = fixerTool(await lead()).jsonSchema as {
          properties: Record<string, { enum?: string[] }>;
        };
        expect(properties.repository.enum).toEqual([DEFAULT, SERVICE_A, SERVICE_B]);
      });

      it.each([
        ["naming a repository", () => fix(SERVICE_A)],
        ["naming none", () => fix()],
      ])("refuses a child without the opt-in, %s, without showing its list", async (_name, args) => {
        await asForeignChild({ optIn: false }, async () => {
          const l = await lead();
          const ex = controlledExecutor();
          const outcome = await durableDelegate(ctxFor(l, ex.executor), "x-1", "delegate_to_fixer", args());
          expect(outcome).toEqual({ result: expect.stringContaining("cross_owner_not_allowed") });
          for (const name of hiddenNames) expect(JSON.stringify(outcome)).not.toContain(name);
          expect(ex.started).toEqual([]);
          expect(await db.run.count({ where: { parentRunId: l.run.id } })).toBe(0);
        });
      });

      it("refuses a child whose owner gave no execute access, without showing its list", async () => {
        await asForeignChild({ optIn: true, grant: false }, async () => {
          const l = await lead();
          const ex = controlledExecutor();
          const outcome = await durableDelegate(ctxFor(l, ex.executor), "x-1", "delegate_to_fixer", fix(SERVICE_A));
          expect(outcome).toEqual({ result: expect.stringContaining("subagent_not_authorized") });
          for (const name of hiddenNames) expect(JSON.stringify(outcome)).not.toContain(name);
          expect(ex.started).toEqual([]);
        });
      });

      it("runs a child with the opt-in in the repository named", async () => {
        await asForeignChild({ optIn: true }, async () => {
          const l = await lead();
          const ex = controlledExecutor();
          expect(await durableDelegate(ctxFor(l, ex.executor), "x-1", "delegate_to_fixer", fix(SERVICE_A))).toEqual({
            pending: true,
          });
          expect(await repositoryOf(ex.started[0])).toBe(SERVICE_A);
        });
      });

      it("still requires a child with the opt-in to name its repository", async () => {
        await asForeignChild({ optIn: true }, async () => {
          const l = await lead();
          const ex = controlledExecutor();
          expect(await durableDelegate(ctxFor(l, ex.executor), "x-1", "delegate_to_fixer", fix())).toEqual({
            result: expect.stringContaining("repository_required"),
          });
          expect(ex.started).toEqual([]);
        });
      });

      it("refuses continuePriorRun even with the opt-in", async () => {
        await asForeignChild({ optIn: true }, async () => {
          const l = await lead();
          const ex = controlledExecutor();
          const outcome = await durableDelegate(
            ctxFor(l, ex.executor),
            "x-1",
            "delegate_to_fixer",
            fix(undefined, { continuePriorRun: "any-run" }),
          );
          expect(outcome).toEqual({ result: expect.stringContaining("cross_owner_not_allowed") });
          expect(ex.started).toEqual([]);
        });
      });
    });

    describe("masks the lead's secret values before validating", () => {
      const FAKE = `fake-secret-value-${tag}`;
      const secretId = `dd-repo-secret-${tag}`;
      const cipher = {
        keyId: () => "k",
        encrypt: async (v: string) => v,
        decrypt: async (v: string) => v,
      };
      async function withSecret(value: string, body: () => Promise<void>) {
        await db.secret.create({ data: { id: secretId, name: `repo-${tag}`, ciphertext: value, keyId: "k", ownerId } });
        await db.agentSecret.create({ data: { agentId: leadId, secretId, boundName: "API_KEY" } });
        try {
          await body();
        } finally {
          await db.agentSecret.deleteMany({ where: { agentId: leadId } });
          await db.secret.deleteMany({ where: { id: secretId } });
        }
      }
      const ctxWithCipher = (l: Awaited<ReturnType<typeof lead>>, executor: Executor) => ({
        ...ctxFor(l, executor),
        providers: { ...providersWith(executor), secrets: cipher },
      });

      it("refuses a secret value in repository, and neither stores nor echoes it", async () => {
        await withSecret(FAKE, async () => {
          const l = await lead();
          const ex = controlledExecutor();
          const outcome = await durableDelegate(
            ctxWithCipher(l, ex.executor),
            "s-1",
            "delegate_to_fixer",
            fix(`acme/${FAKE}`),
          );
          expect(outcome).toEqual({ result: expect.stringContaining("repository_not_listed") });
          expect(JSON.stringify(outcome)).not.toContain(FAKE);
          const row = await gatewayCall(l.session.id, "s-1");
          expect(row.childRepository).toBeNull();
          expect(JSON.stringify(row)).not.toContain(FAKE);
          expect(await db.run.count({ where: { parentRunId: l.run.id } })).toBe(0);
        });
      });

      it("validates the masked value: a secret that spells a listed repository is refused too", async () => {
        await withSecret(SERVICE_A, async () => {
          const l = await lead();
          const ex = controlledExecutor();
          const outcome = await durableDelegate(
            ctxWithCipher(l, ex.executor),
            "s-1",
            "delegate_to_fixer",
            fix(SERVICE_A),
          );
          expect(outcome).toEqual({ result: expect.not.stringContaining('"status"') });
          expect(ex.started).toEqual([]);
        });
      });
    });

    describe("a re-executed call finds its child before any repository check", () => {
      const orphanIn = async (parentRunId: string, callId: string, repository: string) => {
        const orphan = await db.run.create({
          data: {
            agentId: fixer,
            parentRunId,
            parentCallId: callId,
            trigger: "subagent",
            executionManaged: true,
            status: "succeeded",
            finalText: "orphan result",
          },
        });
        await db.codingRun.create({
          data: {
            runId: orphan.id,
            task: "t",
            repository,
            baseRef: "main",
            headRef: `wardby/run-${orphan.id}`,
            provider: "codex",
            model: "gpt-5.6-luna",
            timeoutSec: 60,
            protectedPaths: [],
            budgetReservedUsd: 0.1,
          },
        });
        return orphan;
      };

      it.each([
        ["its link removed, naming that repository", [SERVICE_B], true],
        ["every link removed", [], true],
        ["no repository named, which a new call would refuse", [SERVICE_A, SERVICE_B], false],
      ] as const)("adopts an unrecorded child with %s", async (_name, remaining, named) => {
        const l = await lead();
        const ex = controlledExecutor();
        await ledger.claim(l.session.id, "o-1", "builtin.call");
        await ledger.setDelegation(l.session.id, "o-1", { status: "pending", childAgentId: fixer });
        const orphan = await orphanIn(l.run.id, "o-1", SERVICE_A);
        await setLinks([...remaining]);
        const outcome = await durableDelegate(
          ctxFor(l, ex.executor),
          "o-1",
          "delegate_to_fixer",
          fix(named ? SERVICE_A : undefined),
        );
        expect(outcome).toEqual({ result: expect.stringContaining("orphan") });
        expect(ex.started).toEqual([]);
        expect(await db.run.findMany({ where: { parentRunId: l.run.id }, select: { id: true } })).toEqual([
          { id: orphan.id },
        ]);
      });

      it("keeps polling a recorded child after its link is removed", async () => {
        const l = await lead();
        const ex = controlledExecutor();
        const ctx = ctxFor(l, ex.executor);
        expect(await durableDelegate(ctx, "p-1", "delegate_to_fixer", fix(SERVICE_A))).toEqual({ pending: true });
        await setLinks([]);
        expect(await durableDelegate(ctx, "p-1", "delegate_to_fixer", fix(SERVICE_A))).toEqual({ pending: true });
        await ex.finishChild(ex.started[0], "done");
        expect(await durableDelegate(ctx, "p-1", "delegate_to_fixer", fix(SERVICE_A))).toEqual({
          result: expect.stringContaining('"status":"succeeded"'),
        });
        expect(ex.started).toHaveLength(1);
      });
    });
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
