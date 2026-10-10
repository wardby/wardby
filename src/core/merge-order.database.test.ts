/**
 * CodingRun.mergeOrder against real PostgreSQL (#260): a delegating agent's
 * declared merge step persists on the coding run it dispatches, is left null
 * when omitted, and a revision-in-place continuation
 * (`continuesCodingRunId`) inherits the root coding run's mergeOrder unless
 * the continuing dispatch sets its own.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Executor } from "../providers/executor/types.js";
import { createPrismaClient } from "./db.js";
import { dispatchRun } from "./dispatch.js";

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

  it("rejects an out-of-range mergeOrder", async () => {
    const coder = await codingAgent("invalid");
    await expect(dispatchRun({ db, executor, agentId: coder, mergeOrder: 100 })).rejects.toThrow("invalid_merge_order");
  });
});
