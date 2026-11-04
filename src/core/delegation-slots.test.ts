import { describe, expect, it } from "vitest";
import { delegationLimitRefusal, delegationSlot, priorDelegationSlots } from "./delegation-slots.js";

describe("delegationSlot", () => {
  it("separates repositories of one child, ignoring case", () => {
    expect(delegationSlot("c", "acme/a")).not.toBe(delegationSlot("c", "acme/b"));
    expect(delegationSlot("c", "Acme/A")).toBe(delegationSlot("c", "acme/a"));
  });
  it("is the child id alone for a native child", () => {
    expect(delegationSlot("c", null)).toBe("c");
  });
});

describe("priorDelegationSlots", () => {
  it("treats this child's refused run, which has no coding run, as its default repository", () => {
    const slots = priorDelegationSlots([{ agentId: "c", codingRun: null }], "c", "acme/default");
    expect(slots).toEqual([delegationSlot("c", "acme/default")]);
  });
  it("uses a coding run's own repository", () => {
    const slots = priorDelegationSlots([{ agentId: "c", codingRun: { repository: "acme/a" } }], "c", "acme/default");
    expect(slots).toEqual([delegationSlot("c", "acme/a")]);
  });
  it("keeps other children's rows countable", () => {
    expect(priorDelegationSlots([{ agentId: "d", codingRun: null }], "c", "acme/default")).toEqual(["d"]);
  });
});

describe("delegationLimitRefusal", () => {
  const base = {
    priorSlots: [] as string[],
    waitingSlots: [] as string[],
    slot: "c\nacme/a",
    boundName: "fixer",
    limit: 5,
    childHasRepositoryList: true,
  };
  const errorOf = (r: string | null) => (r ? (JSON.parse(r) as { error: string; message: string }) : null);

  it("allows a free slot and a different slot of the same child", () => {
    expect(delegationLimitRefusal(base)).toBeNull();
    expect(delegationLimitRefusal({ ...base, priorSlots: ["c\nacme/b"] })).toBeNull();
  });
  it("refuses a slot already delegated", () => {
    const out = errorOf(delegationLimitRefusal({ ...base, priorSlots: ["c\nacme/a"] }));
    expect(out?.error).toBe("already_dispatched");
    expect(out?.message).toContain("at most once");
  });
  it("speaks of the repository only for a child with a list", () => {
    const withList = errorOf(delegationLimitRefusal({ ...base, priorSlots: ["c\nacme/a"] }));
    expect(withList?.message).toBe(
      'This run already delegated to "fixer" for this repository; a run delegates to each sub-agent and repository at most once.',
    );
    const withoutList = errorOf(
      delegationLimitRefusal({ ...base, childHasRepositoryList: false, priorSlots: ["c\nacme/a"] }),
    );
    expect(withoutList?.message).toBe(
      'This run already delegated to "fixer"; a run delegates to each sub-agent at most once.',
    );
  });
  it("refuses a slot that is waiting for budget, but not a different waiting slot", () => {
    expect(errorOf(delegationLimitRefusal({ ...base, waitingSlots: ["c\nacme/a"] }))?.error).toBe("already_dispatched");
    expect(delegationLimitRefusal({ ...base, waitingSlots: ["c\nacme/b"] })).toBeNull();
  });
  it("refuses at the limit, with the single-delegation and multi-delegation messages", () => {
    const one = errorOf(delegationLimitRefusal({ ...base, limit: 1, priorSlots: ["d"] }));
    expect(one?.message).toBe("This run already delegated to a sub-agent; only one delegation is allowed per run.");
    const many = errorOf(delegationLimitRefusal({ ...base, limit: 2, priorSlots: ["d", "e"] }));
    expect(many?.message).toBe("This run already made 2 delegations, the most this agent allows per run.");
  });
  it("refuses when prior plus waiting fill the limit", () => {
    const out = errorOf(delegationLimitRefusal({ ...base, limit: 2, priorSlots: ["d"], waitingSlots: ["e"] }));
    expect(out?.message).toBe("This run reached its limit of 2 delegations: 1 made and 1 waiting for budget.");
  });
});
