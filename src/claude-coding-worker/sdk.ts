import { createRequire } from "node:module";
import type { ClaudeQueryFactory, ClaudeQueryOptions, ClaudeSdkMessage } from "./driver.js";

const runtimeRequire = createRequire(import.meta.url);
const TOOL_NAME = "mcp__wardby_tools__run_command";

export function buildClaudeSdkOptions(config: ClaudeQueryOptions): Record<string, unknown> {
  const abortController = new AbortController();
  if (config.signal.aborted) abortController.abort();
  else config.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  const context = config.contextDirectory;
  const skills = context !== null && config.skills;
  return {
    abortController,
    // Native mode with repo context: Claude Code loads CLAUDE.md (and skills) from a directory the
    // worker wrote from the trusted input; it holds no settings, hooks, or MCP config, so "project"
    // can load nothing else. Otherwise an empty directory and no setting sources.
    cwd: context ?? "/opt/wardby/empty-workspace",
    model: config.model,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.budgetUsd,
    tools: skills ? ["Skill"] : [],
    allowedTools: skills ? [TOOL_NAME, "Skill"] : [TOOL_NAME],
    strictMcpConfig: true,
    mcpServers: {
      wardby_tools: {
        command: "node",
        args: ["/opt/wardby/claude-coding-worker/tool-relay.js"],
        env: config.relayEnvironment,
        timeout: 120_000,
        alwaysLoad: true,
      },
    },
    settingSources: context ? ["project"] : [],
    systemPrompt: config.developerInstructions,
    outputFormat: { type: "json_schema", schema: config.outputSchema },
    permissionMode: "dontAsk",
    persistSession: false,
    env: config.environment,
  };
}

/** Loads the pinned SDK from the worker image's private dependency directory. */
export const createClaudeSdkQuery: ClaudeQueryFactory = (config) => {
  const sdk = runtimeRequire("@anthropic-ai/claude-agent-sdk") as {
    query(input: { prompt: string; options: Record<string, unknown> }): AsyncIterable<ClaudeSdkMessage>;
  };
  return sdk.query({
    prompt: config.prompt,
    options: buildClaudeSdkOptions(config),
  });
};
