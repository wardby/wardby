/**
 * list_agent_links: the caller's readable agents with their links, as flows (src/core/agent-flows.ts),
 * in one call, for the Claude Code pane's Agents tab and the admin viewer. Link facts only: no secret
 * values or names, webhook secrets, Jira account ids, JQL, writable fields, hook config or tool code. Status
 * names (trigger statuses, allowed transitions, pull request moves) are link facts and are included.
 * A sub-agent link to an agent the caller cannot read is counted in `hidden`, never named.
 */
import { buildAgentFlows, type AgentLinkFacts, type SubAgentFact } from "../../core/agent-flows.js";
import { stripControlSequences } from "../../core/run-steps/control-chars.js";
import { agentAccessResolver, readableAgentsWhere } from "../auth/access.js";
import { isOwnerAll, requireScope } from "../auth/resource-server.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

const PROMPT_LINE_MAX = 200;

/** The prompt's first non-blank line, without terminal control sequences (a reader may draw it in a terminal). */
function firstLine(prompt: string): string {
  const line =
    stripControlSequences(prompt)
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  return line.length > PROMPT_LINE_MAX ? `${line.slice(0, PROMPT_LINE_MAX - 1)}…` : line;
}

export function registerAgentLinkTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "list_agent_links",
    scope: "agents:read",
    description:
      "The agents you can read and how they link, grouped into flows: sub-agent delegation, pull request review, " +
      "review fix rounds, after-merge triggers and ticket status hand-offs (an agent that moves a Jira ticket to a status " +
      "starts the agents that trigger on it), plus each agent's entry points (mention, Jira, a status only a person sets, " +
      "schedule, webhook, manual). " +
      "Link facts only, never secrets. A link to an agent you cannot read is counted in `hidden`. " +
      "all: true covers every agent in the deployment (admins only, admin:view).",
    inputSchema: { type: "object", properties: { all: { type: "boolean" } }, additionalProperties: false },
    handler: async (args: { all?: boolean }, ctx) => {
      if (args.all === true && !ctx.operator && !isOwnerAll(ctx)) requireScope(ctx, ctx.canonicalUri, "admin:view");
      const [where, accessOf] = await Promise.all([
        args.all === true ? Promise.resolve({}) : readableAgentsWhere(ctx),
        agentAccessResolver(ctx),
      ]);
      const rows = await ctx.db.agent.findMany({
        where,
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          kind: true,
          model: true,
          budgetUsd: true,
          ownerId: true,
          systemPrompt: true,
          schedule: true,
          scheduleEnabled: true,
          budgetGroup: { select: { id: true, name: true } },
          codingProfile: { select: { provider: true, repository: true } },
          repositories: {
            select: {
              provider: true,
              repository: true,
              access: true,
              triggers: true,
              reviewFixMaxRounds: true,
              waitForCi: true,
              markReadyWhenPassing: true,
            },
            orderBy: { createdAt: "asc" },
          },
          issueProjects: {
            select: {
              provider: true,
              projectKey: true,
              triggers: true,
              triggerStatuses: true,
              allowedTransitions: true,
              onPullRequestOpened: true,
              onPullRequestMerged: true,
            },
          },
          webhooks: { where: { status: "enabled" }, select: { id: true } },
          mcpServers: { select: { server: { select: { name: true } } } },
          runHooks: { where: { enabled: true }, select: { events: true } },
        },
      });
      const ids = new Set(rows.map((r) => r.id));
      const edgeRows = await ctx.db.agentSubAgent.findMany({
        where: { OR: [{ parentAgentId: { in: [...ids] } }, { childAgentId: { in: [...ids] } }] },
        select: { parentAgentId: true, childAgentId: true, boundName: true },
      });
      const subAgents: SubAgentFact[] = [];
      const hiddenAgents = new Set<string>();
      let hiddenEdges = 0;
      for (const e of edgeRows) {
        const parentSeen = ids.has(e.parentAgentId);
        const childSeen = ids.has(e.childAgentId);
        if (parentSeen && childSeen)
          subAgents.push({ parentId: e.parentAgentId, childId: e.childAgentId, boundName: e.boundName });
        else {
          hiddenEdges++;
          hiddenAgents.add(parentSeen ? e.childAgentId : e.parentAgentId);
        }
      }
      const facts: AgentLinkFacts[] = rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        codingRepository: r.codingProfile?.repository ?? null,
        budgetGroup: r.budgetGroup,
        scheduled: r.schedule !== null && r.scheduleEnabled,
        webhook: r.webhooks.length > 0,
        repositories: r.repositories.map((l) => ({ ...l, access: l.access === "write" ? "write" : "read" })),
        issueProjects: r.issueProjects,
      }));
      const flows = buildAgentFlows(facts, subAgents);
      return textResult({
        agents: rows.map((r, i) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          codingProvider: r.codingProfile?.provider ?? null,
          model: r.model,
          budgetUsd: Number(r.budgetUsd),
          access: accessOf(r),
          budgetGroup: r.budgetGroup,
          promptFirstLine: firstLine(r.systemPrompt),
          entry: flows.entries[r.id],
          repositories: facts[i].repositories,
          notes: [
            ...r.mcpServers.map((m) => `mcp:${m.server.name}`),
            ...[...new Set(r.runHooks.flatMap((h) => (h.events.length === 0 ? ["all"] : h.events)))]
              .sort()
              .map((ev) => `runHook:${ev}`),
          ],
        })),
        edges: flows.edges,
        flows: flows.flows,
        unlinked: flows.unlinked,
        hidden: { agents: hiddenAgents.size, edges: hiddenEdges },
      });
    },
  });
}
