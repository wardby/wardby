/**
 * Plan approval (docs/private spec §7b) against real PostgreSQL: the review event that approves a
 * set's last counted document posts a notice ("notify") or starts the builder for ticket 1
 * ("build"), once per approval. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../db.js";
import { documentSecretValues } from "../documents/redact.js";
import { reopenDocument, reviewDocument, submitForReview } from "../documents/review.js";
import { attachSecret, createSecret } from "../secrets.js";
import {
  createPlanChainHook,
  createPlanReviewHook,
  defuseNotice,
  issueNoticePoster,
  planApprovedNotice,
  planBuildStartedNotice,
  runningPlanTicket,
  setPlanReviewHook,
  type PlanApprovalDeps,
  type StartTicketInput,
  type StartTicketResult,
} from "./approval.js";
import { createPlanSetFixture, type FixtureDocument } from "./build.test-support.js";
import { publishPlanFromRun } from "./publish.js";

const FAKE_SECRET = "wardby-fake-approval-secret-9d3a";
/** A fake secret with Markdown punctuation: escaping it before redaction would let it through. */
const FAKE_NAME_SECRET = "abc_def_123_fake";
const PLAN_MD = `# Plan\n\nkey ${FAKE_SECRET}\n\n## Tickets\n### Ticket 1: Login\n### Ticket 2: Feed\n`;
const SCREENS = {
  "manifest.json": '{"boards":[{"id":"home","title":"Home"}]}',
  "boards/home.html": "<main>Home</main>",
};
const APPROVED = "Plan 12 approved (plan.md v3, api.md v1, screens v2).";

describe.skipIf(!process.env.DATABASE_URL)("plan approval (database)", { timeout: 30_000 }, () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID().slice(0, 8);
  const repository = `o/r-${s}`;
  let owner: Principal;
  let ada: Principal;
  const agents: string[] = [];
  let n = 0;

  let notices: { issueKey: string | null; text: string }[];
  let starts: StartTicketInput[];
  let startResult: StartTicketResult;
  let handle: string | null;
  let background: Promise<void>[] = [];
  /** Awaits the work the hook started in the background (the notice and the ticket start). */
  const settle = async () => {
    while (background.length > 0) await background.shift();
  };
  const deps: PlanApprovalDeps = {
    postIssueNotice: async (set, text) => {
      notices.push({ issueKey: set.issueKey, text });
    },
    startTicket: async (input) => {
      starts.push(input);
      return startResult;
    },
    mentionHandle: async () => handle,
    secretValues: (agentId) => documentSecretValues(db, cipher, agentId),
    track: (work) => {
      background.push(work);
    },
  };

  beforeAll(async () => {
    owner = await db.principal.create({ data: { subject: `appr-owner-${s}` } });
    ada = await db.principal.create({ data: { subject: `appr-ada-${s}` } });
    await db.principalProfile.create({ data: { principalId: ada.id, displayName: "Ada", source: "oidc" } });
    await createSecret(`APPR_KEY_${s}`, FAKE_SECRET, owner.id, cipher, db);
    await createSecret(`APPR_NAME_${s}`, FAKE_NAME_SECRET, owner.id, cipher, db);
    setPlanReviewHook(createPlanReviewHook(deps));
  });
  beforeEach(() => {
    notices = [];
    starts = [];
    startResult = { runId: "run-1" };
    handle = "wardby";
    background = [];
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    setPlanReviewHook(undefined);
    await db.document.deleteMany({ where: { ownerId: owner.id } });
    await db.planSet.deleteMany({ where: { agentId: { in: agents } } });
    await db.run.deleteMany({ where: { agentId: { in: agents } } });
    await db.agentSecret.deleteMany({ where: { agentId: { in: agents } } });
    await db.secret.deleteMany({ where: { ownerId: owner.id } });
    await db.agent.deleteMany({ where: { id: { in: agents } } });
    await db.principalProfile.deleteMany({ where: { principalId: ada.id } });
    await db.resourceGrant.deleteMany({ where: { granteePrincipalId: { in: [owner.id, ada.id] } } });
    await db.principal.deleteMany({ where: { id: { in: [owner.id, ada.id] } } });
    await db.$disconnect();
  });

  async function makeAgent(profile: object): Promise<string> {
    const agent = await db.agent.create({
      data: {
        name: `appr-${s}-${++n}`,
        systemPrompt: "p",
        model: "m",
        budgetUsd: 1,
        ownerId: owner.id,
        kind: "coding",
        codingProfile: { create: { repository, protectedPaths: [], ...profile } },
      },
    });
    agents.push(agent.id);
    return agent.id;
  }

  const as = (p: Principal) => ({ kind: "principal" as const, principalId: p.id });

  /** A planner and its set #12: every document in review by Ada, unless a document says otherwise. */
  async function makeSet(
    planDocument: object,
    documents: FixtureDocument[] = [
      { path: "plan.md", content: PLAN_MD, version: 3, reviewState: "draft" },
      { path: "api.md", content: "# API\n", version: 1, reviewState: "draft" },
      { path: "screens/", content: SCREENS, version: 2, reviewState: "draft" },
    ],
  ) {
    const plannerId = await makeAgent({ planDocument: { store: "wardby", reviewers: [ada.id], ...planDocument } });
    await attachSecret(plannerId, `APPR_KEY_${s}`, owner.id, db);
    await attachSecret(plannerId, `APPR_NAME_${s}`, owner.id, db);
    const fixture = await createPlanSetFixture(db, { plannerId, ownerId: owner.id, repository, number: 12, documents });
    await db.planSet.update({
      where: { id: fixture.planSetId },
      data: { issueProvider: "github", issueKey: `o/r-${s}#12` },
    });
    for (const doc of documents) {
      if (doc.reviewState === "draft") {
        await submitForReview(db, {
          documentId: fixture.documentIds[doc.path],
          viewer: as(owner),
          reviewers: [ada.id],
        });
      }
    }
    return { plannerId, ...fixture };
  }

  const approve = async (documentId: string) => {
    const doc = await db.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { currentVersion: { select: { number: true } } },
    });
    await reviewDocument(db, cipher, {
      documentId,
      viewer: as(ada),
      verdict: "approve",
      versionNumber: doc.currentVersion!.number,
    });
    await settle();
  };
  const approveAll = async (ids: Record<string, string>) => {
    for (const id of Object.values(ids)) await approve(id);
  };
  const setRow = (id: string) => db.planSet.findUniqueOrThrow({ where: { id } });

  it("notify: the last approval posts one notice with the hint; a reopen and a new approval post again", async () => {
    const { planSetId, documentIds } = await makeSet({ onApproved: "notify" });
    await approve(documentIds["plan.md"]);
    await approve(documentIds["api.md"]);
    expect(notices).toEqual([]);
    expect((await setRow(planSetId)).approvedAt).toBeNull();
    await approve(documentIds["screens/"]);
    expect(notices).toEqual([
      {
        issueKey: `o/r-${s}#12`,
        text: `${APPROVED} Comment \`@wardby build ticket <t>\` to build.`,
      },
    ]);
    expect((await setRow(planSetId)).approvedAt).not.toBeNull();
    // A repeat verdict (a no-op) and another review event while it stays approved: no second notice.
    await approve(documentIds["screens/"]);
    await setPlanReviewHookCall(documentIds["api.md"]);
    expect(notices).toHaveLength(1);
    expect(starts).toEqual([]);

    await reopenDocument(db, cipher, { documentId: documentIds["api.md"], viewer: as(owner) });
    expect((await setRow(planSetId)).approvedAt).toBeNull();
    expect(notices).toHaveLength(1);
    await approve(documentIds["api.md"]);
    expect(notices).toHaveLength(2);
    expect(notices[1].text).toBe(
      "Plan 12 approved (plan.md v3, api.md v2, screens v2). Comment `@wardby build ticket <t>` to build.",
    );
  });

  /** Fires the hook directly, as another review event on the set would. */
  async function setPlanReviewHookCall(documentId: string) {
    await createPlanReviewHook(deps)(db, documentId, ada.id);
    await settle();
  }

  it("notify without an App handle, or on a Jira issue (the command is a GitHub mention): no hint", async () => {
    handle = null;
    const first = await makeSet({ onApproved: "notify" });
    await approveAll(first.documentIds);
    expect(notices.map((x) => x.text)).toEqual([APPROVED]);

    handle = "wardby";
    notices = [];
    const jira = await makeSet({ onApproved: "notify" });
    await db.planSet.update({ where: { id: jira.planSetId }, data: { issueProvider: "jira", issueKey: "PLAN-12" } });
    await approveAll(jira.documentIds);
    expect(notices).toEqual([{ issueKey: "PLAN-12", text: APPROVED }]);
  });

  it("build: ticket 1 starts once, started by the approver, and the notice names them (R12)", async () => {
    const builder = await makeAgent({ buildFromPlan: true });
    const { planSetId, documentIds } = await makeSet({ onApproved: "build", builderAgentId: builder });
    await approveAll(documentIds);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      builderAgentId: builder,
      ticket: 1,
      trigger: "plan_approved",
      starterId: ada.id,
    });
    expect(starts[0].set).toMatchObject({ id: planSetId, number: 12 });
    expect(starts[0].set).not.toHaveProperty("documents");
    expect(await setRow(planSetId)).toMatchObject({ chainTicket: 1, chainStopped: null });
    expect(notices.map((x) => x.text)).toEqual([`${APPROVED}\nPlan 12: building ticket 1, started by Ada.`]);
  });

  it("R12: a builder that cannot build any more stops with plan_builder_invalid and starts nothing", async () => {
    const builder = await makeAgent({ buildFromPlan: true });
    const { planSetId, documentIds } = await makeSet({ onApproved: "build", builderAgentId: builder });
    await db.codingAgentProfile.update({ where: { agentId: builder }, data: { buildFromPlan: false } });
    await approveAll(documentIds);
    expect(starts).toEqual([]);
    expect(notices.map((x) => x.text)).toEqual([
      "Plan 12 approved, but its builder cannot build it now (plan_builder_invalid). Comment `@wardby build ticket 1` once it is fixed.",
    ]);
    expect((await setRow(planSetId)).chainStopped).toBe("plan_builder_invalid");
  });

  it("a refused start stops the chain; a running ticket is reported", async () => {
    const builder = await makeAgent({ buildFromPlan: true });
    startResult = { refused: "plan_not_approved" };
    const first = await makeSet({ onApproved: "build", builderAgentId: builder });
    await approveAll(first.documentIds);
    expect((await setRow(first.planSetId)).chainStopped).toBe("plan_not_approved");
    expect(notices.map((x) => x.text)).toEqual([`${APPROVED}\nPlan 12: ticket 1 did not start (plan_not_approved).`]);

    notices = [];
    startResult = { running: 1 };
    const second = await makeSet({ onApproved: "build", builderAgentId: builder });
    await approveAll(second.documentIds);
    expect(notices.map((x) => x.text)).toEqual([`${APPROVED}\nPlan 12: already building ticket 1.`]);

    notices = [];
    // A refusal that is not a bare code is never quoted.
    startResult = { refused: "Something: with @people and text" };
    const third = await makeSet({ onApproved: "build", builderAgentId: builder });
    await approveAll(third.documentIds);
    expect(notices.map((x) => x.text)).toEqual([`${APPROVED}\nPlan 12: ticket 1 did not start (refused).`]);

    notices = [];
    // A start that throws stops the chain with a notice.
    const throwing = vi.spyOn(deps, "startTicket").mockRejectedValueOnce(new Error(`boom ${FAKE_SECRET}`));
    const fourth = await makeSet({ onApproved: "build", builderAgentId: builder });
    await approveAll(fourth.documentIds);
    expect(throwing).toHaveBeenCalledTimes(1);
    expect((await setRow(fourth.planSetId)).chainStopped).toBe("start_failed");
    expect(notices.map((x) => x.text)).toEqual([`${APPROVED}\nPlan 12: ticket 1 did not start (start_failed).`]);
  });

  it("build: a plan.md without tickets asks for build ticket <t> and starts nothing", async () => {
    const builder = await makeAgent({ buildFromPlan: true });
    const { documentIds } = await makeSet({ onApproved: "build", builderAgentId: builder }, [
      { path: "plan.md", content: "# Plan\n\nNo tickets here.\n", version: 1, reviewState: "draft" },
    ]);
    await approveAll(documentIds);
    expect(starts).toEqual([]);
    expect(notices.map((x) => x.text)).toEqual([
      "Plan 12 approved, but plan.md has no `## Tickets` section with `### Ticket <t>:` headings. Comment `@wardby build ticket <t>` to build one.",
    ]);
  });

  it("removing the last waiting document (a publish) is the approving event", async () => {
    const { plannerId, planSetId, documentIds } = await makeSet({ onApproved: "notify" }, [
      { path: "plan.md", content: PLAN_MD, version: 3 },
      { path: "api.md", content: "# API\n", version: 1 },
      { path: "screens/", content: SCREENS, version: 2, reviewState: "draft" },
    ]);
    expect(documentIds["screens/"]).toBeDefined();
    const run = await db.run.create({ data: { agentId: plannerId, status: "succeeded", trigger: "manual" } });
    await db.codingRun.create({
      data: {
        runId: run.id,
        task: "t",
        repository,
        baseRef: "main",
        headRef: `wardby/run-${run.id}`,
        provider: "codex",
        model: "m",
        timeoutSec: 60,
        protectedPaths: [],
        budgetReservedUsd: 0.1,
        collectPlanFiles: true,
        planNumber: 12,
        planFilesStatus: "stored",
      },
    });
    await db.codingRunPlanFile.createMany({
      data: [
        { runId: run.id, direction: "output", path: "plan.md", content: PLAN_MD },
        { runId: run.id, direction: "output", path: "api.md", content: "# API\n" },
      ],
    });
    expect(notices).toEqual([]);
    await publishPlanFromRun(db, { cipher, origin: null }, run.id);
    await settle();
    expect(notices.map((x) => x.text)).toEqual([
      "Plan 12 approved (plan.md v3, api.md v1). Comment `@wardby build ticket <t>` to build.",
    ]);
    expect((await setRow(planSetId)).approvedAt).not.toBeNull();
  });

  it("secrets: a secret in plan.md or in a plan path never reaches a notice", async () => {
    const { documentIds } = await makeSet({ onApproved: "notify" }, [
      { path: "plan.md", content: PLAN_MD, version: 3, reviewState: "draft" },
      { path: `notes-${FAKE_SECRET}.md`, content: "# Notes\n", version: 1, reviewState: "draft" },
    ]);
    await approveAll(documentIds);
    expect(notices).toHaveLength(1);
    expect(notices[0].text).not.toContain(FAKE_SECRET);
    expect(notices[0].text).toContain("notes-[REDACTED].md v1");
  });

  it("defuseNotice: names and paths ping nobody; the code-span hint stays copyable", () => {
    expect(defuseNotice("by @ada; `@wardby build ticket 1`")).toBe("by @\u200bada; `@wardby build ticket 1`");
    // A display name is people-written: no code span to hide a mention in, Markdown escaped, one line.
    expect(defuseNotice(planBuildStartedNotice(12, 1, "@eve `@x`\n*b* [l](u)"))).toBe(
      "Plan 12: building ticket 1, started by @\u200beve @\u200bx \\*b\\* \\[l\\](u).",
    );
  });

  it("secrets: an approver's name is redacted before it is escaped, so a secret with `_` never gets through", async () => {
    await db.principalProfile.update({
      where: { principalId: ada.id },
      data: { displayName: `Ada ${FAKE_NAME_SECRET}` },
    });
    try {
      const builder = await makeAgent({ buildFromPlan: true });
      const { documentIds } = await makeSet({ onApproved: "build", builderAgentId: builder });
      await approveAll(documentIds);
      expect(notices).toHaveLength(1);
      expect(notices[0].text).not.toContain(FAKE_NAME_SECRET);
      expect(notices[0].text).not.toContain("abc\\_def\\_123\\_fake");
      expect(notices[0].text).not.toContain("def");
      expect(notices[0].text).toContain("started by Ada \\[REDACTED\\].");
    } finally {
      await db.principalProfile.update({ where: { principalId: ada.id }, data: { displayName: "Ada" } });
    }
  });

  it("bare URLs in a name or a path are not autolinked", () => {
    expect(planBuildStartedNotice(12, 1, "Eve https://evil.example/x www.evil.example HTTP://b.example")).toBe(
      "Plan 12: building ticket 1, started by Eve https\u200b://evil.example/x www\u200b.evil.example HTTP\u200b://b.example.",
    );
    expect(
      planApprovedNotice(
        12,
        [{ documentId: "d", path: "see-www.x.io/http://y.md", kind: "document", versionNumber: 1 }],
        null,
      ),
    ).toBe("Plan 12 approved (see-www\u200b.x.io/http\u200b://y.md v1).");
  });

  it("two final verdicts on different documents at the same time: one notice, one ticket-1 start", async () => {
    const builder = await makeAgent({ buildFromPlan: true });
    const { planSetId, documentIds } = await makeSet({ onApproved: "build", builderAgentId: builder });
    await approve(documentIds["plan.md"]);
    await Promise.all([approve(documentIds["api.md"]), approve(documentIds["screens/"])]);
    await settle();
    expect(starts).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect((await setRow(planSetId)).approvedAt).not.toBeNull();
  });

  it("a hook decides on the state it sees under the set's row lock: a late clear never wipes a fresh approval", async () => {
    const { planSetId, documentIds } = await makeSet({ onApproved: "notify" });
    await approveAll(documentIds);
    const approvedAt = (await setRow(planSetId)).approvedAt;
    expect(approvedAt).not.toBeNull();
    notices = [];

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "PlanSet" WHERE "id" = ${planSetId} FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    // api.md is reopened and its hook starts, but must wait for the set's row.
    await db.document.update({ where: { id: documentIds["api.md"] }, data: { reviewState: "in_review" } });
    const late = createPlanReviewHook(deps)(db, documentIds["api.md"], null);
    await waitForLockWaiter();
    // Meanwhile api.md is approved again (its own hook found the set still approved: nothing to do).
    await db.document.update({ where: { id: documentIds["api.md"] }, data: { reviewState: "approved" } });
    release();
    await holder;
    await late;
    await settle();
    expect((await setRow(planSetId)).approvedAt).toEqual(approvedAt);
    expect(notices).toEqual([]);
  });

  /** Until a session of this database waits on a row lock of PlanSet. */
  async function waitForLockWaiter() {
    for (let i = 0; i < 200; i++) {
      const rows = await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%PlanSet%'`;
      if (Number(rows[0].n) > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("no hook waited on the set's row lock");
  }

  it("a reopen keeps a recorded stop code; it records reopened only when none is recorded", async () => {
    const builder = await makeAgent({ buildFromPlan: true });
    startResult = { refused: "plan_not_approved" };
    const stopped = await makeSet({ onApproved: "build", builderAgentId: builder });
    await approveAll(stopped.documentIds);
    expect((await setRow(stopped.planSetId)).chainStopped).toBe("plan_not_approved");
    await reopenDocument(db, cipher, { documentId: stopped.documentIds["api.md"], viewer: as(owner) });
    expect(await setRow(stopped.planSetId)).toMatchObject({ approvedAt: null, chainStopped: "plan_not_approved" });

    startResult = { runId: "run-2" };
    const running = await makeSet({ onApproved: "build", builderAgentId: builder });
    await approveAll(running.documentIds);
    expect((await setRow(running.planSetId)).chainStopped).toBeNull();
    await reopenDocument(db, cipher, { documentId: running.documentIds["api.md"], viewer: as(owner) });
    expect(await setRow(running.planSetId)).toMatchObject({ approvedAt: null, chainStopped: "reopened" });
  });

  it("build: the approving request does not wait for the ticket start; a failed start still posts start_failed", async () => {
    const builder = await makeAgent({ buildFromPlan: true });
    const { planSetId, documentIds } = await makeSet({ onApproved: "build", builderAgentId: builder });
    await approve(documentIds["plan.md"]);
    await approve(documentIds["api.md"]);
    let fail!: (err: Error) => void;
    vi.spyOn(deps, "startTicket").mockImplementationOnce(
      () => new Promise<StartTicketResult>((_resolve, reject) => (fail = reject)),
    );
    const doc = await db.document.findUniqueOrThrow({
      where: { id: documentIds["screens/"] },
      select: { currentVersion: { select: { number: true } } },
    });
    const review = reviewDocument(db, cipher, {
      documentId: documentIds["screens/"],
      viewer: as(ada),
      verdict: "approve",
      versionNumber: doc.currentVersion!.number,
    }).then(() => "returned" as const);
    const timeout = new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 3_000));
    expect(await Promise.race([review, timeout])).toBe("returned");
    expect(notices).toEqual([]);
    await vi.waitFor(() => expect(fail).toBeDefined());
    fail(new Error(`boom ${FAKE_SECRET}`));
    await settle();
    expect((await setRow(planSetId)).chainStopped).toBe("start_failed");
    expect(notices.map((x) => x.text)).toEqual([`${APPROVED}\nPlan 12: ticket 1 did not start (start_failed).`]);
  });

  it("runningPlanTicket: a pending ticket run of the set, until it ends", async () => {
    const builder = await makeAgent({ buildFromPlan: true });
    const { planSetId } = await makeSet({ onApproved: "notify" }, [{ path: "plan.md", content: PLAN_MD, version: 1 }]);
    expect(await runningPlanTicket(db, planSetId)).toBeNull();
    const run = await db.run.create({ data: { agentId: builder, status: "pending", trigger: "plan_approved" } });
    await db.codingRun.create({
      data: {
        runId: run.id,
        task: "t",
        repository,
        baseRef: "main",
        headRef: `wardby/run-${run.id}`,
        provider: "codex",
        model: "m",
        timeoutSec: 60,
        protectedPaths: [],
        budgetReservedUsd: 0.1,
        planSetId,
        planTicket: 2,
      },
    });
    expect(await runningPlanTicket(db, planSetId)).toBe(2);
    await db.run.update({ where: { id: run.id }, data: { status: "succeeded" } });
    expect(await runningPlanTicket(db, planSetId)).toBeNull();
  });

  describe("build chain", () => {
    const chain = () => createPlanChainHook(deps);
    let pr = 4000;
    /** A ticket run of the builder on the set, with the PR it opened (when given). */
    async function ticketRun(
      builder: string,
      planSetId: string | null,
      planTicket: number | null,
      status: "pending" | "running" | "succeeded" | "failed" | "cancelled",
      prNumber?: number,
    ) {
      const run = await db.run.create({ data: { agentId: builder, status, trigger: "plan_approved" } });
      await db.codingRun.create({
        data: {
          runId: run.id,
          task: "t",
          repository,
          baseRef: "main",
          headRef: `wardby/run-${run.id}`,
          provider: "codex",
          model: "m",
          timeoutSec: 60,
          protectedPaths: [],
          budgetReservedUsd: 0.1,
          planSetId,
          planTicket,
          ...(prNumber !== undefined ? { result: { pullRequestNumber: prNumber } } : {}),
        },
      });
      return run.id;
    }
    /** A "build" plan approved with ticket 1 started; the notices and starts of the approval cleared. */
    async function building() {
      const builder = await makeAgent({ buildFromPlan: true });
      const made = await makeSet({ onApproved: "build", builderAgentId: builder });
      await approveAll(made.documentIds);
      expect(await setRow(made.planSetId)).toMatchObject({ chainTicket: 1, chainStopped: null });
      notices = [];
      starts = [];
      return { builder, ...made };
    }
    const merged = (number: number, isMerged = true) => chain().onMerged(db, { repository, number, merged: isMerged });

    it("ticket 1 merged starts ticket 2; ticket 2 merged ends the chain", async () => {
      const { builder, planSetId } = await building();
      const first = ++pr;
      await ticketRun(builder, planSetId, 1, "succeeded", first);
      await merged(first);
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        builderAgentId: builder,
        ticket: 2,
        trigger: "plan_approved",
        starterId: null,
      });
      expect(starts[0].set).toMatchObject({ id: planSetId, number: 12 });
      expect((await setRow(planSetId)).chainTicket).toBe(2);
      expect(notices.map((x) => x.text)).toEqual(["Plan 12: building ticket 2."]);

      notices = [];
      starts = [];
      const second = ++pr;
      await ticketRun(builder, planSetId, 2, "succeeded", second);
      await merged(second);
      expect(starts).toEqual([]);
      expect(notices.map((x) => x.text)).toEqual(["Plan 12: all 2 tickets built."]);
      expect(await setRow(planSetId)).toMatchObject({ chainTicket: null, chainStopped: null });
      // A repeat delivery of the last merge posts nothing more.
      await merged(second);
      expect(notices).toHaveLength(1);
      // Notices never carry a ticket title or plan text.
      for (const notice of notices) {
        expect(notice.text).not.toContain("Feed");
        expect(notice.text).not.toContain(FAKE_SECRET);
      }
    });

    it("a closed but unmerged PR does nothing", async () => {
      const { builder, planSetId } = await building();
      const number = ++pr;
      await ticketRun(builder, planSetId, 1, "succeeded", number);
      await merged(number, false);
      expect(starts).toEqual([]);
      expect(notices).toEqual([]);
      expect((await setRow(planSetId)).chainTicket).toBe(1);
    });

    it("two deliveries of the same merge start one run", async () => {
      const { builder, planSetId } = await building();
      const number = ++pr;
      await ticketRun(builder, planSetId, 1, "succeeded", number);
      await Promise.all([merged(number), merged(number)]);
      expect(starts).toHaveLength(1);
      expect(notices).toHaveLength(1);
      expect((await setRow(planSetId)).chainTicket).toBe(2);
    });

    it("a failed ticket run stops the chain; a later merge of its PR starts nothing", async () => {
      const { builder, planSetId } = await building();
      const number = ++pr;
      const runId = await ticketRun(builder, planSetId, 1, "failed", number);
      await chain().onTicketFinished(db, runId);
      expect(notices.map((x) => x.text)).toEqual([
        "Plan 12 stopped at ticket 1 (failed). Comment `@wardby build ticket 1` to continue.",
      ]);
      expect((await setRow(planSetId)).chainStopped).toBe("failed");
      // A second terminal call (a repeat) posts nothing more.
      await chain().onTicketFinished(db, runId);
      expect(notices).toHaveLength(1);
      await merged(number);
      expect(starts).toEqual([]);
      expect(notices).toHaveLength(1);
    });

    it("a stop without an App handle has no hint; a succeeded or non-ticket run does nothing", async () => {
      const { builder, planSetId } = await building();
      const succeeded = await ticketRun(builder, planSetId, 1, "succeeded");
      await chain().onTicketFinished(db, succeeded);
      const planless = await ticketRun(builder, null, null, "failed");
      await chain().onTicketFinished(db, planless);
      const noTicket = await ticketRun(builder, planSetId, null, "failed");
      await chain().onTicketFinished(db, noTicket);
      expect(notices).toEqual([]);
      expect((await setRow(planSetId)).chainStopped).toBeNull();

      handle = null;
      const cancelled = await ticketRun(builder, planSetId, 1, "cancelled");
      await chain().onTicketFinished(db, cancelled);
      expect(notices.map((x) => x.text)).toEqual(["Plan 12 stopped at ticket 1 (cancelled)."]);
    });

    it("a reopen of any document stops the chain before its next ticket", async () => {
      const { builder, planSetId, documentIds } = await building();
      const number = ++pr;
      await ticketRun(builder, planSetId, 1, "succeeded", number);
      await reopenDocument(db, cipher, { documentId: documentIds["api.md"], viewer: as(owner) });
      expect((await setRow(planSetId)).chainStopped).toBe("reopened");
      await merged(number);
      expect(starts).toEqual([]);
      expect(notices).toEqual([]);
      expect((await setRow(planSetId)).chainTicket).toBe(1);
    });

    it("never more than one run at a time: a pending ticket run of the set holds the next start", async () => {
      const { builder, planSetId } = await building();
      const number = ++pr;
      await ticketRun(builder, planSetId, 1, "succeeded", number);
      await ticketRun(builder, planSetId, 2, "pending");
      await merged(number);
      expect(starts).toEqual([]);
      expect(notices).toEqual([]);
      expect((await setRow(planSetId)).chainTicket).toBe(1);
    });

    it("an approval that finds ticket 2 already running follows that ticket: its merge ends the chain", async () => {
      const builder = await makeAgent({ buildFromPlan: true });
      startResult = { running: 2 };
      const { planSetId, documentIds } = await makeSet({ onApproved: "build", builderAgentId: builder });
      await approveAll(documentIds);
      expect(await setRow(planSetId)).toMatchObject({ chainTicket: 2, chainStopped: null });
      notices = [];
      const number = ++pr;
      await ticketRun(builder, planSetId, 2, "succeeded", number);
      await merged(number);
      expect(starts).toHaveLength(1);
      expect(notices.map((x) => x.text)).toEqual(["Plan 12: all 2 tickets built."]);
    });

    it("a next start that throws or is refused stops the chain with a notice", async () => {
      const { builder, planSetId } = await building();
      const number = ++pr;
      await ticketRun(builder, planSetId, 1, "succeeded", number);
      vi.spyOn(deps, "startTicket").mockRejectedValueOnce(new Error(`boom ${FAKE_SECRET}`));
      await merged(number);
      expect(await setRow(planSetId)).toMatchObject({ chainTicket: 2, chainStopped: "start_failed" });
      expect(notices.map((x) => x.text)).toEqual(["Plan 12: ticket 2 did not start (start_failed)."]);
    });
  });

  it("issueNoticePoster: GitHub comments on the key's issue; Jira only through a write link, with its visibility", async () => {
    const github = { comment: vi.fn(async () => ({ url: "u", id: "1" })) };
    const jira = { comment: vi.fn(async () => ({ url: "u", id: "1" })) };
    const plannerId = await makeAgent({});
    const post = issueNoticePoster({
      db,
      reviewHosts: { github } as never,
      issueTrackers: { jira } as never,
    });
    await post({ issueProvider: "github", issueKey: "acme/web#7", repository: "acme/other" }, "hello");
    expect(github.comment).toHaveBeenCalledWith("acme/web", { number: 7, body: "hello" });
    await post({ issueProvider: "jira", issueKey: "PLAN-3", repository: "x/y", agentIds: [plannerId] }, "hi");
    expect(jira.comment).not.toHaveBeenCalled();
    await db.agentIssueProject.create({
      data: {
        agentId: plannerId,
        provider: "jira",
        projectKey: "PLAN",
        access: "write",
        commentVisibilityRole: "Developers",
        authorizedById: owner.id,
      },
    });
    await post({ issueProvider: "jira", issueKey: "PLAN-3", repository: "x/y", agentIds: [plannerId] }, "hi");
    expect(jira.comment).toHaveBeenCalledWith("PLAN-3", { markdown: "hi", visibilityRole: "Developers" });
  });
});
