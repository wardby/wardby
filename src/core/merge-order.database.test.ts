/**
 * CodingRun.mergeOrder against real PostgreSQL (#260): a delegating agent's
 * declared merge step persists on the coding run it dispatches, is left null
 * when omitted, and a revision-in-place continuation
 * (`continuesCodingRunId`) inherits the pull request's effective mergeOrder
 * (the newest non-null value among the root and its continuations) unless
 * the continuing dispatch sets its own.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Executor } from "../providers/executor/types.js";
import { createPrismaClient } from "./db.js";
import { dispatchRun } from "./dispatch.js";
import { collectRelatedPullRequests } from "./related-pull-requests.js";

describe.skipIf(!process.env.DATABASE_URL)("CodingRun.mergeOrder (database)", () => {
  const db = createPrismaClient();
  const PREFIX = "modb-";
  const suffix = randomUUID();
  const owner = `${PREFIX}owner-${suffix}`;
  const id = (name: string) => `${PREFIX}${name}-${suffix}`;
  const executor: Executor = {
    async start() {},
    async stop() {},
  };

  async function codingAgent(name: string): Promise<string> {
    const agentId = id(name);
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        systemPrompt: "Fix things.",
        model: "gpt-5.6-luna",
        budgetUsd: 2,
        kind: "coding",
        ownerId: owner,
        codingProfile: {
          create: { provider: "codex", repository: "openai/example", defaultTask: "Fix it.", protectedPaths: [] },
        },
      },
    });
    return agentId;
  }

  async function mergeOrderOf(runId: string): Promise<number | null> {
    const row = await db.codingRun.findUniqueOrThrow({ where: { runId }, select: { mergeOrder: true } });
    return row.mergeOrder;
  }

  async function cleanup(): Promise<void> {
    const agents = { agentId: { startsWith: PREFIX } };
    await db.codingRun.deleteMany({ where: { run: agents } });
    await db.run.deleteMany({ where: agents });
    await db.codingAgentProfile.deleteMany({ where: agents });
    await db.agent.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await db.principal.deleteMany({ where: { id: { startsWith: PREFIX } } });
  }

  beforeAll(async () => {
    await cleanup();
    await db.principal.create({ data: { id: owner, subject: owner } });
  });

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("persists the caller's mergeOrder on the coding run it dispatches", async () => {
    const coder = await codingAgent("persists");
    const result = await dispatchRun({ db, executor, agentId: coder, mergeOrder: 2 });
    expect(await mergeOrderOf(result!.run.id)).toBe(2);
  });

  it("leaves mergeOrder null when the caller gives none", async () => {
    const coder = await codingAgent("absent");
    const result = await dispatchRun({ db, executor, agentId: coder });
    expect(await mergeOrderOf(result!.run.id)).toBeNull();
  });

  it("a continuation with no mergeOrder inherits the root coding run's", async () => {
    const coder = await codingAgent("continuation-inherit");
    const root = await dispatchRun({ db, executor, agentId: coder, mergeOrder: 3 });
    await db.run.update({
      where: { id: root!.run.id },
      data: {
        codingRun: {
          update: {
            result: {
              schemaVersion: 1,
              outcome: "pull_request_opened",
              repository: "openai/example",
              baseRef: "main",
              headRef: `wardby/run-${root!.run.id}`,
              commitSha: "a".repeat(40),
              pullRequestUrl: "https://github.com/openai/example/pull/1",
              pullRequestNumber: 1,
              summary: "Opened the PR",
              tests: [],
              usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
            },
          },
        },
      },
    });

    const continuation = await dispatchRun({
      db,
      executor,
      agentId: coder,
      continuesCodingRunId: root!.run.id,
    });

    expect(await mergeOrderOf(continuation!.run.id)).toBe(3);
  });

  it("a continuation's own mergeOrder overrides the root's", async () => {
    const coder = await codingAgent("continuation-override");
    const root = await dispatchRun({ db, executor, agentId: coder, mergeOrder: 3 });
    await db.run.update({
      where: { id: root!.run.id },
      data: {
        codingRun: {
          update: {
            result: {
              schemaVersion: 1,
              outcome: "pull_request_opened",
              repository: "openai/example",
              baseRef: "main",
              headRef: `wardby/run-${root!.run.id}`,
              commitSha: "a".repeat(40),
              pullRequestUrl: "https://github.com/openai/example/pull/1",
              pullRequestNumber: 1,
              summary: "Opened the PR",
              tests: [],
              usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
            },
          },
        },
      },
    });

    const continuation = await dispatchRun({
      db,
      executor,
      agentId: coder,
      continuesCodingRunId: root!.run.id,
      mergeOrder: 1,
    });

    expect(await mergeOrderOf(continuation!.run.id)).toBe(1);
  });

  describe("a chain of continuations on one pull request", () => {
    let clock = Date.parse("2026-10-10T00:00:00Z");

    /** Dispatches, then records the run as having started after every earlier one and acted on PR #7. */
    async function step(
      agentId: string,
      options: { continuesCodingRunId?: string; mergeOrder?: number } = {},
    ): Promise<string> {
      const result = await dispatchRun({ db, executor, agentId, ...options });
      const runId = result!.run.id;
      clock += 60_000;
      await db.run.update({
        where: { id: runId },
        data: {
          startedAt: new Date(clock),
          codingRun: {
            update: {
              result: {
                schemaVersion: 1,
                outcome: options.continuesCodingRunId ? "pull_request_updated" : "pull_request_opened",
                repository: "openai/example",
                baseRef: "main",
                headRef: "wardby/chain",
                commitSha: "b".repeat(40),
                pullRequestUrl: "https://github.com/openai/example/pull/7",
                pullRequestNumber: 7,
                summary: "Worked on the PR",
                tests: [],
                usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
              },
            },
          },
        },
      });
      return runId;
    }

    async function collectedMergeOrder(runId: string): Promise<number | undefined> {
      const group = await collectRelatedPullRequests(db, runId);
      const pr = group.pullRequests.find((p) => p.repository === "openai/example" && p.number === 7);
      expect(pr).toBeDefined();
      return pr!.mergeOrder;
    }

    it("a continuation that omits mergeOrder keeps an earlier continuation's override", async () => {
      const coder = await codingAgent("chain-keep");
      const root = await step(coder, { mergeOrder: 2 });
      await step(coder, { continuesCodingRunId: root, mergeOrder: 1 });
      const last = await step(coder, { continuesCodingRunId: root });

      expect(await mergeOrderOf(last)).toBe(1);
      expect(await collectedMergeOrder(last)).toBe(1);
    });

    it("an explicit mergeOrder on a later continuation still wins", async () => {
      const coder = await codingAgent("chain-explicit");
      const root = await step(coder, { mergeOrder: 2 });
      await step(coder, { continuesCodingRunId: root, mergeOrder: 1 });
      const last = await step(coder, { continuesCodingRunId: root, mergeOrder: 3 });

      expect(await mergeOrderOf(last)).toBe(3);
      expect(await collectedMergeOrder(last)).toBe(3);
    });

    it("stays null through the chain when nothing ever set one", async () => {
      const coder = await codingAgent("chain-none");
      const root = await step(coder);
      const middle = await step(coder, { continuesCodingRunId: root });
      const last = await step(coder, { continuesCodingRunId: middle });

      expect(await mergeOrderOf(middle)).toBeNull();
      expect(await mergeOrderOf(last)).toBeNull();
      expect(await collectedMergeOrder(last)).toBeUndefined();
    });
  });

  it("rejects an out-of-range mergeOrder", async () => {
    const coder = await codingAgent("invalid");
    await expect(dispatchRun({ db, executor, agentId: coder, mergeOrder: 100 })).rejects.toThrow("invalid_merge_order");
  });
});
