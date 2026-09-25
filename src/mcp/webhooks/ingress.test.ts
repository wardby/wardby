import { describe, it, expect } from "vitest";
import { handleWebhookIngress } from "./ingress.js";
import { createWebhook } from "../../core/webhooks.js";
import type { Executor } from "../../providers/executor/types.js";

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

function fakeDb(agents: FakeAgentRow[]) {
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
        if (row) return { kind: "native", codingProfile: null, budgetUsd: 1, model: "m", ...row };
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
  return db as import("#prisma").PrismaClient;
}

describe("webhook ingress", () => {
  it("valid secret in the header -> 202 with a runId", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]);
    const { id, secret } = await createWebhook("a1", "p1", db);
    const result = await handleWebhookIngress(id, { headers: { "x-webhook-secret": secret }, body: {} }, db, executor);
    expect(result.status).toBe(202);
    expect((result.body as { runId: string }).runId).toBeTruthy();
  });

  it("valid secret in the body -> 202", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]);
    const { id, secret } = await createWebhook("a1", "p1", db);
    const result = await handleWebhookIngress(id, { headers: {}, body: { secret } }, db, executor);
    expect(result.status).toBe(202);
  });

  it("wrong secret -> 401", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]);
    const { id } = await createWebhook("a1", "p1", db);
    const result = await handleWebhookIngress(id, { headers: { "x-webhook-secret": "wrong" }, body: {} }, db, executor);
    expect(result.status).toBe(401);
  });

  it("unknown webhook id -> 404", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]);
    const result = await handleWebhookIngress(
      "no-such-id",
      { headers: { "x-webhook-secret": "x" }, body: {} },
      db,
      executor,
    );
    expect(result.status).toBe(404);
  });

  it("disabled webhook -> 403", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]);
    const { id, secret } = await createWebhook("a1", "p1", db);
    await db.webhook.update({ where: { id }, data: { status: "disabled" } });
    const result = await handleWebhookIngress(id, { headers: { "x-webhook-secret": secret }, body: {} }, db, executor);
    expect(result.status).toBe(403);
  });

  it("missing secret entirely -> 401", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]);
    const { id } = await createWebhook("a1", "p1", db);
    const result = await handleWebhookIngress(id, { headers: {}, body: {} }, db, executor);
    expect(result.status).toBe(401);
  });

  it("rejects malformed webhook task input before dispatch", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]);
    const { id, secret } = await createWebhook("a1", "p1", db);
    const result = await handleWebhookIngress(
      id,
      { headers: { "x-webhook-secret": secret }, body: { task: "\u0000not valid" } },
      db,
      executor,
    );
    expect(result).toEqual({ status: 400, body: { error: "invalid_task" } });
  });
});
