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
import type { Principal } from "#prisma";
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
async function resolveGrantee(ctx: McpRequestContext, grantee: Grantee): Promise<Principal | null> {
  if (grantee === "everyone") return null;
  const principal =
    "subject" in grantee
      ? await ctx.db.principal.findUnique({ where: { subject: grantee.subject } })
      : await ctx.db.principal.findUnique({ where: { id: grantee.principalId } });
  if (!principal) {
    throw new McpError(404, "Grantee not found: they must have signed in to wardby at least once.");
  }
  return principal;
}

/** Grant management is the owner's (or the stdio operator's). Phase 1: agents. */
async function requireOwnedResource(ctx: McpRequestContext, type: ResourceType, id: string) {
  // Only "agent" reaches here in Phase 1 (shareableType).
  void type;
  const row = await ctx.db.agent.findUnique({ where: { id } });
  return (await assertAgentAccess(ctx, row, id, "owner")).agent;
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
      "Shares an agent you own with one principal or with everyone, at a level: read (see its config, never secret values or other owners' tool code), execute (also trigger runs and see the runs they triggered), or write (also change its prompt, model, schedule, budget, tools and sub-agents). " +
      "Consequences: execute lets them run your agent with your tools, secrets, datastores and repository -- and every run shares the agent's memory. " +
      "Write lets them change what those runs do (its prompt and schedule), but never bind secrets, datastores or repositories, nor grant a tool your capabilities. " +
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
      const resource = await requireOwnedResource(ctx, type, args.resourceId);
      const principal = await resolveGrantee(ctx, args.grantee);
      if (principal && (principal.id === resource.ownerId || principal.id === ctx.principal.id)) {
        throw new McpError(400, "The owner already has full access; a grant to yourself or the owner changes nothing.");
      }
      if (!principal && accessRank(type, args.level) > accessRank(type, EVERYONE_MAX[type])) {
        throw new McpError(
          400,
          `An everyone grant can be at most ${EVERYONE_MAX[type]}: write for everyone would let anyone rewrite an agent that holds your tools and secrets.`,
        );
      }
      const granteeKey = principal ? principalGranteeKey(principal.id) : EVERYONE_KEY;
      const grant = await ctx.db.resourceGrant.upsert({
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
      return textResult({
        granted: true,
        resourceType: type,
        resourceId: resource.id,
        grantee: principal ? { principalId: principal.id, subject: principal.subject } : "everyone",
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
      const resource = await requireOwnedResource(ctx, type, args.resourceId);
      const granteeKey =
        args.grantee === "everyone" ? EVERYONE_KEY : principalGranteeKey((await resolveGrantee(ctx, args.grantee))!.id);
      const { count } = await ctx.db.resourceGrant.deleteMany({
        where: { resourceType: type, resourceId: resource.id, granteeKey },
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
