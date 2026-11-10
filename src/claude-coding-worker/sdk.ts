import { createRequire } from "node:module";
import type { ClaudeQueryFactory, ClaudeQueryOptions, ClaudeSdkMessage } from "./driver.js";
import { PREPARE_DEPENDENCIES_TOOL } from "./tool-socket.js";
import { WARDBY_MCP_SERVER, WARDBY_MCP_TIMEOUT_MS } from "../coding-worker/mcp-config.js";

const runtimeRequire = createRequire(import.meta.url);
const TOOL_NAME = "mcp__wardby_tools__run_command";
/**
 * The tool runner's internal dependency-cache tool (PREPARE_DEPENDENCIES_TOOL, tool-socket.ts): the
 * worker calls it itself before the query. Disallowed, so it never reaches the model's context;
 * dontAsk plus allowedTools would already deny it, this keeps it out of the tool list as well.
 */
const PREPARE_DEPENDENCIES_TOOL_NAME = `mcp__wardby_tools__${PREPARE_DEPENDENCIES_TOOL}`;
/**
 * Claude Code's own wall-clock limit on one wardby_tools call (its per-server MCP `timeout`, which
 * also sets the idle limit): above the longest command the tool runner can be set to run
 * (MAX_CLAUDE_COMMAND_TIMEOUT_MS, src/coding/command-timeouts.ts; a test keeps them in step) plus
 * its kill grace, so the tool runner's own per-command limit is the one that stops a command.
 */
export const WARDBY_TOOLS_TIMEOUT_MS = 7_200_000 + 60_000;

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
    // On a run with MCP tools, the server-level rule allows every tool of wardby_mcp: the proxy and
    // the gateway allow only the run's pinned tools, and dontAsk denies anything not allowed here.
    allowedTools: [TOOL_NAME, ...(skills ? ["Skill"] : []), ...(config.mcp ? [`mcp__${WARDBY_MCP_SERVER}`] : [])],
    disallowedTools: [PREPARE_DEPENDENCIES_TOOL_NAME],
    strictMcpConfig: true,
    mcpServers: {
      wardby_tools: {
        command: "node",
        args: ["/opt/wardby/claude-coding-worker/tool-relay.js"],
        env: config.relayEnvironment,
        timeout: WARDBY_TOOLS_TIMEOUT_MS,
        alwaysLoad: true,
      },
      // The token rides only in this header (Claude Code passes it on its own command line, inside
      // this container, which runs no model commands); never in an environment.
      ...(config.mcp
        ? {
            [WARDBY_MCP_SERVER]: {
              type: "http",
              url: config.mcp.url,
              headers: { Authorization: `Bearer ${config.mcp.token}` },
              alwaysLoad: true,
              timeout: WARDBY_MCP_TIMEOUT_MS,
            },
          }
        : {}),
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
