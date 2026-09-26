/**
 * grant_access / revoke_access / list_access: the owner's sharing controls
 * (resource-sharing grants spec §3.11). Phase 1 shares agents only; other
 * resource types are refused as "not shareable yet".
 *
 * - Only the resource's owner (or the stdio operator) grants and revokes.
 *   Admins get no implicit access: they may only list_access, for incident
 *   response ("who can reach this?"), and reassign with make_owner.
 * - One grant per resource and grantee, so granting again replaces the
 *   level (also downgrades). Everyone grants are capped below write.
 * - Takes effect on the next check; runs already in flight keep going.
 */
import { z } from "zod";
import { Prisma, type Principal, type PrismaClient } from "#prisma";
import {
  EVERYONE_KEY,
  EVERYONE_MAX,
  LEVELS,
  SHAREABLE_TYPES,
  accessRank,
  atLeast,
  isLevel,
  isResourceType,
  principalGranteeKey,
  type ResourceType,
} from "../../core/grants.js";
import { agentNotFound, assertAgentAccess, agentAccess } from "../auth/access.js";
import { permissionsOf } from "../auth/resource-server.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

const GranteeSchema = z.union([
  z.literal("everyone"),
  z.object({ subject: z.string().min(1).max(512) }).strict(),
  z.object({ principalId: z.string().min(1).max(128) }).strict(),
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

/** The grantee's principal (must have signed in once: never created here), or null for everyone. */
async function resolveGrantee(db: GrantTx, grantee: Grantee): Promise<Principal | null> {
  if (grantee === "everyone") return null;
  const principal =
    "subject" in grantee
      ? await db.principal.findUnique({ where: { subject: grantee.subject } })
      : await db.principal.findUnique({ where: { id: grantee.principalId } });
  if (!principal) {
    throw new McpError(404, "Grantee not found: they must have signed in to wardby at least once.");
  }
  return principal;
}

/** Grant management is the owner's (or the stdio operator's). Phase 1: agents. */
async function requireOwnedResource(ctx: McpRequestContext, db: GrantTx, type: ResourceType, id: string) {
  // Only "agent" reaches here in Phase 1 (shareableType).
  void type;
  const row = await db.agent.findUnique({ where: { id } });
  return (await assertAgentAccess(ctx, row, id, "owner", db)).agent;
}

type GrantTx = Pick<PrismaClient, "agent" | "principal" | "resourceGrant">;

/**
 * The ownership check and the write in one Serializable transaction (review
 * M3): a concurrent make_owner, which resets grants in its own transaction,
 * conflicts instead of letting the old owner's grant land on the new
 * owner's agent.
 */
function inSerializable<T>(ctx: McpRequestContext, fn: (tx: GrantTx) => Promise<T>): Promise<T> {
  return ctx.db.$transaction((tx) => fn(tx), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

function isAdmin(ctx: McpRequestContext): boolean {
  return ctx.scopes.has("agents:admin") && permissionsOf(ctx.roles).has("agents:admin");
}

const TYPE_PROPERTIES = {
  // No enum: another type gets a clear "not shareable yet" from the handler.
  resourceType: { type: "string", description: 'Only "agent" is shareable today.' },
  resourceId: { type: "string" },
};
const GRANTEE_PROPERTY = {
  description: 'One principal, as {"subject": "<IdP subject>"} or {"principalId": "<id>"}, or "everyone".',
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
  ],
};

export function registerGrantTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "grant_access",
    scope: "agents:write",
    description:
      "Shares an agent you own with one principal or with everyone, at a level: " +
      "read (see its config, never secret values or other owners' tool code); " +
      "execute (also trigger runs and see the runs they triggered); " +
      "write (also change its name, prompt, model, budget amount, max turns, effort, memory on/off and schedule, attach tools they can use and detach tools, and create webhooks). " +
      "Owner-only whatever the level: the coding profile (task, base ref, protected paths, task-override opt-in, image, packages, limits), kind, budget group, sub-agents, secret/datastore/repository bindings, tool capabilities, memory and datastore contents, grants, delete. " +
      "Consequences: execute lets them run your agent with your tools, secrets, datastores and repository, and every run shares the agent's memory; they supply no task text unless it's a coding agent with allowWebhookTaskOverride. " +
      "Write lets them rewrite what those runs do: the prompt can make a run use everything the agent can already reach (the capabilities you granted, its memory, its linked repositories), and on a coding agent the prompt is part of every coding task, so write directs work done with your GitHub access. " +
      "Granting again replaces the level. Everyone is capped at execute. The grantee must have signed in once.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...TYPE_PROPERTIES,
        grantee: GRANTEE_PROPERTY,
        level: { type: "string", description: "Agents: read < execute < write." },
      },
      required: ["resourceType", "resourceId", "grantee", "level"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = parse(GrantSchema, "grant_access", rawArgs);
      const type = shareableType(args.resourceType);
      if (!isLevel(type, args.level)) {
        throw new McpError(400, `Level "${args.level}" is not valid for ${type} (${LEVELS[type].join(" < ")}).`);
      }
      const { resource, principal, grant } = await inSerializable(ctx, async (tx) => {
        const resource = await requireOwnedResource(ctx, tx, type, args.resourceId);
        const principal = await resolveGrantee(tx, args.grantee);
        if (principal && (principal.id === resource.ownerId || principal.id === ctx.principal.id)) {
          throw new McpError(
            400,
            "The owner already has full access; a grant to yourself or the owner changes nothing.",
          );
        }
        if (!principal && accessRank(type, args.level) > accessRank(type, EVERYONE_MAX[type])) {
          throw new McpError(
            400,
            `An everyone grant can be at most ${EVERYONE_MAX[type]}: write for everyone would let anyone rewrite an agent that holds your tools and secrets.`,
          );
        }
        const granteeKey = principal ? principalGranteeKey(principal.id) : EVERYONE_KEY;
        const grant = await tx.resourceGrant.upsert({
          where: { resourceType_resourceId_granteeKey: { resourceType: type, resourceId: resource.id, granteeKey } },
          create: {
            resourceType: type,
            resourceId: resource.id,
            granteeKind: principal ? "principal" : "everyone",
            granteePrincipalId: principal?.id ?? null,
            granteeKey,
            level: args.level,
            source: "owner",
            grantedById: ctx.principal.id,
          },
          update: { level: args.level, source: "owner", grantedById: ctx.principal.id },
        });
        return { resource, principal, grant };
      });
      return textResult({
        granted: true,
        resourceType: type,
        resourceId: resource.id,
        // Echo only what the caller supplied: a principalId never reveals a subject (review M4).
        grantee: !principal
          ? "everyone"
          : args.grantee !== "everyone" && "subject" in args.grantee
            ? { principalId: principal.id, subject: principal.subject }
            : { principalId: principal.id },
        level: grant.level,
      });
    },
  });

  mcp.registerTool({
    name: "revoke_access",
    scope: "agents:write",
    description:
      "Removes a grant on an agent you own. Idempotent. Takes effect on the next check (trigger, delegation, webhook fire); runs already in flight keep going.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ...TYPE_PROPERTIES, grantee: GRANTEE_PROPERTY },
      required: ["resourceType", "resourceId", "grantee"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = parse(RevokeSchema, "revoke_access", rawArgs);
      const type = shareableType(args.resourceType);
      const { count } = await inSerializable(ctx, async (tx) => {
        const resource = await requireOwnedResource(ctx, tx, type, args.resourceId);
        const granteeKey =
          args.grantee === "everyone"
            ? EVERYONE_KEY
            : principalGranteeKey((await resolveGrantee(tx, args.grantee))!.id);
        return tx.resourceGrant.deleteMany({ where: { resourceType: type, resourceId: resource.id, granteeKey } });
      });
      return textResult({ revoked: count > 0 });
    },
  });

  mcp.registerTool({
    name: "list_access",
    scope: "agents:read",
    description:
      "Lists who an agent is shared with (grant metadata only). For its owner, the stdio operator, and admins (incident response).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: TYPE_PROPERTIES,
      required: ["resourceType", "resourceId"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = parse(ListSchema, "list_access", rawArgs);
      const type = shareableType(args.resourceType);
      const resource = await ctx.db.agent.findUnique({ where: { id: args.resourceId } });
      if (!resource) throw agentNotFound(args.resourceId);
      if (!isAdmin(ctx)) {
        const access = await agentAccess(ctx, resource);
        if (!atLeast("agent", access, "read")) throw agentNotFound(args.resourceId);
        if (access !== "owner") {
          throw new McpError(
            403,
            `Agent "${resource.id}": only its owner (or an admin) can list who it is shared with.`,
          );
        }
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
      return textResult({
        resourceType: type,
        resourceId: resource.id,
        ownerId: resource.ownerId,
        grants: grants.map((g) => ({
          grantee: g.granteePrincipalId
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
