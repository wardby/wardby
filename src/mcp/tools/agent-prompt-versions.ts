/**
 * list/get/restore for an agent's system-prompt history (src/core/agent-prompt-versions.ts).
 * Secrets: list and restore output carry no prompt text; get returns it masked by exact secret value
 * and fails closed when the agent's secrets cannot be loaded.
 */
import { z } from "zod";
import {
  DEFAULT_PROMPT_VERSIONS_PAGE,
  listPromptVersions,
  MAX_PROMPT_VERSIONS_PAGE,
  readPromptVersion,
  restorePromptVersion,
} from "../../core/agent-prompt-versions.js";
import { assertAgentAccess } from "../auth/access.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { warmFingerprintChanged } from "./agents.js";
import { removeRetainedRounds } from "./retained-rounds.js";
import { textResult } from "./text-result.js";

const listArgs = z
  .object({
    agentId: z.string().min(1).max(128),
    limit: z.number().int().min(1).max(MAX_PROMPT_VERSIONS_PAGE).optional(),
  })
  .strict();
const getArgs = z.object({ agentId: z.string().min(1).max(128), versionNumber: z.number().int().min(1) }).strict();
const restoreArgs = getArgs.extend({ baseNumber: z.number().int().min(1) }).strict();

async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error.message === "agent_prompt_version_not_found") throw new McpError(404, error.message);
    if (error.message === "agent_prompt_version_conflict") {
      throw new McpError(
        409,
        `${error.message}: the prompt changed since you listed it; call list_agent_prompt_versions again`,
      );
    }
    if (error.message === "agent_prompt_version_is_latest") throw new McpError(409, error.message);
    throw error;
  }
}

export function registerAgentPromptVersionTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "list_agent_prompt_versions",
    scope: "agents:read",
    description:
      "Lists an agent's system-prompt history, newest first: number, how it was made (via), who, the optional summary, " +
      "size and time; never the text (read one with get_agent_prompt_version). Every prompt change is kept.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentId: { type: "string" },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_PROMPT_VERSIONS_PAGE,
          description: `Default ${DEFAULT_PROMPT_VERSIONS_PAGE}.`,
        },
      },
      required: ["agentId"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = listArgs.parse(rawArgs);
      const agent = await ctx.db.agent.findUnique({ where: { id: args.agentId } });
      await assertAgentAccess(ctx, agent, args.agentId, "read");
      return textResult({ versions: await listPromptVersions(ctx.db, args.agentId, args.limit) });
    },
  });

  mcp.registerTool({
    name: "get_agent_prompt_version",
    scope: "agents:read",
    description:
      "Reads one version of an agent's system prompt. The text is in systemPromptText with the agent's secret values " +
      "masked, so it can differ from what restore_agent_prompt_version would put back (restore copies the stored text as is).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { agentId: { type: "string" }, versionNumber: { type: "integer", minimum: 1 } },
      required: ["agentId", "versionNumber"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = getArgs.parse(rawArgs);
      const agent = await ctx.db.agent.findUnique({ where: { id: args.agentId } });
      await assertAgentAccess(ctx, agent, args.agentId, "read");
      const version = await mapped(() =>
        readPromptVersion(ctx.db, ctx.providers.secrets, args.agentId, args.versionNumber),
      );
      return textResult(version);
    },
  });

  mcp.registerTool({
    name: "restore_agent_prompt_version",
    scope: "agents:write",
    description:
      "Restores an earlier system prompt of an agent you can write: it becomes the live prompt AND a NEW version " +
      '(summary "Restored v<N>"); nothing is deleted. Give baseNumber (required: the latest version you saw); it refuses with ' +
      "agent_prompt_version_conflict if the prompt changed since. Refuses with agent_prompt_version_is_latest when the live prompt already has that text. " +
      "The restored text is copied as stored (not masked); the reply has numbers only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentId: { type: "string" },
        versionNumber: { type: "integer", minimum: 1 },
        baseNumber: { type: "integer", minimum: 1 },
      },
      required: ["agentId", "versionNumber", "baseNumber"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = restoreArgs.parse(rawArgs);
      const before = await ctx.db.agent.findUnique({ where: { id: args.agentId }, include: { codingProfile: true } });
      await assertAgentAccess(ctx, before, args.agentId, "write");
      const out = await mapped(() =>
        restorePromptVersion(ctx.db, {
          agentId: args.agentId,
          number: args.versionNumber,
          baseNumber: args.baseNumber,
          createdById: ctx.principal.id,
        }),
      );
      if (warmFingerprintChanged(before!, { ...before!, systemPrompt: out.after })) {
        await removeRetainedRounds(ctx, args.agentId);
      }
      return textResult({ number: out.number, restored: args.versionNumber });
    },
  });
}
