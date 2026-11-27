/**
 * Routed delegation (#646, spec §4) against real PostgreSQL: the decision's start count (maxStartsPerDecision,
 * shared by a job and the jobs that continue it, counted on the root job), a native target without documentTools
 * refused, and a coding child of a routed run getting the job's documents as plan files, named and redacted the
 * way a builder gets an approved plan. Both admission sites: in process (executeRun) and the native gateway
 * (durableDelegate). Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { NativeEngine } from "../engine-native.js";
import {
  durableDelegate,
  executeRun,
  loadNativeRun,
  type LoadedNativeRun,
  type NativeRunProviders,
} from "../runner.js";
import type { Executor } from "../../providers/executor/types.js";
import type { LlmStreamEvent } from "../../providers/llm/types.js";
import type { Datastore } from "../../providers/datastore/types.js";
import { PrismaGatewayLedger } from "../../native-worker/ledger.js";
import { identityCipher, MODEL, noMemory, scriptedModel, usage } from "../../native-worker/fixtures.test-support.js";
import { countRoutedStart } from "./jobs.js";

const SECRET = "fake-routed-secret-4242";

describe.skipIf(!process.env.DATABASE_URL)("routed delegation limits (database)", { timeout: 30_000 }, () => {
  const db = createPrismaClient();
  const ledger = new PrismaGatewayLedger(db);
  const tag = randomUUID().slice(0, 8);
  const ownerId = `rl-owner-${tag}`;
  const routerId = `rl-router-${tag}`;
  const bareId = `rl-bare-${tag}`;
  const readerId = `rl-reader-${tag}`;
  const coderId = `rl-coder-${tag}`;
  const agentIds = [routerId, bareId, readerId, coderId];
  const readSetting = { access: "read", reviewers: [], finalApproverId: null, maxNewPerRun: 0, plans: [] };
  const documentIds: string[] = [];

  beforeAll(async () => {
    await db.principal.create({ data: { id: ownerId, subject: ownerId } });
    const base = { systemPrompt: "s", model: MODEL, budgetUsd: 1, maxTurns: 3, ownerId };
    await db.agent.create({
      data: { id: routerId, name: routerId, ...base, maxStartsPerDecision: 2, maxDelegationsPerRun: 10 },
    });
    await db.agent.create({ data: { id: bareId, name: bareId, ...base } });
    await db.agent.create({ data: { id: readerId, name: readerId, ...base, documentTools: readSetting } });
    await db.agent.create({
      data: {
        id: coderId,
        name: coderId,
        ...base,
        model: "gpt-5.6-luna",
        kind: "coding",
        codingProfile: {
          create: {
            provider: "codex",
            repository: `acme/routed-${tag}`,
            protectedPaths: [],
            allowWebhookTaskOverride: true,
          },
        },
      },
    });
    await db.agentSubAgent.createMany({
      data: [
        { parentAgentId: routerId, childAgentId: bareId, boundName: "bare" },
        { parentAgentId: routerId, childAgentId: readerId, boundName: "reader" },
        { parentAgentId: routerId, childAgentId: coderId, boundName: "coder" },
      ],
    });
    await db.secret.create({
      data: { id: `rl-secret-${tag}`, name: `rl-${tag}`, ciphertext: SECRET, keyId: "k", ownerId },
    });
    await db.agentSecret.create({ data: { agentId: coderId, secretId: `rl-secret-${tag}`, boundName: "KEY" } });
  });

  afterAll(async () => {
    const runs = await db.run.findMany({ where: { agentId: { in: agentIds } }, select: { id: true } });
    const ids = runs.map((r) => r.id);
    await db.reviewJob.deleteMany({ where: { routerAgentId: routerId } });
    await db.runDocumentGrant.deleteMany({ where: { runId: { in: ids } } });
    await db.codingRunPlanFile.deleteMany({ where: { runId: { in: ids } } });
    await db.codingRunRepository.deleteMany({ where: { runId: { in: ids } } });
    await db.codingRun.deleteMany({ where: { runId: { in: ids } } });
    await db.runAttribution.deleteMany({ where: { runId: { in: ids } } });
    await db.runModelUsage.deleteMany({ where: { runId: { in: ids } } });
    await db.run.updateMany({ where: { id: { in: ids } }, data: { parentRunId: null } });
    await db.run.deleteMany({ where: { id: { in: ids } } });
    await db.document.updateMany({ where: { id: { in: documentIds } }, data: { currentVersionId: null } });
    await db.document.deleteMany({ where: { id: { in: documentIds } } });
    await db.agentSecret.deleteMany({ where: { agentId: coderId } });
    await db.secret.deleteMany({ where: { id: `rl-secret-${tag}` } });
    await db.agentSubAgent.deleteMany({ where: { parentAgentId: routerId } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.principal.deleteMany({ where: { id: ownerId } });
    await db.$disconnect();
  });

  /** A job whose router run is `runId`; `rootJobId` makes it continue another job. */
  const job = (runId: string, rootJobId: string | null = null, startsUsed = 0) =>
    db.reviewJob.create({
      data: {
        reviewEventId: `rl-ev-${randomUUID()}`,
        routerAgentId: routerId,
        routerRunId: runId,
        rootJobId,
        startsUsed,
        outcome: "started",
      },
    });
  const routerRun = (data: Record<string, unknown> = {}) => db.run.create({ data: { agentId: routerId, ...data } });

  /** A Markdown document with one current version, granted to `runId`. */
  async function grantedDocument(runId: string, markdown: string, names: { planPath?: string; path?: string } = {}) {
    const doc = await db.document.create({ data: { title: "Epic", ownerId, ...names } });
    documentIds.push(doc.id);
    const version = await db.documentVersion.create({
      data: { documentId: doc.id, number: 1, markdown, contentHash: "h", via: "agent" },
    });
    await db.document.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
    await db.runDocumentGrant.create({ data: { runId, documentId: doc.id } });
    return doc.id;
  }

  describe("countRoutedStart", () => {
    it("counts up to maxStartsPerDecision, then refuses and records it; a child run and a continuing job share it", async () => {
      const r = await routerRun();
      const first = await job(r.id);
      expect(await countRoutedStart(db, r.id)).toBeNull();
      expect(await countRoutedStart(db, r.id)).toBeNull();
      const refused = await countRoutedStart(db, r.id);
      expect(refused).not.toBeNull();
      expect(JSON.parse(refused!.refusal)).toEqual({
        error: "review_route_limit",
        message:
          "This decision has already started the most agents its router allows (maxStartsPerDecision). A person's next review action starts a new count.",
      });
      expect(await db.reviewJob.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({
        startsUsed: 2,
        outcome: "review_route_limit",
      });

      // A run below the router run belongs to the same job.
      const child = await db.run.create({ data: { agentId: readerId, parentRunId: r.id } });
      expect(await countRoutedStart(db, child.id)).toEqual({ refusal: expect.stringContaining("review_route_limit") });

      // A job continuing the first counts on the first (the root).
      const r2 = await routerRun();
      const continuing = await job(r2.id, first.id);
      expect(await countRoutedStart(db, r2.id)).toEqual({ refusal: expect.stringContaining("review_route_limit") });
      expect((await db.reviewJob.findUniqueOrThrow({ where: { id: continuing.id } })).startsUsed).toBe(0);
      expect((await db.reviewJob.findUniqueOrThrow({ where: { id: first.id } })).startsUsed).toBe(2);
    });

    it("a continuing job's starts count on the root's, so both see the same remaining count", async () => {
      const r = await routerRun();
      const root = await job(r.id);
      const r2 = await routerRun();
      await job(r2.id, root.id);
      expect(await countRoutedStart(db, r2.id)).toBeNull();
      expect(await countRoutedStart(db, r.id)).toBeNull();
      expect(await countRoutedStart(db, r2.id)).toEqual({ refusal: expect.stringContaining("review_route_limit") });
      expect((await db.reviewJob.findUniqueOrThrow({ where: { id: root.id } })).startsUsed).toBe(2);
    });

    it("a refused start keeps a job that already started an agent as started; one that started none records the limit", async () => {
      const r = await routerRun();
      const busy = await job(r.id, null, 2);
      await db.run.create({ data: { agentId: readerId, parentRunId: r.id } });
      expect(await countRoutedStart(db, r.id)).toEqual({ refusal: expect.stringContaining("review_route_limit") });
      expect((await db.reviewJob.findUniqueOrThrow({ where: { id: busy.id } })).outcome).toBe("started");
      const idle = await routerRun();
      const none = await job(idle.id, null, 2);
      expect(await countRoutedStart(db, idle.id)).toEqual({ refusal: expect.stringContaining("review_route_limit") });
      expect((await db.reviewJob.findUniqueOrThrow({ where: { id: none.id } })).outcome).toBe("review_route_limit");
    });

    it("a run that belongs to no job has no limit", async () => {
      const r = await routerRun();
      for (let i = 0; i < 4; i++) expect(await countRoutedStart(db, r.id)).toBeNull();
    });
  });

  describe("the native gateway (durableDelegate)", () => {
    /** An Executor whose runs never finish: a dispatched child stays pending. */
    function idleExecutor() {
      const started: string[] = [];
      const executor: Executor = {
        async start(runId) {
          started.push(runId);
        },
        async stop() {},
      };
      return { executor, started };
    }
    const providersWith = (executor: Executor): NativeRunProviders => ({
      llm: scriptedModel([]).llm,
      engine: new NativeEngine(),
      datastore: {} as Datastore,
      secrets: identityCipher,
      memory: noMemory,
      executor,
    });

    async function sandboxedRouter(startsUsed: number | null) {
      const run = await routerRun({ status: "running", nativeExecutionMode: "sandbox", executionManaged: true });
      const jobRow = startsUsed === null ? null : await job(run.id, null, startsUsed);
      const ex = idleExecutor();
      const loaded = (await loadNativeRun({
        runId: run.id,
        existingRun: run,
        providers: providersWith(ex.executor),
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
      const ctx = {
        runId: run.id,
        existingRun: run,
        loaded,
        providers: providersWith(ex.executor),
        db,
        issueTrackers: undefined,
        ledger,
        sessionId: session.id,
        pollWindowMs: 50,
        pollIntervalMs: 10,
      };
      return { run, job: jobRow, ctx, started: ex.started };
    }
    const task = JSON.stringify({ task: "look at the epic" });

    it("refuses a native child without documentTools, starting nothing and counting nothing", async () => {
      const r = await sandboxedRouter(0);
      await grantedDocument(r.run.id, "# Epic\n");
      const outcome = await durableDelegate(r.ctx, "g-1", "delegate_to_bare", task);
      expect(outcome).toEqual({
        result: JSON.stringify({
          error: "review_route_target_no_documents",
          message:
            "This agent cannot read documents (it has no documentTools), so it cannot take work routed from a review. Give it documentTools or start another agent.",
        }),
      });
      expect(r.started).toEqual([]);
      expect(await db.run.count({ where: { parentRunId: r.run.id } })).toBe(0);
      expect((await db.reviewJob.findUniqueOrThrow({ where: { id: r.job!.id } })).startsUsed).toBe(0);
    });

    it("counts a start, then refuses past maxStartsPerDecision", async () => {
      const r = await sandboxedRouter(1);
      expect(await durableDelegate(r.ctx, "g-1", "delegate_to_reader", task)).toEqual({ pending: true });
      expect(r.started).toHaveLength(1);
      expect((await db.reviewJob.findUniqueOrThrow({ where: { id: r.job!.id } })).startsUsed).toBe(2);
      const refused = await durableDelegate(r.ctx, "g-2", "delegate_to_coder", task);
      expect(refused).toEqual({ result: expect.stringContaining('"error":"review_route_limit"') });
      expect(r.started).toHaveLength(1);
      // The job started an agent: it stays started (the refusal went back to the router as the tool's result).
      expect((await db.reviewJob.findUniqueOrThrow({ where: { id: r.job!.id } })).outcome).toBe("started");
    });

    it("a job whose router run was given no documents (request_work) may start a native child without documentTools", async () => {
      const r = await sandboxedRouter(0);
      expect(await durableDelegate(r.ctx, "g-1", "delegate_to_bare", task)).toEqual({ pending: true });
      expect(r.started).toHaveLength(1);
      // Still a start of the decision: counted.
      expect((await db.reviewJob.findUniqueOrThrow({ where: { id: r.job!.id } })).startsUsed).toBe(1);
    });

    it("leaves an unrouted run's delegation as it was: a native child without documentTools starts", async () => {
      const r = await sandboxedRouter(null);
      expect(await durableDelegate(r.ctx, "g-1", "delegate_to_bare", task)).toEqual({ pending: true });
      expect(r.started).toHaveLength(1);
    });

    it("gives a coding child the job's documents as plan files, named as a builder's and redacted", async () => {
      const r = await sandboxedRouter(0);
      await grantedDocument(r.run.id, `# Plan\nkey ${SECRET}\n`, { planPath: "plan.md" });
      const unnamed = await grantedDocument(r.run.id, "# Epic\n");
      expect(await durableDelegate(r.ctx, "g-1", "delegate_to_coder", task)).toEqual({ pending: true });
      const files = await db.codingRunPlanFile.findMany({
        where: { runId: r.started[0], direction: "input" },
        orderBy: { path: "asc" },
        select: { path: true, content: true },
      });
      expect(files.map((f) => f.path).sort()).toEqual([`${unnamed}.md`, "plan.md"].sort());
      expect(JSON.stringify(files)).not.toContain(SECRET);
      expect(files.find((f) => f.path === `${unnamed}.md`)?.content).toBe("# Epic\n");
    });

    it("gives no routed files when the call names a planNumber", async () => {
      const r = await sandboxedRouter(0);
      await grantedDocument(r.run.id, "# Plan\n", { planPath: "plan.md" });
      const args = JSON.stringify({ task: "plan it", planNumber: 7 });
      expect(await durableDelegate(r.ctx, "g-1", "delegate_to_coder", args)).toEqual({ pending: true });
      expect(await db.codingRunPlanFile.count({ where: { runId: r.started[0] } })).toBe(0);
    });
  });

  describe("in process (executeRun)", () => {
    const call = (id: string, bound: string, args: unknown = { task: "look at the epic" }): LlmStreamEvent[] => [
      { type: "tool_call", id, name: `delegate_to_${bound}`, argsJson: JSON.stringify(args) },
      { type: "done", stopReason: "tool_use", usage: usage(100, 10) },
    ];
    const say = (text: string): LlmStreamEvent[] => [
      { type: "text", delta: text },
      { type: "done", stopReason: "end_turn", usage: usage(100, 5) },
    ];
    /** An Executor that finishes a coding child as soon as it starts. */
    const finishingExecutor = (started: string[]): Executor => ({
      async start(runId) {
        started.push(runId);
        await db.run.update({
          where: { id: runId },
          data: { status: "succeeded", finalText: "ok", finishedAt: new Date() },
        });
      },
      async stop() {},
    });

    async function run(turns: LlmStreamEvent[][], startsUsed: number, documents?: (runId: string) => Promise<void>) {
      const { llm, requests } = scriptedModel(turns);
      const started: string[] = [];
      const providers: NativeRunProviders = {
        llm,
        engine: new NativeEngine(),
        datastore: {} as Datastore,
        secrets: identityCipher,
        memory: noMemory,
        executor: finishingExecutor(started),
      };
      const r = await routerRun({ trigger: "manual", nativeExecutionMode: "control_plane" });
      const jobRow = await job(r.id, null, startsUsed);
      await documents?.(r.id);
      const finished = await executeRun(r.id, providers, db, () => {});
      const toolResults = requests.flatMap((q) =>
        q.messages.filter((m) => m.role === "tool").map((m) => String(m.content)),
      );
      return { finished, toolResults, job: jobRow, runId: r.id, started };
    }

    it("refuses a native child without documentTools and a start past the limit, as tool results", async () => {
      const out = await run([call("c1", "bare"), call("c2", "reader"), say("done")], 2, async (runId) => {
        await grantedDocument(runId, "# Epic\n");
      });
      expect(out.finished.status).toBe("succeeded");
      expect(out.toolResults[0]).toContain("review_route_target_no_documents");
      expect(out.toolResults.at(-1)).toContain("review_route_limit");
      expect(await db.run.count({ where: { parentRunId: out.runId } })).toBe(0);
    });

    it("counts a native child's start", async () => {
      const out = await run([call("c1", "reader"), say("child read it"), say("done")], 0);
      expect(out.finished.status).toBe("succeeded");
      expect(await db.run.count({ where: { parentRunId: out.runId } })).toBe(1);
      expect((await db.reviewJob.findUniqueOrThrow({ where: { id: out.job.id } })).startsUsed).toBe(1);
    });

    it("gives a coding child the job's documents as plan files", async () => {
      let docId = "";
      const out = await run([call("c1", "coder"), say("done")], 0, async (runId) => {
        docId = await grantedDocument(runId, `# Design\n${SECRET}\n`, { path: "docs/epic.md" });
      });
      expect(out.finished.status).toBe("succeeded");
      expect(out.started).toHaveLength(1);
      const files = await db.codingRunPlanFile.findMany({ where: { runId: out.started[0], direction: "input" } });
      expect(files.map((f) => f.path)).toEqual(["docs/epic.md"]);
      expect(files[0].content).toContain("# Design\n");
      expect(files[0].content).not.toContain(SECRET);
      expect(docId).not.toBe("");
    });
  });
});
