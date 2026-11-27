import { createRequire } from "node:module";
import type { ClaudeQueryFactory, ClaudeQueryOptions, ClaudeSdkMessage } from "./driver.js";
import {
  GIT_CHECK_TOOL,
  PLAN_LIST_TOOL,
  PLAN_PLACE_TOOL,
  PLAN_READ_TOOL,
  PREPARE_DEPENDENCIES_TOOL,
  RESTORE_PYPI_LOCKFILES_TOOL,
  RESULT_BUNDLE_TOOL,
} from "./tool-socket.js";
import { assertMcpHeaderPlaceholder, WARDBY_MCP_SERVER, WARDBY_MCP_TIMEOUT_MS } from "../coding-worker/mcp-config.js";

const runtimeRequire = createRequire(import.meta.url);
const TOOL_NAME = "mcp__wardby_tools__run_command";
/**
 * The tool runner's internal dependency-cache tool (PREPARE_DEPENDENCIES_TOOL, tool-socket.ts): the
 * worker calls it itself before the query. Disallowed, so it never reaches the model's context;
 * dontAsk plus allowedTools would already deny it, this keeps it out of the tool list as well.
 */
const PREPARE_DEPENDENCIES_TOOL_NAME = `mcp__wardby_tools__${PREPARE_DEPENDENCIES_TOOL}`;
/** The tool runner's git and plan tools (tool-socket.ts), which the worker alone calls: disallowed the same way. */
const WORKER_TOOL_NAMES = [
  GIT_CHECK_TOOL,
  RESULT_BUNDLE_TOOL,
  PLAN_PLACE_TOOL,
  PLAN_LIST_TOOL,
  PLAN_READ_TOOL,
  RESTORE_PYPI_LOCKFILES_TOOL,
].map((tool) => `mcp__wardby_tools__${tool}`);
/**
 * Claude Code's own wall-clock limit on one wardby_tools call (its per-server MCP `timeout`, which
 * also sets the idle limit): above the longest command the tool runner can be set to run
 * (MAX_CLAUDE_COMMAND_TIMEOUT_MS, src/coding/command-timeouts.ts; a test keeps them in step) plus
 * its kill grace, so the tool runner's own per-command limit is the one that stops a command.
 */
export const WARDBY_TOOLS_TIMEOUT_MS = 7_200_000 + 60_000;

const WORKFLOW_TOOL = "Workflow";
const WORKFLOW_REFUSED =
  "Wardby runs only this run's own workflow, once: call Workflow with just its name, and nothing else.";

const AGENT_TOOL = "Agent";
/**
 * The Agent guard's hook matcher: the pinned CLI also accepts the tool's legacy name, Task (it runs it
 * as Agent). The matcher takes alternation; both names are listed so the guard cannot be bypassed.
 */
const AGENT_HOOK_MATCHER = "Agent|Task";
/** The fields of Claude Code's Agent input (pinned SDK AgentInput) a sub-agent call may keep. */
const AGENT_KEPT_FIELDS = ["description", "prompt", "subagent_type"] as const;
const AGENT_REFUSED = "Start a sub-agent with a description and a prompt.";

type PreToolUseResult = {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision?: "allow" | "deny";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
};

/**
 * The PreToolUse guard on a workflow run's Workflow tool (#582). It allows exactly one call, for the
 * run's own workflow name, with only `name` (and `args`, which it replaces) in the input, and puts
 * Wardby's args in it, so the model never copies them. Everything else is denied: a second call,
 * another name, an inline `script`, a `scriptPath`, `remote`, `resumeFromRunId`. In-process (an
 * SDK hook, not a settings file), so repository settings can't remove it.
 */
export function workflowGuard(workflow: {
  name: string;
  args: unknown;
}): (input: { tool_input?: unknown }) => Promise<PreToolUseResult> {
  let launched = false;
  return async (input) => {
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const keys = Object.keys(toolInput);
    const allowed =
      !launched && toolInput.name === workflow.name && keys.every((key) => key === "name" || key === "args");
    if (!allowed) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: WORKFLOW_REFUSED,
        },
      };
    }
    launched = true;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { name: workflow.name, args: workflow.args },
      },
    };
  };
}

/**
 * The PreToolUse guard on Claude Code's Agent tool, on a run with sub-agents on. It keeps the
 * description, prompt and sub-agent type, and runs the sub-agent in the foreground. It drops `model`
 * (the run's model is the only one the coding proxy allows; CLAUDE_CODE_SUBAGENT_MODEL pins it),
 * `isolation` (a git worktree changes the run's Git metadata; `remote` leaves the sandbox), and the
 * team/name/mode fields. In-process (an SDK hook), so repository settings can't remove it.
 */
export function agentGuard(): (input: { tool_input?: unknown }) => Promise<PreToolUseResult> {
  return async (input) => {
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    if (typeof toolInput.prompt !== "string" || toolInput.prompt.length === 0) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: AGENT_REFUSED,
        },
      };
    }
    const kept = Object.fromEntries(
      AGENT_KEPT_FIELDS.filter((key) => typeof toolInput[key] === "string").map((key) => [key, toolInput[key]]),
    );
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...kept, run_in_background: false },
      },
    };
  };
}

export function buildClaudeSdkOptions(config: ClaudeQueryOptions): Record<string, unknown> {
  // Claude Code passes the MCP config on its own command line: in header mode (Substrate) only the
  // gateway's placeholder may ever go there.
  if (config.mcp) assertMcpHeaderPlaceholder(config.mcp.token, config.mcp.header);
  const abortController = new AbortController();
  if (config.signal.aborted) abortController.abort();
  else config.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  const context = config.contextDirectory;
  const skills = context !== null && config.skills;
  const subAgents = config.subAgents;
  const preToolUse = [
    ...(config.workflow ? [{ matcher: WORKFLOW_TOOL, hooks: [workflowGuard(config.workflow)] }] : []),
    ...(subAgents ? [{ matcher: AGENT_HOOK_MATCHER, hooks: [agentGuard()] }] : []),
  ];
  return {
    abortController,
    // Native mode with repo context: Claude Code loads CLAUDE.md (and skills) from a directory the
    // worker wrote (context.ts), which holds only allowlisted Markdown files: no settings, hooks,
    // or MCP config. Otherwise an empty directory and no setting sources.
    cwd: context ?? "/opt/wardby/empty-workspace",
    model: config.model,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.budgetUsd,
    tools: [
      ...(skills ? ["Skill"] : []),
      ...(config.workflow ? [WORKFLOW_TOOL] : []),
      ...(subAgents ? [AGENT_TOOL] : []),
    ],
    // On a run with MCP tools, the server-level rule allows every tool of wardby_mcp: the proxy and
    // the gateway allow only the run's pinned tools, and dontAsk denies anything not allowed here.
    allowedTools: [
      TOOL_NAME,
      ...(skills ? ["Skill"] : []),
      ...(config.workflow ? [WORKFLOW_TOOL] : []),
      ...(subAgents ? [AGENT_TOOL] : []),
      ...(config.mcp ? [`mcp__${WARDBY_MCP_SERVER}`] : []),
    ],
    disallowedTools: [PREPARE_DEPENDENCIES_TOOL_NAME, ...WORKER_TOOL_NAMES],
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
      // this container, which runs no model commands); never in an environment. Header mode
      // (Substrate) sends the placeholder in its own header and no Authorization.
      ...(config.mcp
        ? {
            [WARDBY_MCP_SERVER]: {
              type: "http",
              url: config.mcp.url,
              headers: config.mcp.header
                ? { [config.mcp.header]: config.mcp.token }
                : { Authorization: `Bearer ${config.mcp.token}` },
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
    // In-process guards only: the Workflow guard on a workflow run (#582), the Agent guard with sub-agents.
    ...(preToolUse.length > 0 ? { hooks: { PreToolUse: preToolUse } } : {}),
    systemPrompt: config.developerInstructions,
    outputFormat: { type: "json_schema", schema: config.outputSchema },
    permissionMode: "dontAsk",
    // Only a session-resume run keeps the session file (under CLAUDE_CONFIG_DIR) for transcript capture.
    persistSession: config.persistSession,
    // Only on a warm Substrate follow-up round: continue the previous round's conversation.
    ...(config.resumeSessionId ? { resume: config.resumeSessionId } : {}),
    // Sub-agents use the run's model: the coding proxy allows no other.
    env: subAgents ? { ...config.environment, CLAUDE_CODE_SUBAGENT_MODEL: config.model } : config.environment,
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
