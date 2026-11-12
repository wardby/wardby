/**
 * One follow-up in flight per root run (#537 §4) against real PostgreSQL: mentions on two pull
 * requests of one root run's set arriving together start exactly one run, through the real
 * dispatch transaction (its Serializable re-check), and the other is told a follow-up is already
 * running. The code host and executor are fakes. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import type { Executor } from "../providers/executor/types.js";
import { createPrismaClient } from "./db.js";
import { mentionDeclinedBody, routeHostEvent, type HostEvent } from "./host-events.js";
import type { RepoAccessGate } from "./repo-access.js";

describe.skipIf(!process.env.DATABASE_URL)("one follow-up in flight per root run (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID().slice(0, 8);
  const id = (name: string) => `rootfu-${name}-${suffix}`;
  const owner = id("owner");
  const builder = id("builder");
  const responder = id("responder");
  const FORK = `your-org/fork-${suffix}`;
  const TOOLS = `your-org/tools-${suffix}`;

  const result = (repository: string, number: number) => ({
    schemaVersion: 1,
    outcome: "pull_request_opened",
    repository,
    baseRef: "main",
    headRef: `wardby/run-${id("root")}`,
    commitSha: "a".repeat(40),
    pullRequestUrl: `https://github.com/${repository}/pull/${number}`,
    pullRequestNumber: number,
    summary: "Did the work.",
    tests: [],
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  });

  const comments: Array<{ repository: string; number: number; body: string }> = [];
  const host = {
    provider: "github",
    acknowledge: vi.fn(async () => undefined),
    comment: vi.fn(async (repository: string, input: { number: number; body: string }) => {
      comments.push({ repository, number: input.number, body: input.body });
      return { url: "https://x/c", id: "1" };
    }),
    editComment: vi.fn(async () => undefined),
  } as unknown as CodeReviewHost;
  const repoAccess = {
    authorizeUse: vi.fn(async () => ({ ok: true })),
    authorizeHostUser: vi.fn(async () => ({ ok: true })),
    authorizePrincipal: vi.fn(),
  } as unknown as RepoAccessGate;
  const executor: Executor = { start: vi.fn(async () => {}), async stop() {} };
  const deps = { db, executor, hosts: { github: host }, repoAccess, mentionHandle: "wardby" };

  const mention = (repository: string, number: number): HostEvent => ({
    kind: "mention",
    provider: "github",
    repository,
    number,
    isPullRequest: true,
    comment: { kind: "conversation", id: `${repository}#${number}` },
    body: "@wardby please fix it",
    author: "someone",
    authorId: "1001",
    priorRunId: id("root"),
  });

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    for (const a of [builder, responder]) {
      await db.agent.create({ data: { id: a, name: a, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner } });
    }
    for (const repository of [FORK, TOOLS]) {
      await db.agentRepository.create({
        data: {
          agentId: responder,
          provider: "github",
          repository,
          name: `github:${repository}`,
          access: "write",
          triggers: ["mention"],
          authorizedVia: "host_permission",
        },
      });
    }
    // The root opened FORK#7 in its default repository and TOOLS#3 in its writable extra `tools`.
    await db.run.create({ data: { id: id("root"), agentId: builder, status: "succeeded" } });
    await db.codingRun.create({
      data: {
        runId: id("root"),
        task: "t",
        repository: FORK,
        baseRef: "main",
        headRef: `wardby/run-${id("root")}`,
        provider: "codex",
        model: "m",
        timeoutSec: 900,
        protectedPaths: [],
        budgetReservedUsd: 1,
        result: result(FORK, 7),
      },
    });
    await db.codingRunRepository.create({
      data: {
        runId: id("root"),
        position: 1,
        name: "tools",
        access: "write",
        provider: "github",
        repository: TOOLS,
        baseRef: "main",
        headRef: `wardby/run-${id("root")}`,
        pullRequestNumber: 3,
        result: result(TOOLS, 3),
      },
    });
  });

  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId: { in: [builder, responder] } } });
    await db.agentRepository.deleteMany({ where: { agentId: responder } });
    await db.agent.deleteMany({ where: { id: { in: [builder, responder] } } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  it("two mentions on the set's pull requests arriving together start one run; the other is told why", async () => {
    for (let round = 0; round < 3; round++) {
      comments.length = 0;
      const routed = await Promise.all([
        routeHostEvent(mention(TOOLS, 3), deps),
        routeHostEvent(mention(FORK, 7), deps),
      ]);
      for (const r of routed) for (const f of r.followUps) await f();
      const started = routed.flatMap((r) => r.runIds);
      expect(started).toHaveLength(1);
      const declined = comments.filter((c) => c.body === mentionDeclinedBody("follow_up_running"));
      expect(declined).toHaveLength(1);
      // A third mention while that run is still going is declined too.
      const third = await routeHostEvent(mention(TOOLS, 3), deps);
      expect(third.runIds).toEqual([]);
      // The run ends: the next round may start one again.
      await db.run.update({ where: { id: started[0] }, data: { status: "succeeded", finishedAt: new Date() } });
    }
    expect(await db.run.count({ where: { agentId: responder } })).toBe(3);
  });
});
