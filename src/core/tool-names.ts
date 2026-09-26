/**
 * Tool-name rules shared by every path that creates or attaches a Tool
 * (MCP create_tool/attach_tool, `wardby tool create|attach`, the importer)
 * and by the runner that dispatches them.
 *
 * Tool names are unique per owner, not globally (schema.prisma), so one
 * agent could otherwise end up holding two same-named tools -- say its own
 * `foo` plus a public `foo`. The runtime dispatches by name (runner.ts), so
 * the model would see a duplicate tool name and one tool would silently
 * shadow the other; every attach path refuses that instead
 * (findSameNamedAttachedTool), and the runner asserts it at load time.
 */
import type { Prisma, PrismaClient, Tool } from "#prisma";
import { MEMORY_TOOL_NAMES } from "./memory-tools.js";
import { SUBAGENT_MEMORY_TOOL_NAMES } from "./subagent-memory-tools.js";

/** The runner's synthesized sub-agent tools are `delegate_to_<boundName>`. */
export const DELEGATE_TOOL_PREFIX = "delegate_to_";

/**
 * Why `name` can't be a user tool's name, or undefined if it can. Each
 * reserved name is checked by the runner before user tools, so a user tool
 * with one of these names could be created but never reached.
 */
export function reservedToolNameReason(name: string): string | undefined {
  if (MEMORY_TOOL_NAMES.has(name)) return `Tool name "${name}" is reserved for the built-in agent-memory tools.`;
  if (SUBAGENT_MEMORY_TOOL_NAMES.has(name)) {
    return `Tool name "${name}" is reserved for the built-in sub-agent memory tools.`;
  }
  if (name.startsWith(DELEGATE_TOOL_PREFIX)) {
    return `Tool names starting with "${DELEGATE_TOOL_PREFIX}" are reserved for sub-agent delegation tools.`;
  }
  return undefined;
}

/** Names appearing more than once, each reported once, in first-seen order. */
export function duplicateToolNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return [...duplicates];
}

export type ToolLookupDb = Pick<PrismaClient | Prisma.TransactionClient, "tool" | "agentTool">;

/**
 * A tool other than `tool` that is already attached to `agentId` under the
 * same name, or null. Run it inside the attaching transaction (attach_tool's
 * is Serializable) so a concurrent attach can't slip in between.
 */
export async function findSameNamedAttachedTool(
  db: Pick<ToolLookupDb, "agentTool">,
  agentId: string,
  tool: Pick<Tool, "id" | "name">,
): Promise<Pick<Tool, "id" | "name" | "ownerId"> | null> {
  const clash = await db.agentTool.findFirst({
    where: { agentId, toolId: { not: tool.id }, tool: { name: tool.name } },
    select: { tool: { select: { id: true, name: true, ownerId: true } } },
  });
  return clash?.tool ?? null;
}

/**
 * Resolves a CLI tool reference: an id, else a name. A name is no longer
 * unique across owners, so more than one match is refused -- with the
 * candidate ids, so the operator can pass one -- rather than guessed at.
 */
export async function resolveToolRef(
  db: Pick<ToolLookupDb, "tool">,
  ref: string,
): Promise<{ ok: true; tool: Tool } | { ok: false; error: string }> {
  const byId = await db.tool.findUnique({ where: { id: ref } });
  if (byId) return { ok: true, tool: byId };
  const byName = await db.tool.findMany({ where: { name: ref } });
  if (byName.length === 0) return { ok: false, error: `unknown tool "${ref}".` };
  if (byName.length > 1) {
    const candidates = byName.map((t) => `${t.id} (owner: ${t.ownerId ?? "public"})`).join(", ");
    return {
      ok: false,
      error: `ambiguous: ${byName.length} tools named "${ref}"; pass the tool id instead (${candidates}).`,
    };
  }
  return { ok: true, tool: byName[0] };
}
