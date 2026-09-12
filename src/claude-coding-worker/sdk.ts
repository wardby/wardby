import { createRequire } from "node:module";
import type { ClaudeQueryFactory, ClaudeQueryOptions, ClaudeSdkMessage } from "./driver.js";

const runtimeRequire = createRequire(import.meta.url);
const TOOL_NAME = "mcp__reevo_tools__run_command";

export function buildClaudeSdkOptions(config: ClaudeQueryOptions): Record<string, unknown> {
  const abortController = new AbortController();
  if (config.signal.aborted) abortController.abort();
  else config.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  return {
    abortController,
    cwd: "/opt/reevo/empty-workspace",
    model: config.model,
    maxTurns: 16,
    maxBudgetUsd: config.budgetUsd,
    tools: [],
    allowedTools: [TOOL_NAME],
    strictMcpConfig: true,
    mcpServers: {
      reevo_tools: {
        command: "node",
        args: ["/opt/reevo/claude-coding-worker/tool-relay.js"],
        env: config.relayEnvironment,
        timeout: 120_000,
        alwaysLoad: true,
      },
    },
    settingSources: [],
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
