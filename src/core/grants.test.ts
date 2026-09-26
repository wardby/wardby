import { describe, expect, it } from "vitest";
import type { PrismaClient } from "#prisma";
import {
  EVERYONE_MAX,
  LEVELS,
  accessRank,
  atLeast,
  canDelegate,
  effectiveAccess,
  grantedAccessMap,
  grantedIds,
  isLevel,
} from "./grants.js";
import { fakeResourceGrants, type FakeGrantSeed } from "./grants.test-support.js";

function db(seed: FakeGrantSeed[] = []) {
  return { resourceGrant: fakeResourceGrants(seed) } as unknown as Pick<PrismaClient, "resourceGrant">;
}

describe("grant levels", () => {
  it("orders levels per type, read first", () => {
    expect(LEVELS.agent).toEqual(["read", "execute", "write"]);
    expect(LEVELS.tool).toEqual(["read", "use", "write"]);
    expect(LEVELS.budget_group).toEqual(["read", "use", "write"]);
    expect(accessRank("agent", "read")).toBeLessThan(accessRank("agent", "execute"));
    expect(accessRank("agent", "execute")).toBeLessThan(accessRank("agent", "write"));
    expect(accessRank("agent", "write")).toBeLessThan(accessRank("agent", "owner"));
    expect(accessRank("agent", "none")).toBeLessThan(accessRank("agent", "read"));
  });

  it("atLeast treats owner as above every level and none as below read", () => {
    for (const level of LEVELS.agent) {
      expect(atLeast("agent", "owner", level)).toBe(true);
      expect(atLeast("agent", "none", level)).toBe(false);
    }
    expect(atLeast("agent", "owner", "owner")).toBe(true);
    expect(atLeast("agent", "write", "owner")).toBe(false);
    expect(atLeast("agent", "execute", "read")).toBe(true);
    expect(atLeast("agent", "execute", "write")).toBe(false);
  });

  it("a level from another type is not a level of this one (fail closed)", () => {
    expect(isLevel("agent", "use")).toBe(false);
    expect(isLevel("tool", "execute")).toBe(false);
    expect(atLeast("agent", "use", "read")).toBe(false);
  });

  it("caps everyone grants below write", () => {
    expect(EVERYONE_MAX).toEqual({ agent: "execute", tool: "use", budget_group: "use" });
  });
});

describe("effectiveAccess", () => {
  const agent = { id: "a1", ownerId: "owner" };

  it("the owner is owner, with no grant lookup needed", async () => {
    expect(await effectiveAccess({} as never, "agent", agent, "owner")).toBe("owner");
  });

  it("a stranger with no grant has none", async () => {
    expect(await effectiveAccess(db(), "agent", agent, "stranger")).toBe("none");
  });

  it("takes the max of the principal grant and the everyone grant", async () => {
    const grants = db([
      { resourceType: "agent", resourceId: "a1", principalId: "p", level: "write" },
      { resourceType: "agent", resourceId: "a1", granteeKind: "everyone", level: "read" },
    ]);
    expect(await effectiveAccess(grants, "agent", agent, "p")).toBe("write");
    expect(await effectiveAccess(grants, "agent", agent, "q")).toBe("read");
    const low = db([
      { resourceType: "agent", resourceId: "a1", principalId: "p", level: "read" },
      { resourceType: "agent", resourceId: "a1", granteeKind: "everyone", level: "execute" },
    ]);
    expect(await effectiveAccess(low, "agent", agent, "p")).toBe("execute");
  });

  it("ignores grants on other resources and other types", async () => {
    const grants = db([
      { resourceType: "agent", resourceId: "a2", principalId: "p", level: "write" },
      { resourceType: "tool", resourceId: "a1", principalId: "p", level: "write" },
    ]);
    expect(await effectiveAccess(grants, "agent", agent, "p")).toBe("none");
  });

  it("an owner-less row gets access from grants only; nobody is its owner", async () => {
    const ownerless = { id: "a1", ownerId: null };
    const grants = db([{ resourceType: "agent", resourceId: "a1", granteeKind: "everyone", level: "execute" }]);
    expect(await effectiveAccess(grants, "agent", ownerless, "anyone")).toBe("execute");
    expect(await effectiveAccess(db(), "agent", ownerless, "anyone")).toBe("none");
  });

  it("the stdio operator is owner of everything", async () => {
    expect(await effectiveAccess(db(), "agent", agent, "stranger", { operator: true })).toBe("owner");
    expect(await effectiveAccess(db(), "agent", { id: "x", ownerId: null }, "s", { operator: true })).toBe("owner");
  });

  it("an unknown stored level counts as none (fail closed)", async () => {
    const grants = db([
      { resourceType: "agent", resourceId: "a1", principalId: "p", level: "admin" },
      { resourceType: "agent", resourceId: "a1", principalId: "q", level: "use" },
    ]);
    expect(await effectiveAccess(grants, "agent", agent, "p")).toBe("none");
    expect(await effectiveAccess(grants, "agent", agent, "q")).toBe("none");
  });

  it("an everyone grant stored above EVERYONE_MAX is read as the cap", async () => {
    const grants = db([{ resourceType: "agent", resourceId: "a1", granteeKind: "everyone", level: "write" }]);
    expect(await effectiveAccess(grants, "agent", agent, "p")).toBe("execute");
  });

  it("a null principal (e.g. a legacy webhook with no creator) only gets everyone grants", async () => {
    const grants = db([{ resourceType: "agent", resourceId: "a1", granteeKind: "everyone", level: "execute" }]);
    expect(await effectiveAccess(grants, "agent", { id: "a1", ownerId: null }, null)).toBe("execute");
    expect(await effectiveAccess(db(), "agent", { id: "a1", ownerId: null }, null)).toBe("none");
  });
});

describe("grantedIds / grantedAccessMap", () => {
  const grants = db([
    { resourceType: "agent", resourceId: "a1", principalId: "p", level: "read" },
    { resourceType: "agent", resourceId: "a2", principalId: "p", level: "write" },
    { resourceType: "agent", resourceId: "a3", granteeKind: "everyone", level: "execute" },
    { resourceType: "agent", resourceId: "a4", principalId: "q", level: "write" },
    { resourceType: "tool", resourceId: "t1", principalId: "p", level: "use" },
  ]);

  it("lists ids held at or above the level, through principal and everyone grants", async () => {
    expect((await grantedIds(grants, "agent", "p", "read")).sort()).toEqual(["a1", "a2", "a3"]);
    expect((await grantedIds(grants, "agent", "p", "execute")).sort()).toEqual(["a2", "a3"]);
    expect(await grantedIds(grants, "agent", "p", "write")).toEqual(["a2"]);
  });

  it("maps each resource to the best level held", async () => {
    const map = await grantedAccessMap(grants, "agent", "p");
    expect(Object.fromEntries(map)).toEqual({ a1: "read", a2: "write", a3: "execute" });
  });
});

describe("canDelegate (sub-agent edge rule)", () => {
  it("same owner is allowed", async () => {
    expect(await canDelegate(db(), { ownerId: "a" }, { id: "c", ownerId: "a" })).toBe(true);
  });

  it("both owner-less counts as the same owner", async () => {
    expect(await canDelegate(db(), { ownerId: null }, { id: "c", ownerId: null })).toBe(true);
  });

  it("cross-owner without the parent owner's execute grant on the child is refused", async () => {
    expect(await canDelegate(db(), { ownerId: "a" }, { id: "c", ownerId: "b" })).toBe(false);
    const readOnly = db([{ resourceType: "agent", resourceId: "c", principalId: "a", level: "read" }]);
    expect(await canDelegate(readOnly, { ownerId: "a" }, { id: "c", ownerId: "b" })).toBe(false);
  });

  it("cross-owner with the parent owner holding execute on the child is allowed", async () => {
    const grants = db([{ resourceType: "agent", resourceId: "c", principalId: "a", level: "execute" }]);
    expect(await canDelegate(grants, { ownerId: "a" }, { id: "c", ownerId: "b" })).toBe(true);
  });

  it("an owner-less parent with an owned child is refused, whatever the grants", async () => {
    const grants = db([{ resourceType: "agent", resourceId: "c", granteeKind: "everyone", level: "execute" }]);
    expect(await canDelegate(grants, { ownerId: null }, { id: "c", ownerId: "b" })).toBe(false);
  });
});
