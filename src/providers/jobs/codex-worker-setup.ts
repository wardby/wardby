/**
 * What a Codex run's Substrate bridge needs from the trusted launcher (the single-actor shape): the
 * run's registry-only token (deriveRegistryToken, never the capability), which the bridge hands the
 * unchanged Codex worker as WARDBY_REGISTRY_TOKEN, and what the workspace upload leaves out. Staged
 * as BLOB.toolSetup(token) and served by the coding proxy to the workspace holder (here the agent
 * actor). The bridge parses exactly this shape.
 */
import { collectExclusions, type CollectExclusions } from "../../coding/collect-exclude.js";
import { deriveRegistryToken } from "../../coding/registry/token.js";
import type { JobSpec } from "./types.js";

export interface CodexWorkerSetup {
  schemaVersion: 1;
  /** deriveRegistryToken(capability): the run's registry-only token. Never the capability. */
  registryToken: string;
  collectExclude: CollectExclusions;
  /** Present (true) only on a git-history run. */
  collectResultBundle?: true;
}

/** Same bound as the Claude tool setup's whole document (CLAUDE_TOOL_SETUP_LIMITS.maxSetupBytes). */
export const CODEX_WORKER_SETUP_LIMITS = { maxSetupBytes: 96 * 1024 } as const;

/**
 * JSON for BLOB.toolSetup(token). Throws "codex_worker_setup_provider" for a non-Codex spec,
 * "codex_worker_setup_too_large" past the bound.
 */
export function codexWorkerSetup(spec: JobSpec, capability: string, options: { collectResultBundle: boolean }): string {
  if (spec.provider !== "codex") throw new Error("codex_worker_setup_provider");
  const setup: CodexWorkerSetup = {
    schemaVersion: 1,
    registryToken: deriveRegistryToken(capability),
    // The Kubernetes launcher's default for a spec without exclusions: the built-in names.
    collectExclude: spec.collectExclude ?? collectExclusions([]),
    ...(options.collectResultBundle ? { collectResultBundle: true as const } : {}),
  };
  const raw = JSON.stringify(setup);
  if (Buffer.byteLength(raw) > CODEX_WORKER_SETUP_LIMITS.maxSetupBytes) {
    throw new Error("codex_worker_setup_too_large");
  }
  return raw;
}
