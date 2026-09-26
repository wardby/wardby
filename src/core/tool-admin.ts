/**
 * Updating and deleting a Tool, shared by MCP update_tool/delete_tool (the
 * owner, over MCP) and `wardby tool update|delete` (the operator, over the
 * CLI). Each caller brings its own authorization -- MCP is strictly
 * owner-only and never touches public tools; the operator may change any
 * tool -- but the attachment rules are the same for both, and are always
 * judged against the *tool's* owner:
 *
 * - An update is refused while the tool is attached to any agent owned by
 *   someone other than the tool's owner (a public agent counts, unless the
 *   tool is public too). An attachment's grants hand whatever code the row
 *   holds to that agent owner's secrets and hosts, and the description
 *   reaches their model context.
 * - A delete is refused while any attachment remains; `detach` first removes
 *   the attachments to the tool owner's own agents (for a public tool, the
 *   public agents), never anyone else's. The check runs before any detach,
 *   so a refusal changes nothing.
 *
 * Both run in one Serializable transaction, the same isolation as MCP
 * attach_tool, so an attach that commits between the check and the write
 * aborts one side instead of letting new code reach a newly attached agent
 * (pinned in core/prisma-adapter.database.test.ts). That guarantee covers
 * MCP attach_tool only: `wardby tool attach` and the importer attach with a
 * plain check-then-upsert, acceptable because both are operator-only.
 */
import { Prisma, type PrismaClient, type Tool } from "#prisma";
import { deriveJsonSchema } from "../sandbox/zod-params.js";

export type AttachedAgent = { id: string; name: string; ownerId: string | null };

export interface ToolChanges {
  description?: string;
  paramsZod?: string;
  code?: string;
}

/**
 * Why a tool change was refused because of its attachments:
 * - `other_owners`: attached to agents owned by someone other than the
 *   tool's owner (`agents` lists them; callers decide how much to reveal).
 * - `needs_detach`: a delete without `detach`, still attached to the tool
 *   owner's own agents.
 * - `race`: an attachment committed after the check, and the RESTRICT
 *   foreign key stopped the delete (`agents` is empty).
 */
export class ToolAttachedError extends Error {
  constructor(
    readonly reason: "other_owners" | "needs_detach" | "race",
    readonly agents: AttachedAgent[],
  ) {
    super(`tool_attached_${reason}`);
    this.name = "ToolAttachedError";
  }
}

/** Whether `changes` names at least one field to change. */
export function hasToolChanges(changes: ToolChanges): boolean {
  return changes.description !== undefined || changes.paramsZod !== undefined || changes.code !== undefined;
}

/**
 * The row update for `changes`, with jsonSchema re-derived exactly as tool
 * creation does whenever paramsZod changes, so the cached schema never goes
 * stale. An invalid paramsZod is returned, not thrown -- the caller reports
 * it like create_tool does and writes nothing. Run it before the transaction
 * so a QuickJS compile never holds one open.
 */
export async function prepareToolUpdate(
  changes: ToolChanges,
): Promise<{ ok: true; data: Prisma.ToolUpdateInput } | { ok: false; errorKind: string; errorMessage: string }> {
  const data: Prisma.ToolUpdateInput = {
    ...(changes.description !== undefined ? { description: changes.description } : {}),
    ...(changes.code !== undefined ? { code: changes.code } : {}),
  };
  if (changes.paramsZod !== undefined) {
    const schemaResult = await deriveJsonSchema(changes.paramsZod);
    if (!schemaResult.ok) {
      return { ok: false, errorKind: schemaResult.errorKind, errorMessage: schemaResult.errorMessage };
    }
    data.paramsZod = changes.paramsZod;
    data.jsonSchema = schemaResult.value as object;
  }
  return { ok: true, data };
}

/** The agents `toolId` is attached to, read inside the caller's transaction. */
export async function attachedAgents(
  tx: Pick<Prisma.TransactionClient, "agentTool">,
  toolId: string,
): Promise<AttachedAgent[]> {
  const rows = await tx.agentTool.findMany({
    where: { toolId },
    select: { agent: { select: { id: true, name: true, ownerId: true } } },
  });
  return rows.map((row) => row.agent);
}

/** Refuses (by throwing) unless the caller may change this tool; receives the row read inside the transaction. */
export type AuthorizeTool = (tool: Tool | null) => void;

export async function updateToolGuarded(
  db: Pick<PrismaClient, "$transaction">,
  toolId: string,
  data: Prisma.ToolUpdateInput,
  authorize: AuthorizeTool,
): Promise<Tool> {
  return db.$transaction(
    async (tx) => {
      const tool = await tx.tool.findUnique({ where: { id: toolId } });
      authorize(tool);
      const others = (await attachedAgents(tx, toolId)).filter((agent) => agent.ownerId !== tool!.ownerId);
      if (others.length > 0) throw new ToolAttachedError("other_owners", others);
      return tx.tool.update({ where: { id: toolId }, data });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

/** Deletes the tool and returns the ids of the agents it was detached from. */
export async function deleteToolGuarded(
  db: Pick<PrismaClient, "$transaction">,
  toolId: string,
  options: { detach: boolean; authorize: AuthorizeTool },
): Promise<string[]> {
  try {
    return await db.$transaction(
      async (tx) => {
        const tool = await tx.tool.findUnique({ where: { id: toolId } });
        options.authorize(tool);
        const agents = await attachedAgents(tx, toolId);
        const own = agents.filter((agent) => agent.ownerId === tool!.ownerId);
        const others = agents.filter((agent) => agent.ownerId !== tool!.ownerId);
        if (others.length > 0) throw new ToolAttachedError("other_owners", others);
        if (own.length > 0 && !options.detach) throw new ToolAttachedError("needs_detach", own);
        if (own.length > 0) {
          await tx.agentTool.deleteMany({ where: { toolId, agentId: { in: own.map((agent) => agent.id) } } });
        }
        await tx.tool.delete({ where: { id: toolId } });
        return own.map((agent) => agent.id);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (err) {
    // AgentTool.toolId is ON DELETE RESTRICT: an attachment that raced in
    // past the check above still stops the delete, as P2003.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      throw new ToolAttachedError("race", []);
    }
    throw err;
  }
}

/** One `wardby tool list` line: names are only unique per owner, so the id and owner disambiguate. */
export function formatToolLine(tool: Pick<Tool, "id" | "name" | "description" | "ownerId">): string {
  return `${tool.id}  ${tool.name}  owner:${tool.ownerId ?? "public"}  ${tool.description}`;
}

/** Attached agents for an operator-facing refusal: unlike MCP's, nothing is redacted. */
export function formatAttachedAgents(agents: AttachedAgent[]): string {
  return agents
    .map((agent) => `"${agent.name}" (${agent.id}, ${agent.ownerId === null ? "public" : `owner ${agent.ownerId}`})`)
    .join(", ");
}
