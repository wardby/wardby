import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal, RunStatus } from "#prisma";
import { createPrismaClient } from "../db.js";
import { submitForReview } from "../documents/review.js";
import { createDocument, publishVersion } from "../documents/service.js";
import { principalGranteeKey } from "../grants.js";
import { attachSecret, createSecret } from "../secrets.js";
import { planRunFinishedHook } from "./hooks.js";
import { planReplyLines, planSummaryLines } from "./wording.js";
import {
  PLAN_PUBLISH_LEASE_MS,
  PLAN_PUBLISH_WAIT_MS,
  planSummaryForRun,
  publishPlanFromRun,
  type PlanPublishClock,
  type PublishedPlan,
} from "./publish.js";

vi.mock("../documents/review.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../documents/review.js")>();
  return { ...real, submitForReview: vi.fn(real.submitForReview) };
});

const FAKE_SECRET = "wardby-fake-plan-secret-4b1e";

describe.skipIf(!process.env.DATABASE_URL)("publishing a plan set (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const deps = { cipher, origin: null };
  const s = randomUUID().slice(0, 8);
  let owner: Principal;
  let reviewer: Principal;
  const agents: string[] = [];
  let n = 0;

  beforeAll(async () => {
    owner = await db.principal.create({ data: { subject: `plan-pub-owner-${s}` } });
    reviewer = await db.principal.create({ data: { subject: `plan-pub-reviewer-${s}` } });
  });
  afterAll(async () => {
    await db.document.deleteMany({ where: { ownerId: owner.id } });
    await db.planSet.deleteMany({ where: { agentId: { in: agents } } });
    await db.run.deleteMany({ where: { agentId: { in: agents } } });
    await db.agentSecret.deleteMany({ where: { agentId: { in: agents } } });
    await db.secret.deleteMany({ where: { ownerId: owner.id } });
    await db.agent.deleteMany({ where: { id: { in: agents } } });
    await db.$disconnect();
  });

  async function makeAgent(kind: "coding" | "native", planDocument?: object): Promise<string> {
    const agent = await db.agent.create({
      data: {
        name: `plan-pub-${s}-${++n}`,
        systemPrompt: "p",
        model: "m",
        budgetUsd: 1,
        ownerId: owner.id,
        kind,
        ...(kind === "coding"
          ? { codingProfile: { create: { repository: "o/r", protectedPaths: [], planDocument } } }
          : {}),
      },
    });
    agents.push(agent.id);
    return agent.id;
  }

  const planner = (reviewers: string[] = [owner.id]) =>
    makeAgent("coding", { store: "wardby", reviewers, onApproved: "notify" });

  async function grantRead(agentId: string, principalId: string): Promise<void> {
    await db.resourceGrant.create({
      data: {
        resourceType: "agent",
        resourceId: agentId,
        granteeKind: "principal",
        granteePrincipalId: principalId,
        granteeKey: principalGranteeKey(principalId),
        level: "read",
        grantedById: owner.id,
      },
    });
  }

  async function makeRun(
    agentId: string,
    files: { path: string; content: string }[],
    opts: {
      status?: RunStatus;
      planFilesStatus?: string | null;
      parentRunId?: string;
      planRepositoryPath?: string;
    } = {},
  ): Promise<string> {
    const run = await db.run.create({
      data: {
        agentId,
        status: opts.status ?? "succeeded",
        trigger: "manual",
        ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
      },
    });
    await db.codingRun.create({
      data: {
        runId: run.id,
        task: "t",
        repository: "o/r",
        baseRef: "main",
        headRef: `wardby/run-${run.id}`,
        provider: "codex",
        model: "m",
        timeoutSec: 60,
        protectedPaths: [],
        budgetReservedUsd: 0.1,
        collectPlanFiles: true,
        planNumber: 12,
        issueProvider: "github",
        issueKey: "o/r#12",
        planFilesStatus: opts.planFilesStatus === undefined ? "stored" : opts.planFilesStatus,
        planRepositoryPath: opts.planRepositoryPath ?? null,
      },
    });
    if (files.length) {
      await db.codingRunPlanFile.createMany({
        data: files.map((f) => ({ runId: run.id, direction: "output", path: f.path, content: f.content })),
      });
    }
    return run.id;
  }

  const published = (result: Awaited<ReturnType<typeof publishPlanFromRun>>): PublishedPlan => {
    if (!result || "error" in result) throw new Error(`expected a published plan, got ${JSON.stringify(result)}`);
    return result;
  };
  const marker = async (runId: string) =>
    (await db.codingRun.findUniqueOrThrow({ where: { runId }, select: { planPublishStatus: true } })).planPublishStatus;
  const changes = (plan: PublishedPlan) => Object.fromEntries(plan.documents.map((d) => [d.path, d.change]));

  it("first run: creates the set and one reviewed document per file, owned by the planner's owner", async () => {
    const agentId = await planner();
    const runId = await makeRun(agentId, [
      { path: "plan.md", content: "# The plan\n" },
      { path: "api.md", content: "# API\n" },
    ]);
    const plan = published(await publishPlanFromRun(db, deps, runId));
    const set = await db.planSet.findUniqueOrThrow({ where: { id: plan.planSetId } });
    expect(set).toMatchObject({ number: 12, accessAgentId: agentId, createdByRunId: runId, store: "wardby" });
    expect(set).toMatchObject({ issueProvider: "github", issueKey: "o/r#12" });
    expect(plan.documents.map((d) => [d.path, d.change, d.reviewState, d.versionNumber])).toEqual([
      ["plan.md", "created", "in_review", 1],
      ["api.md", "created", "in_review", 1],
    ]);
    const docs = await db.document.findMany({ where: { planSetId: set.id }, orderBy: { planPath: "asc" } });
    expect(docs.map((d) => [d.planPath, d.title, d.ownerId, d.agentId, d.repository])).toEqual([
      ["api.md", "API", owner.id, agentId, null],
      ["plan.md", "The plan", owner.id, agentId, null],
    ]);
    expect(plan.documents[0]).toMatchObject({ pagePath: `/d/${plan.documents[0].id}` });
    expect(plan.documents[0].url).toBeUndefined();
    const reviewers = await db.documentReviewer.findMany({ where: { documentId: docs[0].id } });
    expect(reviewers.map((r) => r.principalId)).toEqual([owner.id]);
    expect(await marker(runId)).toBe("published");
  });

  it("a later run: a changed file is the next version, the same file unchanged, a gone file removed", async () => {
    const agentId = await planner();
    const first = await makeRun(agentId, [
      { path: "plan.md", content: "# Plan\n\nv1\n" },
      { path: "api.md", content: "# API\n" },
      { path: "old.md", content: "# Old\n" },
    ]);
    published(await publishPlanFromRun(db, deps, first));
    const second = await makeRun(agentId, [
      { path: "plan.md", content: "# Plan\n\nv2\n" },
      { path: "api.md", content: "# API\n" },
    ]);
    const plan = published(await publishPlanFromRun(db, deps, second));
    expect(changes(plan)).toEqual({ "plan.md": "updated", "api.md": "unchanged", "old.md": "removed" });
    const planDoc = plan.documents.find((d) => d.path === "plan.md")!;
    const v2 = await db.documentVersion.findUniqueOrThrow({
      where: { documentId_number: { documentId: planDoc.id, number: 2 } },
    });
    expect(v2).toMatchObject({ via: "agent", runId: second, markdown: "# Plan\n\nv2\n" });
    expect(planDoc.versionNumber).toBe(2);
    const old = await db.document.findUniqueOrThrow({
      where: { id: plan.documents.find((d) => d.path === "old.md")!.id },
    });
    expect(old.removedFromPlan).toBe(true);
    expect(await db.planSet.count({ where: { agentId } })).toBe(1);
  });

  it("an approved or archived document is not changed (R21: archived is never approved_unchanged)", async () => {
    const agentId = await planner();
    const first = await makeRun(agentId, [
      { path: "plan.md", content: "# Plan\n" },
      { path: "api.md", content: "# API\n" },
    ]);
    const plan1 = published(await publishPlanFromRun(db, deps, first));
    const id = (path: string) => plan1.documents.find((d) => d.path === path)!.id;
    await db.document.update({ where: { id: id("plan.md") }, data: { reviewState: "approved" } });
    await db.document.update({ where: { id: id("api.md") }, data: { reviewState: "archived" } });
    const second = await makeRun(agentId, [
      { path: "plan.md", content: "# Plan\n\nchanged\n" },
      { path: "api.md", content: "# API\n\nchanged\n" },
    ]);
    const plan2 = published(await publishPlanFromRun(db, deps, second));
    expect(changes(plan2)).toEqual({ "plan.md": "approved_unchanged", "api.md": "archived_unchanged" });
    expect(await db.documentVersion.count({ where: { documentId: { in: [id("plan.md"), id("api.md")] } } })).toBe(2);
  });

  it("a run whose files were not stored publishes nothing and reports the reason", async () => {
    const agentId = await planner();
    const runId = await makeRun(agentId, [], { planFilesStatus: "plan_files_unsupported" });
    expect(await publishPlanFromRun(db, deps, runId)).toEqual({ number: 12, error: "plan_files_unsupported" });
    expect(await db.planSet.count({ where: { agentId } })).toBe(0);
    expect(await planSummaryForRun(db, runId, null)).toEqual({ number: 12, error: "plan_files_unsupported" });
    const other = await makeRun(agentId, [], { planFilesStatus: "secrets_changed" });
    expect(await publishPlanFromRun(db, deps, other)).toEqual({ number: 12, error: "plan_not_stored" });
  });

  it("not a planner run, or a run that did not succeed: null", async () => {
    const plain = await makeAgent("coding");
    expect(await publishPlanFromRun(db, deps, await makeRun(plain, [{ path: "plan.md", content: "# P" }]))).toBeNull();
    const agentId = await planner();
    const failed = await makeRun(agentId, [{ path: "plan.md", content: "# P" }], { status: "failed" });
    expect(await publishPlanFromRun(db, deps, failed)).toBeNull();
    expect(await db.planSet.count({ where: { agentId } })).toBe(0);
  });

  it("a lead's delegated run: the set's access agent is the lead", async () => {
    const lead = await makeAgent("native");
    const leadRun = await db.run.create({ data: { agentId: lead, status: "running", trigger: "manual" } });
    const agentId = await planner();
    const runId = await makeRun(agentId, [{ path: "plan.md", content: "# P" }], { parentRunId: leadRun.id });
    const plan = published(await publishPlanFromRun(db, deps, runId));
    expect((await db.planSet.findUniqueOrThrow({ where: { id: plan.planSetId } })).accessAgentId).toBe(lead);
  });

  it("no document version holds a secret value: the stored marker stays, and the publish redacts again", async () => {
    const agentId = await planner();
    const name = `PLAN_KEY_${s}`;
    await createSecret(name, FAKE_SECRET, owner.id, cipher, db);
    await attachSecret(agentId, name, owner.id, db);
    const runId = await makeRun(agentId, [
      { path: "plan.md", content: "# Plan\n\nkey [REDACTED]\n" },
      { path: "api.md", content: `# API\n\ntoken ${FAKE_SECRET}\n` },
    ]);
    const plan = published(await publishPlanFromRun(db, deps, runId));
    const versions = await db.documentVersion.findMany({
      where: { documentId: { in: plan.documents.map((d) => d.id) } },
    });
    expect(versions).toHaveLength(2);
    for (const v of versions) expect(v.markdown).not.toContain(FAKE_SECRET);
    expect(versions.every((v) => v.markdown?.includes("[REDACTED]"))).toBe(true);
    expect(JSON.stringify(plan)).not.toContain(FAKE_SECRET);
  });

  it("store repository: documents and designs link to the plan folder on the run's branch; an unchanged design stays", async () => {
    const agentId = await makeAgent("coding", {
      store: "repository",
      path: "docs/plans/{n}/",
      reviewers: [owner.id],
      onApproved: "notify",
    });
    const manifest = JSON.stringify({
      title: "Screens",
      boards: [{ id: "home", name: "Home", file: "boards/home.html", width: 1280 }],
    });
    const files = [
      { path: "plan.md", content: "# Plan\n" },
      { path: "screens/manifest.json", content: manifest },
      { path: "screens/boards/home.html", content: "<main>Home</main>" },
    ];
    const first = await makeRun(agentId, files, { planRepositoryPath: "docs/plans/12/" });
    const plan1 = published(await publishPlanFromRun(db, deps, first));
    expect(plan1.documents.map((d) => [d.kind, d.path, d.change])).toEqual([
      ["document", "plan.md", "created"],
      ["design", "screens/", "created"],
    ]);
    const docs = await db.document.findMany({
      where: { id: { in: plan1.documents.map((d) => d.id) } },
      orderBy: { planPath: "asc" },
    });
    expect(docs.map((d) => [d.kind, d.repository, d.path, d.baseRef])).toEqual([
      ["document", "o/r", "docs/plans/12/plan.md", `wardby/run-${first}`],
      ["design", "o/r", "docs/plans/12/screens/", `wardby/run-${first}`],
    ]);
    expect((await db.planSet.findUniqueOrThrow({ where: { id: plan1.planSetId } })).store).toBe("repository");
    const second = await makeRun(agentId, files, { planRepositoryPath: "docs/plans/12/" });
    expect(changes(published(await publishPlanFromRun(db, deps, second)))).toEqual({
      "plan.md": "unchanged",
      "screens/": "unchanged",
    });
    // A document that gets a version from a later run links to that run's branch (and plan folder).
    const third = await makeRun(agentId, [{ path: "plan.md", content: "# Plan\n\nv2\n" }, ...files.slice(1)], {
      planRepositoryPath: "docs/plans/12b/",
    });
    expect(changes(published(await publishPlanFromRun(db, deps, third)))).toEqual({
      "plan.md": "updated",
      "screens/": "unchanged",
    });
    const after = await db.document.findMany({
      where: { id: { in: plan1.documents.map((d) => d.id) } },
      orderBy: { planPath: "asc" },
    });
    expect(after.map((d) => [d.planPath, d.repository, d.path, d.baseRef])).toEqual([
      ["plan.md", "o/r", "docs/plans/12b/plan.md", `wardby/run-${third}`],
      ["screens/", "o/r", "docs/plans/12/screens/", `wardby/run-${first}`],
    ]);
  });

  it("R11: a document that already has a version from this run is left alone and reported as updated", async () => {
    const agentId = await planner();
    const first = await makeRun(agentId, [{ path: "plan.md", content: "# Plan\n" }]);
    const plan1 = published(await publishPlanFromRun(db, deps, first));
    const docId = plan1.documents[0].id;
    const second = await makeRun(agentId, [{ path: "plan.md", content: "# Plan\n\nfrom the files\n" }]);
    await publishVersion(db, cipher, {
      documentId: docId,
      markdown: "# Plan\n\nrevision\n",
      via: "agent",
      runId: second,
    });
    const plan2 = published(await publishPlanFromRun(db, deps, second));
    expect(changes(plan2)).toEqual({ "plan.md": "updated" });
    const versions = await db.documentVersion.findMany({ where: { documentId: docId }, orderBy: { number: "asc" } });
    expect(versions.map((v) => v.markdown)).toEqual(["# Plan\n", "# Plan\n\nrevision\n"]);
  });

  it("R10a: planSummaryForRun is pending before the publish and the published plan after it", async () => {
    const agentId = await planner();
    const runId = await makeRun(agentId, [
      { path: "plan.md", content: "# Plan\n" },
      { path: "api.md", content: "# API\n" },
    ]);
    expect(await planSummaryForRun(db, runId, null)).toEqual({ number: 12, documents: [], pending: true });
    const plan = published(await publishPlanFromRun(db, deps, runId));
    expect(await planSummaryForRun(db, runId, null)).toEqual(plan);
    const withOrigin = await planSummaryForRun(db, runId, "https://wardby.example");
    expect(withOrigin && "documents" in withOrigin && withOrigin.documents[0].url).toBe(
      `https://wardby.example/d/${plan.documents[0].id}`,
    );
    const running = await makeRun(agentId, [], { status: "running", planFilesStatus: null });
    expect(await planSummaryForRun(db, running, null)).toEqual({ number: 12, documents: [], pending: true });
    const later = await makeRun(agentId, [
      { path: "plan.md", content: "# Plan\n\nv2\n" },
      { path: "api.md", content: "# API\n" },
    ]);
    // The set exists, but this run's publish has not finished: pending, never the old documents' states.
    expect(await planSummaryForRun(db, later, null)).toEqual({ number: 12, documents: [], pending: true });
    const plan2 = published(await publishPlanFromRun(db, deps, later));
    expect(await planSummaryForRun(db, later, null)).toEqual(plan2);
  });

  it("R10b: a reviewer who lost access to the planner is not asked, and is counted as skipped", async () => {
    const agentId = await planner([reviewer.id]);
    await grantRead(agentId, reviewer.id);
    const first = await makeRun(agentId, [{ path: "plan.md", content: "# Plan\n" }]);
    const plan1 = published(await publishPlanFromRun(db, deps, first));
    expect(plan1.skippedReviewers).toEqual([]);
    expect(
      (await db.documentReviewer.findMany({ where: { documentId: plan1.documents[0].id } })).map((r) => r.principalId),
    ).toEqual([reviewer.id]);
    await db.resourceGrant.deleteMany({ where: { resourceType: "agent", resourceId: agentId } });
    const second = await makeRun(agentId, [
      { path: "plan.md", content: "# Plan\n" },
      { path: "new.md", content: "# New\n" },
    ]);
    const plan2 = published(await publishPlanFromRun(db, deps, second));
    expect(plan2.skippedReviewers).toEqual([reviewer.id]);
    const added = plan2.documents.find((d) => d.path === "new.md")!;
    // No reviewer left: submitted to the owner alone.
    expect((await db.documentReviewer.findMany({ where: { documentId: added.id } })).map((r) => r.principalId)).toEqual(
      [owner.id],
    );
  });

  it("R11 hook: a revision run (threads sent with it) publishes nothing; another run publishes the set", async () => {
    const hook = planRunFinishedHook(() => ({ db, cipher, origin: null }));
    const agentId = await planner();
    const revision = await makeRun(agentId, [{ path: "plan.md", content: "# Plan\n" }]);
    const doc = await createDocument(db, cipher, { ownerId: owner.id, title: "T", markdown: "x", agentId });
    await db.commentThread.create({
      data: {
        documentId: doc.id,
        number: 1,
        versionId: doc.versionId,
        anchor: { type: "text", quote: "x" },
        sentRunId: revision,
      },
    });
    // The hook's promise settles when its work is done (callers never await it, R10d).
    await hook(revision);
    expect(await marker(revision)).toBeNull();
    expect(await db.planSet.count({ where: { agentId } })).toBe(0);
    const plain = await planner();
    const runId = await makeRun(plain, [{ path: "plan.md", content: "# Plan\n" }]);
    await hook(runId);
    expect(await marker(runId)).toBe("published");
    expect(await planSummaryForRun(db, runId, null)).toMatchObject({
      documents: [{ path: "plan.md", change: "created", reviewState: "in_review" }],
    });
  });

  it("R25: a planner run with no lead gets its reply on the issue; a delegated one and a failed publish follow the rules", async () => {
    const notices: { issueKey: string | null; text: string }[] = [];
    const postIssueNotice = vi.fn(async (set: { issueKey: string | null }, text: string) => {
      notices.push({ issueKey: set.issueKey, text });
    });
    const hook = planRunFinishedHook(() => ({ db, cipher, origin: null, postIssueNotice }));
    const agentId = await planner();
    const name = `PLAN_NOTICE_KEY_${s}`;
    await createSecret(name, FAKE_SECRET, owner.id, cipher, db);
    await attachSecret(agentId, name, owner.id, db);
    const runId = await makeRun(agentId, [{ path: "plan.md", content: `# Plan\n\ntoken ${FAKE_SECRET}\n` }]);
    await hook(runId);
    const summary = await planSummaryForRun(db, runId, null);
    expect(notices).toHaveLength(1);
    expect(notices[0].issueKey).toBe("o/r#12");
    expect(notices[0].text).toBe(planSummaryLines(summary!).join("\n"));
    expect(notices[0].text).toBe(planReplyLines(summary as PublishedPlan).join("\n"));
    expect(notices[0].text).not.toContain(FAKE_SECRET);
    // A delegated planner: its lead replies, so nothing is posted here.
    const lead = await makeRun(await makeAgent("native"), []);
    const child = await makeRun(await planner(), [{ path: "plan.md", content: "# Plan\n" }], { parentRunId: lead });
    await hook(child);
    expect(notices).toHaveLength(1);
    expect(await marker(child)).toBe("published");
    // A failed publish posts the failure line.
    const bad = await makeRun(await planner(), [], { planFilesStatus: "plan_too_large" });
    await hook(bad);
    expect(notices).toHaveLength(2);
    expect(notices[1].text).toBe(planSummaryLines({ number: 12, error: "plan_too_large" }).join("\n"));
  });

  it("two concurrent first publishes on a one-connection pool make one set and one document per path", async () => {
    // A publish holds no connection while it works or waits for the lease: with a pool of one, both finish.
    const small = createPrismaClient(undefined, { poolMax: 1 });
    try {
      const agentId = await planner();
      const a = await makeRun(agentId, [{ path: "plan.md", content: "# Plan\n\na\n" }]);
      const b = await makeRun(agentId, [{ path: "plan.md", content: "# Plan\n\nb\n" }]);
      // A frozen clock: the lease never expires and the wait never runs out; the waiter only yields.
      const t = Date.now();
      const clock: PlanPublishClock = { now: () => t, sleep: () => new Promise((resolve) => setImmediate(resolve)) };
      const [planA, planB] = await Promise.all([
        publishPlanFromRun(small, { ...deps, clock }, a),
        publishPlanFromRun(small, { ...deps, clock }, b),
      ]);
      expect(published(planA).planSetId).toBe(published(planB).planSetId);
      expect(await db.planSet.count({ where: { agentId } })).toBe(1);
      const set = await db.planSet.findFirstOrThrow({ where: { agentId } });
      expect(set).toMatchObject({ publishLeaseRunId: null, publishLeaseUntil: null });
      expect(await db.document.count({ where: { planSetId: set.id, planPath: "plan.md" } })).toBe(1);
      expect([await marker(a), await marker(b)]).toEqual(["published", "published"]);
    } finally {
      await small.$disconnect();
    }
  });

  it("an expired lease is taken over: the old publisher stops and never writes published", async () => {
    const agentId = await planner();
    const files = (tag: string) => [
      { path: "plan.md", content: `# Plan\n\n${tag}\n` },
      { path: "api.md", content: `# API\n\n${tag}\n` },
    ];
    const a = await makeRun(agentId, files("a"));
    const b = await makeRun(agentId, files("b"));
    let t = Date.now();
    const clock: PlanPublishClock = {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    };
    const { submitForReview: realSubmit } =
      await vi.importActual<typeof import("../documents/review.js")>("../documents/review.js");
    let planB: Awaited<ReturnType<typeof publishPlanFromRun>> = null;
    // a stalls in its first submit (plan.md) past its lease; b takes the set over and finishes.
    vi.mocked(submitForReview).mockImplementationOnce(async (...args) => {
      t += PLAN_PUBLISH_LEASE_MS + 1;
      planB = await publishPlanFromRun(db, { ...deps, clock }, b);
      return realSubmit(...args);
    });
    expect(await publishPlanFromRun(db, { ...deps, clock }, a)).toEqual({ number: 12, error: "plan_publish_busy" });
    expect(
      published(planB)
        .documents.map((d) => d.path)
        .sort(),
    ).toEqual(["api.md", "plan.md"]);
    expect(await marker(b)).toBe("published");
    expect(await marker(a)).toBe("plan_publish_busy");
    expect(await planSummaryForRun(db, a, null)).toEqual({ number: 12, error: "plan_publish_busy" });
    const set = await db.planSet.findFirstOrThrow({ where: { agentId } });
    expect(set).toMatchObject({ publishLeaseRunId: null, publishLeaseUntil: null });
    // a stopped before api.md: b made it, and no document has a version from a past its first step.
    const docs = await db.document.findMany({ where: { planSetId: set.id }, select: { id: true, planPath: true } });
    expect(docs.map((d) => d.planPath).sort()).toEqual(["api.md", "plan.md"]);
    const api = docs.find((d) => d.planPath === "api.md")!;
    expect(await db.documentVersion.count({ where: { documentId: api.id, runId: a } })).toBe(0);
  });

  it("a lease another publish keeps renewing: the waiter gives up at the bound with plan_publish_busy", async () => {
    const agentId = await planner();
    const first = await makeRun(agentId, [{ path: "plan.md", content: "# Plan\n" }]);
    published(await publishPlanFromRun(db, deps, first));
    let t = Date.now();
    let waited = 0;
    const clock: PlanPublishClock = {
      now: () => t,
      sleep: async (ms) => {
        waited += ms;
        t += ms;
      },
    };
    const set = await db.planSet.findFirstOrThrow({ where: { agentId } });
    const until = new Date(t + 10 * PLAN_PUBLISH_WAIT_MS);
    await db.planSet.update({ where: { id: set.id }, data: { publishLeaseRunId: first, publishLeaseUntil: until } });
    const runId = await makeRun(agentId, [{ path: "plan.md", content: "# Plan\n\nchanged\n" }]);
    expect(await publishPlanFromRun(db, { ...deps, clock }, runId)).toEqual({ number: 12, error: "plan_publish_busy" });
    expect(waited).toBeGreaterThanOrEqual(PLAN_PUBLISH_WAIT_MS);
    expect(waited).toBeLessThan(PLAN_PUBLISH_WAIT_MS + 5_000);
    expect(await marker(runId)).toBe("plan_publish_busy");
    expect(await planSummaryForRun(db, runId, null)).toEqual({ number: 12, error: "plan_publish_busy" });
    expect(await db.documentVersion.count({ where: { runId } })).toBe(0);
    // The holder's lease is untouched.
    expect(await db.planSet.findUniqueOrThrow({ where: { id: set.id } })).toMatchObject({
      publishLeaseRunId: first,
      publishLeaseUntil: until,
    });
  });

  it("a submit that fails mid-set: the rest still publish, the failure is recorded, and a retry leaves no draft", async () => {
    const agentId = await planner();
    const runId = await makeRun(agentId, [
      { path: "plan.md", content: "# Plan\n" },
      { path: "api.md", content: "# API\n" },
    ]);
    vi.mocked(submitForReview).mockRejectedValueOnce(new Error("submit failed"));
    await expect(publishPlanFromRun(db, deps, runId)).rejects.toThrow("submit failed");
    expect(await marker(runId)).toBe("plan_publish_failed");
    expect(await planSummaryForRun(db, runId, null)).toEqual({ number: 12, error: "plan_publish_failed" });
    const set = await db.planSet.findFirstOrThrow({ where: { agentId } });
    const states = async () =>
      Object.fromEntries(
        (await db.document.findMany({ where: { planSetId: set.id } })).map((d) => [d.planPath, d.reviewState]),
      );
    // plan.md is first: its submit failed, and api.md was still published after it.
    expect(await states()).toEqual({ "plan.md": "draft", "api.md": "in_review" });
    const retry = published(await publishPlanFromRun(db, deps, runId));
    expect(changes(retry)).toEqual({ "plan.md": "created", "api.md": "created" });
    expect(await states()).toEqual({ "plan.md": "in_review", "api.md": "in_review" });
    expect(await marker(runId)).toBe("published");
    expect(await planSummaryForRun(db, runId, null)).toEqual(retry);
  });

  it("a final approver who no longer exists or has no access to the access agent is dropped, not fatal", async () => {
    const approver = await db.principal.create({ data: { subject: `plan-pub-approver-${s}` } });
    const agentId = await makeAgent("coding", {
      store: "wardby",
      reviewers: [owner.id],
      finalApproverId: approver.id,
      onApproved: "notify",
    });
    await grantRead(agentId, approver.id);
    const first = published(
      await publishPlanFromRun(db, deps, await makeRun(agentId, [{ path: "a.md", content: "# A" }])),
    );
    expect(first.skippedReviewers).toEqual([]);
    expect((await db.document.findUniqueOrThrow({ where: { id: first.documents[0].id } })).finalApproverId).toBe(
      approver.id,
    );
    await db.resourceGrant.deleteMany({ where: { resourceType: "agent", resourceId: agentId } });
    const runId = await makeRun(agentId, [
      { path: "a.md", content: "# A" },
      { path: "b.md", content: "# B" },
    ]);
    const second = published(await publishPlanFromRun(db, deps, runId));
    expect(second.skippedReviewers).toEqual([approver.id]);
    const added = await db.document.findUniqueOrThrow({
      where: { id: second.documents.find((d) => d.path === "b.md")!.id },
    });
    expect(added).toMatchObject({ reviewState: "in_review", finalApproverId: null });
    expect(await planSummaryForRun(db, runId, null)).toEqual(second);
    await db.principal.delete({ where: { id: approver.id } }).catch(() => undefined);
  });
});
