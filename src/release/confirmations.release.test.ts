/**
 * Confirmations: each finding the release invariants turned up, re-checked against the production
 * code with no fake or mock in the path (pure functions with realistic input, or the real
 * dispatch path on real PostgreSQL). Each test asserts the behaviour as it is today, so it passes
 * while the finding stands and fails once it is fixed; it then belongs with the fix. Findings
 * that cannot be confirmed this way are listed in the phase 1 report with the check that would.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { dispatchRun } from "../core/dispatch.js";
import { ReviewReadLedger } from "../core/review-reads.js";
import type { Executor } from "../providers/executor/types.js";
import type { PullRequestFileView, PullRequestView } from "../providers/review-host/types.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const file = (filename: string, patchStatus: PullRequestFileView["patchStatus"]): PullRequestFileView => ({
  filename,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: patchStatus === "complete" ? "@@ -1 +1 @@\n-a\n+b" : "",
  patchTruncated: patchStatus !== "complete",
  patchStatus,
});
const view = (files: PullRequestFileView[]): PullRequestView =>
  ({ headSha: HEAD, files, fileListComplete: true }) as unknown as PullRequestView;

describe("confirms N1 (production ReviewReadLedger, no host): a sinceSha read narrows what is gated", () => {
  it("control plane: one ledger, the narrower page replaces the code set", () => {
    const reads = new ReviewReadLedger();
    reads.recordPage("o/r", 7, view([file("src/a.ts", "complete"), file("src/b.ts", "later_page")]), false);
    expect(reads.unreadCode("o/r", 7, HEAD)).toEqual(["src/b.ts"]);
    // repo_pr_read with sinceSha: a first page (no cursor) listing only what changed since.
    reads.recordPage("o/r", 7, view([file("src/a.ts", "complete")]), false);
    expect(reads.unreadCode("o/r", 7, HEAD)).toEqual([]);
  });

  it("sandbox: the gateway's per-request ledgers merged into the saved one keep src/b.ts gated", () => {
    const saved = new ReviewReadLedger();
    for (const files of [
      [file("src/a.ts", "complete"), file("src/b.ts", "later_page")],
      [file("src/a.ts", "complete")],
    ]) {
      const request = ReviewReadLedger.fromJSON(saved.toJSON());
      request.recordPage("o/r", 7, view(files), false);
      saved.merge(request);
    }
    expect(saved.unreadCode("o/r", 7, HEAD)).toEqual(["src/b.ts"]);
  });
});

describe("confirms R2 (production ReviewReadLedger): an attempt that read nothing is not gated", () => {
  it("unreadCode is null, which repo_publish_review treats as nothing to refuse", () => {
    expect(new ReviewReadLedger().unreadCode("o/r", 7, HEAD)).toBeNull();
    expect(new ReviewReadLedger().fileListCut("o/r", 7, HEAD)).toBe(false);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("confirms B1 and B2 (production dispatchRun on PostgreSQL)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID().slice(0, 8);
  const PREFIX = `relconf-${suffix}-`;
  const owner = `${PREFIX}owner`;
  const executor: Executor = { start: async () => undefined, stop: async () => undefined };
  let setUp = false;

  async function setUpOnce() {
    if (setUp) return;
    setUp = true;
    await db.principal.create({ data: { id: owner, subject: owner } });
  }
  async function group(name: string, dailyBudgetUsd: number) {
    return (
      await db.budgetGroup.create({ data: { id: PREFIX + name, name: PREFIX + name, ownerId: owner, dailyBudgetUsd } })
    ).id;
  }
  async function lead(name: string, budgetUsd: number, allowedOverrunPercent: number, budgetGroupId: string | null) {
    const id = PREFIX + name;
    await db.agent.create({
      data: {
        id,
        name: id,
        systemPrompt: "t",
        model: "t",
        budgetUsd,
        allowedOverrunPercent,
        ownerId: owner,
        budgetGroupId,
      },
    });
    return id;
  }
  async function coder(name: string, budgetUsd: number, allowedOverrunPercent: number, budgetGroupId: string | null) {
    const id = PREFIX + name;
    await db.agent.create({
      data: {
        id,
        name: id,
        systemPrompt: "Fix things.",
        model: "gpt-5.6-luna",
        budgetUsd,
        allowedOverrunPercent,
        kind: "coding",
        ownerId: owner,
        budgetGroupId,
        codingProfile: {
          create: { provider: "codex", repository: "your-org/your-repo", defaultTask: "Fix it.", protectedPaths: [] },
        },
      },
    });
    return id;
  }
  const reserved = async (runId: string) =>
    Number(
      (await db.codingRun.findUniqueOrThrow({ where: { runId }, select: { budgetReservedUsd: true } }))
        .budgetReservedUsd,
    );

  afterAll(async () => {
    const agents = { agentId: { startsWith: PREFIX } };
    await db.codingRun.deleteMany({ where: { run: agents } });
    await db.run.deleteMany({ where: { ...agents, parentRunId: { not: null } } });
    await db.run.deleteMany({ where: agents });
    await db.codingAgentProfile.deleteMany({ where: agents });
    await db.agent.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await db.budgetGroup.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  it("B1: a running $10 lead that has spent nothing delegates a builder the whole $10 tree", async () => {
    await setUpOnce();
    const leadId = await lead("b1-lead", 10, 0, null);
    const builder = await coder("b1-builder", 10, 0, null);
    const parent = await db.run.create({ data: { agentId: leadId, status: "running", costUsd: 0 } });
    const child = await dispatchRun({ db, executor, agentId: builder, trigger: "subagent", parentRunId: parent.id });
    // The lead's own $10 (pinned when it loaded) is not held against its tree: lead + builder can reach $20.
    expect(await reserved(child!.run.id)).toBeCloseTo(10, 6);
    await db.run.updateMany({ where: { id: { in: [parent.id, child!.run.id] } }, data: { status: "cancelled" } });
  });

  it("B2: a run started between a $10 (+50%) lead and its builder takes the rest of a $20 cap; the builder then reserves $15", async () => {
    await setUpOnce();
    const g = await group("b2", 20);
    const leadId = await lead("b2-lead", 10, 50, g);
    const builder = await coder("b2-builder", 10, 50, g);
    const other = await coder("b2-other", 10, 0, g);
    const parent = await db.run.create({ data: { agentId: leadId, status: "running", costUsd: 0 } });
    const between = await dispatchRun({ db, executor, agentId: other });
    const child = await dispatchRun({ db, executor, agentId: builder, trigger: "subagent", parentRunId: parent.id });
    const otherReserved = await reserved(between!.run.id);
    const childReserved = await reserved(child!.run.id);
    expect(otherReserved).toBeCloseTo(10, 6);
    expect(childReserved).toBeCloseTo(15, 6);
    // $25 reserved against a $20 cap.
    expect(otherReserved + childReserved).toBeGreaterThan(20);
    await db.run.updateMany({
      where: { id: { in: [parent.id, between!.run.id, child!.run.id] } },
      data: { status: "cancelled" },
    });
  });
});
