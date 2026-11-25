/**
 * Ownership decisions for the resource types that don't have grants yet:
 * BudgetGroup/Tool/Secret/Datastore/Webhook/Task. A null owner still means
 * "public" here: readable AND mutable by anyone. Tool and budget-group
 * grants replace that in the resource-sharing grants Phases 2 and 3.
 *
 * Agents are NOT decided here any more: they use explicit grants (owner, or
 * read < execute < write), and an owner-less agent is reachable only
 * through its grants -- see ./access.ts and core/grants.ts. `isOwner` stays
 * available (strict, no null-passthrough) for checks that must stay
 * owner-only regardless of publicness.
 */
import type { PrismaClient, Tool } from "#prisma";
import { McpError } from "../errors.js";
import type { McpRequestContext } from "../context.js";
import {
  actsForOwner,
  atLeast,
  accessFor,
  grantedIds,
  ownedByWhere,
  ownerCanUseBudgetGroup,
  type Access,
  type Acting,
  type Level,
} from "../../core/grants.js";
import { actsForOf } from "./access.js";
import { isOwnerAll } from "./resource-server.js";

/** The caller bypasses per-owner checks: an owner-all caller (owner:all scope + wardby_owner role). */
type OwnerAllCtx = Pick<McpRequestContext, "scopes" | "roles">;
type ActingCtx = OwnerAllCtx & Pick<McpRequestContext, "principal" | "actsFor">;

/**
 * Owner checks take who the caller acts for: one principal id, or the caller's
 * own plus its Teams' backing principals (McpRequestContext.actsFor), so a Team
 * member owns what the Team owns.
 */
export function canRead(ownerId: string | null, acting: Acting): boolean {
  return ownerId === null || actsForOwner(acting, ownerId);
}

export function isOwner(ownerId: string | null, acting: Acting): boolean {
  return actsForOwner(acting, ownerId);
}

/** canRead, plus owner-all callers read every owner's rows. */
export function canReadFor(ctx: ActingCtx, ownerId: string | null): boolean {
  return isOwnerAll(ctx) || canRead(ownerId, actsForOf(ctx));
}

/** canMutate, plus owner-all callers mutate every owner's rows. */
export function canMutateFor(ctx: ActingCtx, ownerId: string | null): boolean {
  return isOwnerAll(ctx) || canMutate(ownerId, actsForOf(ctx));
}

/** Same rule as canRead: a null owner is a mutation target for anyone, same as it's a read target for anyone. */
export function canMutate(ownerId: string | null, acting: Acting): boolean {
  return ownerId === null || actsForOwner(acting, ownerId);
}

export function assertCanMutate(
  ownerId: string | null,
  acting: Acting,
  notFoundMessage: string,
  ownerAll = false,
): void {
  if (!ownerAll && !canMutate(ownerId, acting)) throw new McpError(403, notFoundMessage);
}

/** Prisma where-clause fragment: rows owned by the caller (or a Team it acts for), plus public (null-owner) rows. */
export function visibleToPrincipal(acting: Acting) {
  return { OR: [ownedByWhere(acting), { ownerId: null }] };
}

/** visibleToPrincipal for a request: an owner-all caller sees every row. */
export function visibleTo(ctx: ActingCtx) {
  return isOwnerAll(ctx) ? {} : visibleToPrincipal(actsForOf(ctx));
}

/**
 * The caller's access to a budget group: owner for its owner (or a Team it acts for), the stdio operator and
 * an owner-all caller; a public (no owner) group is open to everyone, as before; otherwise the best Grant.
 */
export async function budgetGroupAccess(
  ctx: ActingCtx & Pick<McpRequestContext, "operator" | "db">,
  group: { id: string; ownerId: string | null },
  db: Pick<PrismaClient, "resourceGrant"> = ctx.db,
): Promise<Access<"budget_group">> {
  if (ctx.operator === true || isOwnerAll(ctx) || group.ownerId === null) return "owner";
  return accessFor(db, "budget_group", group, actsForOf(ctx));
}

/** 404 if missing or below read; 403 if below `need`. */
export async function requireBudgetGroupAccess(
  ctx: McpRequestContext,
  id: string,
  need: Level<"budget_group"> | "owner",
  db: Pick<PrismaClient, "budgetGroup" | "resourceGrant"> = ctx.db,
) {
  const group = await db.budgetGroup.findUnique({ where: { id } });
  const access = group ? await budgetGroupAccess(ctx, group, db) : "none";
  if (!group || !atLeast("budget_group", access, "read")) throw new McpError(404, `Budget group "${id}" not found.`);
  if (!atLeast("budget_group", access, need)) {
    throw new McpError(
      403,
      `Budget group "${id}": this needs ${need === "owner" ? "the group's owner" : `${need} access`}; you have ${access} access.`,
    );
  }
  return group;
}

/**
 * Puts an agent in a budget group: the caller must be able to see the group, and the agent's OWNER (who is
 * charged, and whose access the grant-revoke cleanup judges) must be able to use it. The stdio operator and an
 * owner-all caller may assign any group.
 */
export async function requireBudgetGroupUsableBy(
  ctx: McpRequestContext,
  id: string,
  agentOwnerId: string | null,
  db: Pick<PrismaClient, "budgetGroup" | "resourceGrant"> = ctx.db,
) {
  const group = await requireBudgetGroupAccess(ctx, id, "read", db);
  if (ctx.operator === true || isOwnerAll(ctx)) return group;
  if (!(await ownerCanUseBudgetGroup(db, agentOwnerId, group))) {
    throw new McpError(
      403,
      `Budget group "${id}": the agent's owner needs use access to put an agent in it; ask the group's owner for a use grant.`,
    );
  }
  return group;
}

/** Prisma where for budget group listings: own rows, public rows, and rows granted at least read. */
export async function readableBudgetGroupsWhere(
  ctx: McpRequestContext,
  db: Pick<PrismaClient, "resourceGrant"> = ctx.db,
) {
  if (ctx.operator === true || isOwnerAll(ctx)) return {};
  const acting = actsForOf(ctx);
  const ids = await grantedIds(db, "budget_group", acting, "read");
  return { OR: [...visibleToPrincipal(acting).OR, { id: { in: ids } }] };
}

type OwnedType = "secret" | "datastore" | "webhook";
type OwnedRow = { id: string; ownerId: string | null };

/**
 * The caller's access to a secret, datastore or webhook: owner for its owner (or a Team it acts for), the stdio
 * operator and an owner-all caller, and for a row with no owner (public, as before); otherwise the best Grant,
 * which only ever confers read (metadata, never a value).
 */
export async function ownedAccess<T extends OwnedType>(
  ctx: ActingCtx & Pick<McpRequestContext, "operator" | "db">,
  type: T,
  row: OwnedRow,
  db: Pick<PrismaClient, "resourceGrant"> = ctx.db,
  alsoOwnedBy: string | null = null,
  ownerlessIsPublic = true,
): Promise<Access<T>> {
  if (ctx.operator === true || isOwnerAll(ctx) || (ownerlessIsPublic && row.ownerId === null)) return "owner";
  const acting = actsForOf(ctx);
  if (alsoOwnedBy !== null && actsForOwner(acting, alsoOwnedBy)) return "owner";
  return accessFor(db, type, row, acting);
}

function requireAccess<T extends OwnedType>(
  access: Access<T>,
  type: T,
  need: Level<T> | "owner",
  label: string,
  id: string,
): void {
  if (!atLeast(type, access, "read")) throw new McpError(404, `${label} "${id}" not found.`);
  if (!atLeast(type, access, need)) {
    throw new McpError(
      403,
      `${label} "${id}": this needs ${need === "owner" ? "its owner" : `${need} access`}; you have ${access} access.`,
    );
  }
}

/** 404 if missing or the caller cannot see it; 403 if they can see it but are not its owner. */
export async function requireSecretAccess(
  ctx: McpRequestContext,
  id: string,
  need: Level<"secret"> | "owner",
  db: Pick<PrismaClient, "secret" | "resourceGrant"> = ctx.db,
) {
  const secret = await db.secret.findUnique({ where: { id } });
  requireAccess(secret ? await ownedAccess(ctx, "secret", secret, db) : "none", "secret", need, "Secret", id);
  return secret!;
}

export async function requireDatastoreAccess(
  ctx: McpRequestContext,
  id: string,
  need: Level<"datastore"> | "owner",
  db: Pick<PrismaClient, "datastore" | "resourceGrant"> = ctx.db,
) {
  const datastore = await db.datastore.findUnique({ where: { id } });
  requireAccess(
    datastore ? await ownedAccess(ctx, "datastore", datastore, db) : "none",
    "datastore",
    need,
    "Datastore",
    id,
  );
  return datastore!;
}

/** A webhook is owned by whoever created it and by the owner of the agent it fires. */
export async function requireWebhookAccess(
  ctx: McpRequestContext,
  id: string,
  need: Level<"webhook"> | "owner",
  db: Pick<PrismaClient, "webhook" | "resourceGrant"> = ctx.db,
) {
  const webhook = await db.webhook.findUnique({ where: { id }, include: { agent: { select: { ownerId: true } } } });
  const access = webhook ? await ownedAccess(ctx, "webhook", webhook, db, webhook.agent.ownerId, false) : "none";
  requireAccess(access, "webhook", need, "Webhook", id);
  return webhook!;
}

/** Prisma where for listings of secrets or datastores: owned (by the caller or a Team it acts for) or granted at least read. */
export async function readableOwnedWhere(
  ctx: McpRequestContext,
  type: "secret" | "datastore",
  db: Pick<PrismaClient, "resourceGrant"> = ctx.db,
) {
  if (ctx.operator === true || isOwnerAll(ctx)) return {};
  const acting = actsForOf(ctx);
  const ids = await grantedIds(db, type, acting, "read");
  const owned = ownedByWhere(acting);
  // Nothing shared with the caller: the plain ownership filter.
  return ids.length === 0 ? owned : { OR: [owned, { id: { in: ids } }] };
}

/**
 * The caller's access to a tool: owner for its owner (or a Team it acts for), the stdio operator and an
 * owner-all caller; a public (no owner) tool is usable and readable by everyone but never changeable here;
 * otherwise the best Grant.
 */
export async function toolAccess(
  ctx: ActingCtx & Pick<McpRequestContext, "operator" | "db">,
  tool: { id: string; ownerId: string | null },
  db: Pick<PrismaClient, "resourceGrant"> = ctx.db,
): Promise<Access<"tool">> {
  if (ctx.operator === true || isOwnerAll(ctx)) return "owner";
  if (tool.ownerId === null) return "use";
  return accessFor(db, "tool", tool, actsForOf(ctx));
}

/** 404 if missing or below read; 403 if below `need`. Returns the tool row. */
export async function requireToolAccess(
  ctx: McpRequestContext,
  id: string,
  need: Level<"tool"> | "owner",
  db: Pick<PrismaClient, "tool" | "resourceGrant"> = ctx.db,
): Promise<Tool> {
  const tool = await db.tool.findUnique({ where: { id } });
  const access = tool ? await toolAccess(ctx, tool, db) : "none";
  if (!tool || !atLeast("tool", access, "read")) throw new McpError(404, `Tool "${id}" not found.`);
  if (!atLeast("tool", access, need)) {
    throw new McpError(
      403,
      `Tool "${id}": this needs ${need === "owner" ? "the tool's owner" : `${need} access`}; you have ${access} access.`,
    );
  }
  return tool;
}

/** Prisma where for tool listings: own rows, public rows, and rows granted at least read. */
export async function readableToolsWhere(ctx: McpRequestContext, db: Pick<PrismaClient, "resourceGrant"> = ctx.db) {
  if (ctx.operator === true || isOwnerAll(ctx)) return {};
  const acting = actsForOf(ctx);
  const ids = await grantedIds(db, "tool", acting, "read");
  return { OR: [...visibleToPrincipal(acting).OR, { id: { in: ids } }] };
}

/**
 * Owner-only, with no null-is-public passthrough: for changing or removing
 * a tool's code (update_tool/delete_tool), where requireOwnedTool's rule
 * would let anyone rewrite a public tool. A public tool is readable but
 * immutable over MCP (403) -- only an operator can change one, via the CLI
 * (or an owner-all caller, who passes `ownerAll`).
 * A tool the caller can't read is 404, the same as a missing one.
 */
export async function requireStrictlyOwnedTool(
  db: Pick<PrismaClient, "tool">,
  id: string,
  principalId: Acting,
  ownerAll = false,
): Promise<Tool> {
  return assertStrictlyOwnedTool(await db.tool.findUnique({ where: { id } }), id, principalId, ownerAll);
}

/** requireStrictlyOwnedTool's rule for a row already read (e.g. inside core/tool-admin.ts's transaction). */
export function assertStrictlyOwnedTool(tool: Tool | null, id: string, principalId: Acting, ownerAll = false): Tool {
  if (!tool || !(ownerAll || canRead(tool.ownerId, principalId))) throw new McpError(404, `Tool "${id}" not found.`);
  if (!ownerAll && !isOwner(tool.ownerId, principalId)) {
    throw new McpError(403, `Tool "${id}" is public; public tools can't be changed or deleted over MCP.`);
  }
  return tool;
}

/**
 * A Task's principalId is the caller who triggered it, not the underlying
 * agent's owner — a public agent's runs are still private to whoever
 * triggered them. No canRead/null=public path exists here on purpose.
 */
export async function requireOwnedTask(db: PrismaClient, taskId: string, principalId: Acting, ownerAll = false) {
  const task = await db.task.findUnique({ where: { id: taskId } });
  // 404, not 403: confirming a taskId exists at all to a non-owner is
  // itself a small information leak — same reasoning as agent reads.
  if (!task || !(ownerAll || isOwner(task.principalId, principalId))) {
    throw new McpError(404, `Task "${taskId}" not found.`);
  }
  return task;
}
