/**
 * The router review hook (#646, spec §3) against real PostgreSQL: which router a review action reaches (the
 * document's, the writer's reviewRouter, a set's), once per action (the job claim), a set routing as one piece
 * of work (its completed approval, a choice), an agent's own action continuing the person's job, the task text
 * (with the stored, redacted note) and a refused start. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../db.js";
import { attachSecret, createSecret } from "../secrets.js";
import type { Viewer } from "../documents/access.js";
import { runReviewHooks, setReviewActionHook } from "../documents/review-hooks.js";
import {
  chooseOption,
  forceApprove,
  rejectDocument,
  reopenDocument,
  reviewDocument,
  setArchived,
  submitForReview,
} from "../documents/review.js";
import { createDocument } from "../documents/service.js";
import { createPlanReviewHook, setPlanReviewHook } from "../plans/approval.js";
import { createPlanSetFixture } from "../plans/build.test-support.js";
import { reviewRouterStarter } from "../../providers/executor/composition.js";
import { createReviewRouterHook, type StartRouter } from "./hook.js";

const SECRET = "s3cret-router-789";

describe.skipIf(!process.env.DATABASE_URL)("review router hook (database)", { timeout: 30_000 }, () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID().slice(0, 8);
  let owner: Principal;
  let ann: Principal;
  const agents: string[] = [];
  let router: string;
  let router2: string;
  let writer: string;
  const as = (p: Principal): Viewer => ({ kind: "principal", principalId: p.id });
  const writeSetting = { access: "write", reviewers: ["x"], finalApproverId: null, maxNewPerRun: 5, plans: [] };

  const agent = async (data: Record<string, unknown> = {}) => {
    const row = await db.agent.create({
      data: {
        name: `rr-${s}-${agents.length}`,
        systemPrompt: "p",
        model: "m",
        budgetUsd: 1,
        ownerId: owner.id,
        ...data,
      },
    });
    agents.push(row.id);
    return row.id;
  };

  beforeAll(async () => {
    owner = await db.principal.create({ data: { subject: `rr-owner-${s}` } });
    ann = await db.principal.create({ data: { subject: `rr-ann-${s}` } });
    await db.principalProfile.create({ data: { principalId: owner.id, displayName: "Olive Owner", source: "oidc" } });
    await db.principalProfile.create({ data: { principalId: ann.id, displayName: "Ann Lead", source: "oidc" } });
    router = await agent({ router: true, description: "routes work" });
    router2 = await agent({ router: true, description: "routes other work" });
    writer = await agent({ documentTools: writeSetting });
    await createSecret(`RR_KEY_${s}`, SECRET, owner.id, cipher, db);
    await attachSecret(writer, `RR_KEY_${s}`, owner.id, db);
  });

  // The fake start: records every call and starts a run of the router (no executor).
  let calls: Parameters<StartRouter>[0][] = [];
  let pending: Promise<void>[] = [];
  let refuse: string | null = null;
  const startRouter: StartRouter = async (input) => {
    calls.push(input);
    if (refuse) return { refused: refuse };
    const run = await db.run.create({ data: { agentId: input.routerAgentId } });
    return { runId: run.id };
  };
  const install = () =>
    setReviewActionHook(createReviewRouterHook({ startRouter, track: (work) => void pending.push(work) }));
  /** Awaits the background routing of every action so far. */
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };

  afterEach(() => {
    setReviewActionHook(undefined);
    setPlanReviewHook(undefined);
    calls = [];
    pending = [];
    refuse = null;
  });
  afterAll(async () => {
    const ids = [owner.id, ann.id];
    await db.reviewJob.deleteMany({ where: { routerAgentId: { in: agents } } });
    await db.document.deleteMany({ where: { ownerId: owner.id } });
    await db.planSet.deleteMany({ where: { agentId: { in: agents } } });
    await db.documentSet.deleteMany({ where: { agentId: { in: agents } } });
    await db.run.deleteMany({ where: { agentId: { in: agents }, parentRunId: { not: null } } });
    await db.run.deleteMany({ where: { agentId: { in: agents } } });
    await db.resourceGrant.deleteMany({ where: { granteePrincipalId: { in: ids } } });
    await db.agentSecret.deleteMany({ where: { agentId: { in: agents } } });
    await db.secret.deleteMany({ where: { ownerId: owner.id } });
    await db.agent.deleteMany({ where: { id: { in: agents } } });
    await db.principalProfile.deleteMany({ where: { principalId: { in: ids } } });
    await db.principal.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  const doc = async (input: { title?: string; agentId?: string; setId?: string; option?: string } = {}) =>
    (
      await createDocument(db, cipher, {
        ownerId: owner.id,
        title: input.title ?? "Spec",
        markdown: "# Spec\n\nhello",
        agentId: input.agentId ?? writer,
        ...(input.setId ? { setId: input.setId, option: input.option ?? "x" } : {}),
      })
    ).id;
  const routed = async (id: string) => db.document.update({ where: { id }, data: { routerAgentId: router } });
  const submit = (id: string, note?: string) =>
    submitForReview(db, cipher, { documentId: id, viewer: as(owner), reviewers: [ann.id], ...(note ? { note } : {}) });
  const approve = (id: string, versionNumber = 1) =>
    reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "approve", versionNumber });
  const nativeSet = async (name: string) =>
    (await db.documentSet.create({ data: { agentId: writer, ownerId: owner.id, name, routerAgentId: router } })).id;
  const eventsOf = (id: string) =>
    db.documentReviewEvent.findMany({ where: { documentId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

  it("no router anywhere: nothing starts and no job is claimed", async () => {
    install();
    const id = await doc();
    await submit(id);
    await settle();
    expect(calls).toEqual([]);
    expect(await db.reviewJob.count({ where: { documentId: id } })).toBe(0);
  });

  it("the document's router starts once per action, with the action in its task and read access to it", async () => {
    install();
    const id = await doc({ title: "Checkout spec" });
    await routed(id);
    await submit(id);
    await approve(id);
    await settle();
    expect(calls.map((c) => c.routerAgentId)).toEqual([router, router]);
    expect(calls[1].task).toContain("Review action: approved on Checkout spec (version 1).");
    expect(calls[1].task).toContain("By: Ann Lead.");
    expect(calls[1].documentIds).toEqual([id]);
    expect(calls[1].triggeredById).toBe(ann.id);
    const approvedEvent = (await eventsOf(id)).find((e) => e.kind === "approved")!;
    const job = await db.reviewJob.findUniqueOrThrow({ where: { reviewEventId: approvedEvent.id } });
    expect(job).toMatchObject({ id: calls[1].jobId, documentId: id, setId: null, routerAgentId: router });
    expect(job.outcome).toBe("started");
    expect(job.routerRunId).not.toBeNull();
    // The same action's hooks again (a retry): the event already has its job, so nothing starts.
    await runReviewHooks(db, { documentId: id, eventIds: [approvedEvent.id], actorId: ann.id });
    await settle();
    expect(calls).toHaveLength(2);
  });

  it("falls back to the writer's reviewRouter, read at action time", async () => {
    install();
    const fallbackWriter = await agent({ reviewRouterId: router2 });
    const id = await doc({ agentId: fallbackWriter });
    await submit(id);
    await settle();
    expect(calls.map((c) => c.routerAgentId)).toEqual([router2]);
    // Turning `router` off stops routing to it.
    await db.agent.update({ where: { id: router2 }, data: { router: false } });
    await approve(id);
    await settle();
    expect(calls).toHaveLength(1);
    await db.agent.update({ where: { id: router2 }, data: { router: true } });
  });

  it("a set routes its approval once, when its last document is approved, with the set's name", async () => {
    install();
    const setId = await nativeSet(`Concepts ${s}`);
    const a = await doc({ setId, option: "concept-a" });
    const b = await doc({ setId, option: "concept-b" });
    await submit(a);
    await submit(b);
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[0].task).toContain(`Review action: submitted on Concepts ${s} (version 1).`);
    calls = [];
    await approve(a);
    await settle();
    expect(calls).toEqual([]);
    await approve(b);
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0].task).toContain(`Review action: approved on Concepts ${s} (version 1).`);
    expect(calls[0].documentIds.sort()).toEqual([a, b].sort());
    const set = await db.documentSet.findUniqueOrThrow({ where: { id: setId } });
    expect(set.approvedAt).not.toBeNull();
    const job = await db.reviewJob.findUniqueOrThrow({ where: { id: calls[0].jobId } });
    expect(job).toMatchObject({ setId, documentId: null });
  });

  it("chooseOption routes once: the chosen option, the rejected ones, and the person's note", async () => {
    install();
    const setId = await nativeSet(`Choice ${s}`);
    const a = await doc({ setId, option: "a" });
    const b = await doc({ setId, option: "b" });
    await submit(a);
    await submit(b);
    await settle();
    calls = [];
    await chooseOption(db, cipher, {
      documentId: b,
      viewer: as(ann),
      versionNumber: 1,
      reject: [a],
      note: "Start with subscriptions.",
    });
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0].task).toContain(`Review action: option chosen on Choice ${s} (version 1).`);
    expect(calls[0].task).toContain('Option "b" was chosen; a were rejected.');
    expect(calls[0].task).toContain('Note from Ann Lead: "Start with subscriptions."');
    expect(calls[0].documentIds.sort()).toEqual([a, b].sort());
  });

  it("an agent's own action under a router run continues that job (rootJobId)", async () => {
    install();
    const first = await doc();
    await routed(first);
    await submit(first);
    await settle();
    const job1 = await db.reviewJob.findUniqueOrThrow({ where: { id: calls[0].jobId } });
    expect(job1.rootJobId).toBeNull();
    const child = await db.run.create({ data: { agentId: writer, parentRunId: job1.routerRunId! } });
    const second = await doc();
    await routed(second);
    await submitForReview(db, cipher, {
      documentId: second,
      viewer: { kind: "agent", agentId: writer, runId: child.id },
      reviewers: [ann.id],
    });
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1].task).toContain("By: an agent.");
    const job2 = await db.reviewJob.findUniqueOrThrow({ where: { id: calls[1].jobId } });
    expect(job2.rootJobId).toBe(job1.id);
    // The router run is visible to the person whose job it continues.
    expect(job2.startedById).toBe(owner.id);
    expect(calls[1].triggeredById).toBe(owner.id);
  });

  it("every other kind of action routes once", async () => {
    install();
    const id = await doc({ title: "Kinds" });
    await routed(id);
    const seen: string[] = [];
    const step = async (act: () => Promise<unknown>, kind: string, on = "Kinds") => {
      const before = calls.length;
      await act();
      await settle();
      expect(calls.length - before, kind).toBe(1);
      expect(calls.at(-1)!.task).toContain(`Review action: ${kind.replace(/_/g, " ")} on ${on} `);
      seen.push(kind);
    };
    await step(() => submit(id), "submitted");
    await step(
      () => submitForReview(db, cipher, { documentId: id, viewer: as(owner), reviewers: [ann.id, owner.id] }),
      "reviewers_changed",
    );
    await step(
      () =>
        reviewDocument(db, cipher, { documentId: id, viewer: as(ann), verdict: "request_changes", versionNumber: 1 }),
      "changes_requested",
    );
    await step(
      () => forceApprove(db, cipher, { documentId: id, viewer: as(owner), note: "ship it" }),
      "force_approved",
    );
    await step(() => reopenDocument(db, cipher, { documentId: id, viewer: as(owner) }), "reopened");
    await step(() => setArchived(db, { documentId: id, viewer: as(owner), archived: true }), "archived");
    await step(() => setArchived(db, { documentId: id, viewer: as(owner), archived: false }), "unarchived");
    // A reject is an action on a set's document: it routes as that action on the set.
    const setId = await nativeSet(`Reject ${s}`);
    const a = await doc({ setId, option: "a", title: "Kinds" });
    await doc({ setId, option: "b" });
    await submit(a);
    await settle();
    await step(
      () => rejectDocument(db, cipher, { documentId: a, viewer: as(owner), note: "no" }),
      "rejected",
      `Reject ${s}`,
    );
    expect(seen).toHaveLength(8);
  });

  it("the note in the task is the stored one, redacted against the document agent's secret values", async () => {
    install();
    const id = await doc();
    await routed(id);
    await submit(id, `token ${SECRET} inside`);
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0].task).not.toContain(SECRET);
    expect(calls[0].task).toContain("[REDACTED]");
  });

  it("a refused start records the refusal on the job; the review action still succeeds", async () => {
    install();
    refuse = "run_refused";
    const id = await doc();
    await routed(id);
    const view = await submit(id);
    expect(view.state).toBe("in_review");
    await settle();
    expect(calls).toHaveLength(1);
    const job = await db.reviewJob.findUniqueOrThrow({ where: { id: calls[0].jobId } });
    expect(job).toMatchObject({ outcome: "run_refused", routerRunId: null });
  });

  const installPlanHook = () =>
    setPlanReviewHook(
      createPlanReviewHook({
        postIssueNotice: async () => {},
        startTicket: async () => ({ refused: "unused" }),
        mentionHandle: async () => null,
        secretValues: async () => [],
        track: (work) => void pending.push(work),
      }),
    );
  let planNumber = 700 + Math.floor(Math.random() * 1000);
  /** plan.md approved, c.md and d.md submitted to Ann; the plan's shared set carries the router. */
  const planFixture = async (onApproved: "build" | "notify") => {
    const plannerId = await agent({
      kind: "coding",
      codingProfile: {
        create: {
          repository: `o/rr-${s}`,
          protectedPaths: [],
          planDocument: {
            store: "wardby",
            onApproved,
            ...(onApproved === "build" ? { builderAgentId: writer } : {}),
          },
        },
      },
    });
    const number = ++planNumber;
    const fixture = await createPlanSetFixture(db, {
      plannerId,
      ownerId: owner.id,
      repository: `o/rr-${s}`,
      number,
      documents: [
        { path: "plan.md", content: "# Plan\n", version: 1 },
        { path: "c.md", content: "c", version: 1, reviewState: "draft" },
        { path: "d.md", content: "d", version: 1, reviewState: "draft" },
      ],
    });
    const setId = (
      await db.documentSet.create({ data: { agentId: plannerId, ownerId: owner.id, routerAgentId: router } })
    ).id;
    await db.planSet.update({ where: { id: fixture.planSetId }, data: { setId } });
    await db.document.updateMany({ where: { planSetId: fixture.planSetId }, data: { setId } });
    const [c, d] = [fixture.documentIds["c.md"], fixture.documentIds["d.md"]];
    await submit(c);
    await submit(d);
    await settle();
    calls = [];
    return { number, c, d, planSetId: fixture.planSetId };
  };

  it("a plan set routes the approval its plan hook claimed; a build planner's task says the builder started", async () => {
    install();
    installPlanHook();
    const { number, c, d } = await planFixture("build");
    await approve(c);
    await settle();
    expect(calls).toEqual([]);
    await approve(d);
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0].task).toContain(`Review action: approved on Plan ${number} (version 1).`);
    expect(calls[0].task).toContain("The builder for this plan was already started.");
    expect(calls[0].documentIds).toHaveLength(3);
  });

  it("a completing force approval on a build plan says the builder started; a notify plan never does", async () => {
    install();
    installPlanHook();
    const build = await planFixture("build");
    await approve(build.c);
    await forceApprove(db, cipher, { documentId: build.d, viewer: as(owner), note: "go" });
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0].task).toContain(`Review action: force approved on Plan ${build.number}`);
    expect(calls[0].task).toContain("The builder for this plan was already started.");
    calls = [];
    const notify = await planFixture("notify");
    await approve(notify.c);
    await approve(notify.d);
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0].task).toContain(`Review action: approved on Plan ${notify.number}`);
    expect(calls[0].task).not.toContain("builder");
  });

  it("an extra approval on an already-approved plan set starts no second job", async () => {
    install();
    installPlanHook();
    const { c, d } = await planFixture("notify");
    await approve(c);
    await approve(d);
    await settle();
    expect(calls).toHaveLength(1);
    // Another approved event on a document of the approved set: the plan hook claims nothing, so nothing routes.
    const extra = await db.documentReviewEvent.create({
      data: {
        documentId: d,
        actorPrincipalId: owner.id,
        kind: "approved",
        fromState: "approved",
        toState: "approved",
        versionNumber: 1,
      },
    });
    await runReviewHooks(db, { documentId: d, eventIds: [extra.id], actorId: owner.id });
    await settle();
    expect(calls).toHaveLength(1);
    expect(await db.reviewJob.count({ where: { reviewEventId: extra.id } })).toBe(0);
  });

  it("a start that throws leaves the job with outcome route_failed; the action still succeeds", async () => {
    setReviewActionHook(
      createReviewRouterHook({
        startRouter: async (input) => {
          calls.push(input);
          throw new Error("boom");
        },
        track: (work) => void pending.push(work),
      }),
    );
    const id = await doc();
    await routed(id);
    expect((await submit(id)).state).toBe("in_review");
    await settle();
    expect(calls).toHaveLength(1);
    const job = await db.reviewJob.findUniqueOrThrow({ where: { id: calls[0].jobId } });
    expect(job).toMatchObject({ outcome: "route_failed", routerRunId: null });
  });

  it("the composed start (real dispatch) makes a review_action run with the task, its job link and grants", async () => {
    const started: string[] = [];
    const executor = {
      async start(runId: string) {
        started.push(runId);
      },
      async stop() {},
    };
    setReviewActionHook(
      createReviewRouterHook({
        startRouter: reviewRouterStarter({ db, executor: () => executor, cipher }),
        track: (work) => void pending.push(work),
      }),
    );
    const id = await doc({ title: "Composed" });
    await routed(id);
    await submit(id);
    await settle();
    const event = (await eventsOf(id))[0];
    const job = await db.reviewJob.findUniqueOrThrow({ where: { reviewEventId: event.id } });
    expect(job.outcome).toBe("started");
    const run = await db.run.findUniqueOrThrow({ where: { id: job.routerRunId! } });
    expect(run).toMatchObject({ agentId: router, trigger: "review_action", triggeredById: owner.id });
    expect(run.taskOverride).toContain("Review action: submitted on Composed (version 1).");
    expect(started).toEqual([run.id]);
    const grants = await db.runDocumentGrant.findMany({ where: { runId: run.id } });
    expect(grants.map((g) => g.documentId)).toEqual([id]);
    // Not a router any more by the time it starts: refused, no run.
    const other = await doc();
    await routed(other);
    await db.agent.update({ where: { id: router }, data: { router: false } });
    try {
      const startRouter = reviewRouterStarter({ db, executor: () => executor, cipher });
      const job2 = await db.reviewJob.create({ data: { reviewEventId: `rr-${s}-x`, routerAgentId: router } });
      expect(
        await startRouter({
          routerAgentId: router,
          task: "t",
          triggeredById: null,
          jobId: job2.id,
          documentIds: [other],
        }),
      ).toEqual({ refused: "review_router_invalid" });
      expect(await db.runDocumentGrant.count({ where: { documentId: other } })).toBe(0);
    } finally {
      await db.agent.update({ where: { id: router }, data: { router: true } });
    }
  });
});
