/**
 * Per-command time limits for Claude Code coding runs: how long one run_command call (the tool
 * runner's shell, src/claude-tool-runner) may take by default, and the most a call may ask for.
 * The operator sets them with CODING_BASH_DEFAULT_TIMEOUT_MS / CODING_BASH_MAX_TIMEOUT_MS
 * (loadClaudeCommandTimeouts, config/providers.ts), named after Claude Code's own
 * BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS. Codex runs do not use them.
 */
import { MAX_CODING_TIMEOUT_SEC } from "./profile.js";

/** Both limits when the operator sets neither: ten minutes. */
export const DEFAULT_CLAUDE_COMMAND_TIMEOUT_MS = 600_000;
/** The bounds an operator value must fall in; the upper one is the longest run timeout. */
export const MIN_CLAUDE_COMMAND_TIMEOUT_MS = 1_000;
export const MAX_CLAUDE_COMMAND_TIMEOUT_MS = MAX_CODING_TIMEOUT_SEC * 1_000;

export interface ClaudeCommandTimeouts {
  defaultMs: number;
  maxMs: number;
}

/** The deployment's limits, each capped at the run's own timeout, so no command outlives its run. */
export function cappedClaudeCommandTimeouts(
  configured: ClaudeCommandTimeouts,
  timeoutSec: number,
): ClaudeCommandTimeouts {
  const cap = timeoutSec * 1_000;
  return { defaultMs: Math.min(configured.defaultMs, cap), maxMs: Math.min(configured.maxMs, cap) };
}
