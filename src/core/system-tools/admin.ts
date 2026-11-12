/**
 * Admin operations on system tools (#529), shared by the MCP tools (an admin)
 * and the CLI (the operator): make a tool public, and grant or revoke a
 * server connection on a public tool. Callers bring their own authorization;
 * the rules here are the same for both.
 */
import { Prisma, type PrismaClient, type Tool, type ToolConnectionGrant } from "#prisma";
import { attachedAgents, type AttachedAgent } from "../tool-admin.js";
import type { ToolConnectionName } from "./connections.js";

export type SystemToolErrorCode =
  "tool_not_found" | "tool_already_public" | "public_tool_name_taken" | "tool_used_by_other_owners" | "tool_not_public";

export class SystemToolError extends Error {
  constructor(
    readonly code: SystemToolErrorCode,
    message: string,
    /** For tool_used_by_other_owners: the agents (callers decide how much to reveal). */
    readonly agents: AttachedAgent[] = [],
  ) {
    super(`${code}: ${message}`);
    this.name = "SystemToolError";
  }
}

/**
 * Makes an owned tool public: no owner, changed only by an admin or the
 * operator from now on. Refused while it runs for an agent whose owner isn't
 * the tool's owner -- publishing would put that owner's secrets and hosts
 * behind code nobody owns. Attachments and hooks on the former owner's agents
 * keep working: their grants came from the agent's owner, not the tool's.
 */
export async function makeToolPublic(
  db: Pick<PrismaClient, "$transaction">,
  toolId: string,
  publishedById: string | null,
): Promise<Tool> {
  return db.$transaction(
    async (tx) => {
      const tool = await tx.tool.findUnique({ where: { id: toolId } });
      if (!tool) throw new SystemToolError("tool_not_found", `Tool "${toolId}" not found.`);
      if (tool.ownerId === null)
        throw new SystemToolError("tool_already_public", `Tool "${tool.name}" is already public.`);
      // (ownerId, name) is unique per owner only: NULL owners don't collide in the index.
      if (await tx.tool.findFirst({ where: { ownerId: null, name: tool.name }, select: { id: true } })) {
        throw new SystemToolError(
          "public_tool_name_taken",
          `A public tool named "${tool.name}" already exists; rename this one (create a new tool) first.`,
        );
      }
      const others = (await attachedAgents(tx, toolId)).filter((agent) => agent.ownerId !== tool.ownerId);
      if (others.length > 0) {
        throw new SystemToolError(
          "tool_used_by_other_owners",
          `Tool "${tool.name}" runs for ${others.length} agent(s) owned by someone else; detach it there first.`,
          others,
        );
      }
      return tx.tool.update({
        where: { id: toolId },
        data: { ownerId: null, publishedById, publishedAt: new Date() },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function requirePublicTool(db: Pick<PrismaClient, "tool">, toolId: string): Promise<Tool> {
  const tool = await db.tool.findUnique({ where: { id: toolId } });
  if (!tool) throw new SystemToolError("tool_not_found", `Tool "${toolId}" not found.`);
  if (tool.ownerId !== null) {
    throw new SystemToolError(
      "tool_not_public",
      `Tool "${tool.name}" is owned; only a public tool can use a server connection (make it public first).`,
    );
  }
  return tool;
}

/** Grants (or replaces) a connection on a public tool. `channels` must already be parsed (parseChannelScope). */
export async function grantToolConnection(
  db: Pick<PrismaClient, "tool" | "toolConnectionGrant">,
  toolId: string,
  connection: ToolConnectionName,
  channels: string[],
  grantedById: string | null,
): Promise<ToolConnectionGrant> {
  await requirePublicTool(db, toolId);
  return db.toolConnectionGrant.upsert({
    where: { toolId_connection: { toolId, connection } },
    create: { toolId, connection, channels, grantedById },
    update: { channels, grantedById },
  });
}

/** Removes a connection grant; false when there was none. */
export async function revokeToolConnection(
  db: Pick<PrismaClient, "tool" | "toolConnectionGrant">,
  toolId: string,
  connection: ToolConnectionName,
): Promise<boolean> {
  const tool = await db.tool.findUnique({ where: { id: toolId }, select: { id: true } });
  if (!tool) throw new SystemToolError("tool_not_found", `Tool "${toolId}" not found.`);
  const { count } = await db.toolConnectionGrant.deleteMany({ where: { toolId, connection } });
  return count > 0;
}
