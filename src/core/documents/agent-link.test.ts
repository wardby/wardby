import { describe, expect, it } from "vitest";
import { documentLinkSendable, wardbyPlanLink } from "./agent-link.js";

const unlinked = {
  kind: "document",
  agentId: null,
  repository: null,
  path: null,
  baseRef: null,
  planPath: null,
  removedFromPlan: false,
};
const wardbySet = { store: "wardby", agentId: "planner" };

describe("wardbyPlanLink", () => {
  it("returns a wardby set for a document with a plan path, and null otherwise", () => {
    expect(wardbyPlanLink({ planPath: "plan.md" }, wardbySet)).toBe(wardbySet);
    expect(wardbyPlanLink({ planPath: null }, wardbySet)).toBeNull();
    expect(wardbyPlanLink({ planPath: "plan.md" }, { store: "repository", agentId: "planner" })).toBeNull();
    expect(wardbyPlanLink({ planPath: "plan.md" }, null)).toBeNull();
  });
});

describe("documentLinkSendable", () => {
  it("sends a wardby plan document or design linked to its set's planner", () => {
    const planDoc = { ...unlinked, agentId: "planner", planPath: "plan.md" };
    expect(documentLinkSendable(planDoc, wardbySet)).toBe(true);
    // A plan design has no base ref of its own: the plan folder is its link.
    expect(documentLinkSendable({ ...planDoc, kind: "design", planPath: "boards" }, wardbySet)).toBe(true);
  });

  it("does not send a plan document removed from its plan, linked to another agent, or with no agent", () => {
    const planDoc = { ...unlinked, agentId: "planner", planPath: "plan.md" };
    expect(documentLinkSendable({ ...planDoc, removedFromPlan: true }, wardbySet)).toBe(false);
    expect(documentLinkSendable({ ...planDoc, agentId: "other" }, wardbySet)).toBe(false);
    expect(documentLinkSendable({ ...planDoc, agentId: null }, wardbySet)).toBe(false);
  });

  it("keeps the repository rule for other documents", () => {
    const linked = { ...unlinked, repository: "acme/web", path: "docs/plan.md" };
    expect(documentLinkSendable(unlinked, null)).toBe(false);
    expect(documentLinkSendable(linked, null)).toBe(true);
    expect(documentLinkSendable({ ...linked, kind: "design", path: "designs/a" }, null)).toBe(false);
    expect(documentLinkSendable({ ...linked, kind: "design", path: "designs/a", baseRef: "main" }, null)).toBe(true);
    // A "repository" plan set's document is linked by its own repository and path.
    const repoSet = { store: "repository", agentId: "planner" };
    expect(documentLinkSendable({ ...linked, planPath: "plan.md" }, repoSet)).toBe(true);
    expect(documentLinkSendable({ ...linked, planPath: "plan.md", removedFromPlan: true }, repoSet)).toBe(false);
  });
});
