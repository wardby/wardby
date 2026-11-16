import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal, RunStatus } from "#prisma";
import { createPrismaClient } from "../db.js";
import { submitForReview } from "../documents/review.js";
import { createDocument, publishVersion } from "../documents/service.js";
import { principalGranteeKey } from "../grants.js";
import { attachSecret, createSecret } from "../secrets.js";
import { planRunFinishedHook } from "./hooks.js";
import { planSummaryForRun, publishPlanFromRun, type PublishedPlan } from "./publish.js";

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

  it("two concurrent first publishes for the same set make one set and one document per path", async () => {
    const agentId = await planner();
    const a = await makeRun(agentId, [{ path: "plan.md", content: "# Plan\n\na\n" }]);
    const b = await makeRun(agentId, [{ path: "plan.md", content: "# Plan\n\nb\n" }]);
    const [planA, planB] = await Promise.all([publishPlanFromRun(db, deps, a), publishPlanFromRun(db, deps, b)]);
    expect(published(planA).planSetId).toBe(published(planB).planSetId);
    expect(await db.planSet.count({ where: { agentId } })).toBe(1);
    expect(await db.document.count({ where: { planSetId: published(planA).planSetId, planPath: "plan.md" } })).toBe(1);
    expect([await marker(a), await marker(b)]).toEqual(["published", "published"]);
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
