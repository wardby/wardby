/**
 * Flows: groups of agents that work together, derived from configuration that already exists
 * (sub-agent edges, repository triggers, issue-project triggers and the statuses agents move tickets to). Pure: no database, no I/O, so
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
  /** With the "transitioned" trigger: the statuses that start the agent. */
  triggerStatuses: string[];
  /** Statuses the agent may move a ticket to. */
  allowedTransitions: string[];
  /** Statuses the control plane moves the ticket to when the agent's pull request opens or merges. */
  onPullRequestOpened: string | null;
  onPullRequestMerged: string | null;
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
export type FlowEdgeKind = "delegates" | "reviews" | "fixes" | "after_merge" | "status";
export interface FlowEdge {
  from: string;
  to: string;
  kind: FlowEdgeKind;
  repository: string | null;
  label: string | null;
}

const DEFAULT_FIX_ROUNDS = 2;
const KIND_ORDER: FlowEdgeKind[] = ["delegates", "fixes", "reviews", "after_merge", "status"];

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

/** An issue project's key, as edges and flows name it: "jira:SCRUM". */
export function issueKey(provider: string, projectKey: string): string {
  return `${provider}:${projectKey}`;
}

const sameStatus = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Statuses an agent can put a ticket of this project in: its allowed transitions and its pull request moves. */
function movesOf(link: IssueLinkFact): string[] {
  return [
    ...link.allowedTransitions,
    ...(link.onPullRequestOpened ? [link.onPullRequestOpened] : []),
    ...(link.onPullRequestMerged ? [link.onPullRequestMerged] : []),
  ];
}

/** Every agent's link to one issue project, keyed by issueKey. */
function issueLinksByProject(agents: AgentLinkFacts[]): Map<string, { agent: AgentLinkFacts; link: IssueLinkFact }[]> {
  const out = new Map<string, { agent: AgentLinkFacts; link: IssueLinkFact }[]>();
  for (const agent of agents)
    for (const link of agent.issueProjects) {
      const key = issueKey(link.provider, link.projectKey);
      out.set(key, [...(out.get(key) ?? []), { agent, link }]);
    }
  return out;
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
  // A ticket hand-off: an agent that can move a ticket to a status starts every agent on the same
  // project that triggers on it. The label is the status as the started agent names it.
  for (const [key, linked] of issueLinksByProject(agents))
    for (const to of linked) {
      if (!to.link.triggers.includes("transitioned")) continue;
      for (const status of to.link.triggerStatuses)
        for (const from of linked)
          if (movesOf(from.link).some((m) => sameStatus(m, status)))
            add({ from: from.agent.id, to: to.agent.id, kind: "status", repository: key, label: status });
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
  for (const issue of agent.issueProjects) {
    const key = issueKey(issue.provider, issue.projectKey);
    const others = issue.triggers.filter((t) => t !== "transitioned");
    const statuses = issue.triggers.includes("transitioned") ? issue.triggerStatuses : [];
    const fromStatus = statuses.filter(
      (s) => !incoming.some((e) => e.kind === "status" && e.repository === key && sameStatus(e.label ?? "", s)),
    );
    // A status only a person moves the ticket to: "status:jira:SCRUM:Approved".
    for (const s of fromStatus) out.push(`status:${key}:${s}`);
    if (others.length > 0 || (issue.triggers.includes("transitioned") && statuses.length === 0)) out.push(key);
  }
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

export interface Flow {
  key: string;
  name: string;
  agentIds: string[];
  entryAgentIds: string[];
  repositories: string[];
  /** Issue projects the flow's agents are started by or move tickets in: "jira:SCRUM". */
  issueProjects: string[];
  related: string[];
}
export interface AgentFlows {
  edges: FlowEdge[];
  entries: Record<string, string[]>;
  flows: Flow[];
  unlinked: string[];
}

const prefixOf = (name: string): string | null => {
  const i = name.indexOf("-");
  return i >= 3 ? name.slice(0, i) : null;
};
const shortRepo = (key: string): string => (key.startsWith("github:") ? key.slice("github:".length) : key);
/** "jira:SCRUM" as a flow name: "Jira SCRUM". */
const projectName = (key: string): string => {
  const i = key.indexOf(":");
  return `${key.charAt(0).toUpperCase()}${key.slice(1, i)} ${key.slice(i + 1)}`;
};

export function buildAgentFlows(agents: AgentLinkFacts[], subAgents: SubAgentFact[]): AgentFlows {
  const edges = flowEdges(agents, subAgents);
  const byId = new Map(agents.map((a) => [a.id, a]));
  const byName = (a: string, b: string) => byId.get(a)!.name.localeCompare(byId.get(b)!.name) || a.localeCompare(b);
  const entries: Record<string, string[]> = {};
  for (const a of agents) entries[a.id] = entryPoints(a, edges);

  // Union-find over every edge.
  const parent = new Map(agents.map((a) => [a.id, a.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (const e of edges) parent.set(find(e.from), find(e.to));
  // One board, one flow: the agents a project starts or that move its tickets belong together even when
  // a person moves the ticket between them (an approval status), since the ticket carries the work.
  const onBoard = new Map<string, Set<string>>();
  for (const [key, linked] of issueLinksByProject(agents)) {
    const members = linked.filter(({ link }) => link.triggers.length > 0 || movesOf(link).length > 0);
    for (const m of members) onBoard.set(m.agent.id, new Set([...(onBoard.get(m.agent.id) ?? []), key]));
    for (const m of members.slice(1)) parent.set(find(m.agent.id), find(members[0].agent.id));
  }
  const groups = new Map<string, string[]>();
  for (const a of agents) groups.set(find(a.id), [...(groups.get(find(a.id)) ?? []), a.id]);

  const flows: Flow[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const ids = [...members].sort(byName);
    const incoming = new Set(edges.filter((e) => members.includes(e.to)).map((e) => e.to));
    // Started by a person through a mention or a ticket (not a schedule, webhook or another agent).
    const triggered = ids.filter((id) =>
      entries[id].some(
        (p) =>
          p.startsWith("mention:") ||
          p.startsWith("status:") ||
          byId.get(id)!.issueProjects.some((i) => p === issueKey(i.provider, i.projectKey)),
      ),
    );
    const roots = ids.filter((id) => !incoming.has(id));
    const key = triggered.find((id) => !incoming.has(id)) ?? triggered[0] ?? roots[0] ?? ids[0];
    // Entry agents: every member a run can start at (a fix loop gives the lead an incoming edge,
    // so "no incoming edge" would drop it).
    const entryAgentIds = ids.filter((id) => entries[id].length > 0);
    const repos = new Set<string>();
    for (const e of edges) if (e.repository && e.kind !== "status" && members.includes(e.from)) repos.add(e.repository);
    for (const id of ids)
      for (const p of entries[id]) if (p.startsWith("mention:")) repos.add(p.slice("mention:".length));
    const repositories = [...repos].sort();
    const issueProjects = [...new Set(ids.flatMap((id) => [...(onBoard.get(id) ?? [])]))].sort();
    const keyName = byId.get(key)!.name;
    const groupIds = new Set(ids.map((id) => byId.get(id)!.budgetGroup?.id ?? null));
    const sharedGroup = groupIds.size === 1 && !groupIds.has(null) ? byId.get(ids[0])!.budgetGroup : null;
    const name =
      repositories.length === 0
        ? issueProjects.length === 1
          ? projectName(issueProjects[0])
          : keyName
        : repositories.length === 1
          ? shortRepo(repositories[0])
          : `${sharedGroup ? sharedGroup.name : keyName} · ${repositories.length} repositories`;
    flows.push({ key, name, agentIds: ids, entryAgentIds, repositories, issueProjects, related: [] });
  }
  flows.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));

  const inFlow = new Set(flows.flatMap((f) => f.agentIds));
  const unlinked: string[] = [];
  for (const id of agents
    .map((a) => a.id)
    .filter((id) => !inFlow.has(id))
    .sort(byName)) {
    const a = byId.get(id)!;
    const touches = new Set(linksOf(a).map((l) => l.key));
    const flow = flows.find(
      (f) =>
        f.repositories.some((r) => touches.has(r)) ||
        (a.budgetGroup !== null && f.agentIds.some((m) => byId.get(m)!.budgetGroup?.id === a.budgetGroup!.id)) ||
        (prefixOf(a.name) !== null && prefixOf(a.name) === prefixOf(byId.get(f.key)!.name)),
    );
    if (flow) flow.related.push(id);
    else unlinked.push(id);
  }
  return { edges, entries, flows, unlinked };
}
