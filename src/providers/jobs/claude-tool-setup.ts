/**
 * What Claude Code's tool runner (the credential-free container that runs commands in the
 * repository) needs from the trusted launcher: the package-registry settings every Codex shell
 * gets, built from the run's registry-only token (deriveRegistryToken, never the capability), and
 * the run's service test variables, and whether the run's dependency cache is on. Delivered as the
 * WARDBY_TOOL_SETUP environment variable (CLAUDE_TOOL_SETUP_ENV, docker-isolation.ts; a test keeps it
 * equal to the tool runner's TOOL_SETUP_ENV): a Kubernetes Secret key, or `docker create --env NAME`
 * with the value in the CLI's own environment.
 */
import { serviceEnvironment } from "../../coding-worker/driver.js";
import { registryWorkerSetup } from "../../coding/registry/worker-config.js";
import { CODING_PROXY_ALIAS, CODING_PROXY_PORT } from "./docker-isolation.js";
import type { JobSpec } from "./types.js";

/** Where the tool runner mounts the repository; the registry's config files live under its .cache. */
const TOOL_WORKSPACE = "/workspace";

/**
 * The tool runner's parseToolSetup bounds (src/claude-tool-runner/command.mjs; a test keeps them
 * equal). A setup past any of them would stop the tool runner before it reports ready, so the
 * launcher refuses to build one instead.
 */
export const CLAUDE_TOOL_SETUP_LIMITS = {
  maxEnvEntries: 1024,
  maxEnvValueBytes: 4096,
  maxFiles: 8,
  maxFileBytes: 16 * 1024,
  maxSetupBytes: 96 * 1024,
} as const;

export interface ClaudeToolSetup {
  schemaVersion: 1;
  env: Record<string, string>;
  files: { path: string; content: string; mode: number }[];
  /** Present only when the run's dependency cache is on, so older tool runners see an unchanged setup. */
  dependencyCache?: true;
  /** With dependencyCache only: the workspace volume size (limits.diskMb) the cache must stay inside. */
  diskMb?: number;
  /** The run's run_command time limits (JobSpec.commandTimeouts); an older tool runner ignores the key. */
  commandTimeouts?: { defaultMs: number; maxMs: number };
}

export function claudeToolSetup(spec: JobSpec, capability: string): string {
  if (spec.provider !== "claude-code") throw new Error("claude_tool_setup_provider");
  const registry = registryWorkerSetup({
    proxyBaseUrl: `http://${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}`,
    capability,
    cacheRoot: `${TOOL_WORKSPACE}/.cache`,
  });
  const setup: ClaudeToolSetup = {
    schemaVersion: 1,
    // Same precedence as the Codex driver: the registry's own settings win over a service's.
    env: { ...serviceEnvironment(spec.services), ...registry.env },
    files: registry.files,
    ...(spec.dependencyCache ? { dependencyCache: true, diskMb: spec.limits.diskMb } : {}),
    ...(spec.commandTimeouts ? { commandTimeouts: { ...spec.commandTimeouts } } : {}),
  };
  const raw = JSON.stringify(setup);
  const limits = CLAUDE_TOOL_SETUP_LIMITS;
  const entries = Object.values(setup.env);
  if (
    entries.length > limits.maxEnvEntries ||
    entries.some((value) => Buffer.byteLength(value) > limits.maxEnvValueBytes) ||
    setup.files.length > limits.maxFiles ||
    setup.files.some((file) => Buffer.byteLength(file.content) > limits.maxFileBytes) ||
    Buffer.byteLength(raw) > limits.maxSetupBytes
  ) {
    throw new Error("claude_tool_setup_too_large");
  }
  return raw;
}
