/**
 * Cross-agent memory reads for sub-agent dispatch. Two deliberately
 * asymmetric built-ins, recognized by name and never
 * sandboxed, the same treatment memory-tools.ts gives the own-memory
 * built-ins:
 *
 * - subagent_memory_get: a parent can always read a declared child's
 *   memory. The AgentSubAgent edge itself is the grant -- no reference
 *   needed each time.
 * - parent_memory_get: a child can read a specific key of its dispatching
 *   parent's memory ONLY when that exact run was handed a grant for that
 *   key at dispatch time (Run.grantedParentMemoryKeys) -- never a standing
 *   allowlist, never the parent's memory in general.
 *
 * Both fail closed: a missing edge or an ungranted key is an error result,
 * never a silent empty read (same discipline as scopeDatastore's shared
 * methods).
 */
import { z } from "zod";
import type { PrismaClient } from "#prisma";
import type { LoadedTool } from "../providers/engine/types.js";
import type { AgentMemoryStore } from "../providers/memory/types.js";

export const SUBAGENT_MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set(["subagent_memory_get", "parent_memory_get"]);

export const SUBAGENT_MEMORY_GET_TOOL: LoadedTool = {
  name: "subagent_memory_get",
  description:
    "Reads one persistent memory entry belonging to one of your declared sub-agents (by its bound name). Returns null if the key doesn't exist.",
  jsonSchema: {
    type: "object",
    properties: { boundName: { type: "string" }, key: { type: "string" } },
    required: ["boundName", "key"],
    additionalProperties: false,
  },
};

export const PARENT_MEMORY_GET_TOOL: LoadedTool = {
  name: "parent_memory_get",
  description:
    "Reads one memory entry from the agent that dispatched you, but only for a key it explicitly granted you access to for this run. Returns an error for any other key.",
  jsonSchema: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
    additionalProperties: false,
  },
};

const SubAgentGetArgs = z.object({ boundName: z.string(), key: z.string() }).strict();
const ParentGetArgs = z.object({ key: z.string() }).strict();

type SubAgentMemoryDb = Pick<PrismaClient, "agentSubAgent" | "run">;

function zodErrorResult(err: z.ZodError): string {
  return JSON.stringify({
    error: "validation_failed",
    message: err.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "),
  });
}

/** `subagent_memory_get` — callable by a parent, gated by the AgentSubAgent edge itself. */
export async function handleSubAgentMemoryGet(
  argsJson: string,
  callingAgentId: string,
  db: SubAgentMemoryDb,
  memory: AgentMemoryStore,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson || "{}");
  } catch (err) {
    return JSON.stringify({
      error: "invalid_arguments_json",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  let args: z.infer<typeof SubAgentGetArgs>;
  try {
    args = SubAgentGetArgs.parse(parsed);
  } catch (err) {
    return zodErrorResult(err as z.ZodError);
  }

  const edge = await db.agentSubAgent.findUnique({
    where: { parentAgentId_boundName: { parentAgentId: callingAgentId, boundName: args.boundName } },
  });
  if (!edge) {
    return JSON.stringify({
      error: "no_such_subagent",
      message: `No sub-agent is bound to name "${args.boundName}".`,
    });
  }
  const content = await memory.get(edge.childAgentId, args.key);
  return JSON.stringify({ content: content ?? null });
}

/**
 * `parent_memory_get` — callable by a dispatched child, gated by this exact
 * run's ephemeral grant. `currentRunId` is the run making the call, not the
 * parent — its own `parentRunId`/`grantedParentMemoryKeys` are looked up
 * fresh rather than threaded through the caller, so this stays correct even
 * if called from deep inside a multi-turn engine loop.
 */
export async function handleParentMemoryGet(
  argsJson: string,
  currentRunId: string,
  db: SubAgentMemoryDb,
  memory: AgentMemoryStore,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson || "{}");
  } catch (err) {
    return JSON.stringify({
      error: "invalid_arguments_json",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  let args: z.infer<typeof ParentGetArgs>;
  try {
    args = ParentGetArgs.parse(parsed);
  } catch (err) {
    return zodErrorResult(err as z.ZodError);
  }

  const run = await db.run.findUniqueOrThrow({
    where: { id: currentRunId },
    select: { parentRunId: true, grantedParentMemoryKeys: true },
  });
  if (!run.parentRunId) {
    return JSON.stringify({ error: "no_parent_run", message: "This run was not dispatched by a parent." });
  }
  if (!run.grantedParentMemoryKeys.includes(args.key)) {
    return JSON.stringify({
      error: "key_not_granted",
      message: `Key "${args.key}" was not granted to this run by its parent.`,
    });
  }
  const parentRun = await db.run.findUniqueOrThrow({ where: { id: run.parentRunId }, select: { agentId: true } });
  const content = await memory.get(parentRun.agentId, args.key);
  return JSON.stringify({ content: content ?? null });
}
