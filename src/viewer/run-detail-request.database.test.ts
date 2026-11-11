import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { identityCipher } from "../native-worker/fixtures.test-support.js";
import { RunDetailSchema } from "./api-schema.js";
import { loadRunDetail } from "./run-detail.js";

const db = createPrismaClient();
const tag = randomUUID();
const id = (name: string) => `detail-request-${name}-${tag}`;
const ownerId = id("owner");
const native = id("native");
const coding = id("coding");
const secretId = id("secret");
const runs = { task: id("r-task"), long: id("r-long"), none: id("r-none"), coding: id("r-coding") };

// Fake values only: an attached secret and a token-shaped value the agent never stored.
const SECRET_VALUE = "fake-attached-secret-7f3a9c2e";
const TOKEN_SHAPED = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

const failingCipher: typeof identityCipher = {
  ...identityCipher,
  decrypt: async () => {
    throw new Error("kms down");
  },
};

describe.skipIf(!process.env.DATABASE_URL)("loadRunDetail's request (PostgreSQL)", () => {
  beforeAll(async () => {
    await db.principal.create({ data: { id: ownerId, subject: ownerId } });
    for (const [agentId, kind] of [
      [native, "native"],
      [coding, "coding"],
    ] as const) {
      await db.agent.create({
        data: { id: agentId, name: agentId, systemPrompt: "x", model: "agent-model", budgetUsd: 1, kind, ownerId },
      });
    }
    await db.secret.create({
      data: { id: secretId, name: "api", ciphertext: SECRET_VALUE, keyId: "test", ownerId },
    });
    await db.agentSecret.create({ data: { agentId: native, secretId, boundName: "api" } });
    await db.agentSecret.create({ data: { agentId: coding, secretId, boundName: "api" } });
    await db.run.create({
      data: {
        id: runs.task,
        agentId: native,
        status: "succeeded",
        taskOverride: `Deploy with key ${SECRET_VALUE} and token ${TOKEN_SHAPED} please`,
      },
    });
    await db.run.create({
      data: {
        id: runs.long,
        agentId: native,
        status: "succeeded",
        taskOverride: `${"a".repeat(7_990)} ${SECRET_VALUE}`,
      },
    });
    await db.run.create({ data: { id: runs.none, agentId: native, status: "succeeded" } });
    await db.run.create({
      data: {
        id: runs.coding,
        agentId: coding,
        trigger: "subagent",
        status: "succeeded",
        taskOverride: "the lead's own task, not this run's",
        codingRun: {
          create: {
            task: "full task with standing instructions",
            request: `Build ticket 8. Use ${SECRET_VALUE}.`,
            repository: "your-org/app",
            baseRef: "main",
            headRef: "wardby/x",
            provider: "codex",
            model: "coding-model",
            timeoutSec: 60,
            protectedPaths: [],
            budgetReservedUsd: 0.5,
          },
        },
      },
    });
  });

  afterAll(async () => {
    await db.run.deleteMany({ where: { id: { in: Object.values(runs) } } });
    await db.agentSecret.deleteMany({ where: { secretId } });
    await db.secret.deleteMany({ where: { id: secretId } });
    await db.agent.deleteMany({ where: { id: { in: [native, coding] } } });
    await db.principal.deleteMany({ where: { id: ownerId } });
  });

  it("returns a native run's task with the agent's secret values and token shapes masked", async () => {
    const detail = await loadRunDetail(db, runs.task, {}, identityCipher);
    expect(RunDetailSchema.parse(detail)).toBeTruthy();
    expect(detail!.request).toContain("Deploy with key");
    expect(detail!.request).not.toContain(SECRET_VALUE);
    expect(detail!.request).not.toContain(TOKEN_SHAPED);
    expect(detail!.requestTruncated).toBe(false);
    expect(JSON.stringify(detail)).not.toContain(SECRET_VALUE);
  });

  it("returns a coding run's own request, not the task it was started with, masked", async () => {
    const detail = await loadRunDetail(db, runs.coding, {}, identityCipher);
    expect(detail!.request).toMatch(/^Build ticket 8\. Use /);
    expect(detail!.request).not.toContain(SECRET_VALUE);
    expect(detail!.request).not.toContain("standing instructions");
    expect(JSON.stringify(detail)).not.toContain(SECRET_VALUE);
  });

  it("masks before cutting, so a secret across the 8,000-character cut never shows in part", async () => {
    const detail = await loadRunDetail(db, runs.long, {}, identityCipher);
    expect(detail!.request).toHaveLength(8_000);
    expect(detail!.requestTruncated).toBe(true);
    expect(detail!.request).not.toContain(SECRET_VALUE.slice(0, 9));
  });

  it("returns null for a run with no request", async () => {
    const detail = await loadRunDetail(db, runs.none, {}, identityCipher);
    expect(detail!.request).toBeNull();
    expect(detail!.requestTruncated).toBe(false);
  });

  it("withholds the request (null) when the agent's secrets can't be read to check it", async () => {
    const detail = await loadRunDetail(db, runs.task, {}, failingCipher);
    expect(detail!.request).toBeNull();
    expect(detail!.requestTruncated).toBe(false);
    expect(JSON.stringify(detail)).not.toContain(SECRET_VALUE);
  });
});
