import { describe, it, expect } from "vitest";
import {
  canRead,
  isOwner,
  canMutate,
  assertCanMutate,
  visibleToPrincipal,
  requireOwnedTask,
  requireSecretAccess,
  requireDatastoreAccess,
  requireWebhookAccess,
  requireToolAccess,
  requireStrictlyOwnedTool,
  requireBudgetGroupAccess,
} from "./ownership.js";
import { McpError } from "../errors.js";
import { fakeResourceGrants, type FakeGrantSeed } from "../../core/grants.test-support.js";

describe("canRead", () => {
  it("null owner (public) is readable by anyone", () => {
    expect(canRead(null, "p1")).toBe(true);
  });
  it("owner reading their own resource", () => {
    expect(canRead("p1", "p1")).toBe(true);
  });
  it("a different principal cannot read an owned (non-null) resource", () => {
    expect(canRead("owner-1", "p1")).toBe(false);
  });
});

describe("isOwner", () => {
  it("null never matches a real principal (no implicit public-mutate)", () => {
    expect(isOwner(null, "p1")).toBe(false);
  });
  it("exact match", () => {
    expect(isOwner("p1", "p1")).toBe(true);
  });
});

describe("canMutate", () => {
  it("null owner (public) is mutable by anyone", () => {
    expect(canMutate(null, "p1")).toBe(true);
  });
  it("owner mutating their own resource", () => {
    expect(canMutate("p1", "p1")).toBe(true);
  });
  it("a different principal cannot mutate an owned (non-null) resource", () => {
    expect(canMutate("owner-1", "p1")).toBe(false);
  });
});

describe("assertCanMutate", () => {
  it("passes for the owner", () => {
    expect(() => assertCanMutate("p1", "p1", "nope")).not.toThrow();
  });
  it("passes for a null (public) owner — public rows are mutable by anyone", () => {
    expect(() => assertCanMutate(null, "p1", "nope")).not.toThrow();
  });
  it("throws 403 for a different owner", () => {
    try {
      assertCanMutate("owner-1", "p1", "custom message");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).httpStatus).toBe(403);
      expect((err as McpError).message).toBe("custom message");
    }
  });
});

describe("visibleToPrincipal", () => {
  it("builds an OR clause covering own + public rows", () => {
    expect(visibleToPrincipal("p1")).toEqual({ OR: [{ ownerId: "p1" }, { ownerId: null }] });
  });
});

function fakeDb(
  agents: Record<string, { id: string; ownerId: string | null }>,
  tasks: Record<string, { id: string; principalId: string | null }> = {},
  secrets: Record<string, { id: string; ownerId: string | null }> = {},
  webhooks: Record<string, { id: string; ownerId: string | null }> = {},
  budgetGroups: Record<string, { id: string; ownerId: string | null }> = {},
  tools: Record<string, { id: string; ownerId: string | null }> = {},
) {
  return {
    agent: { findUnique: async ({ where }: { where: { id: string } }) => agents[where.id] ?? null },
    task: { findUnique: async ({ where }: { where: { id: string } }) => tasks[where.id] ?? null },
    secret: { findUnique: async ({ where }: { where: { id: string } }) => secrets[where.id] ?? null },
    webhook: { findUnique: async ({ where }: { where: { id: string } }) => webhooks[where.id] ?? null },
    budgetGroup: { findUnique: async ({ where }: { where: { id: string } }) => budgetGroups[where.id] ?? null },
    tool: { findUnique: async ({ where }: { where: { id: string } }) => tools[where.id] ?? null },
  } as unknown as import("#prisma").PrismaClient;
}

// Agents no longer use this module's owner-or-public rule: their access
// checks (owner, missing, owner-less, other owner) are covered in
// access.test.ts under the grants model.

describe("requireOwnedTask", () => {
  it("returns the task for the triggering principal", async () => {
    const db = fakeDb({}, { t1: { id: "t1", principalId: "p1" } });
    await expect(requireOwnedTask(db, "t1", "p1")).resolves.toMatchObject({ id: "t1" });
  });
  it("404s for a null principalId — a task has no public-read concept", async () => {
    const db = fakeDb({}, { t1: { id: "t1", principalId: null } });
    await expect(requireOwnedTask(db, "t1", "p1")).rejects.toMatchObject({ httpStatus: 404 });
  });
  it("404s (not 403) for another principal's task", async () => {
    const db = fakeDb({}, { t1: { id: "t1", principalId: "owner-1" } });
    await expect(requireOwnedTask(db, "t1", "p1")).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("requireSecretAccess, requireDatastoreAccess and requireWebhookAccess", () => {
  type Row = { id: string; ownerId: string | null };
  const rows = (map: Record<string, Row>) => ({
    findUnique: async ({ where }: { where: { id: string } }) => map[where.id] ?? null,
  });
  const callerCtx = (
    principalId: string,
    opts: {
      actsFor?: string[];
      grants?: FakeGrantSeed[];
      webhooks?: Record<string, Row & { agentOwner: string | null }>;
    } = {},
  ) =>
    ({
      principal: { id: principalId },
      actsFor: opts.actsFor,
      scopes: new Set<string>(),
      roles: [],
      db: {
        resourceGrant: fakeResourceGrants(opts.grants ?? []),
        secret: rows({
          mine: { id: "mine", ownerId: "p1" },
          theirs: { id: "theirs", ownerId: "owner-1" },
          team: { id: "team", ownerId: "team-p" },
          public: { id: "public", ownerId: null },
        }),
        datastore: rows({ mine: { id: "mine", ownerId: "p1" }, theirs: { id: "theirs", ownerId: "owner-1" } }),
        webhook: {
          findUnique: async ({ where }: { where: { id: string } }) => {
            const w = opts.webhooks?.[where.id];
            return w ? { id: w.id, ownerId: w.ownerId, agent: { ownerId: w.agentOwner } } : null;
          },
        },
      },
    }) as unknown as import("../context.js").McpRequestContext;

  it("the owner holds every level; a missing or someone else's row is 404, not 403", async () => {
    await expect(requireSecretAccess(callerCtx("p1"), "mine", "owner")).resolves.toMatchObject({ id: "mine" });
    await expect(requireSecretAccess(callerCtx("p1"), "missing", "owner")).rejects.toMatchObject({ httpStatus: 404 });
    await expect(requireSecretAccess(callerCtx("p1"), "theirs", "owner")).rejects.toMatchObject({ httpStatus: 404 });
    await expect(requireDatastoreAccess(callerCtx("p1"), "theirs", "read")).rejects.toMatchObject({ httpStatus: 404 });
  });
  it("a Team the caller acts for owns what the Team owns", async () => {
    await expect(
      requireSecretAccess(callerCtx("p1", { actsFor: ["p1", "team-p"] }), "team", "owner"),
    ).resolves.toMatchObject({
      id: "team",
    });
  });
  it("a public (no owner) row stays open to everyone, as before", async () => {
    await expect(requireSecretAccess(callerCtx("anyone"), "public", "owner")).resolves.toMatchObject({ id: "public" });
  });
  it("a read grant shows the row but makes the caller no owner (403 naming both)", async () => {
    const grants: FakeGrantSeed[] = [
      { resourceType: "secret", resourceId: "theirs", level: "read", principalId: "p1" },
    ];
    const ctx = callerCtx("p1", { grants });
    await expect(requireSecretAccess(ctx, "theirs", "read")).resolves.toMatchObject({ id: "theirs" });
    await expect(requireSecretAccess(ctx, "theirs", "owner")).rejects.toMatchObject({ httpStatus: 403 });
  });
  it("a webhook is owned by its creator and by the owner of the agent it fires", async () => {
    const webhooks = { w1: { id: "w1", ownerId: "creator", agentOwner: "p1" } };
    await expect(requireWebhookAccess(callerCtx("p1", { webhooks }), "w1", "owner")).resolves.toMatchObject({
      id: "w1",
    });
    await expect(requireWebhookAccess(callerCtx("stranger", { webhooks }), "w1", "owner")).rejects.toMatchObject({
      httpStatus: 404,
    });
  });
});

describe("requireToolAccess", () => {
  const tools: Record<string, { id: string; ownerId: string | null }> = {
    mine: { id: "mine", ownerId: "p1" },
    theirs: { id: "theirs", ownerId: "owner-1" },
    team: { id: "team", ownerId: "team-p" },
    public: { id: "public", ownerId: null },
  };
  const toolCtx = (principalId: string, actsFor?: string[], grants: FakeGrantSeed[] = []) =>
    ({
      principal: { id: principalId },
      actsFor,
      scopes: new Set<string>(),
      roles: [],
      db: {
        resourceGrant: fakeResourceGrants(grants),
        tool: { findUnique: async ({ where }: { where: { id: string } }) => tools[where.id] ?? null },
      },
    }) as unknown as import("../context.js").McpRequestContext;

  it("returns the tool for its owner at every level", async () => {
    await expect(requireToolAccess(toolCtx("p1"), "mine", "owner")).resolves.toMatchObject({ id: "mine" });
  });
  it("404s a missing tool and one the caller cannot read", async () => {
    await expect(requireToolAccess(toolCtx("p1"), "missing", "read")).rejects.toMatchObject({ httpStatus: 404 });
    await expect(requireToolAccess(toolCtx("p1"), "theirs", "read")).rejects.toMatchObject({ httpStatus: 404 });
  });
  it("a Team the caller acts for owns it", async () => {
    await expect(requireToolAccess(toolCtx("p1", ["p1", "team-p"]), "team", "owner")).resolves.toMatchObject({
      id: "team",
    });
  });
  it("a public (null-owner) tool is usable by anyone but never owned", async () => {
    await expect(requireToolAccess(toolCtx("anyone"), "public", "use")).resolves.toMatchObject({ id: "public" });
    await expect(requireToolAccess(toolCtx("anyone"), "public", "write")).rejects.toMatchObject({ httpStatus: 403 });
  });
  it("a grant confers its level and no more", async () => {
    const ctx = toolCtx("p1", undefined, [
      { resourceType: "tool", resourceId: "theirs", level: "read", principalId: "p1" },
    ]);
    await expect(requireToolAccess(ctx, "theirs", "read")).resolves.toMatchObject({ id: "theirs" });
    await expect(requireToolAccess(ctx, "theirs", "use")).rejects.toMatchObject({ httpStatus: 403 });
  });
});

describe("requireBudgetGroupAccess", () => {
  const groupCtx = (principalId: string, actsFor?: string[], grants: FakeGrantSeed[] = []) =>
    ({
      principal: { id: principalId },
      actsFor,
      scopes: new Set<string>(),
      roles: [],
      db: {
        resourceGrant: fakeResourceGrants(grants),
        budgetGroup: {
          findUnique: async ({ where }: { where: { id: string } }) => groups[where.id] ?? null,
        },
      },
    }) as unknown as import("../context.js").McpRequestContext;
  const groups: Record<string, { id: string; ownerId: string | null }> = {
    mine: { id: "mine", ownerId: "p1" },
    theirs: { id: "theirs", ownerId: "someone-else" },
    team: { id: "team", ownerId: "team-p" },
    public: { id: "public", ownerId: null },
  };

  it("the owner holds every level", async () => {
    await expect(requireBudgetGroupAccess(groupCtx("p1"), "mine", "owner")).resolves.toMatchObject({ id: "mine" });
  });
  it("404s a missing group and a group the caller cannot read", async () => {
    await expect(requireBudgetGroupAccess(groupCtx("p1"), "missing", "read")).rejects.toMatchObject({
      httpStatus: 404,
    });
    await expect(requireBudgetGroupAccess(groupCtx("p1"), "theirs", "read")).rejects.toMatchObject({
      httpStatus: 404,
    });
  });
  it("a Team the caller acts for owns it", async () => {
    await expect(requireBudgetGroupAccess(groupCtx("p1", ["p1", "team-p"]), "team", "owner")).resolves.toMatchObject({
      id: "team",
    });
  });
  it("a public (no owner) group is open to everyone, as before", async () => {
    await expect(requireBudgetGroupAccess(groupCtx("anyone"), "public", "owner")).resolves.toMatchObject({
      id: "public",
    });
  });
  it("a grant confers its level and no more: use reads and uses but cannot write, and 403 names both", async () => {
    const ctx = groupCtx("p1", undefined, [
      { resourceType: "budget_group", resourceId: "theirs", level: "use", principalId: "p1" },
    ]);
    await expect(requireBudgetGroupAccess(ctx, "theirs", "use")).resolves.toMatchObject({ id: "theirs" });
    await expect(requireBudgetGroupAccess(ctx, "theirs", "write")).rejects.toMatchObject({ httpStatus: 403 });
  });
});

describe("requireStrictlyOwnedTool", () => {
  it("returns the tool for its owner", async () => {
    const db = fakeDb({}, {}, {}, {}, {}, { t1: { id: "t1", ownerId: "p1" } });
    await expect(requireStrictlyOwnedTool(db, "t1", "p1")).resolves.toMatchObject({ id: "t1" });
  });
  it("404s for a missing tool", async () => {
    const db = fakeDb({}, {}, {}, {}, {}, {});
    await expect(requireStrictlyOwnedTool(db, "missing", "p1")).rejects.toMatchObject({ httpStatus: 404 });
  });
  it("404s for another principal's tool, not confirming it exists", async () => {
    const db = fakeDb({}, {}, {}, {}, {}, { t1: { id: "t1", ownerId: "owner-1" } });
    await expect(requireStrictlyOwnedTool(db, "t1", "p1")).rejects.toMatchObject({ httpStatus: 404 });
  });
  it("403s for a public (null-owner) tool, unlike requireOwnedTool", async () => {
    const db = fakeDb({}, {}, {}, {}, {}, { t1: { id: "t1", ownerId: null } });
    await expect(requireStrictlyOwnedTool(db, "t1", "anyone")).rejects.toMatchObject({ httpStatus: 403 });
  });
});
