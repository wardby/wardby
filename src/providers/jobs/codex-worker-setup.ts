/**
 * What a Codex run's Substrate bridge needs from the trusted launcher (the single-actor shape): the
 * run's registry-only token (deriveRegistryToken, never the capability), which the bridge hands the
 * unchanged Codex worker as WARDBY_REGISTRY_TOKEN, and what the workspace upload leaves out. Staged
 * as BLOB.toolSetup(token) and served by the coding proxy to the workspace holder (here the agent
 * actor). The bridge parses exactly this shape. On a run with extra repositories, `repositories`
 * (HolderSetupRepository, shared with the Claude Code tool setup) tells the holder's bridge which
 * /repos/<name> folders to seed and collect: names and access only, never a host path or a ref.
 */
import { collectExclusions, type CollectExclusions } from "../../coding/collect-exclude.js";
import { deriveRegistryToken } from "../../coding/registry/token.js";
import { REPOSITORY_MOUNT_ROOT } from "./storage-init.js";
import type { JobSpec } from "./types.js";

/** One extra repository as the holder bridge's setup lists it (never a host path or a ref). */
export interface HolderSetupRepository {
  name: string;
  access: "read" | "write";
  /** A write extra whose /repos/<name> is in the input's gitHistory.repositories. */
  collectResultBundle?: true;
}

/**
 * The spec's extras in spec order, or undefined for a spec without any. `historyPaths` are the
 * staged input's gitHistory.repositories paths (inputGitHistory); only a write extra collects a
 * result bundle, since a read one is never collected.
 */
export function holderSetupRepositories(
  spec: Pick<JobSpec, "repositories">,
  historyPaths: ReadonlySet<string>,
): HolderSetupRepository[] | undefined {
  if (spec.repositories === undefined) return undefined;
  return spec.repositories.map(({ name, access }) => ({
    name,
    access,
    ...(access === "write" && historyPaths.has(`${REPOSITORY_MOUNT_ROOT}/${name}`)
      ? { collectResultBundle: true as const }
      : {}),
  }));
}

/** One service's start script, as the holder bridge's setup lists it (in servicesInOrder order). */
export interface HolderSetupService {
  name: string;
  /** serviceStartScript(service): carries serviceEnv and the commands; never logged. */
  script: string;
}

export interface CodexWorkerSetup {
  schemaVersion: 1;
  /** deriveRegistryToken(capability): the run's registry-only token. Never the capability. */
  registryToken: string;
  collectExclude: CollectExclusions;
  /** Present (true) only on a git-history run. */
  collectResultBundle?: true;
  /** Present only on a run with extra repositories. */
  repositories?: HolderSetupRepository[];
  /** Present only on a run with services: their start scripts, by name order. */
  services?: HolderSetupService[];
  /** Present exactly with `services`: servicesWaitMs(...), the bridge's bound for all of them. */
  servicesWaitMs?: number;
}

/** Same bound as the Claude tool setup's whole document (CLAUDE_TOOL_SETUP_LIMITS.maxSetupBytes). */
export const CODEX_WORKER_SETUP_LIMITS = { maxSetupBytes: 96 * 1024 } as const;

/**
 * JSON for BLOB.toolSetup(token). Throws "codex_worker_setup_provider" for a non-Codex spec,
 * "codex_worker_setup_too_large" past the bound.
 */
export function codexWorkerSetup(
  spec: JobSpec,
  capability: string,
  options: {
    collectResultBundle: boolean;
    repositories?: HolderSetupRepository[];
    services?: { entries: HolderSetupService[]; waitMs: number };
  },
): string {
  if (spec.provider !== "codex") throw new Error("codex_worker_setup_provider");
  const setup: CodexWorkerSetup = {
    schemaVersion: 1,
    registryToken: deriveRegistryToken(capability),
    // The Kubernetes launcher's default for a spec without exclusions: the built-in names.
    collectExclude: spec.collectExclude ?? collectExclusions([]),
    ...(options.collectResultBundle ? { collectResultBundle: true as const } : {}),
    // Rebuilt field by field, so nothing but a name, an access and the bundle flag is ever written.
    ...(options.repositories
      ? {
          repositories: options.repositories.map(({ name, access, collectResultBundle }) => ({
            name,
            access,
            ...(collectResultBundle ? { collectResultBundle: true as const } : {}),
          })),
        }
      : {}),
    // Rebuilt field by field: only a name and its script. The scripts carry serviceEnv (never logged).
    ...(options.services
      ? {
          services: options.services.entries.map(({ name, script }) => ({ name, script })),
          servicesWaitMs: options.services.waitMs,
        }
      : {}),
  };
  const raw = JSON.stringify(setup);
  if (Buffer.byteLength(raw) > CODEX_WORKER_SETUP_LIMITS.maxSetupBytes) {
    throw new Error("codex_worker_setup_too_large");
  }
  return raw;
}
