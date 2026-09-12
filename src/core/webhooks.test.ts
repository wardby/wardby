import { describe, it, expect } from "vitest";
import type { Executor } from "../providers/executor/types.js";
import { createWebhook, listWebhooks, deleteWebhook, resolveWebhookRun } from "./webhooks.js";

const executor: Executor = { async start() {}, async stop() {} };

interface FakeWebhookRow {
  id: string;
  agentId: string;
  secretHash: string;
  status: "enabled" | "disabled";
  ownerId: string | null;
  createdAt: Date;
  lastFiredAt: Date | null;
}
interface FakeAgentRow {
  id: string;
  name: string;
  kind?: "native" | "coding";
  codingProfile?: Record<string, unknown> | null;
}

function fakeDb(agents: FakeAgentRow[] = []) {
  const webhooks = new Map<string, FakeWebhookRow>();
  const agentsById = new Map(agents.map((a) => [a.id, a]));
  let counter = 0;
  let runCounter = 0;

  const db: any = {
    webhook: {
      create: async ({ data }: { data: Partial<FakeWebhookRow> & { agentId: string; secretHash: string } }) => {
        const row: FakeWebhookRow = {
          id: `webhook_${++counter}`,
          status: "enabled",
          ownerId: null,
          createdAt: new Date(),
          lastFiredAt: null,
          ...data,
        };
        webhooks.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => webhooks.get(where.id) ?? null,
      findMany: async ({ where }: { where: { ownerId: string } }) =>
        [...webhooks.values()].filter((w) => w.ownerId === where.ownerId),
      delete: async ({ where }: { where: { id: string } }) => {
        const row = webhooks.get(where.id);
        webhooks.delete(where.id);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeWebhookRow> }) => {
        const row = webhooks.get(where.id);
        if (!row) throw new Error("not found");
        const updated = { ...row, ...data };
        webhooks.set(where.id, updated);
        return updated;
      },
    },
    agent: {
      findUnique: async ({ where }: { where: { id?: string; name?: string } }) => {
        const row = where.id ? agentsById.get(where.id) : agents.find((a) => a.name === where.name);
        if (row) return { kind: "native", codingProfile: null, budgetUsd: 1, model: "gpt-5.6-luna", ...row };
        return null;
      },
    },
    run: {
      create: async ({ data }: { data: { agentId: string; trigger: string } }) => ({
        id: `run_${++runCounter}`,
        status: "pending",
        startedAt: new Date(),
        ...data,
      }),
      updateMany: async () => ({ count: 1 }),
    },
    codingRun: { create: async ({ data }: any) => data },
    task: {
      create: async ({ data }: any) => ({ id: "task_1", createdAt: new Date(), updatedAt: new Date(), ...data }),
    },
    $queryRaw: async () => [],
  };
  db.$transaction = async (fn: (tx: any) => unknown) => fn(db);
  return db as import("@prisma/client").PrismaClient;
}

describe("core/webhooks", () => {
  it("createWebhook returns the raw secret once and stores only a hash", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]);
    const { id, secret } = await createWebhook("a1", "p1", db);
    expect(secret).toBeTruthy();
    const row = await db.webhook.findUnique({ where: { id } });
    expect(row?.secretHash).not.toBe(secret);
    expect(row?.secretHash.length).toBeGreaterThan(0);
  });

  it("listWebhooks never returns the secret or its hash", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]);
    await createWebhook("a1", "p1", db);
    const list = await listWebhooks("p1", db);
    expect(list.length).toBe(1);
    expect(list[0]).not.toHaveProperty("secret");
    expect(list[0]).not.toHaveProperty("secretHash");
  });

  it("resolveWebhookRun with the valid secret creates a manual run and stamps lastFiredAt", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]);
    const { id, secret } = await createWebhook("a1", "p1", db);
    const result = await resolveWebhookRun(id, secret, db, executor);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.runId).toBeTruthy();
    const row = await db.webhook.findUnique({ where: { id } });
    expect(row?.lastFiredAt).not.toBeNull();
  });

  it("resolveWebhookRun with the wrong secret is rejected without creating a run", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]);
    const { id } = await createWebhook("a1", "p1", db);
    const result = await resolveWebhookRun(id, "wrong-secret", db, executor);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_secret");
  });

  it("resolveWebhookRun for an unknown id is not_found", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]);
    const result = await resolveWebhookRun("no-such-webhook", "anything", db, executor);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });

  it("resolveWebhookRun for a disabled webhook is rejected", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]);
    const { id, secret } = await createWebhook("a1", "p1", db);
    await db.webhook.update({ where: { id }, data: { status: "disabled" } });
    const result = await resolveWebhookRun(id, secret, db, executor);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("disabled");
  });

  it("accepts webhook task input only for an opted-in coding profile", async () => {
    const codingProfile = {
      provider: "codex",
      repository: "openai/reevo",
      baseRef: "main",
      defaultTask: "Default task",
      allowWebhookTaskOverride: true,
      timeoutSec: 900,
      allowedEgress: [],
      protectedPaths: ["CODEOWNERS"],
    };
    const db = fakeDb([{ id: "a1", name: "coder", kind: "coding", codingProfile }]);
    const { id, secret } = await createWebhook("a1", "p1", db);
    await expect(resolveWebhookRun(id, secret, db, executor, "Fix the failing test")).resolves.toMatchObject({
      ok: true,
    });

    const blockedDb = fakeDb([
      { id: "a1", name: "coder", kind: "coding", codingProfile: { ...codingProfile, allowWebhookTaskOverride: false } },
    ]);
    const blocked = await createWebhook("a1", "p1", blockedDb);
    await expect(
      resolveWebhookRun(blocked.id, blocked.secret, blockedDb, executor, "Fix the failing test"),
    ).resolves.toEqual({
      ok: false,
      reason: "disabled",
    });
  });

  it("deleteWebhook removes it from listWebhooks", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]);
    const { id } = await createWebhook("a1", "p1", db);
    await deleteWebhook(id, db);
    const list = await listWebhooks("p1", db);
    expect(list.length).toBe(0);
  });
});
