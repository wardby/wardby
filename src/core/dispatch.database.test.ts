/**
 * A coding run's repository set (#537) against real PostgreSQL: dispatch writes the
 * CodingRunRepository rows in the same transaction as the CodingRun, each extra authorized
 * through the repository-access gate before its ref is resolved. The executor is a fake; the gate
 * is the real one, with a fixed GitHub allowlist. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Executor } from "../providers/executor/types.js";
import { RepositoryRefUnreadableError, RepositorySetRefusedError } from "./coding-repository-set.js";
import { createPrismaClient } from "./db.js";
import { setLogLineFilter } from "./logger.js";
import { checkContinuation, ContinuationRefusedError, dispatchRun } from "./dispatch.js";
import { loadPlanFiles } from "../coding/plan-files/store.js";
import { MAX_CODING_TASK_BYTES, PLAN_FOLDER_PATH } from "../coding/protocol.js";
import { PlanRefusedError } from "./plans/refusal.js";
import { createPlanSetFixture, setReviewState } from "./plans/build.test-support.js";
import { createRepoAccessGate } from "./repo-access.js";
import { claimDueRun, findDueCandidates } from "./scheduler.js";

const BASE_SHA = "c".repeat(40);
const MAIN_SHA = "d".repeat(40);
const FAKE_TOKEN = "ghs_FAKEtoken0123456789abcdefABCDEF";

describe.skipIf(!process.env.DATABASE_URL)("dispatchRun repository set (database)", () => {
  const db = createPrismaClient();
  const PREFIX = "drsdb-";
  const suffix = randomUUID().slice(0, 8);
  const owner = `${PREFIX}owner-${suffix}`;
  let counter = 0;
  /** The served GitHub accounts: `acme` only. */
  const gate = createRepoAccessGate({ db: {} as never, hosts: {}, trustedAccounts: async () => new Set(["acme"]) });

  function fakeExecutor(refFile: string | null = BASE_SHA) {
    const spies = {
      authorizeCodingRepository: vi.fn((input: Parameters<typeof gate.authorizeUse>[0]) => gate.authorizeUse(input)),
      readCodingRepositoryFile: vi.fn(async () => refFile),
      // `main` names MAIN_SHA; a SHA names itself; anything else does not exist.
      resolveCodingRepositoryRef: vi.fn(async ({ ref }: { ref: string }) =>
        ref === "main" ? MAIN_SHA : /^[0-9a-f]{40}$/.test(ref) ? ref : null,
      ),
    };
    const executor: Executor = { start: vi.fn(async () => {}), async stop() {}, ...spies };
    return { executor, spies };
  }

  /** A coding agent with read links `base` (ref file upstream-sync) and `upstream` (ref main), both in its default set. */
  async function codingAgent(links: { upstreamRepository?: string } = {}) {
    const agentId = `${PREFIX}agent-${suffix}-${++counter}`;
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        systemPrompt: "Sync things.",
        model: "gpt-5.6-luna",
        budgetUsd: 2,
        kind: "coding",
        ownerId: owner,
        codingProfile: {
          create: { provider: "codex", repository: "acme/fork", defaultTask: "Sync.", protectedPaths: [] },
        },
      },
    });
    const base = await db.agentRepository.create({
      data: {
        agentId,
        name: "base",
        provider: "github",
        repository: `acme/base-${suffix}-${counter}`,
        access: "read",
        refFromFile: "upstream-sync",
        inDefaultSet: true,
        authorizedVia: "admin",
        createdAt: new Date(1_000),
      },
    });
    const upstream = await db.agentRepository.create({
      data: {
        agentId,
        name: "upstream",
        provider: "github",
        repository: links.upstreamRepository ?? `acme/upstream-${suffix}-${counter}`,
        access: "read",
        ref: "main",
        inDefaultSet: true,
        authorizedVia: "admin",
        createdAt: new Date(2_000),
      },
    });
    return { agentId, base, upstream };
  }

  const rowsOf = (runId: string) => db.codingRunRepository.findMany({ where: { runId }, orderBy: { position: "asc" } });
  const runsOf = (agentId: string) => db.run.findMany({ where: { agentId } });

  async function cleanup(): Promise<void> {
    const agents = { agentId: { startsWith: PREFIX } };
    await db.run.deleteMany({ where: agents });
    await db.document.deleteMany({ where: { ownerId: { startsWith: PREFIX } } });
    await db.workItem.deleteMany({ where: { provider: "jira", scopeKey: { startsWith: `T${suffix}` } } });
    await db.agent.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await db.principal.deleteMany({ where: { id: { startsWith: PREFIX } } });
  }

  beforeAll(async () => {
    await cleanup();
    await db.principal.create({ data: { id: owner, subject: owner } });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("writes the default set's rows, the file's ref resolved and the link's ref resolved", async () => {
    const { agentId, base, upstream } = await codingAgent();
    const { executor, spies } = fakeExecutor();
    const result = await dispatchRun({ db, executor, agentId, codingTask: "sync" });

    expect(spies.readCodingRepositoryFile).toHaveBeenCalledWith(
      expect.objectContaining({ repository: "acme/fork", baseRef: "main", path: "upstream-sync" }),
    );
    expect(await rowsOf(result!.run.id)).toEqual([
      expect.objectContaining({
        position: 0,
        name: "base",
        requestedRef: BASE_SHA,
        refFromFile: "upstream-sync",
        resolvedSha: BASE_SHA,
        access: "read",
        linkId: base.id,
        baseRef: null,
        headRef: null,
        viaRepositoryLink: true,
      }),
      expect.objectContaining({
        position: 1,
        name: "upstream",
        requestedRef: "main",
        refFromFile: null,
        resolvedSha: MAIN_SHA,
        linkId: upstream.id,
      }),
    ]);
  });

  it("writes no rows for repositories: []", async () => {
    const { agentId } = await codingAgent();
    const { executor, spies } = fakeExecutor();
    const result = await dispatchRun({ db, executor, agentId, codingTask: "sync", codingRepositories: [] });
    expect(await rowsOf(result!.run.id)).toEqual([]);
    expect(spies.resolveCodingRepositoryRef).not.toHaveBeenCalled();
  });

  it("stores a coding run's input plan files and its collectPlanFiles flag", async () => {
    const { agentId } = await codingAgent();
    const { executor } = fakeExecutor();
    const result = await dispatchRun({
      db,
      executor,
      agentId,
      codingTask: "sync",
      planInputFiles: [{ path: "plan.md", content: "# P" }],
      collectPlanFiles: true,
    });
    const runId = result!.run.id;
    expect((await db.codingRun.findUniqueOrThrow({ where: { runId } })).collectPlanFiles).toBe(true);
    expect(await loadPlanFiles(db, runId, "input")).toEqual([{ path: "plan.md", content: "# P" }]);
  });

  it("refuses input plan files over the limit before anything is created", async () => {
    const { agentId } = await codingAgent();
    const { executor } = fakeExecutor();
    const files = Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.md`, content: "x" }));
    const attempt = dispatchRun({ db, executor, agentId, codingTask: "sync", planInputFiles: files });
    await expect(attempt).rejects.toBeInstanceOf(PlanRefusedError);
    await expect(attempt).rejects.toThrow("plan_too_large");
    expect(await runsOf(agentId)).toEqual([]);
  });

  describe("plan numbers", () => {
    async function planner() {
      const { agentId } = await codingAgent();
      await db.codingAgentProfile.update({
        where: { agentId },
        data: { planDocument: { store: "wardby", reviewers: [owner] } },
      });
      return agentId;
    }

    it("refuses a planner with no number, leaving no run", async () => {
      const agentId = await planner();
      const { executor } = fakeExecutor();
      await expect(dispatchRun({ db, executor, agentId, codingTask: "plan" })).rejects.toThrow("plan_number_missing");
      expect(await runsOf(agentId)).toEqual([]);
    });

    it("stores planNumber from the call", async () => {
      const agentId = await planner();
      const { executor } = fakeExecutor();
      const result = await dispatchRun({ db, executor, agentId, codingTask: "plan", planNumber: 7 });
      expect((await db.codingRun.findUniqueOrThrow({ where: { runId: result!.run.id } })).planNumber).toBe(7);
    });

    it("reads the number from the attribution intent", async () => {
      const agentId = await planner();
      const { executor } = fakeExecutor();
      const result = await dispatchRun({
        db,
        executor,
        agentId,
        codingTask: "plan",
        attribution: {
          source: "issue_event",
          item: { provider: "github", key: "o/r#12", scopeKey: "o/r", snapshot: null },
        },
      });
      expect((await db.codingRun.findUniqueOrThrow({ where: { runId: result!.run.id } })).planNumber).toBe(12);
    });

    it("reads the number from the parent run's issue (delegated)", async () => {
      const agentId = await planner();
      const parentId = `${PREFIX}parent-${suffix}-${++counter}`;
      const parentAgent = `${PREFIX}pagent-${suffix}-${counter}`;
      await db.agent.create({
        data: {
          id: parentAgent,
          name: parentAgent,
          systemPrompt: "p",
          model: "gpt-5.6-luna",
          budgetUsd: 1,
          ownerId: owner,
        },
      });
      await db.run.create({ data: { id: parentId, agentId: parentAgent, trigger: "manual", status: "running" } });
      const item = await db.workItem.create({
        data: { provider: "jira", key: `T${suffix.toUpperCase()}-345`, scopeKey: `T${suffix}` },
      });
      await db.runAttribution.create({ data: { runId: parentId, workItemId: item.id, source: "issue_event" } });
      const { executor } = fakeExecutor();
      const result = await dispatchRun({ db, executor, agentId, codingTask: "plan", parentRunId: parentId });
      expect((await db.codingRun.findUniqueOrThrow({ where: { runId: result!.run.id } })).planNumber).toBe(345);
    });

    it("keeps an explicit planNumber across a continuation that has no issue", async () => {
      const agentId = await planner();
      const { executor } = fakeExecutor();
      const first = await dispatchRun({ db, executor, agentId, codingTask: "plan", planNumber: 9 });
      await db.run.update({ where: { id: first!.run.id }, data: { status: "succeeded" } });
      await db.codingRun.update({
        where: { runId: first!.run.id },
        data: {
          result: {
            schemaVersion: 1,
            outcome: "pull_request_opened",
            repository: "acme/fork",
            baseRef: "main",
            headRef: `wardby/run-${first!.run.id}`,
            commitSha: "a".repeat(40),
            pullRequestUrl: "https://github.com/acme/fork/pull/1",
            pullRequestNumber: 1,
            summary: "Opened the PR",
            tests: [],
            usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
          },
        },
      });
      const second = await dispatchRun({
        db,
        executor,
        agentId,
        codingTask: "plan",
        continuesCodingRunId: first!.run.id,
      });
      expect((await db.codingRun.findUniqueOrThrow({ where: { runId: second!.run.id } })).planNumber).toBe(9);
    });

    it("treats a malformed stored planDocument as no plan setting", async () => {
      const { agentId } = await codingAgent();
      await db.codingAgentProfile.update({ where: { agentId }, data: { planDocument: { store: 42 } } });
      const { executor } = fakeExecutor();
      const result = await dispatchRun({ db, executor, agentId, codingTask: "plan" });
      expect(result!.run.status).not.toBe("refused");
      expect((await db.codingRun.findUniqueOrThrow({ where: { runId: result!.run.id } })).planNumber).toBeNull();
    });

    describe("planner task note", () => {
      const WRITE = /Write plan/;
      async function run(
        planDocument: object,
        extra: Partial<Parameters<typeof dispatchRun>[0]> = {},
        deferred = false,
      ) {
        const { agentId } = await codingAgent();
        await db.codingAgentProfile.update({ where: { agentId }, data: { planDocument } });
        const { executor } = fakeExecutor();
        if (deferred) (executor as { defersCodingResolution?: boolean }).defersCodingResolution = true;
        const result = await dispatchRun({ db, executor, agentId, codingTask: "plan it", planNumber: 12, ...extra });
        return db.codingRun.findUniqueOrThrow({ where: { runId: result!.run.id } });
      }

      it("a wardby-store planner's task and request carry the plan folder, and it collects files", async () => {
        const row = await run({ store: "wardby", reviewers: [owner] });
        expect(row.task).toContain(PLAN_FOLDER_PATH);
        expect(row.request).toContain(PLAN_FOLDER_PATH);
        expect(row.collectPlanFiles).toBe(true);
        expect(row.planRepositoryPath).toBeNull();
      });

      it("a repository-store planner records the folder and does not collect files", async () => {
        const row = await run({ store: "repository", path: "docs/plans/issue-{n}/", reviewers: [owner] });
        expect(row.planRepositoryPath).toBe("docs/plans/issue-12/");
        expect(row.collectPlanFiles).toBe(false);
        expect(row.request).toContain("docs/plans/issue-12/");
      });

      it("a deferred executor's stored request holds the note", async () => {
        const row = await run({ store: "wardby", reviewers: [owner] }, {}, true);
        expect(row.request).toContain(PLAN_FOLDER_PATH);
      });

      it("a revision (planInputFiles) adds no planner note and collects files", async () => {
        const row = await run(
          { store: "wardby", reviewers: [owner] },
          { planInputFiles: [{ path: "plan.md", content: "# P" }] },
        );
        expect(row.request).not.toMatch(WRITE);
        expect(row.collectPlanFiles).toBe(true);
      });
    });

    it("refuses a planner whose note overflows the task limit, leaving no run", async () => {
      const agentId = await planner();
      const { executor } = fakeExecutor();
      const attempt = dispatchRun({
        db,
        executor,
        agentId,
        codingTask: "x".repeat(MAX_CODING_TASK_BYTES),
        planNumber: 3,
      });
      await expect(attempt).rejects.toBeInstanceOf(PlanRefusedError);
      await expect(attempt).rejects.toThrow("plan_too_large");
      expect(await runsOf(agentId)).toEqual([]);
    });

    it("commits a refused run for a scheduled planner whose note overflows the task limit", async () => {
      const agentId = await planner();
      const { executor } = fakeExecutor();
      const result = await dispatchRun({
        db,
        executor,
        agentId,
        codingTask: "x".repeat(MAX_CODING_TASK_BYTES),
        planNumber: 3,
        trigger: "scheduled",
      });
      expect(result!.run.status).toBe("refused");
      expect(result!.run.error).toMatch(/^plan_too_large:/);
    });

    it("commits a refused run for a scheduled planner with no number", async () => {
      const agentId = await planner();
      const { executor } = fakeExecutor();
      const result = await dispatchRun({ db, executor, agentId, codingTask: "plan", trigger: "scheduled" });
      expect(result!.run.status).toBe("refused");
      expect(result!.run.error).toMatch(/^plan_number_missing:/);
    });
  });

  describe("building from an approved plan", () => {
    const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
    const PLAN_MD = "# Plan\n\nSee [api](api.md).\n\n## Tickets\n### Ticket 1: Login\n### Ticket 2: Feed\n";
    const SCREENS = { "manifest.json": '{"boards":[{"id":"home"}]}', "boards/home.html": "<main>Home</main>" };

    /** A planner and a buildFromPlan builder on their own repository, and plan set #12 with api.md in review. */
    async function setUp(setRepository: (repository: string) => string = (r) => r) {
      const repository = `acme/build-${suffix}-${++counter}`;
      const make = async (profile: object) => {
        const id = `${PREFIX}agent-${suffix}-${++counter}`;
        await db.agent.create({
          data: {
            id,
            name: id,
            systemPrompt: "Build things.",
            model: "gpt-5.6-luna",
            budgetUsd: 2,
            kind: "coding",
            ownerId: owner,
            codingProfile: {
              create: { provider: "codex", repository, defaultTask: "Build.", protectedPaths: [], ...profile },
            },
          },
        });
        return id;
      };
      const planner = await make({ planDocument: { store: "wardby", reviewers: [owner] } });
      const builder = await make({ buildFromPlan: true });
      const { planSetId, documentIds } = await createPlanSetFixture(db, {
        plannerId: planner,
        ownerId: owner,
        repository: setRepository(repository),
        number: 12,
        documents: [
          { path: "plan.md", content: PLAN_MD, version: 3 },
          { path: "screens/", content: SCREENS, version: 2 },
          { path: "api.md", content: "# API\n", version: 1, reviewState: "in_review" },
        ],
      });
      const approveAll = () => setReviewState(db, documentIds["api.md"], "approved");
      return { repository, builder, planSetId, documentIds, approveAll };
    }
    const codingRunOf = (runId: string) => db.codingRun.findUniqueOrThrow({ where: { runId } });
    /** Marks a root run finished with an opened pull request, so it can be continued. */
    async function finishWithPullRequest(rootId: string, repository: string): Promise<void> {
      await db.run.update({ where: { id: rootId }, data: { status: "succeeded" } });
      await db.codingRun.update({
        where: { runId: rootId },
        data: {
          result: {
            schemaVersion: 1,
            outcome: "pull_request_opened",
            repository,
            baseRef: "main",
            headRef: `wardby/run-${rootId}`,
            commitSha: "a".repeat(40),
            pullRequestUrl: `https://github.com/${repository}/pull/5`,
            pullRequestNumber: 5,
            summary: "Opened the PR",
            tests: [],
            usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
          },
        },
      });
    }

    it("refuses while a document waits, leaving no run; a scheduled build commits a refused run", async () => {
      const { builder } = await setUp();
      const { executor } = fakeExecutor(null);
      const attempt = dispatchRun({ db, executor, agentId: builder, planNumber: 12, secretCipher: cipher });
      await expect(attempt).rejects.toBeInstanceOf(PlanRefusedError);
      await expect(attempt).rejects.toThrow(/^plan_not_approved: .*api\.md/);
      expect(await runsOf(builder)).toEqual([]);

      const scheduled = await dispatchRun({
        db,
        executor,
        agentId: builder,
        planNumber: 12,
        secretCipher: cipher,
        trigger: "scheduled",
      });
      expect(scheduled!.run.status).toBe("refused");
      expect(scheduled!.run.error).toMatch(/^plan_not_approved:/);
      expect(await db.codingRun.findUnique({ where: { runId: scheduled!.run.id } })).toBeNull();
    });

    it("builds from the approved versions: plan set, versions, ticket, plan section and files on the run", async () => {
      const { builder, planSetId, documentIds, approveAll } = await setUp();
      await approveAll();
      const { executor } = fakeExecutor(null);
      const result = await dispatchRun({
        db,
        executor,
        agentId: builder,
        codingTask: "Build ticket 2.",
        planNumber: 12,
        planTicket: 2,
        secretCipher: cipher,
      });
      expect(result!.run.status).not.toBe("refused");
      const row = await codingRunOf(result!.run.id);
      expect(row.planSetId).toBe(planSetId);
      expect(row.planNumber).toBe(12);
      expect(row.planTicket).toBe(2);
      expect(row.planVersions).toEqual([
        { documentId: documentIds["plan.md"], path: "plan.md", kind: "document", versionNumber: 3 },
        { documentId: documentIds["api.md"], path: "api.md", kind: "document", versionNumber: 1 },
        { documentId: documentIds["screens/"], path: "screens/", kind: "design", versionNumber: 2 },
      ]);
      expect(row.collectPlanFiles).toBe(false);
      for (const text of [row.request!, row.task]) {
        expect(text).toContain("Build ticket 2.");
        expect(text).toContain("Approved plan 12. Build exactly ticket 2 from this approved plan.");
        expect(text).toMatch(/<plan>\n[\s\S]*\[api\]\(\/tmp\/wardby-plan\/api\.md\)[\s\S]*\n<\/plan>/);
      }
      expect((await loadPlanFiles(db, result!.run.id, "input")).map((f) => f.path)).toEqual([
        "api.md",
        "plan.md",
        "screens/boards/home.html",
        "screens/manifest.json",
      ]);
    });

    it("keeps the whole plan section in the task beside a knowledge index (never cut)", async () => {
      const { builder, approveAll } = await setUp();
      await approveAll();
      const { executor } = fakeExecutor(null);
      // A large bundle index: the knowledge slot is cut to fit, the plan section is not.
      executor.readCodingRepositoryFile = vi.fn(async ({ path }: { path: string }) =>
        path.endsWith("index.md") ? `# Knowledge\n${"k".repeat(MAX_CODING_TASK_BYTES)}` : null,
      );
      const result = await dispatchRun({ db, executor, agentId: builder, planNumber: 12, secretCipher: cipher });
      expect(executor.readCodingRepositoryFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: expect.stringMatching(/index\.md$/) }),
      );
      const row = await codingRunOf(result!.run.id);
      const section = /<plan>\n[\s\S]*?\n<\/plan>/.exec(row.request!)![0];
      expect(row.task).toContain(section);
      expect(row.task).toContain("Request:");
    });

    it("stores the plan section in the request a deferred executor composes later", async () => {
      const { builder, approveAll } = await setUp();
      await approveAll();
      const { executor } = fakeExecutor(null);
      executor.defersCodingResolution = true;
      const result = await dispatchRun({ db, executor, agentId: builder, planNumber: 12, secretCipher: cipher });
      const row = await codingRunOf(result!.run.id);
      expect(row.request).toMatch(/<plan>\n[\s\S]*\n<\/plan>/);
      expect(row.planSetId).not.toBeNull();
    });

    it("gates a builder linked as acme/… on a plan set recorded as Acme/… (fresh and deferred)", async () => {
      const { builder, repository } = await setUp((r) => r.toUpperCase());
      const { executor } = fakeExecutor(null);
      await expect(
        dispatchRun({ db, executor, agentId: builder, planNumber: 12, secretCipher: cipher }),
      ).rejects.toThrow(/^plan_not_approved: .*api\.md/);
      // Deferred: the raw requested repository is matched the same way before the lookup.
      executor.defersCodingResolution = true;
      await expect(
        dispatchRun({
          db,
          executor,
          agentId: builder,
          planNumber: 12,
          secretCipher: cipher,
          codingRepository: `https://github.com/${repository}`,
        }),
      ).rejects.toThrow(/^plan_not_approved: .*api\.md/);
      expect(await runsOf(builder)).toEqual([]);
    });

    it("a continuation builds from its root's versions after a document is reopened (no plan_not_approved)", async () => {
      const { repository, builder, planSetId, documentIds, approveAll } = await setUp();
      await approveAll();
      const { executor } = fakeExecutor(null);
      const root = await dispatchRun({
        db,
        executor,
        agentId: builder,
        codingTask: "Build ticket 2.",
        planNumber: 12,
        planTicket: 2,
        secretCipher: cipher,
      });
      const rootId = root!.run.id;
      await finishWithPullRequest(rootId, repository);
      // A reviewer reopens api.md and the planner publishes v2: a fresh build would now be refused.
      await setReviewState(db, documentIds["api.md"], "in_review");
      const v2 = await db.documentVersion.create({
        data: {
          documentId: documentIds["api.md"],
          number: 2,
          format: "markdown",
          markdown: "# API\n\nPOST /feed (reopened)\n",
          contentHash: `api-v2-${suffix}-${counter}`,
          via: "agent",
        },
      });
      await db.document.update({ where: { id: documentIds["api.md"] }, data: { currentVersionId: v2.id } });
      await expect(
        dispatchRun({ db, executor, agentId: builder, planNumber: 12, secretCipher: cipher }),
      ).rejects.toThrow(/^plan_not_approved/);

      // The fix round (a continuation of the root): built from the root's versions, never refused.
      const fix = await dispatchRun({
        db,
        executor,
        agentId: builder,
        codingTask: "Fix the review findings.",
        continuesCodingRunId: rootId,
        secretCipher: cipher,
      });
      expect(fix!.run.status).not.toBe("refused");
      const rootRow = await codingRunOf(rootId);
      const fixRow = await codingRunOf(fix!.run.id);
      expect(fixRow.rootCodingRunId).toBe(rootId);
      expect(fixRow.planSetId).toBe(planSetId);
      expect(fixRow.planVersions).toEqual(rootRow.planVersions);
      expect(fixRow.planTicket).toBe(2);
      expect(fixRow.request).toContain("Approved plan 12. Build exactly ticket 2 from this approved plan.");
      expect(fixRow.request).toMatch(/<plan>\n[\s\S]*--- api\.md \(approved v1\) ---[\s\S]*\n<\/plan>/);
      expect(fixRow.request).not.toContain("reopened");
      const files = await loadPlanFiles(db, fix!.run.id, "input");
      expect(files.map((f) => f.path)).toEqual([
        "api.md",
        "plan.md",
        "screens/boards/home.html",
        "screens/manifest.json",
      ]);
      expect(files.find((f) => f.path === "api.md")!.content).toBe("# API\n");
    });

    it("a continuation of a root that recorded no plan still passes the gate (plan_not_approved)", async () => {
      const { repository, builder } = await setUp();
      const { executor } = fakeExecutor(null);
      // The root had no plan number, so it built from no plan; plan #12 still waits on api.md.
      const root = await dispatchRun({ db, executor, agentId: builder, codingTask: "Build.", secretCipher: cipher });
      expect((await codingRunOf(root!.run.id)).planSetId).toBeNull();
      await finishWithPullRequest(root!.run.id, repository);
      const before = await db.run.count({ where: { agentId: builder } });
      const attempt = dispatchRun({
        db,
        executor,
        agentId: builder,
        codingTask: "Build plan 12.",
        planNumber: 12,
        continuesCodingRunId: root!.run.id,
        secretCipher: cipher,
      });
      await expect(attempt).rejects.toBeInstanceOf(PlanRefusedError);
      await expect(attempt).rejects.toThrow(/^plan_not_approved: .*api\.md/);
      expect(await db.run.count({ where: { agentId: builder } })).toBe(before);
    });

    it("refuses a continuation of another owner's root before any of its plan is loaded", async () => {
      const { repository, builder, approveAll } = await setUp();
      await approveAll();
      const { executor } = fakeExecutor(null);
      const root = await dispatchRun({
        db,
        executor,
        agentId: builder,
        codingTask: "Build.",
        planNumber: 12,
        secretCipher: cipher,
      });
      expect((await codingRunOf(root!.run.id)).planSetId).not.toBeNull();
      await finishWithPullRequest(root!.run.id, repository);
      // Another owner's builder on the same repository names that root.
      const otherOwner = `${PREFIX}other-owner-${suffix}-${++counter}`;
      await db.principal.create({ data: { id: otherOwner, subject: otherOwner } });
      const foreign = `${PREFIX}agent-${suffix}-${++counter}`;
      await db.agent.create({
        data: {
          id: foreign,
          name: foreign,
          systemPrompt: "Build things.",
          model: "gpt-5.6-luna",
          budgetUsd: 2,
          kind: "coding",
          ownerId: otherOwner,
          codingProfile: {
            create: { provider: "codex", repository, defaultTask: "Build.", protectedPaths: [], buildFromPlan: true },
          },
        },
      });
      // Every read of plan content goes through documentVersion or documentFile: none may happen.
      const planReads: string[] = [];
      const watched = new Proxy(db, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target) as unknown;
          if (prop === "documentVersion" || prop === "documentFile") {
            return new Proxy(value as object, {
              get(delegate, method) {
                planReads.push(`${String(prop)}.${String(method)}`);
                const fn = Reflect.get(delegate, method, delegate) as unknown;
                return typeof fn === "function" ? (fn as (...a: unknown[]) => unknown).bind(delegate) : fn;
              },
            });
          }
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      await expect(
        dispatchRun({
          db: watched,
          executor,
          agentId: foreign,
          codingTask: "Fix.",
          continuesCodingRunId: root!.run.id,
          secretCipher: cipher,
        }),
      ).rejects.toEqual(new ContinuationRefusedError("other_owner"));
      expect(planReads).toEqual([]);
      expect(await db.run.count({ where: { agentId: foreign } })).toBe(0);
    });

    it("refuses without a secret cipher: the plan is never sent unredacted", async () => {
      const { builder, approveAll } = await setUp();
      await approveAll();
      const { executor } = fakeExecutor(null);
      await expect(dispatchRun({ db, executor, agentId: builder, planNumber: 12 })).rejects.toThrow(
        /^plan_not_approved: secret values unavailable/,
      );
      expect(await runsOf(builder)).toEqual([]);
    });
  });

  it("refuses an unlisted name before any run exists", async () => {
    const { agentId } = await codingAgent();
    const { executor } = fakeExecutor();
    await expect(
      dispatchRun({ db, executor, agentId, codingTask: "sync", codingRepositories: ["nope"] }),
    ).rejects.toBeInstanceOf(RepositorySetRefusedError);
    expect(await runsOf(agentId)).toEqual([]);
  });

  it.each([FAKE_TOKEN, "sk-fake-secret-0123456789"])(
    "names a ref file by its path, never its content (%s), anywhere: error, run record, logs",
    async (secret) => {
      const { agentId } = await codingAgent();
      // A valid branch name that does not exist: the fake resolves it to null.
      const { executor } = fakeExecutor(`${secret}\n`);
      // Every dispatch log line (pino writes to fd 2, past any console or stream spy).
      const logged: string[] = [];
      setLogLineFilter((line) => {
        logged.push(line);
        return line;
      });
      for (const method of ["log", "info", "warn", "error", "debug"] as const) {
        vi.spyOn(console, method).mockImplementation(
          (...args: unknown[]) => void logged.push(args.map(String).join(" ")),
        );
      }

      let caught: unknown;
      try {
        await dispatchRun({ db, executor, agentId, codingTask: "sync" });
      } catch (err) {
        caught = err;
      } finally {
        setLogLineFilter((line) => line);
      }

      expect(caught).toBeInstanceOf(RepositoryRefUnreadableError);
      const err = caught as RepositoryRefUnreadableError;
      expect(err.message).toBe(
        'repository_ref_unreadable: the ref file upstream-sync for link "base" names a ref that does not exist.',
      );
      expect(await runsOf(agentId)).toEqual([]);
      const seen = [err.message, JSON.stringify(err), String(err.stack), ...logged].join("\n");
      expect(seen).not.toContain(secret);
    },
  );

  it("refuses a run whose host is unavailable as repository_ref_unreadable (unavailable), before any run exists", async () => {
    const { agentId } = await codingAgent();
    const { executor, spies } = fakeExecutor();
    spies.resolveCodingRepositoryRef.mockRejectedValue(new Error("github_api_unavailable"));
    const attempt = dispatchRun({ db, executor, agentId, codingTask: "sync" });
    await expect(attempt).rejects.toBeInstanceOf(RepositoryRefUnreadableError);
    await expect(attempt).rejects.toMatchObject({ reason: "unavailable" });
    expect(await runsOf(agentId)).toEqual([]);
  });

  it("refuses a read link outside the GitHub allowlist without resolving any ref", async () => {
    // Stamped admin: the allowlist is still a hard limit.
    const { agentId } = await codingAgent({ upstreamRepository: `outside-org/upstream-${suffix}` });
    const { executor, spies } = fakeExecutor();
    const result = await dispatchRun({ db, executor, agentId, codingTask: "sync" });

    expect(result!.run).toMatchObject({ status: "refused" });
    expect(result!.run.error).toMatch(/^repo_access_github_account_not_allowed: /);
    expect(spies.authorizeCodingRepository).toHaveBeenCalledWith(
      expect.objectContaining({ repository: `outside-org/upstream-${suffix}`, required: "read", ownerId: owner }),
    );
    expect(spies.resolveCodingRepositoryRef).not.toHaveBeenCalled();
    expect(spies.readCodingRepositoryFile).not.toHaveBeenCalledWith(expect.objectContaining({ path: "upstream-sync" }));
    expect(executor.start).not.toHaveBeenCalled();
    expect(await db.codingRun.findUnique({ where: { runId: result!.run.id } })).toBeNull();
  });

  it("copies a continuation's rows from its root, never resolving again", async () => {
    const { agentId } = await codingAgent();
    const { executor } = fakeExecutor();
    const root = await dispatchRun({ db, executor, agentId, codingTask: "sync" });
    await db.run.update({ where: { id: root!.run.id }, data: { status: "succeeded" } });
    await db.codingRun.update({
      where: { runId: root!.run.id },
      data: {
        result: {
          schemaVersion: 1,
          outcome: "pull_request_opened",
          repository: "acme/fork",
          baseRef: "main",
          headRef: `wardby/run-${root!.run.id}`,
          commitSha: "a".repeat(40),
          pullRequestUrl: "https://github.com/acme/fork/pull/1",
          pullRequestNumber: 1,
          summary: "Opened the PR",
          tests: [],
          usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        },
      },
    });

    const second = fakeExecutor();
    const continuation = await dispatchRun({
      db,
      executor: second.executor,
      agentId,
      codingTask: "again",
      continuesCodingRunId: root!.run.id,
    });

    const strip = (rows: Awaited<ReturnType<typeof rowsOf>>) =>
      rows.map(({ name, position, resolvedSha, requestedRef, refFromFile, linkId, access }) => ({
        name,
        position,
        resolvedSha,
        requestedRef,
        refFromFile,
        linkId,
        access,
      }));
    expect(strip(await rowsOf(continuation!.run.id))).toEqual(strip(await rowsOf(root!.run.id)));
    expect((await rowsOf(continuation!.run.id)).map((r) => r.name)).toEqual(["base", "upstream"]);
    expect(second.spies.resolveCodingRepositoryRef).not.toHaveBeenCalled();
    expect(second.spies.authorizeCodingRepository).not.toHaveBeenCalled();
  });

  /** A root run of `agentId` with a writable `tools` row (pull request `toolsPr`) and the default's `result`. */
  async function rootWithTools(agentId: string, defaultResult: "opened" | "no_changes", toolsPr = 3) {
    const root = await dispatchRun({ db, executor: fakeExecutor().executor, agentId, codingTask: "sync" });
    const runId = root!.run.id;
    await db.run.update({ where: { id: runId }, data: { status: "succeeded" } });
    const opened = (repository: string, number: number) => ({
      schemaVersion: 1,
      outcome: "pull_request_opened",
      repository,
      baseRef: "main",
      headRef: `wardby/run-${runId}`,
      commitSha: "a".repeat(40),
      pullRequestUrl: `https://github.com/${repository}/pull/${number}`,
      pullRequestNumber: number,
      summary: "Opened the PR",
      tests: [],
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    });
    await db.codingRun.update({
      where: { runId },
      data: {
        result:
          defaultResult === "opened"
            ? opened("acme/fork", 7)
            : {
                schemaVersion: 1,
                outcome: "no_changes",
                repository: "acme/fork",
                baseRef: "main",
                summary: "Nothing here",
                tests: [],
                usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
              },
      },
    });
    const tools = `acme/tools-${suffix}-${++counter}`;
    await db.codingRunRepository.create({
      data: {
        runId,
        position: 2,
        name: "tools",
        access: "write",
        provider: "github",
        repository: tools,
        resolvedSha: MAIN_SHA,
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        pullRequestNumber: toolsPr,
        mergeOrder: 2,
        result: opened(tools, toolsPr),
      },
    });
    return { runId, tools };
  }

  it("copies the root row's merge order onto a continuation's row; the pull request is the continuation's own to record", async () => {
    const { agentId } = await codingAgent();
    const { runId } = await rootWithTools(agentId, "opened");
    const continuation = await dispatchRun({
      db,
      executor: fakeExecutor().executor,
      agentId,
      codingTask: "again",
      continuesCodingRunId: runId,
    });
    const tools = await db.codingRunRepository.findUniqueOrThrow({
      where: { runId_name: { runId: continuation!.run.id, name: "tools" } },
      select: { mergeOrder: true, pullRequestNumber: true, result: true, markedReadyAt: true },
    });
    expect(tools).toEqual({ mergeOrder: 2, pullRequestNumber: null, result: null, markedReadyAt: null });
  });

  it("continues a root from one of its writable extras' pull requests (checkContinuation)", async () => {
    const { agentId } = await codingAgent();
    const { runId, tools } = await rootWithTools(agentId, "opened");
    expect(await checkContinuation(db, runId, tools, owner)).toEqual({
      ok: true,
      root: {
        runId,
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        pullRequestNumber: 3,
        repo: { kind: "extra", name: "tools", repository: tools, pullRequestNumber: 3 },
      },
    });
    expect(await checkContinuation(db, runId, "acme/fork")).toMatchObject({
      ok: true,
      root: { pullRequestNumber: 7, repo: { kind: "default" } },
    });
    // A read repository of the set, and one outside it, are still other repositories.
    const [base] = await rowsOf(runId);
    expect(await checkContinuation(db, runId, base.repository)).toEqual({ ok: false, reason: "other_repository" });
    expect(await checkContinuation(db, runId, "acme/elsewhere")).toEqual({ ok: false, reason: "other_repository" });
  });

  it.each(["pending", "running"] as const)(
    "refuses to continue a run that is still %s (run_not_finished)",
    async (status) => {
      const { agentId } = await codingAgent();
      const { runId } = await rootWithTools(agentId, "opened");
      await db.run.update({ where: { id: runId }, data: { status } });
      expect(await checkContinuation(db, runId, "acme/fork", owner, undefined, { requireFinished: true })).toEqual({
        ok: false,
        reason: "run_not_finished",
      });
      // Validating the marker run only (review-fix, mentions) does not require it finished.
      expect(await checkContinuation(db, runId, "acme/fork", owner)).toMatchObject({ ok: true });
      // Dispatch, which a delegation's continuePriorRun reaches, refuses the same way and starts nothing.
      const before = await db.run.count({ where: { agentId } });
      await expect(
        dispatchRun({
          db,
          executor: fakeExecutor().executor,
          agentId,
          codingTask: "again",
          continuesCodingRunId: runId,
        }),
      ).rejects.toEqual(new ContinuationRefusedError("run_not_finished"));
      expect(await db.run.count({ where: { agentId } })).toBe(before);
      // A different owner still learns nothing about its state.
      expect(
        await checkContinuation(db, runId, "acme/fork", "someone-else", undefined, { requireFinished: true }),
      ).toEqual({
        ok: false,
        reason: "other_owner",
      });
    },
  );

  it("matches an extra's replacement pull request by its own number, not the oldest row of that repository", async () => {
    const { agentId } = await codingAgent();
    const { runId, tools } = await rootWithTools(agentId, "opened");
    // A follow-up replaced tools#3 (closed) with tools#4: recorded on the continuation's own row.
    const continuation = await dispatchRun({
      db,
      executor: fakeExecutor().executor,
      agentId,
      codingTask: "replace the tools pull request",
      continuesCodingRunId: runId,
    });
    const contId = continuation!.run.id;
    await db.run.update({ where: { id: contId }, data: { status: "succeeded" } });
    await db.codingRunRepository.update({
      where: { runId_name: { runId: contId, name: "tools" } },
      data: { pullRequestNumber: 4 },
    });
    const check = (number?: number) =>
      checkContinuation(db, contId, tools, owner, number === undefined ? undefined : { provider: "github", number });
    expect(await check(4)).toMatchObject({
      ok: true,
      root: { runId, pullRequestNumber: 4, repo: { kind: "extra", name: "tools", pullRequestNumber: 4 } },
    });
    expect(await check(3)).toMatchObject({ ok: true, root: { pullRequestNumber: 3 } });
    // Without the number, the oldest row of the repository answers: the caller would refuse #4 as another PR.
    expect(await check()).toMatchObject({ ok: true, root: { pullRequestNumber: 3 } });
    expect(await check(5)).toEqual({ ok: false, reason: "no_pull_request" });
    // The provider is part of the match.
    expect(await checkContinuation(db, contId, tools, owner, { provider: "bitbucket", number: 4 })).toEqual({
      ok: false,
      reason: "other_repository",
    });
  });

  it("dispatches a continuation of a root whose default repository opened no pull request but an extra did", async () => {
    const { agentId } = await codingAgent();
    const { runId } = await rootWithTools(agentId, "no_changes");
    expect(await checkContinuation(db, runId, "acme/fork")).toEqual({ ok: false, reason: "no_pull_request" });
    const continuation = await dispatchRun({
      db,
      executor: fakeExecutor().executor,
      agentId,
      codingTask: "retry the default",
      continuesCodingRunId: runId,
    });
    const row = await db.codingRun.findUnique({ where: { runId: continuation!.run.id } });
    expect(row).toMatchObject({ rootCodingRunId: runId, repository: "acme/fork", headRef: `wardby/run-${runId}` });
    expect((await rowsOf(continuation!.run.id)).map((r) => r.name)).toEqual(["base", "upstream", "tools"]);
  });

  it("refuses a continuation of a root that opened no pull request anywhere", async () => {
    const { agentId } = await codingAgent();
    const { runId } = await rootWithTools(agentId, "no_changes");
    await db.codingRunRepository.updateMany({ where: { runId }, data: { pullRequestNumber: null } });
    await expect(
      dispatchRun({ db, executor: fakeExecutor().executor, agentId, codingTask: "again", continuesCodingRunId: runId }),
    ).rejects.toEqual(new ContinuationRefusedError("no_pull_request"));
  });

  it("refuses a continuation whose workspace would be one of the root's extras", async () => {
    const { agentId } = await codingAgent();
    const { runId } = await rootWithTools(agentId, "opened");
    // The root's default is now a repository this agent does not list, and its row is the agent's default.
    await db.codingRun.update({ where: { runId }, data: { repository: `acme/gone-${suffix}` } });
    await db.codingRunRepository.updateMany({ where: { runId, name: "tools" }, data: { repository: "acme/fork" } });
    await expect(
      dispatchRun({ db, executor: fakeExecutor().executor, agentId, codingTask: "again", continuesCodingRunId: runId }),
    ).rejects.toEqual(new ContinuationRefusedError("other_repository"));
  });

  it("refuses repositories on a continuation, which always reuses its root's set, before any run exists", async () => {
    const { agentId } = await codingAgent();
    const { runId } = await rootWithTools(agentId, "opened");
    const before = (await runsOf(agentId)).length;
    await expect(
      dispatchRun({
        db,
        executor: fakeExecutor().executor,
        agentId,
        codingTask: "again",
        continuesCodingRunId: runId,
        codingRepositories: ["base"],
      }),
    ).rejects.toThrow(RepositorySetRefusedError);
    expect(await runsOf(agentId)).toHaveLength(before);
  });

  it("records a deferred run's rows unresolved, the file's ref left for the start", async () => {
    const { agentId } = await codingAgent();
    const { executor, spies } = fakeExecutor();
    const deferred: Executor = { ...executor, defersCodingResolution: true };
    const result = await dispatchRun({ db, executor: deferred, agentId, codingTask: "sync" });
    expect(await rowsOf(result!.run.id)).toEqual([
      expect.objectContaining({ name: "base", requestedRef: null, refFromFile: "upstream-sync", resolvedSha: null }),
      expect.objectContaining({ name: "upstream", requestedRef: "main", resolvedSha: null }),
    ]);
    expect(spies.authorizeCodingRepository).not.toHaveBeenCalled();
    expect(spies.resolveCodingRepositoryRef).not.toHaveBeenCalled();
  });

  it("refuses a stored ref file path outside the repository at dispatch, without reading it", async () => {
    const { agentId, base } = await codingAgent();
    // Link-time validation refuses this; a row written some other way is refused here too.
    await db.agentRepository.update({ where: { id: base.id }, data: { refFromFile: "../secrets" } });
    const { executor, spies } = fakeExecutor();
    const attempt = dispatchRun({ db, executor, agentId, codingTask: "sync" });
    await expect(attempt).rejects.toBeInstanceOf(RepositoryRefUnreadableError);
    await expect(attempt).rejects.toThrow(
      'repository_ref_unreadable: the ref file for link "base" is not a repository-relative file path.',
    );
    expect(spies.readCodingRepositoryFile).not.toHaveBeenCalledWith(expect.objectContaining({ path: "../secrets" }));
    expect(await runsOf(agentId)).toEqual([]);
  });

  describe("remote links and git history (#536)", () => {
    afterEach(async () => {
      await db.agent.updateMany({ where: { id: { startsWith: PREFIX } }, data: { scheduleEnabled: false } });
    });
    const NOW = new Date("2026-09-05T12:16:00.000Z");

    async function remoteAgent(history: { gitHistoryDepth: number | null; gitHistoryFull: boolean }) {
      const made = await codingAgent();
      await db.codingAgentProfile.update({ where: { agentId: made.agentId }, data: history });
      await db.agentRepository.update({ where: { id: made.upstream.id }, data: { asRemote: true } });
      return made;
    }

    it("refuses a remote link while history is off, before any run exists", async () => {
      const { agentId } = await remoteAgent({ gitHistoryDepth: null, gitHistoryFull: false });
      const { executor, spies } = fakeExecutor();
      await expect(dispatchRun({ db, executor, agentId, codingTask: "sync" })).rejects.toThrow(
        /^repository_remote_needs_history:/,
      );
      expect(await runsOf(agentId)).toEqual([]);
      expect(spies.resolveCodingRepositoryRef).not.toHaveBeenCalled();
    });

    it("records one refused run for a scheduled dispatch, and advances the schedule", async () => {
      const { agentId } = await remoteAgent({ gitHistoryDepth: null, gitHistoryFull: false });
      await db.agent.update({
        where: { id: agentId },
        data: { schedule: "*/15 * * * *", timezone: "UTC", scheduleEnabled: true },
      });
      const { executor } = fakeExecutor();
      const runId = await claimDueRun(db, executor, agentId, NOW);
      const run = await db.run.findUnique({ where: { id: runId! } });
      expect(run).toMatchObject({ status: "refused", trigger: "scheduled" });
      expect(run?.error).toMatch(/^repository_remote_needs_history: /);
      expect(await runsOf(agentId)).toHaveLength(1);
      expect(executor.start).not.toHaveBeenCalled();
    });

    it("refuses a remote link on another host than the default repository (repository_remote_invalid)", async () => {
      const { agentId } = await remoteAgent({ gitHistoryDepth: 10, gitHistoryFull: false });
      await db.agentRepository.create({
        data: {
          agentId,
          name: "localup",
          provider: "local",
          repository: "local:/srv/up",
          access: "read",
          ref: "main",
          asRemote: true,
          inDefaultSet: true,
          authorizedVia: "local_root",
          createdAt: new Date(3_000),
        },
      });
      await expect(dispatchRun({ db, executor: fakeExecutor().executor, agentId, codingTask: "sync" })).rejects.toThrow(
        /^repository_remote_invalid:/,
      );
      expect(await runsOf(agentId)).toEqual([]);
    });

    it.each([[{ gitHistoryDepth: 50, gitHistoryFull: false }], [{ gitHistoryDepth: null, gitHistoryFull: true }]])(
      "copies the history setting %j to the run and asRemote to the repository row",
      async (history) => {
        const { agentId } = await remoteAgent(history);
        const result = await dispatchRun({ db, executor: fakeExecutor().executor, agentId, codingTask: "sync" });
        const run = await db.codingRun.findUniqueOrThrow({ where: { runId: result!.run.id } });
        expect({ gitHistoryDepth: run.gitHistoryDepth, gitHistoryFull: run.gitHistoryFull }).toEqual(history);
        expect((await rowsOf(result!.run.id)).map((r) => [r.name, r.asRemote])).toEqual([
          ["base", false],
          ["upstream", true],
        ]);
      },
    );

    it("leaves history off on the run and rows as before when the setting is off and no link is remote", async () => {
      const { agentId } = await codingAgent();
      const result = await dispatchRun({ db, executor: fakeExecutor().executor, agentId, codingTask: "sync" });
      const run = await db.codingRun.findUniqueOrThrow({ where: { runId: result!.run.id } });
      expect(run).toMatchObject({ gitHistoryDepth: null, gitHistoryFull: false });
      expect((await rowsOf(result!.run.id)).every((r) => r.asRemote === false)).toBe(true);
    });

    it("keeps asRemote on a continuation's copied rows", async () => {
      const { agentId } = await remoteAgent({ gitHistoryDepth: 50, gitHistoryFull: false });
      const { runId } = await rootWithTools(agentId, "opened");
      await db.codingRunRepository.updateMany({ where: { runId, name: "upstream" }, data: { asRemote: true } });
      const continuation = await dispatchRun({
        db,
        executor: fakeExecutor().executor,
        agentId,
        codingTask: "again",
        continuesCodingRunId: runId,
      });
      expect((await rowsOf(continuation!.run.id)).map((r) => [r.name, r.asRemote])).toEqual([
        ["base", false],
        ["upstream", true],
        ["tools", false],
      ]);
    });
  });

  describe("a continuation's git history comes from its root run (#536, #537)", () => {
    it.each([
      ["history switched off", { gitHistoryDepth: null, gitHistoryFull: false }],
      ["history switched to full", { gitHistoryDepth: null, gitHistoryFull: true }],
    ])("keeps the root's depth when the profile has %s", async (_label, switched) => {
      const { agentId } = await codingAgent();
      await db.codingAgentProfile.update({
        where: { agentId },
        data: { gitHistoryDepth: 50, gitHistoryFull: false },
      });
      const { runId } = await rootWithTools(agentId, "opened");
      await db.codingRun.update({ where: { runId }, data: { gitHistoryDepth: 50, gitHistoryFull: false } });
      await db.codingRunRepository.updateMany({ where: { runId, name: "upstream" }, data: { asRemote: true } });
      await db.codingAgentProfile.update({ where: { agentId }, data: switched });
      const continuation = await dispatchRun({
        db,
        executor: fakeExecutor().executor,
        agentId,
        codingTask: "again",
        continuesCodingRunId: runId,
      });
      const run = await db.codingRun.findUniqueOrThrow({ where: { runId: continuation!.run.id } });
      expect(run).toMatchObject({ gitHistoryDepth: 50, gitHistoryFull: false });
      expect((await rowsOf(continuation!.run.id)).map((r) => [r.name, r.asRemote])).toEqual([
        ["base", false],
        ["upstream", true],
        ["tools", false],
      ]);
    });
  });

  describe("a scheduled dispatch (no caller waiting for the error)", () => {
    const NOW = new Date("2026-09-05T12:16:00.000Z");
    const WINDOW = new Date("2026-09-05T12:15:00.000Z");

    async function scheduledAgent(): Promise<string> {
      const { agentId } = await codingAgent();
      await db.agent.update({
        where: { id: agentId },
        data: { schedule: "*/15 * * * *", timezone: "UTC", scheduleEnabled: true },
      });
      return agentId;
    }

    afterEach(async () => {
      vi.unstubAllEnvs();
      // Other suites count enabled schedules in this shared database (and a live scheduler would fire them).
      await db.agent.updateMany({ where: { id: { startsWith: PREFIX } }, data: { scheduleEnabled: false } });
    });

    it("commits a missing ref file as one refused run and advances the schedule, so the next tick does not retry", async () => {
      const agentId = await scheduledAgent();
      const { executor, spies } = fakeExecutor(null);

      const runId = await claimDueRun(db, executor, agentId, NOW);

      expect(runId).not.toBeNull();
      const run = await db.run.findUnique({ where: { id: runId! }, include: { codingRun: true } });
      expect(run).toMatchObject({
        status: "refused",
        trigger: "scheduled",
        finishedAt: NOW,
        error:
          'repository_ref_unreadable: the ref file upstream-sync for link "base" does not exist at the default repository\'s base branch.',
      });
      expect(run?.codingRun).toBeNull();
      expect(await rowsOf(runId!)).toEqual([]);
      expect(executor.start).not.toHaveBeenCalled();
      expect((await db.agent.findUnique({ where: { id: agentId } }))?.lastScheduledAt).toEqual(WINDOW);

      expect(spies.readCodingRepositoryFile).toHaveBeenCalledTimes(1);
      // The next tick (10 s later, same window) finds the agent not due, so it never claims it or
      // calls the host again; a claim that raced past that check still creates nothing.
      const nextTick = new Date(NOW.getTime() + 10_000);
      expect((await findDueCandidates(db, nextTick)).map((a) => a.id)).not.toContain(agentId);
      expect(await claimDueRun(db, executor, agentId, nextTick)).toBeNull();
      expect(await runsOf(agentId)).toHaveLength(1);
    });

    it("commits an over-limit default set as a refused run and advances the schedule", async () => {
      const agentId = await scheduledAgent();
      vi.stubEnv("CODING_MAX_RUN_REPOSITORIES", "2");
      const { executor, spies } = fakeExecutor();

      const runId = await claimDueRun(db, executor, agentId, NOW);

      const run = await db.run.findUnique({ where: { id: runId! } });
      expect(run).toMatchObject({ status: "refused", trigger: "scheduled" });
      expect(run?.error).toMatch(/^repository_set_too_large: this run would have 3 repositories; the limit is 2/);
      expect(spies.readCodingRepositoryFile).not.toHaveBeenCalledWith(
        expect.objectContaining({ path: "upstream-sync" }),
      );
      expect((await db.agent.findUnique({ where: { id: agentId } }))?.lastScheduledAt).toEqual(WINDOW);
      expect(await claimDueRun(db, executor, agentId, NOW)).toBeNull();
    });

    it("commits an over-limit default set as a refused run when the dispatch is deferred too", async () => {
      const agentId = await scheduledAgent();
      vi.stubEnv("CODING_MAX_RUN_REPOSITORIES", "2");
      const { executor } = fakeExecutor();
      const deferred: Executor = { ...executor, defersCodingResolution: true };

      const runId = await claimDueRun(db, deferred, agentId, NOW);

      const run = await db.run.findUnique({ where: { id: runId! } });
      expect(run).toMatchObject({ status: "refused", trigger: "scheduled" });
      expect(run?.error).toMatch(/^repository_set_too_large: /);
      expect((await db.agent.findUnique({ where: { id: agentId } }))?.lastScheduledAt).toEqual(WINDOW);
    });

    it("commits an executor without extra-repository support as a refused run", async () => {
      const agentId = await scheduledAgent();
      const bare: Executor = { start: vi.fn(async () => {}), async stop() {} };

      const runId = await claimDueRun(db, bare, agentId, NOW);

      const run = await db.run.findUnique({ where: { id: runId! } });
      expect(run).toMatchObject({
        status: "refused",
        error: "coding_repositories_unsupported: this deployment cannot resolve extra repositories.",
      });
      expect((await db.agent.findUnique({ where: { id: agentId } }))?.lastScheduledAt).toEqual(WINDOW);
    });

    it.each([FAKE_TOKEN, "sk-fake-secret-0123456789"])(
      "never writes the ref file's content (%s) to the refused run or the logs",
      async (secret) => {
        const agentId = await scheduledAgent();
        // A valid branch name that does not exist: the fake resolves it to null.
        const { executor } = fakeExecutor(`${secret}\n`);
        const logged: string[] = [];
        setLogLineFilter((line) => {
          logged.push(line);
          return line;
        });
        for (const method of ["log", "info", "warn", "error", "debug"] as const) {
          vi.spyOn(console, method).mockImplementation(
            (...args: unknown[]) => void logged.push(args.map(String).join(" ")),
          );
        }
        let runId: string | null;
        try {
          runId = await claimDueRun(db, executor, agentId, NOW);
        } finally {
          setLogLineFilter((line) => line);
        }

        const run = await db.run.findUnique({ where: { id: runId! }, include: { codingRun: true } });
        expect(run).toMatchObject({
          status: "refused",
          error:
            'repository_ref_unreadable: the ref file upstream-sync for link "base" names a ref that does not exist.',
        });
        const events = await db.runBudgetEvent.findMany({ where: { runId: runId! } });
        const seen = [JSON.stringify(run), JSON.stringify(events), ...logged].join("\n");
        expect(seen).not.toContain(secret);
      },
    );

    it("still refuses a manual dispatch synchronously, with no run", async () => {
      const agentId = await scheduledAgent();
      const { executor } = fakeExecutor(null);
      await expect(dispatchRun({ db, executor, agentId, codingTask: "sync" })).rejects.toBeInstanceOf(
        RepositoryRefUnreadableError,
      );
      expect(await runsOf(agentId)).toEqual([]);
      expect((await db.agent.findUnique({ where: { id: agentId } }))?.lastScheduledAt).toBeNull();
    });
  });
});
