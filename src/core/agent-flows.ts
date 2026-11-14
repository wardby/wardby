/**
 * Flows: groups of agents that work together, derived from configuration that already exists
 * (sub-agent edges, repository triggers, issue-project triggers). Pure: no database, no I/O, so
 * the MCP tool and the admin viewer share one definition of what a flow is.
 */

export interface RepoLinkFact {
  provider: string;
  repository: string;
  access: "read" | "write";
  triggers: string[];
  reviewFixMaxRounds: number | null;
  waitForCi: boolean;
  markReadyWhenPassing: boolean;
}
export interface IssueLinkFact {
  provider: string;
  projectKey: string;
  triggers: string[];
}
export interface AgentLinkFacts {
  id: string;
  name: string;
  kind: "native" | "coding";
  codingRepository: string | null;
  budgetGroup: { id: string; name: string } | null;
  scheduled: boolean;
  webhook: boolean;
  repositories: RepoLinkFact[];
  issueProjects: IssueLinkFact[];
}
export interface SubAgentFact {
  parentId: string;
  childId: string;
  boundName: string;
}
export type FlowEdgeKind = "delegates" | "reviews" | "fixes" | "after_merge";
export interface FlowEdge {
  from: string;
  to: string;
  kind: FlowEdgeKind;
  repository: string | null;
  label: string | null;
}

const DEFAULT_FIX_ROUNDS = 2;
const KIND_ORDER: FlowEdgeKind[] = ["delegates", "fixes", "reviews", "after_merge"];

export function repoKey(provider: string, repository: string): string {
  return `${provider}:${provider === "github" ? repository.toLowerCase() : repository}`;
}

export function profileRepoKey(codingRepository: string): string {
  return codingRepository.startsWith("local:") ? codingRepository : repoKey("github", codingRepository);
}

/** Every repository key an agent touches, with the link (null for a coding profile's own repository). */
function linksOf(agent: AgentLinkFacts): { key: string; link: RepoLinkFact | null }[] {
  const out: { key: string; link: RepoLinkFact | null }[] = agent.repositories.map((link) => ({
    key: repoKey(link.provider, link.repository),
    link,
  }));
  if (agent.kind === "coding" && agent.codingRepository)
    out.push({ key: profileRepoKey(agent.codingRepository), link: null });
  return out;
}

function withTrigger(
  agents: AgentLinkFacts[],
  key: string,
  trigger: string,
): { agent: AgentLinkFacts; link: RepoLinkFact }[] {
  const out: { agent: AgentLinkFacts; link: RepoLinkFact }[] = [];
  for (const agent of agents)
    for (const { key: k, link } of linksOf(agent))
      if (k === key && link && link.triggers.includes(trigger)) out.push({ agent, link });
  return out;
}

function writersOf(agents: AgentLinkFacts[], key: string): AgentLinkFacts[] {
  return agents.filter(
    (agent) =>
      agent.kind === "coding" &&
      linksOf(agent).some(({ key: k, link }) => k === key && (link === null || link.access === "write")),
  );
}

export function flowEdges(agents: AgentLinkFacts[], subAgents: SubAgentFact[]): FlowEdge[] {
  const ids = new Set(agents.map((a) => a.id));
  const edges = new Map<string, FlowEdge>();
  const add = (edge: FlowEdge) => {
    if (edge.from === edge.to) return;
    const id = `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edge.repository ?? ""}`;
    if (!edges.has(id)) edges.set(id, edge);
  };
  for (const s of subAgents)
    if (ids.has(s.parentId) && ids.has(s.childId))
      add({ from: s.parentId, to: s.childId, kind: "delegates", repository: null, label: s.boundName });
  const keys = [...new Set(agents.flatMap((a) => linksOf(a).map((l) => l.key)))].sort();
  for (const key of keys) {
    const writers = writersOf(agents, key);
    const reviewers = withTrigger(agents, key, "pull_request");
    for (const w of writers)
      for (const v of reviewers)
        add({ from: w.id, to: v.agent.id, kind: "reviews", repository: key, label: "PR opened" });
    for (const v of reviewers)
      for (const f of withTrigger(agents, key, "review_fix"))
        add({
          from: v.agent.id,
          to: f.agent.id,
          kind: "fixes",
          repository: key,
          label: `fix ≤${f.link.reviewFixMaxRounds ?? DEFAULT_FIX_ROUNDS}`,
        });
    for (const w of writers)
      for (const p of withTrigger(agents, key, "push"))
        add({ from: w.id, to: p.agent.id, kind: "after_merge", repository: key, label: "merged" });
  }
  return [...edges.values()].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      (a.repository ?? "").localeCompare(b.repository ?? ""),
  );
}

export function entryPoints(agent: AgentLinkFacts, edges: FlowEdge[]): string[] {
  const incoming = edges.filter((e) => e.to === agent.id);
  const out: string[] = [];
  const links = linksOf(agent).filter((l) => l.link);
  for (const { key, link } of links) if (link!.triggers.includes("mention")) out.push(`mention:${key}`);
  for (const issue of agent.issueProjects)
    if (issue.triggers.length > 0) out.push(`${issue.provider}:${issue.projectKey}`);
  if (agent.scheduled) out.push("schedule");
  if (agent.webhook) out.push("webhook");
  for (const { key, link } of links) {
    if (link!.triggers.includes("pull_request") && !incoming.some((e) => e.kind === "reviews" && e.repository === key))
      out.push(`pull_request:${key}`);
    if (link!.triggers.includes("push") && !incoming.some((e) => e.kind === "after_merge" && e.repository === key))
      out.push(`push:${key}`);
  }
  if (out.length === 0 && incoming.length === 0) return ["manual"];
  return out;
}
