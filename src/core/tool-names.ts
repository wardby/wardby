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
 * The same holds against an attached MCP server's exposed tool names
 * (findSameNamedMcpTool); the runner leaves a clashing MCP tool out.
 */
import type { Prisma, PrismaClient, Tool } from "#prisma";
import { MEMORY_TOOL_NAMES } from "./memory-tools.js";
import { SUBAGENT_MEMORY_TOOL_NAMES } from "./subagent-memory-tools.js";
import { ISSUE_TRACKER_TOOL_NAMES } from "./issue-tracker-tools.js";
import { exposedNames } from "./mcp-servers.js";
import { runsCommandsInAgentContainer } from "./mcp-tools.js";
import { DOCUMENT_TOOL_PREFIX } from "./documents/tools-setting.js";
import { MAX_TOOL_TEXT_BYTES } from "../providers/coding-proxy/types.js";

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
  if (ISSUE_TRACKER_TOOL_NAMES.has(name)) return `Tool name "${name}" is reserved for the built-in Jira tools.`;
  if (name.startsWith(DOCUMENT_TOOL_PREFIX)) {
    return `Tool names starting with "${DOCUMENT_TOOL_PREFIX}" are reserved for the built-in document tools.`;
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
 * An MCP attachment of `agentId` whose exposed tool name (`<server>__<tool>`) equals `toolName`,
 * or null: the other direction of attach_mcp_server's clash check, for every path that attaches a
 * Tool. Every exposed name contains "__", so any other name needs no lookup.
 */
export async function findSameNamedMcpTool(
  db: Pick<PrismaClient | Prisma.TransactionClient, "agentMcpServer">,
  agentId: string,
  toolName: string,
): Promise<{ serverId: string; serverName: string } | null> {
  if (!toolName.includes("__")) return null;
  const rows = await db.agentMcpServer.findMany({
    where: { agentId },
    select: { allowedTools: true, server: { select: { id: true, name: true } } },
  });
  const hit = rows.find((row) => exposedNames(row.server.name, row.allowedTools).includes(toolName));
  return hit ? { serverId: hit.server.id, serverName: hit.server.name } : null;
}

/** The refusal for a Tool whose name is an exposed MCP tool name on the agent (findSameNamedMcpTool). */
export function sameNamedMcpToolMessage(agentRef: string, toolName: string, serverName: string): string {
  return `Agent "${agentRef}" already has the tool "${toolName}" from MCP server "${serverName}"; detach it or allow a different tool first.`;
}

/**
 * The names Claude Code can be offered: the same rule as an MCP tool's exposed name. A native tool
 * whose name doesn't fit is refused at attach on a Claude Code agent and left out of its runs (#622).
 */
export const NATIVE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The longest native tool description a Claude Code run can carry: the coding proxy's tool-text limit. */
export const NATIVE_TOOL_DESCRIPTION_MAX_CHARS = MAX_TOOL_TEXT_BYTES;

/** The refusal for a name Claude Code can't be offered. */
export function nativeToolNameMessage(name: string): string {
  return `The tool name "${name.slice(0, 80)}" can't be offered to a Claude Code agent: use only letters, digits, "_" and "-", up to 64 characters.`;
}

/** The refusal for a description over the coding proxy's limit. */
export function nativeToolDescriptionMessage(name: string): string {
  return `The tool "${name.slice(0, 80)}" can't be offered to a Claude Code agent: its description is over ${NATIVE_TOOL_DESCRIPTION_MAX_CHARS} characters.`;
}

/**
 * The refusal for attaching a native tool to a coding agent that runs its commands next to the agent
 * (Codex, Gemini CLI).
 */
export const IN_CONTAINER_NATIVE_TOOLS_MESSAGE =
  "Native tools work only on Claude Code coding agents for now: a coding agent that runs its commands next to the agent (Codex, Gemini CLI) can't take them yet.";

/** Why a Claude Code run can't be offered `tool`, or undefined when it can. */
export function claudeCodeToolProblem(tool: Pick<Tool, "name" | "description">): string | undefined {
  if (!NATIVE_TOOL_NAME.test(tool.name)) return nativeToolNameMessage(tool.name);
  if (tool.description.length > NATIVE_TOOL_DESCRIPTION_MAX_CHARS) return nativeToolDescriptionMessage(tool.name);
  return undefined;
}

/**
 * Why `tool` can't be attached to the agent `agentId` because the agent is a coding agent, or undefined
 * (a native agent, or a Claude Code agent the tool fits). A coding agent that runs its commands next to
 * the agent (Codex, Gemini CLI, or one with no coding profile, which counts as one) takes no native
 * tools; a Claude Code agent takes only a tool its runs can be offered. Every attach path asks it: MCP
 * attach_tool, `wardby tool attach` and the importer.
 */
export async function codingAgentAttachProblem(
  db: Pick<PrismaClient | Prisma.TransactionClient, "agent">,
  agentId: string,
  tool: Pick<Tool, "name" | "description">,
): Promise<string | undefined> {
  const agent = await db.agent.findUnique({
    where: { id: agentId },
    select: { kind: true, codingProfile: { select: { provider: true } } },
  });
  if (!agent || agent.kind !== "coding") return undefined;
  if (runsCommandsInAgentContainer(agent.codingProfile?.provider)) return IN_CONTAINER_NATIVE_TOOLS_MESSAGE;
  return claudeCodeToolProblem(tool);
}

/**
 * The names of the agent's attached tools a Claude Code run can't be offered (claudeCodeToolProblem),
 * sorted: update_agent warns with them when an agent becomes Claude Code.
 */
export async function claudeCodeUnofferedTools(
  db: Pick<PrismaClient | Prisma.TransactionClient, "agentTool">,
  agentId: string,
): Promise<string[]> {
  const rows = await db.agentTool.findMany({
    where: { agentId },
    select: { tool: { select: { name: true, description: true } } },
  });
  return [...new Set(rows.filter((row) => claudeCodeToolProblem(row.tool)).map((row) => row.tool.name))].sort();
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
