import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import { createPrismaClient } from "./db.js";
import type { RepoAccessGate } from "./repo-access.js";

vi.mock("./host-events.js", async (orig) => ({
  ...(await orig<typeof import("./host-events.js")>()),
  startReviews: vi.fn(async () => ["review-run-2"]),
}));
import { startReviews } from "./host-events.js";
import { reReviewAfterNoChangeFix, reviewFixTaskText } from "./review-fix.js";

const db = createPrismaClient();
const suffix = randomUUID();
const principalId = `rereview-principal-${suffix}`;
const fixAgent = `rereview-fix-${suffix}`;
const coder = `rereview-coder-${suffix}`;
const reviewer = `rereview-reviewer-${suffix}`;
const repository = `o/rereview-${suffix}`;
const SHA = "0123456789abcdef0123456789abcdef01234567";

describe.skipIf(!process.env.DATABASE_URL)("reReviewAfterNoChangeFix (PostgreSQL)", () => {
  beforeAll(async () => {
    await db.principal.create({ data: { id: principalId, subject: principalId } });
    for (const [id, kind] of [
      [fixAgent, "native"],
      [coder, "coding"],
      [reviewer, "native"],
    ] as const) {
      await db.agent.create({
        data: { id, name: id, systemPrompt: "x", model: "gpt-5.6-luna", budgetUsd: 1, kind, ownerId: principalId },
      });
    }
    await db.agentRepository.create({
      data: {
        agentId: fixAgent,
        provider: "github",
        repository,
        access: "write",
        triggers: ["mention", "review_fix"],
        authorizedVia: "host_permission",
      },
    });
    await db.agentRepository.create({
      data: {
        agentId: reviewer,
        provider: "github",
        repository,
        access: "write",
        triggers: ["pull_request"],
        checkName: "wardby review",
        authorizedVia: "host_permission",
      },
    });
  });

  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId: { in: [fixAgent, coder, reviewer] } } });
    await db.agent.deleteMany({ where: { id: { in: [fixAgent, coder, reviewer] } } });
    await db.principal.deleteMany({ where: { id: principalId } });
    await db.$disconnect();
  });

  it("starts exactly one review under concurrent and repeated terminal hooks", async () => {
    const reviewRun = `rereview-review-${suffix}`;
    const fixRun = `rereview-fixrun-${suffix}`;
    const codingRun = `rereview-coding-${suffix}`;
    const t0 = new Date(Date.now() - 60_000);
    await db.run.create({
      data: { id: reviewRun, agentId: reviewer, status: "succeeded", trigger: "host_event", startedAt: t0 },
    });
    await db.runHostCheck.create({
      data: {
        runId: reviewRun,
        provider: "github",
        repository,
        checkId: "1",
        headSha: SHA,
        prNumber: 7,
        verdict: "CHANGES_REQUESTED",
        reviewBody: "needs work",
        completedAt: new Date(t0.getTime() + 1000),
      },
    });
    await db.run.create({
      data: {
        id: fixRun,
        agentId: fixAgent,
        status: "running",
        trigger: "host_event",
        startedAt: new Date(t0.getTime() + 2000),
        taskOverride: reviewFixTaskText({
          repository,
          prNumber: 7,
          headSha: SHA,
          round: 1,
          maxRounds: 2,
          priorRunId: "run_1",
          reviewBody: "needs work",
        }),
      },
    });
    await db.runHostStatus.create({
      data: { runId: fixRun, provider: "github", repository, number: 7, commentKind: "conversation" },
    });
    await db.run.create({
      data: { id: codingRun, agentId: coder, status: "succeeded", parentRunId: fixRun, executionManaged: true },
    });
    await db.codingRun.create({
      data: {
        runId: codingRun,
        task: "Fix it.",
        repository,
        baseRef: "main",
        headRef: "wardby/run-run_1",
        provider: "codex",
        model: "gpt-5.6-luna",
        timeoutSec: 900,
        protectedPaths: [],
        budgetReservedUsd: 1,
        result: { outcome: "no_changes", summary: "Nothing to fix." },
      },
    });

    const labels = ["wardby-autofix-1"];
    const host = {
      provider: "github",
      pullRequestOrigin: vi.fn(async () => ({
        headSha: SHA,
        isFork: false,
        state: "open",
        labels: [...labels],
        markerRunId: "run_1",
      })),
      addLabel: vi.fn(async (_r: string, _n: number, label: string) => {
        if (!labels.includes(label)) labels.push(label);
      }),
      comment: vi.fn(async () => ({ url: "u", id: "1" })),
    } as unknown as CodeReviewHost;
    const repoAccess = { authorizeUse: vi.fn(async () => ({ ok: true })) } as unknown as RepoAccessGate;
    const deps = { db, executor: {} as never, hosts: { github: host }, repoAccess };

    vi.mocked(startReviews).mockClear();
    await Promise.all([reReviewAfterNoChangeFix(codingRun, deps), reReviewAfterNoChangeFix(codingRun, deps)]);
    await reReviewAfterNoChangeFix(codingRun, deps);

    expect(startReviews).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startReviews).mock.calls[0].slice(2, 6)).toEqual([
      repository,
      7,
      SHA,
      [{ agentId: reviewer, checkName: "wardby review" }],
    ]);
    expect(labels).toEqual(["wardby-autofix-1", "wardby-autofix-2"]);
    const claimed = await db.runHostCheck.findUnique({ where: { runId: reviewRun } });
    expect(claimed?.noChangeRereviewAt).toBeInstanceOf(Date);
    // The CI re-review claim is a separate column, untouched here.
    expect(claimed?.ciRereviewAt).toBeNull();
  });
});
