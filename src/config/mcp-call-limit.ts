/**
 * WARDBY_MCP_MAX_CALLS_PER_RUN: the most remote MCP tool calls one coding run may make
 * (docs/security-deployment.md, "Remote MCP servers"). Default 100. Codex has no turn limit, so
 * this is what bounds a coding run's MCP calls. Read on every call; checked at start-up so a bad
 * value stops the process, not every run.
 */
export const DEFAULT_MCP_MAX_CALLS_PER_RUN = 100;

export function loadMcpMaxCallsPerRun(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.WARDBY_MCP_MAX_CALLS_PER_RUN ?? "").trim();
  if (raw === "") return DEFAULT_MCP_MAX_CALLS_PER_RUN;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  // At most int4: the counter is a PostgreSQL integer.
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(`WARDBY_MCP_MAX_CALLS_PER_RUN must be a positive whole number (got "${raw}").`);
  }
  return value;
}
