/**
 * The spend line's SQL against real PostgreSQL: the recursive run-tree total
 * (grandchildren included), the issue total across attributed runs, and the
 * tree's per-model breakdown. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./db.js";
import { spendLine } from "./issue-status.js";

describe.skipIf(!process.env.DATABASE_URL)("spendLine (database)", () => {
  const db = createPrismaClient();
  const PREFIX = "spenddb-";
  const suffix = randomUUID();
  const owner = `${PREFIX}owner-${suffix}`;
  const id = (name: string) => `${PREFIX}${name}-${suffix}`;
  const itemKey = `SPND-${Math.floor(Math.random() * 1e9)}`;
  const agentId = id("agent");
  const root = id("root");
  const child = id("child");
  const grandchild = id("grand");
  const other = id("other");
  const solo = id("solo");

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 100, ownerId: owner },
    });
    const run = (runId: string, costUsd: number, parentRunId?: string) =>
      db.run.create({
        data: { id: runId, agentId, status: "succeeded", costUsd, ...(parentRunId ? { parentRunId } : {}) },
      });
    await run(root, 1);
    await run(child, 2, root);
    await run(grandchild, 3, child);
    await run(other, 4);
    await run(solo, 0.5);
    const item = await db.workItem.create({ data: { provider: "jira", key: itemKey, scopeKey: "SPND" } });
    const attribute = (runId: string, source: string) =>
      db.runAttribution.create({ data: { runId, workItemId: item.id, source } });
    await attribute(root, "issue_event");
    await attribute(child, "inherited");
    await attribute(grandchild, "inherited");
    await attribute(other, "issue_event");
    const usage = (runId: string, model: string, costUsd: number) =>
      db.runModelUsage.create({ data: { runId, model, costUsd } });
    await usage(root, "model-a", 1);
    await usage(child, "model-b", 2);
    await usage(grandchild, "model-a", 3);
    await usage(other, "model-c", 4);
  });

  afterAll(async () => {
    for (const runId of [grandchild, child, root, other, solo]) await db.run.deleteMany({ where: { id: runId } });
    await db.workItem.deleteMany({ where: { provider: "jira", key: itemKey } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  it("totals the whole run tree (grandchildren too), the issue, and the tree's models by cost", async () => {
    expect(await spendLine(db, root)).toBe(
      "Agent spend: $6 this run · $10 on this issue so far · model-a $4, model-b $2",
    );
  });

  it("counts only the subtree under a child run", async () => {
    expect(await spendLine(db, child)).toContain("$5 this run · $10 on this issue so far");
  });

  it("gives no issue total for an unattributed run", async () => {
    expect(await spendLine(db, solo)).toBe("Agent spend: $0.5 this run");
  });
});
