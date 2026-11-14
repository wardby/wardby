import { describe, expect, it } from "vitest";
import {
  buildAgentFlows,
  entryPoints,
  flowEdges,
  profileRepoKey,
  repoKey,
  type AgentLinkFacts,
} from "./agent-flows.js";

const R = "your-org/mobile";
function agent(over: Partial<AgentLinkFacts> & { id: string }): AgentLinkFacts {
  return {
    name: over.id,
    kind: "native",
    codingRepository: null,
    budgetGroup: null,
    scheduled: false,
    webhook: false,
    repositories: [],
    issueProjects: [],
    ...over,
  };
}
const link = (triggers: string[], access: "read" | "write" = "read", extra = {}) => ({
  provider: "github",
  repository: R,
  access,
  triggers,
  reviewFixMaxRounds: null,
  waitForCi: false,
  markReadyWhenPassing: false,
  ...extra,
});

const jira = (
  triggers: string[],
  extra: Partial<{
    triggerStatuses: string[];
    allowedTransitions: string[];
    onPullRequestOpened: string | null;
    onPullRequestMerged: string | null;
  }> = {},
) => ({
  provider: "jira",
  projectKey: "ABC",
  triggers,
  triggerStatuses: [],
  allowedTransitions: [],
  onPullRequestOpened: null,
  onPullRequestMerged: null,
  ...extra,
});

// A board: a person moves a ticket to "Ready for agent" (planner), the planner moves it to "Plan review",
// a person approves by moving it to "Approved" (builder), the builder's pull request moves it to
// "In Review", where a triage agent also starts, and the merge moves it to "Done".
export const BOARD: AgentLinkFacts[] = [
  agent({
    id: "planner",
    issueProjects: [
      jira(["transitioned"], { triggerStatuses: ["Ready for agent"], allowedTransitions: ["Plan review"] }),
    ],
  }),
  agent({
    id: "builder",
    kind: "coding",
    codingRepository: R,
    issueProjects: [
      jira(["transitioned"], {
        triggerStatuses: ["approved"],
        allowedTransitions: ["In Progress"],
        onPullRequestOpened: "In Review",
        onPullRequestMerged: "Done",
      }),
    ],
  }),
  agent({ id: "triage", issueProjects: [jira(["transitioned"], { triggerStatuses: ["in review"] })] }),
  agent({ id: "reader", issueProjects: [jira([])] }),
];

// The mobile-shaped setup: a lead with mention + review_fix delegating to planner and builder,
// a reviewer on pull_request, a device lead sharing the builder.
export const MOBILE: AgentLinkFacts[] = [
  agent({ id: "delivery", repositories: [link(["mention", "review_fix"])] }),
  agent({ id: "planner", kind: "coding", codingRepository: R }),
  agent({ id: "builder", kind: "coding", codingRepository: R }),
  agent({ id: "reviewer", repositories: [link(["pull_request"], "read", { waitForCi: true })] }),
  agent({ id: "device-lead" }),
];
export const MOBILE_SUBS = [
  { parentId: "delivery", childId: "planner", boundName: "plan" },
  { parentId: "delivery", childId: "builder", boundName: "build" },
  { parentId: "device-lead", childId: "builder", boundName: "build" },
];

describe("repo keys", () => {
  it("normalises GitHub names and keeps local paths", () => {
    expect(repoKey("github", "Your-Org/Web")).toBe("github:your-org/web");
    expect(repoKey("local", "/srv/Repo")).toBe("local:/srv/Repo");
    expect(profileRepoKey("Your-Org/Web")).toBe("github:your-org/web");
    expect(profileRepoKey("local:/srv/Repo")).toBe("local:/srv/Repo");
  });
});

describe("flowEdges", () => {
  it("draws delegation, review and fix edges for a mobile-shaped setup", () => {
    const edges = flowEdges(MOBILE, MOBILE_SUBS);
    const key = `github:${R}`;
    expect(edges).toEqual([
      { from: "delivery", to: "builder", kind: "delegates", repository: null, label: "build" },
      { from: "delivery", to: "planner", kind: "delegates", repository: null, label: "plan" },
      { from: "device-lead", to: "builder", kind: "delegates", repository: null, label: "build" },
      { from: "reviewer", to: "delivery", kind: "fixes", repository: key, label: "fix ≤2" },
      { from: "builder", to: "reviewer", kind: "reviews", repository: key, label: "PR opened" },
      { from: "planner", to: "reviewer", kind: "reviews", repository: key, label: "PR opened" },
    ]);
  });

  it("uses the fixer's reviewFixMaxRounds and adds after_merge for push", () => {
    const agents = [
      agent({ id: "b", kind: "coding", codingRepository: R }),
      agent({ id: "v", repositories: [link(["pull_request"])] }),
      agent({ id: "f", repositories: [link(["review_fix"], "read", { reviewFixMaxRounds: 4 })] }),
      agent({ id: "w", repositories: [link(["push"])] }),
    ];
    const edges = flowEdges(agents, []);
    expect(edges.find((e) => e.kind === "fixes")?.label).toBe("fix ≤4");
    expect(edges.filter((e) => e.kind === "after_merge")).toEqual([
      { from: "b", to: "w", kind: "after_merge", repository: `github:${R}`, label: "merged" },
    ]);
  });

  it("ignores sub-agent facts whose other end is not in the set, and self edges", () => {
    const agents = [agent({ id: "x", kind: "coding", codingRepository: R, repositories: [link(["pull_request"])] })];
    expect(flowEdges(agents, [{ parentId: "x", childId: "gone", boundName: "b" }])).toEqual([]);
  });
});

describe("entryPoints", () => {
  it("names mention, Jira, schedule and webhook entries", () => {
    const a = agent({
      id: "a",
      scheduled: true,
      webhook: true,
      repositories: [link(["mention"])],
      issueProjects: [jira(["created"])],
    });
    expect(entryPoints(a, [])).toEqual([`mention:github:${R}`, "jira:ABC", "schedule", "webhook"]);
  });

  it("is manual with no trigger and no incoming edge, empty for a pure sub-agent", () => {
    const edges = flowEdges(MOBILE, MOBILE_SUBS);
    expect(entryPoints(MOBILE[4], edges)).toEqual(["manual"]);
    expect(entryPoints(MOBILE[2], edges)).toEqual([]);
  });

  it("shows pull_request as an entry only when no writer feeds the reviewer", () => {
    const lone = agent({ id: "v", repositories: [link(["pull_request"])] });
    expect(entryPoints(lone, [])).toEqual([`pull_request:github:${R}`]);
    const edges = flowEdges(MOBILE, MOBILE_SUBS);
    expect(entryPoints(MOBILE[3], edges)).toEqual([]);
  });
});

describe("buildAgentFlows", () => {
  it("groups the mobile-shaped setup into one flow keyed by the mention lead", () => {
    const agents = [...MOBILE, agent({ id: "mobile-device-tester", name: "mobile-device-tester" })];
    const named = agents.map((a) => (a.id === "delivery" ? { ...a, name: "mobile-delivery" } : a));
    const result = buildAgentFlows(named, MOBILE_SUBS);
    expect(result.flows).toHaveLength(1);
    const flow = result.flows[0];
    expect(flow.key).toBe("delivery");
    expect(flow.name).toBe(R);
    expect(flow.agentIds.sort()).toEqual(["builder", "delivery", "device-lead", "planner", "reviewer"]);
    // Sorted by name: "device-lead" before "mobile-delivery". The lead counts although the fix loop
    // gives it an incoming edge.
    expect(flow.entryAgentIds).toEqual(["device-lead", "delivery"]);
    expect(flow.related).toEqual(["mobile-device-tester"]);
    expect(result.unlinked).toEqual([]);
    expect(result.entries["device-lead"]).toEqual(["manual"]);
  });

  it("does not join an agent that only shares a repository without a trigger relation", () => {
    const auditor = agent({ id: "auditor", scheduled: true, repositories: [link([], "read")] });
    const result = buildAgentFlows([...MOBILE, auditor], MOBILE_SUBS);
    expect(result.flows[0].agentIds).not.toContain("auditor");
    // It touches the flow's repository, so it is listed as related, not unlinked.
    expect(result.flows[0].related).toContain("auditor");
  });

  it("names a multi-repository flow after a shared budget group, else after its key agent", () => {
    const group = { id: "g1", name: "Shop" };
    const lead = agent({
      id: "lead",
      budgetGroup: group,
      repositories: ["a", "b"].map((r) => ({ ...link(["mention"]), repository: `your-org/${r}` })),
    });
    const ba = agent({ id: "ba", kind: "coding", codingRepository: "your-org/a", budgetGroup: group });
    const bb = agent({ id: "bb", kind: "coding", codingRepository: "your-org/b", budgetGroup: group });
    const subs = [
      { parentId: "lead", childId: "ba", boundName: "a" },
      { parentId: "lead", childId: "bb", boundName: "b" },
    ];
    expect(buildAgentFlows([lead, ba, bb], subs).flows[0].name).toBe("Shop · 2 repositories");
    const noGroup = [lead, ba, bb].map((a) => ({ ...a, budgetGroup: null }));
    expect(buildAgentFlows(noGroup, subs).flows[0].name).toBe("lead · 2 repositories");
  });

  it("puts a lone agent with nothing related under unlinked", () => {
    const result = buildAgentFlows([agent({ id: "solo", name: "solo" })], []);
    expect(result.flows).toEqual([]);
    expect(result.unlinked).toEqual(["solo"]);
  });
});

describe("ticket status hand-offs", () => {
  it("links an agent that moves a ticket to the agents that start on that status, case-insensitively", () => {
    expect(flowEdges(BOARD, []).filter((e) => e.kind === "status")).toEqual([
      { from: "builder", to: "triage", kind: "status", repository: "jira:ABC", label: "in review" },
    ]);
  });

  it("makes a status only a person can set an entry point, and none for one an agent sets", () => {
    const { entries } = buildAgentFlows(BOARD, []);
    expect(entries.planner).toEqual(["status:jira:ABC:Ready for agent"]);
    expect(entries.builder).toEqual(["status:jira:ABC:approved"]);
    expect(entries.triage).toEqual([]);
    expect(entries.reader).toEqual(["manual"]);
  });

  it("keeps a board's agents in one flow across a person-only approval, named after the project", () => {
    const result = buildAgentFlows(BOARD, []);
    expect(result.flows).toHaveLength(1);
    const flow = result.flows[0];
    expect(flow.agentIds.sort()).toEqual(["builder", "planner", "triage"]);
    expect(flow.issueProjects).toEqual(["jira:ABC"]);
    // A coding agent's profile repository is not a link into the flow's name.
    expect(flow.name).toBe("Jira ABC");
    // The key agent is a person-started agent with no incoming link: "builder" sorts first.
    expect(flow.key).toBe("builder");
    // An agent with a read-only link and no trigger stays out of the flow.
    expect(result.unlinked).toEqual(["reader"]);
  });

  it("names the issue project and the pull request moves, not other Jira settings", () => {
    const edges = flowEdges(
      [
        agent({ id: "a", issueProjects: [jira([], { onPullRequestMerged: "Done" })] }),
        agent({ id: "b", issueProjects: [jira(["transitioned"], { triggerStatuses: ["Done"] })] }),
      ],
      [],
    );
    expect(edges).toEqual([{ from: "a", to: "b", kind: "status", repository: "jira:ABC", label: "Done" }]);
  });
});
