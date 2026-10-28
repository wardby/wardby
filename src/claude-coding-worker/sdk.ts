import { createRequire } from "node:module";
import type { ClaudeQueryFactory, ClaudeQueryOptions, ClaudeSdkMessage } from "./driver.js";
import { PREPARE_DEPENDENCIES_TOOL } from "./tool-socket.js";

const runtimeRequire = createRequire(import.meta.url);
const TOOL_NAME = "mcp__wardby_tools__run_command";
/**
 * The tool runner's internal dependency-cache tool (PREPARE_DEPENDENCIES_TOOL, tool-socket.ts): the
 * worker calls it itself before the query. Disallowed, so it never reaches the model's context;
 * dontAsk plus allowedTools would already deny it, this keeps it out of the tool list as well.
 */
const PREPARE_DEPENDENCIES_TOOL_NAME = `mcp__wardby_tools__${PREPARE_DEPENDENCIES_TOOL}`;

export function buildClaudeSdkOptions(config: ClaudeQueryOptions): Record<string, unknown> {
  const abortController = new AbortController();
  if (config.signal.aborted) abortController.abort();
  else config.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  const context = config.contextDirectory;
  const skills = context !== null && config.skills;
  return {
    abortController,
    // Native mode with repo context: Claude Code loads CLAUDE.md (and skills) from a directory the
    // worker wrote (context.ts), which holds only allowlisted Markdown files: no settings, hooks,
    // or MCP config. Otherwise an empty directory and no setting sources.
    cwd: context ?? "/opt/wardby/empty-workspace",
    model: config.model,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.budgetUsd,
    tools: skills ? ["Skill"] : [],
    allowedTools: skills ? [TOOL_NAME, "Skill"] : [TOOL_NAME],
    disallowedTools: [PREPARE_DEPENDENCIES_TOOL_NAME],
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
    // Second layer for native mode: only hooks from managed settings may run, and there are none, so
    // a hook in any project file (settings or SKILL.md frontmatter) is ignored. This SDK's
    // managedSettings keeps only restrictive keys; allowManagedHooksOnly is the hook lock it accepts.
    ...(context ? { managedSettings: { allowManagedHooksOnly: true } } : {}),
    systemPrompt: config.developerInstructions,
    outputFormat: { type: "json_schema", schema: config.outputSchema },
    permissionMode: "dontAsk",
    // Only a session-resume run keeps the session file (under CLAUDE_CONFIG_DIR) for transcript capture.
    persistSession: config.persistSession,
    env: config.environment,
    // Only on a traced run; otherwise the SDK's default handling is unchanged.
    ...(config.stderr ? { stderr: config.stderr } : {}),
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
