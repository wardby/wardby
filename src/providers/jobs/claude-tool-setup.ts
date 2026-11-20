/**
 * What Claude Code's tool runner (the credential-free container that runs commands in the
 * repository) needs from the trusted launcher: the package-registry settings every Codex shell
 * gets, built from the run's registry-only token (deriveRegistryToken, never the capability), the
 * run's service test variables, whether the run's dependency cache is on, and whether the
 * workspace is a resumed one (a Substrate warm round). Delivered as the WARDBY_TOOL_SETUP
 * environment variable (CLAUDE_TOOL_SETUP_ENV, docker-isolation.ts; a test keeps it equal to the
 * tool runner's TOOL_SETUP_ENV): a Kubernetes Secret key, or `docker create --env NAME` with the
 * value in the CLI's own environment.
 */
import { serviceEnvironment } from "../../coding-worker/driver.js";
import { configuredRegistryAdapters } from "../../coding/registry/adapters.js";
import { deriveRegistryToken } from "../../coding/registry/token.js";
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
  /**
   * With dependencyCache only: the workspace is resumed from an earlier round (Substrate warm
   * rounds), so the tool runner skips the cache (`reused_workspace`). The proxy refuses it anyway.
   */
  workspaceReused?: true;
}

export interface ClaudeToolSetupOptions {
  /**
   * The coding proxy as the tool runner reaches it. Default: the Docker/Kubernetes host alias
   * (`http://wardby-proxy:8787`); the Substrate launcher passes its configured proxy host and port.
   */
  proxyBaseUrl?: string;
  /** The Substrate launcher's adopt path. Ignored unless the spec has dependencyCache. */
  workspaceReused?: boolean;
  /** Where the registry settings are read from (default process.env). */
  env?: NodeJS.ProcessEnv;
}

export function claudeToolSetup(spec: JobSpec, capability: string, options: ClaudeToolSetupOptions = {}): string {
  if (spec.provider !== "claude-code") throw new Error("claude_tool_setup_provider");
  const registry = registryWorkerSetup({
    proxyBaseUrl: options.proxyBaseUrl ?? `http://${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}`,
    token: deriveRegistryToken(capability),
    cacheRoot: `${TOOL_WORKSPACE}/.cache`,
    // Only the non-secret JFrog settings are read; the upstream credential is the proxy's alone.
    adapters: configuredRegistryAdapters(options.env ?? process.env),
  });
  const setup: ClaudeToolSetup = {
    schemaVersion: 1,
    // Same precedence as the Codex driver: the registry's own settings win over a service's.
    env: { ...serviceEnvironment(spec.services), ...registry.env },
    files: registry.files,
    ...(spec.dependencyCache
      ? {
          dependencyCache: true,
          diskMb: spec.limits.diskMb,
          ...(options.workspaceReused ? { workspaceReused: true as const } : {}),
        }
      : {}),
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
