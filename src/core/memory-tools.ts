/**
 * Built-in agent-memory tools (`memory_get`/`memory_set`/`memory_list`/
 * `memory_search`), synthesized by the runner for any agent with
 * `memoryEnabled` — never persisted as `Tool`/`AgentTool` rows and never
 * run through the sandbox, the same "recognized by name, no sandbox"
 * treatment the coding proxy already gives its own built-in tools
 * (`StructuredOutput`, `mcp__reevo_tools__run_command`). No capability
 * scoping is needed here: memory is inherently scoped to the calling
 * agent's own `agentId` and can't reach secrets, the network, or other
 * agents' data.
 */
import { z } from "zod";
import type { LoadedTool } from "../providers/engine/types.js";
import type { AgentMemoryStore } from "../providers/memory/types.js";
import {
  MEMORY_CONTENT_MAX_BYTES,
  MEMORY_KEY_MAX_BYTES,
  MEMORY_MAX_KEYS_PER_AGENT,
  MEMORY_SEARCH_MAX_LIMIT,
} from "../providers/memory/types.js";

export const MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "memory_get",
  "memory_set",
  "memory_list",
  "memory_search",
]);

export const MEMORY_TOOL_DEFS: LoadedTool[] = [
  {
    name: "memory_get",
    description:
      "Reads one persistent memory entry you previously stored with memory_set. Returns null if the key doesn't exist.",
    jsonSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_set",
    description: `Stores or overwrites a persistent memory entry (key up to ${MEMORY_KEY_MAX_BYTES} bytes, content up to ${MEMORY_CONTENT_MAX_BYTES} bytes) that future runs of this agent can read back with memory_get, memory_list, or memory_search.`,
    jsonSchema: {
      type: "object",
      properties: { key: { type: "string" }, content: { type: "string" } },
      required: ["key", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_list",
    description:
      "Lists every memory key you have stored (not their content), so you can decide what's worth reading with memory_get.",
    jsonSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "memory_search",
    description: `Full-text searches your stored memory content and returns the best-matching entries, best first (up to ${MEMORY_SEARCH_MAX_LIMIT} results).`,
    jsonSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

const GetArgs = z.object({ key: z.string() }).strict();
const SetArgs = z.object({ key: z.string(), content: z.string() }).strict();
const ListArgs = z.object({}).strict();
const SearchArgs = z.object({ query: z.string(), limit: z.number().int().positive().optional() }).strict();

const MEMORY_ERROR_MESSAGES: Record<string, string> = {
  memory_key_limit: `key must be 1-${MEMORY_KEY_MAX_BYTES} bytes`,
  memory_content_limit: `content must be at most ${MEMORY_CONTENT_MAX_BYTES} bytes`,
  memory_limit_exceeded: `this agent already has ${MEMORY_MAX_KEYS_PER_AGENT} memory keys; overwrite an existing key or free one up first`,
};

/**
 * Dispatches one built-in memory tool call. Never throws — mirrors
 * runner.ts's `runSandboxTool` contract: a failure becomes a JSON error
 * result fed back to the model as the tool's result, not an engine-halting
 * exception.
 */
export async function handleMemoryTool(
  name: string,
  argsJson: string,
  agentId: string,
  memory: AgentMemoryStore,
): Promise<string> {
  let parsed: unknown;
  try {
    // Some providers stream no JSON delta at all for a zero-parameter tool
    // call, yielding an empty argsJson rather than "{}" (matches
    // runSandboxTool's own handling of this case).
    parsed = JSON.parse(argsJson || "{}");
  } catch (err) {
    return JSON.stringify({
      error: "invalid_arguments_json",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    switch (name) {
      case "memory_get": {
        const { key } = GetArgs.parse(parsed);
        const content = await memory.get(agentId, key);
        return JSON.stringify({ content: content ?? null });
      }
      case "memory_set": {
        const { key, content } = SetArgs.parse(parsed);
        await memory.set(agentId, key, content);
        return JSON.stringify({ ok: true });
      }
      case "memory_list": {
        ListArgs.parse(parsed);
        const keys = await memory.list(agentId);
        return JSON.stringify({ keys });
      }
      case "memory_search": {
        const { query, limit } = SearchArgs.parse(parsed);
        const hits = await memory.search(agentId, query, limit);
        return JSON.stringify({ hits });
      }
      default:
        return JSON.stringify({ error: "unknown_tool", message: `No memory tool named "${name}".` });
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return JSON.stringify({
        error: "validation_failed",
        message: err.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "),
      });
    }
    const code = err instanceof Error ? err.message : "memory_error";
    return JSON.stringify({ error: code, message: MEMORY_ERROR_MESSAGES[code] ?? code });
  }
}
