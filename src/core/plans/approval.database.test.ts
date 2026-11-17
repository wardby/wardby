/**
 * Plan approval (docs/private spec §7b) against real PostgreSQL: the review event that approves a
 * set's last counted document posts a notice ("notify") or starts the builder for ticket 1
 * ("build"), once per approval. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "#prisma";
import type { Executor } from "../../providers/executor/types.js";
import { drainCodingQueue } from "../coding-queue.js";
import { markRunFailedFromExecutorError } from "../dispatch.js";
import { createPrismaClient } from "../db.js";
import { documentSecretValues } from "../documents/redact.js";
import { reopenDocument, reviewDocument, submitForReview } from "../documents/review.js";
import { attachSecret, createSecret } from "../secrets.js";
import {
  createPlanChainHook,
  createPlanReviewHook,
  defuseNotice,
  issueNoticePoster,
  lockPlanSetForTicketStart,
  planApprovedNotice,
  planTicketStartBlock,
  planBuildStartedNotice,
  runningPlanTicket,
  setPlanChainHook,
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
  /** "real": the start creates a running ticket run of the set and returns its id. */
  let startResult: StartTicketResult | "real";
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
      if (startResult !== "real") return startResult;
      return { runId: await ticketRun(input.builderAgentId, input.set.id, input.ticket, "running") };
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
    expect(await setRow(planSetId)).toMatchObject({
      chainTicket: 1,
      chainStopped: null,
      chainRunId: "run-1",
      approvedById: ada.id,
    });
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
    // The run the guard saw in flight: the chain follows it.
    const inFlight = await ticketRun(builder, second.planSetId, 1, "running");
    await approveAll(second.documentIds);
    expect((await setRow(second.planSetId)).chainRunId).toBe(inFlight);
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
    beforeEach(() => {
      startResult = "real";
    });
    afterEach(() => setPlanChainHook(undefined));
    /** A "build" plan approved by Ada, ticket 1's run started; the notices and starts of the approval cleared. */
    async function building() {
      const builder = await makeAgent({ buildFromPlan: true });
      const made = await makeSet({ onApproved: "build", builderAgentId: builder });
      await approveAll(made.documentIds);
      const row = await setRow(made.planSetId);
      expect(row).toMatchObject({ chainTicket: 1, chainStopped: null, approvedById: ada.id });
      expect(row.chainRunId).not.toBeNull();
      notices = [];
      starts = [];
      return { builder, run1: row.chainRunId!, ...made };
    }
    /** The run ends; a succeeded one opened `prNumber` (when given). */
    async function finish(runId: string, status: "succeeded" | "failed" | "cancelled", prNumber?: number) {
      await db.run.update({ where: { id: runId }, data: { status, finishedAt: new Date() } });
      if (prNumber !== undefined) {
        await db.codingRun.update({ where: { runId }, data: { result: { pullRequestNumber: prNumber } } });
      }
    }
    const closed = async (number: number, isMerged = true) => {
      await chain().onMerged(db, { repository, number, merged: isMerged });
      await settle();
    };
    const merged = (number: number) => closed(number, true);
    const finished = async (runId: string) => {
      await chain().onTicketFinished(db, runId);
      await settle();
    };

    it("ticket 1 merged starts ticket 2 as the approver; ticket 2 merged ends the chain", async () => {
      const { builder, planSetId, run1 } = await building();
      const first = ++pr;
      await finish(run1, "succeeded", first);
      await merged(first);
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        builderAgentId: builder,
        ticket: 2,
        trigger: "plan_approved",
        // Every ticket the approval starts records the approver as its starter.
        starterId: ada.id,
      });
      expect(starts[0].set).toMatchObject({ id: planSetId, number: 12 });
      const row = await setRow(planSetId);
      expect(row.chainTicket).toBe(2);
      expect(row.chainRunId).not.toBe(run1);
      expect(notices.map((x) => x.text)).toEqual(["Plan 12: building ticket 2."]);

      notices = [];
      starts = [];
      const second = ++pr;
      await finish(row.chainRunId!, "succeeded", second);
      await merged(second);
      expect(starts).toEqual([]);
      expect(notices.map((x) => x.text)).toEqual(["Plan 12: all 2 tickets built."]);
      expect(await setRow(planSetId)).toMatchObject({ chainTicket: null, chainStopped: null, chainRunId: null });
      // A repeat delivery of the last merge posts nothing more.
      await merged(second);
      expect(notices).toHaveLength(1);
      // Notices never carry a ticket title or plan text.
      for (const notice of notices) {
        expect(notice.text).not.toContain("Feed");
        expect(notice.text).not.toContain(FAKE_SECRET);
      }
    });

    it("a stale PR of the current ticket from before a reopen never moves the re-approved chain", async () => {
      const { planSetId, documentIds, run1 } = await building();
      const old = ++pr;
      await finish(run1, "succeeded", old);
      await reopenDocument(db, cipher, { documentId: documentIds["api.md"], viewer: as(owner) });
      expect(await setRow(planSetId)).toMatchObject({
        approvedAt: null,
        approvedById: null,
        chainStopped: "reopened",
        chainRunId: null,
      });
      await approve(documentIds["api.md"]);
      expect(starts.map((x) => x.ticket)).toEqual([1]);
      const again = await setRow(planSetId);
      expect(again).toMatchObject({ chainTicket: 1, chainStopped: null, approvedById: ada.id });
      expect(again.chainRunId).not.toBe(run1);

      starts = [];
      notices = [];
      await merged(old);
      expect(starts).toEqual([]);
      expect(notices).toEqual([]);
      expect(await setRow(planSetId)).toMatchObject({ chainTicket: 1, chainRunId: again.chainRunId });

      const fresh = ++pr;
      await finish(again.chainRunId!, "succeeded", fresh);
      await merged(fresh);
      expect(starts.map((x) => x.ticket)).toEqual([2]);
      expect((await setRow(planSetId)).chainTicket).toBe(2);
    });

    it("the current ticket's PR closed unmerged stops the chain; another PR's close does nothing", async () => {
      const { builder, planSetId, run1 } = await building();
      const other = ++pr;
      await ticketRun(builder, planSetId, 1, "succeeded", other);
      await closed(other, false);
      expect(notices).toEqual([]);
      expect((await setRow(planSetId)).chainStopped).toBeNull();

      const number = ++pr;
      await finish(run1, "succeeded", number);
      await closed(number, false);
      expect(starts).toEqual([]);
      expect(notices.map((x) => x.text)).toEqual([
        "Plan 12 stopped at ticket 1 (pr_closed). Comment `@wardby build ticket 1` to continue.",
      ]);
      expect(await setRow(planSetId)).toMatchObject({ chainTicket: 1, chainStopped: "pr_closed", chainRunId: null });
      // A repeat (the state sync settling the same close) posts nothing more; a later merge starts nothing.
      await closed(number, false);
      await merged(number);
      expect(notices).toHaveLength(1);
      expect(starts).toEqual([]);
    });

    it("two deliveries of the same merge start one run", async () => {
      const { planSetId, run1 } = await building();
      const number = ++pr;
      await finish(run1, "succeeded", number);
      await Promise.all([merged(number), merged(number)]);
      expect(starts).toHaveLength(1);
      expect(notices).toHaveLength(1);
      expect((await setRow(planSetId)).chainTicket).toBe(2);
    });

    it("a failed ticket run stops the chain; a later merge of its PR starts nothing", async () => {
      const { planSetId, run1 } = await building();
      const number = ++pr;
      await finish(run1, "failed", number);
      await finished(run1);
      expect(notices.map((x) => x.text)).toEqual([
        "Plan 12 stopped at ticket 1 (failed). Comment `@wardby build ticket 1` to continue.",
      ]);
      expect(await setRow(planSetId)).toMatchObject({ chainStopped: "failed", chainRunId: null });
      // A second terminal call (a repeat) posts nothing more.
      await finished(run1);
      expect(notices).toHaveLength(1);
      await merged(number);
      expect(starts).toEqual([]);
      expect(notices).toHaveLength(1);
    });

    it("a ticket run that succeeds without a PR stops the chain with no_pull_request", async () => {
      const { planSetId, run1 } = await building();
      await finish(run1, "succeeded");
      await finished(run1);
      expect(notices.map((x) => x.text)).toEqual([
        "Plan 12 stopped at ticket 1 (no_pull_request). Comment `@wardby build ticket 1` to continue.",
      ]);
      expect(await setRow(planSetId)).toMatchObject({ chainStopped: "no_pull_request", chainRunId: null });
    });

    it("a stop without an App handle has no hint; a succeeded run with a PR, or another run, does nothing", async () => {
      const { builder, planSetId, run1 } = await building();
      await finish(run1, "succeeded", ++pr);
      await finished(run1);
      const planless = await ticketRun(builder, null, null, "failed");
      await finished(planless);
      const noTicket = await ticketRun(builder, planSetId, null, "failed");
      await finished(noTicket);
      // A run of the set that is not the chain's run (a fix round of the ticket's PR, say).
      const other = await ticketRun(builder, planSetId, 1, "failed");
      await finished(other);
      expect(notices).toEqual([]);
      expect((await setRow(planSetId)).chainStopped).toBeNull();

      handle = null;
      const second = await building();
      await finish(second.run1, "cancelled");
      await finished(second.run1);
      expect(notices.map((x) => x.text)).toEqual(["Plan 12 stopped at ticket 1 (cancelled)."]);
    });

    it("a reopen of any document stops the chain before its next ticket", async () => {
      const { planSetId, documentIds, run1 } = await building();
      const number = ++pr;
      await finish(run1, "succeeded", number);
      await reopenDocument(db, cipher, { documentId: documentIds["api.md"], viewer: as(owner) });
      expect((await setRow(planSetId)).chainStopped).toBe("reopened");
      await merged(number);
      expect(starts).toEqual([]);
      expect(notices).toEqual([]);
      expect((await setRow(planSetId)).chainTicket).toBe(1);
    });

    it("never more than one run at a time: a pending ticket run of the set holds the next start", async () => {
      const { builder, planSetId, run1 } = await building();
      const number = ++pr;
      await finish(run1, "succeeded", number);
      await ticketRun(builder, planSetId, 2, "pending");
      await merged(number);
      expect(starts).toEqual([]);
      expect(notices).toEqual([]);
      expect((await setRow(planSetId)).chainTicket).toBe(1);
    });

    it("an approval that finds ticket 2 already running follows that run: its merge ends the chain", async () => {
      const builder = await makeAgent({ buildFromPlan: true });
      const { planSetId, documentIds } = await makeSet({ onApproved: "build", builderAgentId: builder });
      const running = await ticketRun(builder, planSetId, 2, "running");
      startResult = { running: 2 };
      await approveAll(documentIds);
      expect(await setRow(planSetId)).toMatchObject({ chainTicket: 2, chainStopped: null, chainRunId: running });
      notices = [];
      const number = ++pr;
      await finish(running, "succeeded", number);
      await merged(number);
      expect(starts).toHaveLength(1);
      expect(notices.map((x) => x.text)).toEqual(["Plan 12: all 2 tickets built."]);
    });

    it("a next start that throws or is refused stops the chain with a notice", async () => {
      const first = await building();
      const number = ++pr;
      await finish(first.run1, "succeeded", number);
      vi.spyOn(deps, "startTicket").mockRejectedValueOnce(new Error(`boom ${FAKE_SECRET}`));
      await merged(number);
      expect(await setRow(first.planSetId)).toMatchObject({
        chainTicket: 2,
        chainStopped: "start_failed",
        chainRunId: null,
      });
      expect(notices.map((x) => x.text)).toEqual(["Plan 12: ticket 2 did not start (start_failed)."]);

      notices = [];
      const second = await building();
      const next = ++pr;
      await finish(second.run1, "succeeded", next);
      startResult = { refused: "plan_not_approved" };
      await merged(next);
      expect(await setRow(second.planSetId)).toMatchObject({
        chainTicket: 2,
        chainStopped: "plan_not_approved",
        chainRunId: null,
      });
      expect(notices.map((x) => x.text)).toEqual(["Plan 12: ticket 2 did not start (plan_not_approved)."]);
    });

    it("the builder is checked again before every chain start: plan_builder_invalid starts nothing", async () => {
      const { builder, planSetId, run1 } = await building();
      const number = ++pr;
      await finish(run1, "succeeded", number);
      await db.codingAgentProfile.update({ where: { agentId: builder }, data: { buildFromPlan: false } });
      await merged(number);
      expect(starts).toEqual([]);
      expect(await setRow(planSetId)).toMatchObject({ chainStopped: "plan_builder_invalid", chainRunId: null });
      expect(notices.map((x) => x.text)).toEqual(["Plan 12: ticket 2 did not start (plan_builder_invalid)."]);
    });

    it("the merge webhook does not wait for the next start", async () => {
      const { planSetId, run1 } = await building();
      const number = ++pr;
      await finish(run1, "succeeded", number);
      let release!: (result: StartTicketResult) => void;
      vi.spyOn(deps, "startTicket").mockImplementationOnce(
        () => new Promise<StartTicketResult>((resolve) => (release = resolve)),
      );
      const handled = chain()
        .onMerged(db, { repository, number, merged: true })
        .then(() => "returned" as const);
      const timeout = new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 3_000));
      expect(await Promise.race([handled, timeout])).toBe("returned");
      await vi.waitFor(() => expect(release).toBeDefined());
      release({ refused: "plan_not_approved" });
      await settle();
      expect((await setRow(planSetId)).chainStopped).toBe("plan_not_approved");
    });

    it("a queue timeout of the chain's run stops the chain (the shared run-end event)", async () => {
      setPlanChainHook(chain());
      const { planSetId, run1 } = await building();
      await db.run.update({ where: { id: run1 }, data: { status: "pending" } });
      await db.codingRun.update({ where: { runId: run1 }, data: { queuedAt: new Date(Date.now() - 3_600_000) } });
      const executor = { start: vi.fn() } as unknown as Executor;
      const drained = await drainCodingQueue({ db, executor, maxConcurrent: 0, queueTimeoutSec: 60 });
      expect(drained.timedOut).toBeGreaterThanOrEqual(1);
      await settle();
      expect(await setRow(planSetId)).toMatchObject({ chainStopped: "failed", chainRunId: null });
      expect(notices.map((x) => x.text)).toEqual([
        "Plan 12 stopped at ticket 1 (failed). Comment `@wardby build ticket 1` to continue.",
      ]);
    });

    it("a ticket run whose executor start fails stops the chain with a notice", async () => {
      setPlanChainHook(chain());
      const { planSetId, run1 } = await building();
      await db.run.update({ where: { id: run1 }, data: { status: "pending" } });
      await markRunFailedFromExecutorError(db, run1, new Error("launch failed"));
      await settle();
      expect(await setRow(planSetId)).toMatchObject({ chainStopped: "failed", chainRunId: null });
      expect(notices.map((x) => x.text)).toEqual([
        "Plan 12 stopped at ticket 1 (failed). Comment `@wardby build ticket 1` to continue.",
      ]);
    });

    it("a start that finds a run in flight that is gone by the time it follows it stops with start_failed", async () => {
      const { planSetId, run1 } = await building();
      const number = ++pr;
      await finish(run1, "succeeded", number);
      // The guard saw ticket 2 in flight; that run ended before the chain looked it up.
      startResult = { running: 2 };
      await merged(number);
      expect(await setRow(planSetId)).toMatchObject({
        chainTicket: 2,
        chainStopped: "start_failed",
        chainRunId: null,
      });
      expect(notices.map((x) => x.text)).toEqual(["Plan 12: ticket 2 did not start (start_failed)."]);
    });

    it("a merge during a fix round of the chain's ticket starts the next ticket when the fix round ends", async () => {
      const { builder, planSetId, run1 } = await building();
      const number = ++pr;
      await finish(run1, "succeeded", number);
      const fixRound = await ticketRun(builder, planSetId, 1, "running");
      await db.codingRun.update({ where: { runId: fixRound }, data: { rootCodingRunId: run1 } });
      // A fix round still counts as a ticket run in flight (R16).
      expect(await runningPlanTicket(db, planSetId)).toBe(1);
      await merged(number);
      expect(starts).toEqual([]);
      expect(notices).toEqual([]);
      // A repeat delivery of the merge while it waits starts nothing either.
      await merged(number);
      expect(starts).toEqual([]);
      await finish(fixRound, "succeeded", number);
      await finished(fixRound);
      expect(starts.map((x) => x.ticket)).toEqual([2]);
      expect(notices.map((x) => x.text)).toEqual(["Plan 12: building ticket 2."]);
      const row = await setRow(planSetId);
      expect(row).toMatchObject({ chainTicket: 2, chainStopped: null });
      expect(row.chainRunId).not.toBe(run1);
      expect(row.chainRunId).not.toBe(fixRound);
      // The fix round's end is heard once: a repeat starts nothing more.
      await finished(fixRound);
      expect(starts).toHaveLength(1);
    });

    it("a fix round that ends before the chain's PR merges starts nothing; the merge then starts the next ticket", async () => {
      const { builder, planSetId, run1 } = await building();
      const number = ++pr;
      await finish(run1, "succeeded", number);
      const fixRound = await ticketRun(builder, planSetId, 1, "running");
      await db.codingRun.update({ where: { runId: fixRound }, data: { rootCodingRunId: run1 } });
      await finish(fixRound, "succeeded", number);
      await finished(fixRound);
      expect(starts).toEqual([]);
      expect(notices).toEqual([]);
      expect(await setRow(planSetId)).toMatchObject({ chainTicket: 1, chainRunId: run1 });
      await merged(number);
      expect(starts.map((x) => x.ticket)).toEqual([2]);
    });

    it("a refused start never overwrites a stop recorded meanwhile (a reopen)", async () => {
      const { planSetId, documentIds, run1 } = await building();
      const number = ++pr;
      await finish(run1, "succeeded", number);
      vi.spyOn(deps, "startTicket").mockImplementationOnce(async () => {
        await reopenDocument(db, cipher, { documentId: documentIds["api.md"], viewer: as(owner) });
        return { refused: "plan_not_approved" };
      });
      await merged(number);
      expect(await setRow(planSetId)).toMatchObject({ chainTicket: 2, chainStopped: "reopened", chainRunId: null });
      expect(notices.map((x) => x.text)).toEqual(["Plan 12: ticket 2 did not start (plan_not_approved)."]);
    });

    it("planTicketStartBlock: says what held a start back, as seen under the lock", async () => {
      const builder = await makeAgent({ buildFromPlan: true });
      const { planSetId, documentIds } = await makeSet({ onApproved: "notify" });
      const block = () => db.$transaction((tx) => planTicketStartBlock(tx, planSetId));
      expect(await block()).toEqual({ refused: "plan_not_approved" });
      await approveAll(documentIds);
      expect(await block()).toBeNull();
      const pending = await ticketRun(builder, planSetId, 1, "pending");
      expect(await block()).toEqual({ running: 1 });
      await finish(pending, "failed");
      expect(await block()).toBeNull();
    });

    describe("build ticket from a comment", () => {
      // Every set here is the repository's plan 12: earlier tests' approved sets would answer first.
      beforeEach(async () => {
        await db.planSet.updateMany({ where: { repository }, data: { approvedAt: null } });
      });
      const build = (ticket: number, starterName = "octocat", number = 12) =>
        chain()
          .buildTicketFromComment(db, { repository, number, ticket, starterName })
          .then(async (answer) => {
            await settle();
            return answer;
          });
      /** A plan approved by Ada whose planner names a builder; "notify", so the approval starts nothing. */
      async function approvedNotify() {
        const builder = await makeAgent({ buildFromPlan: true });
        const made = await makeSet({ onApproved: "notify", builderAgentId: builder });
        await approveAll(made.documentIds);
        notices = [];
        starts = [];
        return { builder, ...made };
      }

      /** A "build" chain stopped at ticket 1 (its run failed); notices and starts cleared. */
      async function stoppedChain() {
        const made = await building();
        await finish(made.run1, "failed");
        await finished(made.run1);
        expect((await setRow(made.planSetId)).chainStopped).toBe("failed");
        notices = [];
        starts = [];
        return made;
      }

      it("notify: builds only the ticket asked for; its merge starts nothing and the chain is untouched", async () => {
        const { builder, planSetId } = await approvedNotify();
        expect(await build(1)).toBe("started");
        expect(starts).toHaveLength(1);
        expect(starts[0]).toMatchObject({
          builderAgentId: builder,
          ticket: 1,
          starterId: null,
          trigger: "comment",
          followedByChain: false,
        });
        expect(starts[0].set).toMatchObject({ id: planSetId, number: 12 });
        expect(await setRow(planSetId)).toMatchObject({ chainTicket: null, chainStopped: null, chainRunId: null });
        expect(notices.map((x) => x.text)).toEqual(["Plan 12: building ticket 1, started by octocat."]);
        // Ticket 1's merge starts nothing: ticket 2 exists, but a notify planner builds only what is asked.
        notices = [];
        starts = [];
        const run = await db.codingRun.findFirstOrThrow({
          where: { planSetId, planTicket: 1 },
          orderBy: { createdAt: "desc" },
          select: { runId: true },
        });
        const number = ++pr;
        await finish(run.runId, "succeeded", number);
        await merged(number);
        expect(starts).toEqual([]);
        expect(notices).toEqual([]);
        expect(await setRow(planSetId)).toMatchObject({ chainTicket: null, chainStopped: null, chainRunId: null });
      });

      it("notify: a refused start is answered but leaves the chain untouched", async () => {
        const { planSetId } = await approvedNotify();
        startResult = { refused: "plan_not_approved" };
        expect(await build(2)).toBe("refused");
        expect(await setRow(planSetId)).toMatchObject({ chainTicket: null, chainStopped: null, chainRunId: null });
        expect(notices.map((x) => x.text)).toEqual(["Plan 12: ticket 2 did not start (plan_not_approved)."]);
      });

      it("build: restarts a stopped chain from the ticket asked for, and its merge moves the chain on", async () => {
        const { builder, planSetId, run1 } = await stoppedChain();
        expect(await build(1)).toBe("started");
        expect(starts[0]).toMatchObject({
          builderAgentId: builder,
          ticket: 1,
          trigger: "comment",
          followedByChain: true,
        });
        const row = await setRow(planSetId);
        expect(row).toMatchObject({ chainTicket: 1, chainStopped: null });
        expect(row.chainRunId).not.toBeNull();
        expect(row.chainRunId).not.toBe(run1);
        expect(notices.map((x) => x.text)).toEqual(["Plan 12: building ticket 1, started by octocat."]);
        notices = [];
        starts = [];
        const number = ++pr;
        await finish(row.chainRunId!, "succeeded", number);
        await merged(number);
        expect(starts.map((x) => x.ticket)).toEqual([2]);
        expect(notices.map((x) => x.text)).toEqual(["Plan 12: building ticket 2."]);
      });

      it("R16: while a ticket run of the set is pending it starts nothing and says so", async () => {
        const { builder, planSetId } = await approvedNotify();
        await ticketRun(builder, planSetId, 1, "pending");
        expect(await build(2)).toBe("refused");
        expect(starts).toEqual([]);
        expect(notices.map((x) => x.text)).toEqual(["Plan 12: already building ticket 1."]);
        expect((await setRow(planSetId)).chainTicket).toBeNull();
      });

      it("R16: a fix round of an earlier ticket still in flight refuses the build", async () => {
        const { builder, planSetId, run1 } = await building();
        const number = ++pr;
        await finish(run1, "succeeded", number);
        const fixRound = await ticketRun(builder, planSetId, 1, "running");
        await db.codingRun.update({ where: { runId: fixRound }, data: { rootCodingRunId: run1 } });
        expect(await build(2)).toBe("refused");
        expect(starts).toEqual([]);
        expect(notices.map((x) => x.text)).toEqual(["Plan 12: already building ticket 1."]);
        expect(await setRow(planSetId)).toMatchObject({ chainTicket: 1, chainStopped: null, chainRunId: run1 });
      });

      it("a ticket plan.md does not list is refused; without a Tickets section any ticket may be built", async () => {
        const { planSetId } = await approvedNotify();
        expect(await build(7)).toBe("refused");
        expect(starts).toEqual([]);
        expect(notices.map((x) => x.text)).toEqual(["Plan 12 has no ticket 7."]);
        expect(await setRow(planSetId)).toMatchObject({ chainTicket: null, chainStopped: null, chainRunId: null });

        await db.planSet.updateMany({ where: { repository }, data: { approvedAt: null } });
        notices = [];
        const builder = await makeAgent({ buildFromPlan: true });
        const plain = await makeSet({ onApproved: "notify", builderAgentId: builder }, [
          { path: "plan.md", content: "# Plan\n\nNo tickets here.\n", version: 1, reviewState: "draft" },
        ]);
        await approveAll(plain.documentIds);
        notices = [];
        expect(await build(7)).toBe("started");
        expect(starts.map((x) => x.ticket)).toEqual([7]);
      });

      it("the newest approved set wins; a newest one without a builder answers none", async () => {
        const older = await approvedNotify();
        const newer = await approvedNotify();
        expect(await build(1)).toBe("started");
        expect(starts.map((x) => [x.builderAgentId, x.set.id])).toEqual([[newer.builder, newer.planSetId]]);
        expect(older.planSetId).not.toBe(newer.planSetId);

        starts = [];
        notices = [];
        await db.run.updateMany({ where: { agentId: newer.builder }, data: { status: "succeeded" } });
        const plain = await makeSet({ onApproved: "notify" });
        await approveAll(plain.documentIds);
        notices = [];
        expect(await build(1)).toBe("none");
        expect(starts).toEqual([]);
        expect(notices).toEqual([]);
      });

      it("the repository matches whatever its case in the event", async () => {
        const { planSetId } = await approvedNotify();
        const shouted = await chain().buildTicketFromComment(db, {
          repository: repository.toUpperCase(),
          number: 12,
          ticket: 2,
          starterName: "octocat",
        });
        await settle();
        expect(shouted).toBe("started");
        expect(starts.map((x) => x.set.id)).toEqual([planSetId]);
      });

      it('"none", posting nothing: a set not approved, a planner without a builder, no set, a Jira plan', async () => {
        const builder = await makeAgent({ buildFromPlan: true });
        await makeSet({ onApproved: "notify", builderAgentId: builder });
        expect(await build(1)).toBe("none");
        const plain = await makeSet({ onApproved: "notify" });
        await approveAll(plain.documentIds);
        notices = [];
        expect(await build(1)).toBe("none");
        expect(await build(1, "octocat", 13)).toBe("none");
        const jira = await makeSet({ onApproved: "notify", builderAgentId: builder });
        await db.planSet.update({
          where: { id: jira.planSetId },
          data: { issueProvider: "jira", issueKey: "PROJ-12" },
        });
        await approveAll(jira.documentIds);
        notices = [];
        expect(await build(1)).toBe("none");
        expect(starts).toEqual([]);
        expect(notices).toEqual([]);
      });

      it("build: a refused start stops the chain with the refusal's code", async () => {
        const { planSetId } = await stoppedChain();
        startResult = { refused: "plan_not_approved" };
        expect(await build(2)).toBe("refused");
        expect(await setRow(planSetId)).toMatchObject({ chainTicket: 2, chainStopped: "plan_not_approved" });
        expect(notices.map((x) => x.text)).toEqual(["Plan 12: ticket 2 did not start (plan_not_approved)."]);
      });

      it("R12: a builder that cannot build any more is refused with plan_builder_invalid", async () => {
        const { builder, planSetId } = await stoppedChain();
        await db.codingAgentProfile.update({ where: { agentId: builder }, data: { buildFromPlan: false } });
        expect(await build(2)).toBe("refused");
        expect(starts).toEqual([]);
        expect((await setRow(planSetId)).chainStopped).toBe("plan_builder_invalid");
        expect(notices.map((x) => x.text)).toEqual(["Plan 12: ticket 2 did not start (plan_builder_invalid)."]);
      });

      it("secrets: the author's name is redacted, escaped and defused in the notice", async () => {
        await approvedNotify();
        expect(await build(2, `x_${FAKE_NAME_SECRET} @someone`)).toBe("started");
        expect(notices).toHaveLength(1);
        expect(notices[0].text).not.toContain(FAKE_NAME_SECRET);
        expect(notices[0].text).not.toContain("@someone");
      });
    });

    it("lockPlanSetForTicketStart: under the set's row lock, an approved set with no ticket run in flight", async () => {
      const builder = await makeAgent({ buildFromPlan: true });
      const { planSetId, documentIds } = await makeSet({ onApproved: "notify" });
      const guard = () => db.$transaction((tx) => lockPlanSetForTicketStart(tx, planSetId));
      expect(await guard()).toBe(false);
      await approveAll(documentIds);
      expect(await guard()).toBe(true);
      const pending = await ticketRun(builder, planSetId, 1, "pending");
      expect(await guard()).toBe(false);
      await finish(pending, "failed");
      expect(await guard()).toBe(true);

      // A start that holds the lock and persists its run: a start waiting on the lock then sees that run.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const holder = db.$transaction(
        async (tx) => {
          expect(await lockPlanSetForTicketStart(tx, planSetId)).toBe(true);
          locked();
          await released;
          await tx.run.create({
            data: { id: `held-${s}`, agentId: builder, status: "pending", trigger: "plan_approved" },
          });
          await tx.codingRun.create({
            data: {
              runId: `held-${s}`,
              task: "t",
              repository,
              baseRef: "main",
              headRef: `wardby/run-held-${s}`,
              provider: "codex",
              model: "m",
              timeoutSec: 60,
              protectedPaths: [],
              budgetReservedUsd: 0.1,
              planSetId,
              planTicket: 2,
            },
          });
        },
        { timeout: 20_000 },
      );
      await isLocked;
      const waiting = guard();
      await waitForLockWaiter();
      release();
      await holder;
      expect(await waiting).toBe(false);
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
