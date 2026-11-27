/**
 * grant_access / revoke_access / list_access: the owner's sharing controls
 * (resource-sharing grants spec §3.11). Agents and MCP servers are shareable;
 * other resource types are refused as "not shareable yet".
 *
 * - Only the resource's owner (or the stdio operator) grants and revokes.
 *   Admins get no implicit access: they may only list_access, for incident
 *   response ("who can reach this?"), and reassign with make_owner.
 * - One grant per resource and grantee, so granting again replaces the
 *   level (also downgrades). Everyone grants are capped below write.
 * - Takes effect on the next check; runs already in flight keep going. For
 *   MCP servers the check is every tool call: revoking or lowering a grant
 *   below use also removes the attachments of agents whose owner can no
 *   longer use the server, in the same transaction.
 */
import { z } from "zod";
import { Prisma, type Principal, type PrismaClient } from "#prisma";
import {
  AGENT_DOCUMENT_GRANT_MAX,
  EVERYONE_KEY,
  EVERYONE_MAX,
  LEVELS,
  NO_EVERYONE_TYPES,
  agentGranteeKey,
  agentOwnerBindings,
  SHAREABLE_TYPES,
  accessRank,
  atLeast,
  isLevel,
  isResourceType,
  principalGranteeKey,
  pruneUnusableBudgetGroupMembers,
  pruneUnusableMcpAttachments,
  pruneUnusableToolAttachments,
  type ResourceType,
} from "../../core/grants.js";
import { preferIndexScans, withSerializableRetry } from "../../core/serializable-retry.js";
import { documentAccess } from "../../core/documents/access.js";
import { agentAccess, agentNotFound, assertAgentAccess, ownsResource } from "../auth/access.js";
import { isOwnerAll } from "../auth/resource-server.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";
import { check } from "../../authz/index.js";
import { requireDatastoreAccess, requireSecretAccess, requireWebhookAccess } from "../auth/ownership.js";

const GranteeSchema = z.union([
  z.literal("everyone"),
  z.object({ subject: z.string().min(1).max(512) }).strict(),
  z.object({ principalId: z.string().min(1).max(128) }).strict(),
  z.object({ agentId: z.string().min(1).max(128) }).strict(),
]);

const TargetSchema = z.object({
  resourceType: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(128),
});
const GrantSchema = TargetSchema.extend({ grantee: GranteeSchema, level: z.string().min(1).max(64) }).strict();
const RevokeSchema = TargetSchema.extend({ grantee: GranteeSchema }).strict();
const ListSchema = TargetSchema.strict();

type Grantee = z.infer<typeof GranteeSchema>;

function parse<T>(schema: z.ZodType<T>, label: string, args: unknown): T {
  const result = schema.safeParse(args);
  if (result.success) return result.data;
  const details = result.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  throw new McpError(400, `Invalid ${label} arguments: ${details}`);
}

function shareableType(value: string): ResourceType {
  if (!isResourceType(value) || !SHAREABLE_TYPES.includes(value)) {
    throw new McpError(
      400,
      `Resource type "${value}" is not shareable yet (shareable: ${SHAREABLE_TYPES.join(", ")}).`,
    );
  }
  return value;
}

/** Agent grantees are for documents, at read or comment (write comes from linking the agent: #625). */
function checkAgentGrantee(type: ResourceType, grantee: Grantee, level?: string): void {
  if (grantee === "everyone" || !("agentId" in grantee)) return;
  if (type !== "document") throw new McpError(400, "Agent grantees are for documents only.");
  if (level !== undefined && accessRank("document", level) > accessRank("document", AGENT_DOCUMENT_GRANT_MAX)) {
    throw new McpError(
      400,
      "document_agent_grant_level: an agent gets read or comment on a document; to make it the writer, link it with link_document.",
    );
  }
}

/**
 * The grantee agent of an agent grant, or null. The grantor must hold at least
 * read on it; an agent they cannot see looks like an unknown principal.
 */
async function resolveGranteeAgent(
  ctx: McpRequestContext,
  db: GrantTx,
  grantee: Grantee,
): Promise<{ id: string; name: string } | null> {
  if (grantee === "everyone" || !("agentId" in grantee)) return null;
  const agent = await db.agent.findUnique({ where: { id: grantee.agentId } });
  const visible = agent !== null && atLeast("agent", await agentAccess(ctx, agent, db), "read");
  if (!agent || !visible) {
    throw new McpError(404, "Grantee not found: they must have signed in to wardby at least once.");
  }
  return { id: agent.id, name: agent.name };
}

/** The grantee's principal (must have signed in once: never created here), or null for everyone or an agent. */
async function resolveGrantee(db: GrantTx, grantee: Grantee): Promise<Principal | null> {
  if (grantee === "everyone" || "agentId" in grantee) return null;
  const principal =
    "subject" in grantee
      ? await db.principal.findUnique({ where: { subject: grantee.subject } })
      : await db.principal.findUnique({ where: { id: grantee.principalId } });
  if (!principal) {
    throw new McpError(404, "Grantee not found: they must have signed in to wardby at least once.");
  }
  return principal;
}

/** Types whose attachments depend on use: lowering a grant below it can remove them. */
const PRUNE_BELOW_USE: ReadonlySet<ResourceType> = new Set<ResourceType>(["mcp_server", "budget_group", "tool"]);

/** What an agent loses when its owner can no longer use a shared resource: MCP server attachments, budget group membership. */
async function pruneUnusable(tx: GrantTx, type: ResourceType, resourceId: string, level?: string): Promise<number> {
  // A grant at or above use keeps every attachment; a revoke (no level) re-checks them all.
  if (level !== undefined && PRUNE_BELOW_USE.has(type) && atLeast(type, level, "use")) return 0;
  if (type === "mcp_server") return pruneUnusableMcpAttachments(tx, resourceId);
  if (type === "budget_group") return pruneUnusableBudgetGroupMembers(tx, resourceId);
  if (type === "tool") return pruneUnusableToolAttachments(tx, resourceId);
  return 0;
}

/** Grant management is the owner's (or the stdio operator's). Agents, MCP servers, documents and budget groups. */
async function requireOwnedResource(
  ctx: McpRequestContext,
  db: GrantTx,
  type: ResourceType,
  id: string,
): Promise<{ id: string; ownerId: string | null }> {
  if (type === "mcp_server") {
    const server = await db.mcpServer.findUnique({ where: { id } });
    // Missing and someone else's look the same. The stdio operator owns everything.
    if (!server || (!ctx.operator && !isOwnerAll(ctx) && !ownsResource(ctx, server.ownerId))) {
      throw new McpError(404, `MCP server "${id}" not found.`);
    }
    return server;
  }
  if (type === "document") {
    const doc = await db.document.findUnique({ where: { id }, select: { id: true, ownerId: true } });
    // Missing and invisible look the same; a reader who isn't the owner gets 403.
    const access = doc
      ? await documentAccess(db, doc.id, {
          kind: "principal",
          principalId: ctx.principal.id,
          ...(ctx.actsFor ? { actsFor: ctx.actsFor } : {}),
          operator: ctx.operator === true || isOwnerAll(ctx),
        })
      : "none";
    if (!doc || !atLeast("document", access, "read")) {
      throw new McpError(404, `Document "${id}" not found.`);
    }
    if (access !== "owner") {
      throw new McpError(403, `Document "${id}": only its owner can manage who it is shared with.`);
    }
    return doc;
  }
  if (type === "secret" || type === "datastore" || type === "webhook") {
    // 404 if missing or invisible, 403 for a read grantee; a row with no owner is the operator's to share.
    const row =
      type === "secret"
        ? await requireSecretAccess(ctx, id, "owner", db)
        : type === "datastore"
          ? await requireDatastoreAccess(ctx, id, "owner", db)
          : await requireWebhookAccess(ctx, id, "owner", db);
    if (row.ownerId === null && !ctx.operator && !isOwnerAll(ctx)) {
      throw new McpError(404, `${type} "${id}" not found.`);
    }
    return row;
  }
  if (type === "tool") {
    const tool = await db.tool.findUnique({ where: { id } });
    // Missing and someone else's look the same. A public tool has no owner: only the operator manages it.
    if (!tool || (!ctx.operator && !isOwnerAll(ctx) && !ownsResource(ctx, tool.ownerId))) {
      throw new McpError(404, `Tool "${id}" not found.`);
    }
    return tool;
  }
  if (type === "budget_group") {
    const group = await db.budgetGroup.findUnique({ where: { id } });
    // Missing and someone else's look the same. A public group has no owner: only the operator manages it.
    if (!group || (!ctx.operator && !isOwnerAll(ctx) && !ownsResource(ctx, group.ownerId))) {
      throw new McpError(404, `Budget group "${id}" not found.`);
    }
    return group;
  }
  // Only "agent" reaches here (shareableType).
  const row = await db.agent.findUnique({ where: { id } });
  return (await assertAgentAccess(ctx, row, id, "owner", db)).agent;
}

type GrantTx = Pick<
  PrismaClient,
  | "agent"
  | "mcpServer"
  | "budgetGroup"
  | "tool"
  | "secret"
  | "datastore"
  | "webhook"
  | "runHook"
  | "teamMember"
  | "document"
  | "documentShareLink"
  | "principal"
  | "resourceGrant"
  | "agentSecret"
  | "agentDatastore"
  | "agentRepository"
  | "agentSubAgent"
  | "agentTool"
  | "codingAgentProfile"
  | "agentMcpServer"
>;

/**
 * The ownership check and the write in one Serializable transaction (review
 * M3): a concurrent make_owner, which resets grants in its own transaction,
 * conflicts instead of letting the old owner's grant land on the new
 * owner's agent. A conflict is retried a bounded number of times
 * (withSerializableRetry); the last one still reaches the caller as a 409.
 */
function inSerializable<T>(ctx: McpRequestContext, fn: (tx: GrantTx) => Promise<T>): Promise<T> {
  return withSerializableRetry(() =>
    ctx.db.$transaction(
      async (tx) => {
        await preferIndexScans(tx);
        return fn(tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

function isAdmin(ctx: McpRequestContext): boolean {
  return check(ctx, ["agents:admin"]) === null;
}

const TYPE_PROPERTIES = {
  // No enum: another type gets a clear "not shareable yet" from the handler.
  resourceType: {
    type: "string",
    description:
      'Shareable: "agent", "mcp_server", "document", "budget_group", "tool", "secret", "datastore" or "webhook".',
  },
  resourceId: { type: "string" },
};
const GRANTEE_PROPERTY = {
  description:
    'One principal, as {"subject": "<IdP subject>"} or {"principalId": "<id>"}, or "everyone". On a document it may also be one agent, as {"agentId": "<id>"}, at read or comment.',
  anyOf: [
    { type: "string", enum: ["everyone"] },
    {
      type: "object",
      additionalProperties: false,
      properties: { subject: { type: "string" } },
      required: ["subject"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { principalId: { type: "string" } },
      required: ["principalId"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { agentId: { type: "string" } },
      required: ["agentId"],
    },
  ],
};

export function registerGrantTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "grant_access",
    permission: "agents:write",
    description:
      "Shares an agent, MCP server, document, budget group or tool you own with one principal or with everyone, at a level: " +
      "read (see its config, never secret values or other owners' tool code); " +
      "execute (also trigger runs and see the runs they triggered); " +
      "write (also change its name, prompt, model, budget amount, max turns, effort, memory on/off and schedule, attach tools they can use and detach tools, and create webhooks). " +
      "Owner-only whatever the level: the coding profile (task, base ref, protected paths, task-override opt-in, image, packages, limits), kind, budget group, sub-agents, secret/datastore/repository bindings, tool capabilities, memory and datastore contents, grants, delete. " +
      "Consequences: execute lets them run your agent with your tools, secrets, datastores and repository, and every run shares the agent's memory; they supply no task text unless it's a coding agent with allowWebhookTaskOverride. " +
      "Write lets them rewrite what those runs do: the prompt can make a run use everything the agent can already reach (the capabilities you granted, its memory, its linked repositories), and on a coding agent the prompt is part of every coding task, so write directs work done with your GitHub access. " +
      "Secrets, datastores and webhooks (resourceType secret, datastore or webhook): read only, and never for everyone; read shows that the resource exists and its name and metadata, never a value, and a grantee binds, changes and deletes nothing (only the owner, or a Team it belongs to, does). " +
      "Tools (resourceType tool): read < use < write; read shows the tool's name, description and time limit, never its code; use lets them attach it to their own agents and run hooks, where it runs with the capabilities they grant it; write adds nothing beyond use: only the owner updates, deletes or re-grants a tool, and not while it is attached to someone else's agent. Lowering a grant to read (including everyone from use to read) detaches the tool from every agent and hook whose owner can no longer use it. " +
      "Budget groups (resourceType budget_group): read < use < write; use lets them put their own agents in the group, so those agents' runs count against it and its cap; write also lets them rename it and change its caps; only the owner deletes it or re-grants. Lowering a grant to read (including everyone from use to read) removes the group from every agent whose owner can no longer use it. " +
      "MCP servers (resourceType mcp_server): read < use < write; use on an MCP server lets them attach it to their own agents; its tools then run with your server's credentials. Write adds nothing beyond use: only the owner updates, refreshes, deletes or re-grants a server. Lowering a grant to read (including everyone from use to read) detaches the server from every agent whose owner can no longer use it, and their runs' next call to it is refused. " +
      "Documents (resourceType document): read < comment < write; everyone may get at most comment. An agent may be granted read or comment with {agentId}; to make an agent the writer, link it with link_document. Only the owner manages grants. " +
      "Granting again replaces the level. Everyone may get write only on a native agent with no secrets, datastores, repositories, sub-agents, MCP servers, tool capabilities or document tools. The grantee must have signed in once.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...TYPE_PROPERTIES,
        grantee: GRANTEE_PROPERTY,
        level: {
          type: "string",
          description:
            "Agents: read < execute < write. MCP servers, budget groups and tools: read < use < write. Documents: read < comment < write.",
        },
      },
      required: ["resourceType", "resourceId", "grantee", "level"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = parse(GrantSchema, "grant_access", rawArgs);
      const type = shareableType(args.resourceType);
      if (!isLevel(type, args.level)) {
        throw new McpError(400, `Level "${args.level}" is not valid for ${type} (${LEVELS[type].join(" < ")}).`);
      }
      checkAgentGrantee(type, args.grantee, args.level);
      const { resource, principal, agent, grant, attachmentsRemoved } = await inSerializable(ctx, async (tx) => {
        const resource = await requireOwnedResource(ctx, tx, type, args.resourceId);
        const agent = await resolveGranteeAgent(ctx, tx, args.grantee);
        const principal = await resolveGrantee(tx, args.grantee);
        if (principal && (principal.id === resource.ownerId || principal.id === ctx.principal.id)) {
          throw new McpError(
            400,
            "The owner already has full access; a grant to yourself or the owner changes nothing.",
          );
        }
        if (!principal && !agent && NO_EVERYONE_TYPES.has(type)) {
          throw new McpError(400, `A ${type} cannot be shared with everyone; name the people it is for.`);
        }
        if (!principal && !agent && accessRank(type, args.level) > accessRank(type, EVERYONE_MAX[type])) {
          throw new McpError(400, `An everyone grant can be at most ${EVERYONE_MAX[type]}.`);
        }
        if (!principal && !agent && atLeast(type, args.level, "write")) {
          const bindings = await agentOwnerBindings(tx, resource.id);
          if (bindings.length) {
            throw new McpError(
              409,
              `Agent "${resource.id}" holds ${bindings.join(", ")}: write for everyone would let anyone rewrite an agent that uses them. Detach them first, or grant everyone execute.`,
            );
          }
        }
        const granteeKey = principal
          ? principalGranteeKey(principal.id)
          : agent
            ? agentGranteeKey(agent.id)
            : EVERYONE_KEY;
        const grant = await tx.resourceGrant.upsert({
          where: { resourceType_resourceId_granteeKey: { resourceType: type, resourceId: resource.id, granteeKey } },
          create: {
            resourceType: type,
            resourceId: resource.id,
            granteeKind: principal ? "principal" : agent ? "agent" : "everyone",
            granteePrincipalId: principal?.id ?? null,
            granteeAgentId: agent?.id ?? null,
            granteeKey,
            level: args.level,
            source: "owner",
            grantedById: ctx.principal.id,
          },
          update: { level: args.level, source: "owner", grantedById: ctx.principal.id },
        });
        // Below use, agents whose owner can no longer use the server (or the budget group) lose it now (C1).
        const attachmentsRemoved = await pruneUnusable(tx, type, resource.id, args.level);
        return { resource, principal, agent, grant, attachmentsRemoved };
      });
      return textResult({
        granted: true,
        resourceType: type,
        resourceId: resource.id,
        // Echo only what the caller supplied: a principalId never reveals a subject (review M4).
        grantee: agent
          ? { agentId: agent.id }
          : !principal
            ? "everyone"
            : args.grantee !== "everyone" && "subject" in args.grantee
              ? { principalId: principal.id, subject: principal.subject }
              : { principalId: principal.id },
        level: grant.level,
        ...(attachmentsRemoved > 0 ? { attachmentsRemoved } : {}),
      });
    },
  });

  mcp.registerTool({
    name: "revoke_access",
    permission: "agents:write",
    description:
      "Removes a grant on an agent, MCP server, budget group, tool or document you own. Idempotent. Takes effect on the next check (trigger, delegation, webhook fire); runs already in flight keep going. For an MCP server the check is every tool call: the server is detached from every agent whose owner can no longer use it (your own agents are untouched), and a run's next call to it is refused with mcp_tool_not_allowed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...TYPE_PROPERTIES, grantee: GRANTEE_PROPERTY },
      required: ["resourceType", "resourceId", "grantee"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = parse(RevokeSchema, "revoke_access", rawArgs);
      const type = shareableType(args.resourceType);
      checkAgentGrantee(type, args.grantee);
      const { count, attachmentsRemoved } = await inSerializable(ctx, async (tx) => {
        const resource = await requireOwnedResource(ctx, tx, type, args.resourceId);
        // An agent grantee need not exist or be visible: delete by key, leaking nothing.
        const granteeKey =
          args.grantee !== "everyone" && "agentId" in args.grantee
            ? agentGranteeKey(args.grantee.agentId)
            : args.grantee === "everyone"
              ? EVERYONE_KEY
              : principalGranteeKey((await resolveGrantee(tx, args.grantee))!.id);
        const { count } = await tx.resourceGrant.deleteMany({
          where: { resourceType: type, resourceId: resource.id, granteeKey },
        });
        // Agents whose owner can no longer use the server (or the budget group) lose it now (C1).
        const attachmentsRemoved = await pruneUnusable(tx, type, resource.id);
        return { count, attachmentsRemoved };
      });
      return textResult({ revoked: count > 0, ...(attachmentsRemoved > 0 ? { attachmentsRemoved } : {}) });
    },
  });

  mcp.registerTool({
    name: "list_access",
    permission: "agents:read",
    description:
      "Lists who an agent, MCP server, budget group, tool or document is shared with (grant metadata only). For its owner, the stdio operator, and admins (incident response).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: TYPE_PROPERTIES,
      required: ["resourceType", "resourceId"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = parse(ListSchema, "list_access", rawArgs);
      const type = shareableType(args.resourceType);
      let resource: { id: string; ownerId: string | null };
      if (type === "mcp_server") {
        const server = await ctx.db.mcpServer.findUnique({ where: { id: args.resourceId } });
        // Owner, stdio operator or admin; anyone else sees a missing server.
        if (!server || (!ctx.operator && !isOwnerAll(ctx) && !isAdmin(ctx) && !ownsResource(ctx, server.ownerId))) {
          throw new McpError(404, `MCP server "${args.resourceId}" not found.`);
        }
        resource = server;
      } else if (type === "document") {
        const doc = await ctx.db.document.findUnique({
          where: { id: args.resourceId },
          select: { id: true, ownerId: true },
        });
        // Owner, stdio operator or admin; anyone else sees a missing document.
        if (!doc || (!ctx.operator && !isOwnerAll(ctx) && !isAdmin(ctx) && !ownsResource(ctx, doc.ownerId))) {
          throw new McpError(404, `Document "${args.resourceId}" not found.`);
        }
        resource = doc;
      } else if (type === "secret" || type === "datastore" || type === "webhook") {
        // Owner, stdio operator or admin; anyone else sees a missing row.
        const row = isAdmin(ctx)
          ? await (type === "secret"
              ? ctx.db.secret.findUnique({ where: { id: args.resourceId } })
              : type === "datastore"
                ? ctx.db.datastore.findUnique({ where: { id: args.resourceId } })
                : ctx.db.webhook.findUnique({ where: { id: args.resourceId } }))
          : type === "secret"
            ? await requireSecretAccess(ctx, args.resourceId, "owner")
            : type === "datastore"
              ? await requireDatastoreAccess(ctx, args.resourceId, "owner")
              : await requireWebhookAccess(ctx, args.resourceId, "owner");
        if (!row) throw new McpError(404, `${type} "${args.resourceId}" not found.`);
        resource = row;
      } else if (type === "tool") {
        const tool = await ctx.db.tool.findUnique({ where: { id: args.resourceId } });
        // Owner, stdio operator or admin; anyone else sees a missing tool.
        if (!tool || (!ctx.operator && !isOwnerAll(ctx) && !isAdmin(ctx) && !ownsResource(ctx, tool.ownerId))) {
          throw new McpError(404, `Tool "${args.resourceId}" not found.`);
        }
        resource = tool;
      } else if (type === "budget_group") {
        const group = await ctx.db.budgetGroup.findUnique({ where: { id: args.resourceId } });
        // Owner, stdio operator or admin; anyone else sees a missing group.
        if (!group || (!ctx.operator && !isOwnerAll(ctx) && !isAdmin(ctx) && !ownsResource(ctx, group.ownerId))) {
          throw new McpError(404, `Budget group "${args.resourceId}" not found.`);
        }
        resource = group;
      } else {
        const agent = await ctx.db.agent.findUnique({ where: { id: args.resourceId } });
        if (!agent) throw agentNotFound(args.resourceId);
        if (!isAdmin(ctx)) {
          const access = await agentAccess(ctx, agent);
          if (!atLeast("agent", access, "read")) throw agentNotFound(args.resourceId);
          if (access !== "owner") {
            throw new McpError(
              403,
              `Agent "${agent.id}": only its owner (or an admin) can list who it is shared with.`,
            );
          }
        }
        resource = agent;
      }
      const grants = await ctx.db.resourceGrant.findMany({
        where: { resourceType: type, resourceId: resource.id },
        orderBy: { createdAt: "asc" },
      });
      const principalIds = grants.flatMap((g) => (g.granteePrincipalId ? [g.granteePrincipalId] : []));
      const principals = principalIds.length
        ? await ctx.db.principal.findMany({ where: { id: { in: principalIds } } })
        : [];
      const subjectOf = new Map(principals.map((p) => [p.id, p.subject]));
      const agentIds = grants.flatMap((g) => (g.granteeAgentId ? [g.granteeAgentId] : []));
      const granteeAgents = agentIds.length
        ? await ctx.db.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } })
        : [];
      const agentNameOf = new Map(granteeAgents.map((a) => [a.id, a.name]));
      return textResult({
        resourceType: type,
        resourceId: resource.id,
        ownerId: resource.ownerId,
        grants: grants.map((g) => ({
          grantee: g.granteeAgentId
            ? { agentId: g.granteeAgentId, agentName: agentNameOf.get(g.granteeAgentId) ?? null }
            : g.granteePrincipalId
              ? { principalId: g.granteePrincipalId, subject: subjectOf.get(g.granteePrincipalId) ?? null }
              : "everyone",
          level: g.level,
          source: g.source,
          grantedById: g.grantedById,
          updatedAt: g.updatedAt,
        })),
      });
    },
  });
}
