import { describe, it, expect, vi } from "vitest";
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
  model?: string;
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
        // Owned by "p1", the creator every test uses, so the fire-time creator check passes.
        if (row) return { kind: "native", codingProfile: null, budgetUsd: 1, model: "m", ownerId: "p1", ...row };
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

  it("accepts an optional wardbyIssue and attributes the run to it", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]) as any;
    const created: unknown[] = [];
    db.agentIssueProject = { findUnique: async () => ({ agentId: "a1" }) };
    db.workItem = { findUnique: async () => null, upsert: async () => ({ id: "wi1", parentKey: null }) };
    db.runAttribution = { findUnique: async () => null, create: async (a: unknown) => created.push(a) };
    db.runIssueStatus = { findUnique: async () => null };
    const { id, secret } = await createWebhook("a1", "p1", db);
    const result = await handleWebhookIngress(
      id,
      { headers: { "x-webhook-secret": secret }, body: { wardbyIssue: { provider: "jira", key: "PAY-241" } } },
      db,
      executor,
    );
    expect(result.status).toBe(202);
    expect(created).toEqual([
      { data: { runId: expect.any(String), workItemId: "wi1", parentKeyAtRun: null, source: "explicit" } },
    ]);
  });

  it("corrects a lowercase wardbyIssue key and attributes the run to the uppercase issue", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]) as any;
    const upserts: Array<{ where: unknown }> = [];
    db.agentIssueProject = { findUnique: async () => ({ agentId: "a1" }) };
    db.workItem = {
      findUnique: async () => null,
      upsert: async (a: { where: unknown }) => (upserts.push(a), { id: "wi1", parentKey: null }),
    };
    db.runAttribution = { findUnique: async () => null, create: async () => ({}) };
    db.runIssueStatus = { findUnique: async () => null };
    const { id, secret } = await createWebhook("a1", "p1", db);
    const result = await handleWebhookIngress(
      id,
      { headers: { "x-webhook-secret": secret }, body: { wardbyIssue: { provider: "jira", key: "pay-241" } } },
      db,
      executor,
    );
    expect(result.status).toBe(202);
    expect(upserts.map((u) => u.where)).toEqual([{ provider_key: { provider: "jira", key: "PAY-241" } }]);
  });

  it("rejects a wardbyIssue the agent is not linked to with 400 invalid_issue, creating no run", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]) as any;
    db.agentIssueProject = { findUnique: async () => null };
    const runCreate = vi.spyOn(db.run, "create");
    const { id, secret } = await createWebhook("a1", "p1", db);
    const result = await handleWebhookIngress(
      id,
      { headers: { "x-webhook-secret": secret }, body: { wardbyIssue: { provider: "jira", key: "PAY-241" } } },
      db,
      executor,
    );
    expect(result).toEqual({
      status: 400,
      body: { error: "invalid_issue", error_description: expect.stringMatching(/not linked/) },
    });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("ignores a forwarded payload's top-level issue object (e.g. a GitHub issues event): 202, unattributed", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]) as any;
    const created: unknown[] = [];
    const linkLookup = vi.fn(async () => null);
    db.agentIssueProject = { findUnique: linkLookup };
    db.runAttribution = { findUnique: async () => null, create: async (a: unknown) => created.push(a) };
    const { id, secret } = await createWebhook("a1", "p1", db);
    const result = await handleWebhookIngress(
      id,
      {
        headers: { "x-webhook-secret": secret },
        body: { action: "opened", issue: { number: 7, title: "Bug", user: { login: "octocat" } } },
      },
      db,
      executor,
    );
    expect(result.status).toBe(202);
    expect(linkLookup).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  describe("wardbyRepository", () => {
    const codingProfile = {
      provider: "codex",
      repository: "acme/service-a",
      baseRef: "main",
      defaultTask: "Default task",
      allowWebhookTaskOverride: true,
      timeoutSec: 900,
      allowedEgress: [],
      protectedPaths: ["CODEOWNERS"],
    };
    async function setup(kind: "coding" | "native" = "coding", profile: Record<string, unknown> = codingProfile) {
      const db = fakeDb([
        // A model the catalog can run: with any other the run fails before its CodingRun is written.
        { id: "a1", name: "coder", kind, model: "gpt-5.6-luna", codingProfile: kind === "coding" ? profile : null },
      ]) as any;
      db.agentRepository = {
        findMany: async () => [{ repository: "acme/service-b", baseRef: null }],
      };
      const { id, secret } = await createWebhook("a1", "p1", db);
      const handle = (body: Record<string, unknown>) =>
        handleWebhookIngress(id, { headers: { "x-webhook-secret": secret }, body }, db, executor);
      return { db, secret, handle };
    }

    it("a coding webhook with the opt-in runs in a listed repository", async () => {
      const { handle, db } = await setup();
      const stored: { repository: string; viaRepositoryLink: boolean }[] = [];
      db.codingRun.create = async ({ data }: any) => {
        stored.push(data);
        return data;
      };
      expect((await handle({ task: "fix", wardbyRepository: "ACME/Service-B" })).status).toBe(202);
      expect((await handle({ task: "fix", wardbyRepository: "acme/service-a" })).status).toBe(202);
      expect(stored).toEqual([
        // The value from the list, not the caller's spelling.
        expect.objectContaining({ repository: "acme/service-b", viaRepositoryLink: true }),
        expect.objectContaining({ repository: "acme/service-a", viaRepositoryLink: false }),
      ]);
    });

    it("an unlisted repository is a 400 with only an error code; neither the secret nor the list is echoed or logged", async () => {
      const { handle, secret } = await setup();
      const logs: string[] = [];
      const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" "))),
      );
      const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        logs.push(String(chunk));
        return true;
      });
      spies.push(out as never);
      try {
        const result = await handle({ wardbyRepository: "acme/sk-fake-secret" });
        expect(result).toEqual({ status: 400, body: { error: "invalid_repository" } });
        const seen = JSON.stringify(result) + logs.join("\n");
        expect(seen).not.toContain(secret);
        expect(seen).not.toContain("acme/service-a");
        expect(seen).not.toContain("acme/service-b");
        expect(seen).not.toContain("sk-fake-secret");
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });

    it("a non-string, empty or oversized wardbyRepository is a 400", async () => {
      const { handle } = await setup();
      for (const value of [42, "", "x".repeat(301), { a: 1 }]) {
        expect((await handle({ wardbyRepository: value })).body).toEqual({ error: "invalid_repository" });
      }
    });

    it("wardbyRepository without the opt-in is refused as disabled", async () => {
      const { handle } = await setup("coding", { ...codingProfile, allowWebhookTaskOverride: false });
      expect((await handle({ wardbyRepository: "acme/service-a" })).status).toBe(403);
    });

    it("wardbyRepository on a native agent is a 400", async () => {
      const { handle } = await setup("native");
      expect((await handle({ wardbyRepository: "acme/service-a" })).body).toEqual({ error: "invalid_repository" });
    });

    it("a forwarded payload's own repository object (e.g. GitHub) is ignored: it runs as today", async () => {
      const { handle } = await setup();
      const result = await handle({ action: "opened", repository: { full_name: "other/repo", id: 1 } });
      expect(result.status).toBe(202);
    });
  });

  it("rejects a malformed wardbyIssue with 400 invalid_issue", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]) as any;
    const runCreate = vi.spyOn(db.run, "create");
    const { id, secret } = await createWebhook("a1", "p1", db);
    const result = await handleWebhookIngress(
      id,
      { headers: { "x-webhook-secret": secret }, body: { wardbyIssue: { provider: "jira", key: "not a key" } } },
      db,
      executor,
    );
    expect(result).toEqual({
      status: 400,
      // Names the webhook's own field, not trigger_agent's `issue`.
      body: { error: "invalid_issue", error_description: "wardbyIssue.key must be an issue key such as PROJ-123." },
    });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("names wardbyIssue.provider when the provider is unknown", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]) as any;
    const { id, secret } = await createWebhook("a1", "p1", db);
    const result = await handleWebhookIngress(
      id,
      { headers: { "x-webhook-secret": secret }, body: { wardbyIssue: { provider: "trello", key: "PAY-241" } } },
      db,
      executor,
    );
    expect(result).toMatchObject({
      status: 400,
      body: { error: "invalid_issue", error_description: expect.stringMatching(/^wardbyIssue\.provider must be/) },
    });
  });

  it("snapshots a wardbyIssue within the response-path budget (2 s, no 429 retry)", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]) as any;
    db.agentIssueProject = { findUnique: async () => ({ agentId: "a1" }) };
    db.workItem = { findUnique: async () => null, upsert: async () => ({ id: "wi1", parentKey: null }) };
    db.runAttribution = { findUnique: async () => null, create: async () => ({}) };
    db.runIssueStatus = { findUnique: async () => null };
    const snapshotIssue = vi.fn(async (key: string) => ({ key, scopeKey: "PAY", url: `https://jira.example/${key}` }));
    const trackers = { jira: { snapshotIssue } } as any;
    const { id, secret } = await createWebhook("a1", "p1", db);
    const result = await handleWebhookIngress(
      id,
      { headers: { "x-webhook-secret": secret }, body: { wardbyIssue: { provider: "jira", key: "PAY-241" } } },
      db,
      executor,
      trackers,
    );
    expect(result.status).toBe(202);
    expect(snapshotIssue).toHaveBeenCalledWith("PAY-241", { timeoutMs: 2000, retryOn429: false });
  });

  it("checks the secret before the wardbyIssue: a wrong secret with a bad or unlinked issue is 401, not 400", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter" }]) as any;
    const linkLookup = vi.fn(async () => null);
    db.agentIssueProject = { findUnique: linkLookup };
    const { id } = await createWebhook("a1", "p1", db);
    for (const wardbyIssue of [
      { provider: "jira", key: "PAY-241" },
      { provider: "nope", key: "??" },
    ]) {
      const result = await handleWebhookIngress(
        id,
        { headers: { "x-webhook-secret": "wrong" }, body: { wardbyIssue } },
        db,
        executor,
      );
      expect(result).toEqual({ status: 401, body: { error: "invalid_secret" } });
    }
    expect(linkLookup).not.toHaveBeenCalled();
  });
});
