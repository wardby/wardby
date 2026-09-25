import { describe, it, expect } from "vitest";
import {
  canRead,
  isOwner,
  canMutate,
  assertCanMutate,
  visibleToPrincipal,
  requireOwnedAgent,
  requireReadableAgent,
  requireOwnedTask,
  requireOwnedSecret,
  requireOwnedWebhook,
  requireOwnedTool,
  requireOwnedBudgetGroup,
  requireReadableBudgetGroup,
} from "./ownership.js";
import { McpError } from "../errors.js";

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

describe("requireOwnedAgent", () => {
  it("returns the agent for its owner", async () => {
    const db = fakeDb({ a1: { id: "a1", ownerId: "p1" } });
    await expect(requireOwnedAgent(db, "a1", "p1")).resolves.toMatchObject({ id: "a1" });
  });
  it("404s for a missing agent", async () => {
    const db = fakeDb({});
    await expect(requireOwnedAgent(db, "missing", "p1")).rejects.toMatchObject({ httpStatus: 404 });
  });
  it("returns a public (null-owner) agent for any principal — public rows are mutable by anyone", async () => {
    const db = fakeDb({ a1: { id: "a1", ownerId: null } });
    await expect(requireOwnedAgent(db, "a1", "anyone")).resolves.toMatchObject({ id: "a1" });
  });
  it("403s for a different owner", async () => {
    const db = fakeDb({ a1: { id: "a1", ownerId: "owner-1" } });
    await expect(requireOwnedAgent(db, "a1", "p1")).rejects.toMatchObject({ httpStatus: 403 });
  });
});

describe("requireReadableAgent", () => {
  it("returns the agent for its owner", async () => {
    const db = fakeDb({ a1: { id: "a1", ownerId: "p1" } });
    await expect(requireReadableAgent(db, "a1", "p1")).resolves.toMatchObject({ id: "a1" });
  });
  it("returns a public (null-owner) agent for any principal", async () => {
    const db = fakeDb({ a1: { id: "a1", ownerId: null } });
    await expect(requireReadableAgent(db, "a1", "anyone")).resolves.toMatchObject({ id: "a1" });
  });
  it("404s (not 403) for a different owner's private agent", async () => {
    const db = fakeDb({ a1: { id: "a1", ownerId: "owner-1" } });
    await expect(requireReadableAgent(db, "a1", "p1")).rejects.toMatchObject({ httpStatus: 404 });
  });
});

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

describe("requireOwnedSecret", () => {
  it("resolves for the owner", async () => {
    const db = fakeDb({}, {}, { s1: { id: "s1", ownerId: "p1" } });
    await expect(requireOwnedSecret(db, "s1", "p1")).resolves.toBeUndefined();
  });
  it("403s for a missing secret", async () => {
    const db = fakeDb({}, {}, {});
    await expect(requireOwnedSecret(db, "missing", "p1")).rejects.toMatchObject({ httpStatus: 403 });
  });
  it("403s for a different owner", async () => {
    const db = fakeDb({}, {}, { s1: { id: "s1", ownerId: "owner-1" } });
    await expect(requireOwnedSecret(db, "s1", "p1")).rejects.toMatchObject({ httpStatus: 403 });
  });
  it("resolves for any principal on a public (null-owner) secret", async () => {
    const db = fakeDb({}, {}, { s1: { id: "s1", ownerId: null } });
    await expect(requireOwnedSecret(db, "s1", "anyone")).resolves.toBeUndefined();
  });
});

describe("requireOwnedWebhook", () => {
  it("resolves for the owner", async () => {
    const db = fakeDb({}, {}, {}, { w1: { id: "w1", ownerId: "p1" } });
    await expect(requireOwnedWebhook(db, "w1", "p1")).resolves.toBeUndefined();
  });
  it("403s for a missing webhook", async () => {
    const db = fakeDb({}, {}, {}, {});
    await expect(requireOwnedWebhook(db, "missing", "p1")).rejects.toMatchObject({ httpStatus: 403 });
  });
  it("403s for a different owner", async () => {
    const db = fakeDb({}, {}, {}, { w1: { id: "w1", ownerId: "owner-1" } });
    await expect(requireOwnedWebhook(db, "w1", "p1")).rejects.toMatchObject({ httpStatus: 403 });
  });
  it("resolves for any principal on a public (null-owner) webhook", async () => {
    const db = fakeDb({}, {}, {}, { w1: { id: "w1", ownerId: null } });
    await expect(requireOwnedWebhook(db, "w1", "anyone")).resolves.toBeUndefined();
  });
});

describe("requireOwnedTool", () => {
  it("returns the tool for its owner", async () => {
    const db = fakeDb({}, {}, {}, {}, {}, { t1: { id: "t1", ownerId: "p1" } });
    await expect(requireOwnedTool(db, "t1", "p1")).resolves.toMatchObject({ id: "t1" });
  });
  it("404s for a missing tool", async () => {
    const db = fakeDb({}, {}, {}, {}, {}, {});
    await expect(requireOwnedTool(db, "missing", "p1")).rejects.toMatchObject({ httpStatus: 404 });
  });
  it("403s for a different owner", async () => {
    const db = fakeDb({}, {}, {}, {}, {}, { t1: { id: "t1", ownerId: "owner-1" } });
    await expect(requireOwnedTool(db, "t1", "p1")).rejects.toMatchObject({ httpStatus: 403 });
  });
  it("returns a public (null-owner) tool for any principal", async () => {
    const db = fakeDb({}, {}, {}, {}, {}, { t1: { id: "t1", ownerId: null } });
    await expect(requireOwnedTool(db, "t1", "anyone")).resolves.toMatchObject({ id: "t1" });
  });
});

describe("requireOwnedBudgetGroup", () => {
  it("returns the group when the caller owns it", async () => {
    const db = fakeDb({}, {}, {}, {}, { g1: { id: "g1", ownerId: "p1" } });
    await expect(requireOwnedBudgetGroup(db, "g1", "p1")).resolves.toMatchObject({ id: "g1" });
  });
  it("throws 404 when the group doesn't exist", async () => {
    const db = fakeDb({}, {}, {}, {}, {});
    await expect(requireOwnedBudgetGroup(db, "missing", "p1")).rejects.toMatchObject({ httpStatus: 404 });
  });
  it("throws 403 when the caller doesn't own a group someone else owns", async () => {
    const db = fakeDb({}, {}, {}, {}, { g1: { id: "g1", ownerId: "someone-else" } });
    await expect(requireOwnedBudgetGroup(db, "g1", "p1")).rejects.toMatchObject({ httpStatus: 403 });
  });
  it("returns a public (null-owner) group for any caller — public rows are mutable by anyone", async () => {
    const db = fakeDb({}, {}, {}, {}, { g1: { id: "g1", ownerId: null } });
    await expect(requireOwnedBudgetGroup(db, "g1", "anyone")).resolves.toMatchObject({ id: "g1" });
  });
});

describe("requireReadableBudgetGroup", () => {
  it("returns a public (null-owner) group for any caller", async () => {
    const db = fakeDb({}, {}, {}, {}, { g1: { id: "g1", ownerId: null } });
    await expect(requireReadableBudgetGroup(db, "g1", "p1")).resolves.toMatchObject({ id: "g1" });
  });
  it("returns the group when the caller owns it", async () => {
    const db = fakeDb({}, {}, {}, {}, { g1: { id: "g1", ownerId: "p1" } });
    await expect(requireReadableBudgetGroup(db, "g1", "p1")).resolves.toMatchObject({ id: "g1" });
  });
  it("404s for a group owned by someone else", async () => {
    const db = fakeDb({}, {}, {}, {}, { g1: { id: "g1", ownerId: "someone-else" } });
    await expect(requireReadableBudgetGroup(db, "g1", "p1")).rejects.toMatchObject({ httpStatus: 404 });
  });
});
