/**
 * AgentIssueProject CRUD — which Jira projects a native agent may act on,
 * and which issue events trigger it. Linking is admin-approved: wardby cannot
 * verify an agent owner's own Jira access (the integration is one service
 * account, no per-user OAuth), so link/unlink need agents:admin with the
 * admin role, and the approver is stamped on the link. Triggers that carry
 * text from a person (mention/assigned) are gated by trustedAccountIds.
 * See docs/private/2026-09-30-jira-issue-tracker-design.md.
 */
import { requireAgentAccess } from "../auth/access.js";
import { authorize } from "../auth/resource-server.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { ISSUE_TRACKER_PROVIDERS, PROJECT_KEY } from "../../providers/issue-tracker/types.js";
import { textResult } from "./text-result.js";

const PROVIDERS = [...ISSUE_TRACKER_PROVIDERS];
const TRIGGERS = ["created", "transitioned", "labeled", "assigned", "mention"] as const;
type Trigger = (typeof TRIGGERS)[number];
const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const WRITABLE_FIELD = /^(labels|components|priority|customfield_\d{1,10})$/;

type LinkArgs = {
  agentId: string;
  provider?: (typeof PROVIDERS)[number];
  projectKey: string;
  access: "read" | "write";
  triggers?: Trigger[];
  triggerStatuses?: string[];
  triggerLabels?: string[];
  jqlFilter?: string;
  trustedAccountIds?: string[];
  commentVisibilityRole?: string;
  allowedTransitions?: string[];
  writableFields?: string[];
  allowedLinkTypes?: string[];
  onPullRequestOpened?: string;
  onPullRequestMerged?: string;
  creatableIssueTypes?: string[];
  maxNewIssuesPerRun?: number;
};

/** Trimmed names, 1-100 characters each, de-duplicated case-insensitively (first spelling kept). */
function nameList(field: string, raw: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of raw ?? []) {
    const name = entry.trim();
    if (name.length === 0 || name.length > 100) throw new McpError(400, `invalid ${field} entry (1-100 characters)`);
    if (!seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      names.push(name);
    }
  }
  return names;
}

/** An optional single status name, trimmed, 1-100 characters; undefined/absent means none. */
function optionalStatus(field: string, raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const name = raw.trim();
  if (name.length === 0 || name.length > 100) throw new McpError(400, `invalid ${field} (1-100 characters)`);
  return name;
}

function normalizeProjectKey(projectKey: string): string {
  const key = projectKey.trim().toUpperCase();
  if (!PROJECT_KEY.test(key)) throw new McpError(400, `invalid projectKey "${projectKey}"`);
  return key;
}

export function registerIssueProjectTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "link_issue_project",
    permission: "agents:write",
    description:
      "Links a native agent to a Jira project, with its access and issue-event triggers. A wardby admin approves Jira links " +
      "(agents:admin with the admin role); the agent acts as the deployment's Jira service account, not as any person. " +
      "triggers (write access only): created, transitioned (needs triggerStatuses), labeled (needs triggerLabels), assigned and " +
      "mention (each needs trustedAccountIds). trustedAccountIds are Jira accountIds (from a Jira profile URL or jira_get_issue " +
      "output) whose mentions/assignments may trigger the agent; triggered text from anyone else is treated as untrusted. " +
      "jqlFilter optionally narrows which issues trigger; commentVisibilityRole restricts the agent's comments to a project role. " +
      "Re-linking a project replaces its access, triggers, and filters (an omitted field is cleared, not kept) — always send " +
      "the full desired state. " +
      "allowedTransitions (write access only): the target status names jira_transition may move issues to (matched by target " +
      "status name, case-insensitive). writableFields (write access only): the field ids jira_update_fields may change " +
      "(labels, components, priority, or customfield_NNNNN). Both allowlists fail closed: empty or omitted means the agent " +
      "cannot transition issues or edit fields at all. " +
      'allowedLinkTypes (write access only): the issue link type names jira_link_issues may create (e.g. "Duplicate", ' +
      "case-insensitive, at most 20); linking also needs write access to both issues' projects, each allowlisting the type. " +
      "It fails closed too: empty or omitted means the agent cannot link issues. Issue properties (jira_set_property) are " +
      "not allowlisted: any write link may set them. " +
      "onPullRequestOpened / onPullRequestMerged (write access only, optional): the status name to move the issue to when a " +
      "pull request wardby opened for it opens or merges. These are control-plane moves, not model actions, and are not gated " +
      "by allowedTransitions; the name is matched in the Jira service account's language, and omitting one means no move. " +
      "creatableIssueTypes (write access only): the issue type names (case-insensitive, at most 20) the agent may create issues " +
      "of in this project; it fails closed too: empty or omitted means the agent cannot create issues here. " +
      "maxNewIssuesPerRun (write access only, optional integer 1-1000): the most issues one run may create in this project; " +
      "omitted means no cap. The cap is best-effort across resumed or concurrent attempts of the same run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentId: { type: "string" },
        provider: { type: "string", enum: PROVIDERS },
        projectKey: { type: "string", minLength: 1, maxLength: 255 },
        access: { type: "string", enum: ["read", "write"] },
        triggers: { type: "array", items: { type: "string", enum: [...TRIGGERS] }, uniqueItems: true },
        triggerStatuses: { type: "array", items: { type: "string", minLength: 1, maxLength: 100 }, maxItems: 50 },
        triggerLabels: { type: "array", items: { type: "string", minLength: 1, maxLength: 255 }, maxItems: 50 },
        jqlFilter: { type: "string", minLength: 1, maxLength: 1000 },
        trustedAccountIds: {
          type: "array",
          items: { type: "string", pattern: ACCOUNT_ID.source },
          maxItems: 50,
        },
        commentVisibilityRole: { type: "string", minLength: 1, maxLength: 100 },
        allowedTransitions: { type: "array", items: { type: "string", minLength: 1, maxLength: 100 }, maxItems: 50 },
        writableFields: { type: "array", items: { type: "string", pattern: WRITABLE_FIELD.source }, maxItems: 50 },
        allowedLinkTypes: { type: "array", items: { type: "string", minLength: 1, maxLength: 100 }, maxItems: 20 },
        onPullRequestOpened: { type: "string", minLength: 1, maxLength: 100 },
        onPullRequestMerged: { type: "string", minLength: 1, maxLength: 100 },
        creatableIssueTypes: { type: "array", items: { type: "string", minLength: 1, maxLength: 100 }, maxItems: 20 },
        maxNewIssuesPerRun: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["agentId", "projectKey", "access"],
    },
    handler: async (args: LinkArgs, ctx) => {
      authorize(ctx, "agents:admin");
      const agent = await ctx.db.agent.findUnique({ where: { id: args.agentId } });
      if (!agent) throw new McpError(404, `Agent "${args.agentId}" not found.`);
      if (agent.kind !== "native") throw new McpError(400, "Issue-project links are for native agents only.");
      if (agent.ownerId === null) {
        throw new McpError(400, `Agent "${agent.id}" has no owner; assign one with make_owner before linking.`);
      }
      const provider = args.provider ?? "jira";
      const projectKey = normalizeProjectKey(args.projectKey);
      const triggers = [...new Set(args.triggers ?? [])];
      const triggerStatuses = args.triggerStatuses ?? [];
      const triggerLabels = args.triggerLabels ?? [];
      const trustedAccountIds = [...new Set(args.trustedAccountIds ?? [])];
      if (trustedAccountIds.some((id) => !ACCOUNT_ID.test(id))) {
        throw new McpError(
          400,
          "invalid trustedAccountIds entry (letters, digits, ':', '_', '-'; up to 128 characters)",
        );
      }
      const allowedTransitions = nameList("allowedTransitions", args.allowedTransitions);
      const allowedLinkTypes = nameList("allowedLinkTypes", args.allowedLinkTypes);
      if (allowedLinkTypes.length > 20) throw new McpError(400, "allowedLinkTypes takes at most 20 entries");
      const creatableIssueTypes = nameList("creatableIssueTypes", args.creatableIssueTypes);
      if (creatableIssueTypes.length > 20) throw new McpError(400, "creatableIssueTypes takes at most 20 entries");
      const maxNewIssuesPerRun = args.maxNewIssuesPerRun ?? null;
      if (
        maxNewIssuesPerRun !== null &&
        (!Number.isInteger(maxNewIssuesPerRun) || maxNewIssuesPerRun < 1 || maxNewIssuesPerRun > 1000)
      ) {
        throw new McpError(400, "maxNewIssuesPerRun must be an integer from 1 to 1000");
      }
      if ((creatableIssueTypes.length > 0 || maxNewIssuesPerRun !== null) && args.access !== "write") {
        throw new McpError(400, "creatableIssueTypes and maxNewIssuesPerRun need write access.");
      }
      const writableFields = [...new Set(args.writableFields ?? [])];
      if (writableFields.some((f) => !WRITABLE_FIELD.test(f))) {
        throw new McpError(400, "invalid writableFields entry (labels, components, priority, or customfield_NNNNN)");
      }
      const onPullRequestOpened = optionalStatus("onPullRequestOpened", args.onPullRequestOpened);
      const onPullRequestMerged = optionalStatus("onPullRequestMerged", args.onPullRequestMerged);
      if ((onPullRequestOpened !== null || onPullRequestMerged !== null) && args.access !== "write") {
        throw new McpError(400, "onPullRequestOpened and onPullRequestMerged need write access.");
      }
      if (
        (allowedTransitions.length > 0 || writableFields.length > 0 || allowedLinkTypes.length > 0) &&
        args.access !== "write"
      ) {
        throw new McpError(400, "allowedTransitions, writableFields, and allowedLinkTypes need write access.");
      }
      if (triggers.length > 0 && args.access !== "write") throw new McpError(400, "Event triggers need write access.");
      if (triggers.includes("transitioned") && triggerStatuses.length === 0) {
        throw new McpError(400, "The transitioned trigger needs a non-empty triggerStatuses.");
      }
      if (triggers.includes("labeled") && triggerLabels.length === 0) {
        throw new McpError(400, "The labeled trigger needs a non-empty triggerLabels.");
      }
      if ((triggers.includes("mention") || triggers.includes("assigned")) && trustedAccountIds.length === 0) {
        throw new McpError(400, "The mention and assigned triggers need a non-empty trustedAccountIds.");
      }
      if (!ctx.providers.issueTrackers?.[provider]) {
        throw new McpError(503, "Jira is not configured on this deployment (see docs/jira-agents.md).");
      }
      const fields = {
        access: args.access,
        triggers,
        triggerStatuses,
        triggerLabels,
        jqlFilter: args.jqlFilter ?? null,
        trustedAccountIds,
        commentVisibilityRole: args.commentVisibilityRole ?? null,
        allowedTransitions,
        writableFields,
        allowedLinkTypes,
        onPullRequestOpened,
        onPullRequestMerged,
        creatableIssueTypes,
        maxNewIssuesPerRun,
        authorizedById: ctx.principal.id,
        authorizedAt: new Date(),
      };
      const link = await ctx.db.agentIssueProject.upsert({
        where: { agentId_provider_projectKey: { agentId: args.agentId, provider, projectKey } },
        create: { agentId: args.agentId, provider, projectKey, ...fields },
        update: fields,
      });
      return textResult({ linked: true, link });
    },
  });

  mcp.registerTool({
    name: "unlink_issue_project",
    permission: "agents:write",
    description: "Removes a native agent's link to a Jira project. Admin only (agents:admin with the admin role).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentId: { type: "string" },
        provider: { type: "string", enum: PROVIDERS },
        projectKey: { type: "string", minLength: 1, maxLength: 255 },
      },
      required: ["agentId", "projectKey"],
    },
    handler: async (args: { agentId: string; provider?: string; projectKey: string }, ctx) => {
      authorize(ctx, "agents:admin");
      const agent = await ctx.db.agent.findUnique({ where: { id: args.agentId } });
      if (!agent) throw new McpError(404, `Agent "${args.agentId}" not found.`);
      const { count } = await ctx.db.agentIssueProject.deleteMany({
        where: {
          agentId: args.agentId,
          provider: args.provider ?? "jira",
          projectKey: normalizeProjectKey(args.projectKey),
        },
      });
      return textResult({ unlinked: count > 0 });
    },
  });

  mcp.registerTool({
    name: "list_issue_projects",
    permission: "agents:read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { agentId: { type: "string" } },
      required: ["agentId"],
    },
    handler: async (args: { agentId: string }, ctx) => {
      await requireAgentAccess(ctx, args.agentId, "read");
      const links = await ctx.db.agentIssueProject.findMany({
        where: { agentId: args.agentId },
        orderBy: { createdAt: "asc" },
      });
      return textResult({ issueProjects: links });
    },
  });
}
