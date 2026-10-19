// Types for dependency-cache.mjs, so the driver and the tool runner's TypeScript callers can import it.

export type PrepareOutcome = "hit" | "nearest" | "cold" | "skipped" | "refused";

export interface PrepareResult {
  readonly result: PrepareOutcome;
  /** The proxy's opaque snapshot key for this run's lockfile (hit, nearest, cold). */
  readonly key?: string;
  /** Archive bytes downloaded (hit) or uploaded (nearest, cold). */
  readonly sizeBytes?: number;
  readonly restoreMs?: number;
  readonly installMs?: number;
  /** A stable code, never raw output: why it was skipped or refused, or why a cold tree was not snapshotted. */
  readonly reason?: string;
}

/** `npm rebuild` after the seal (hit, nearest and cold only): `skipped` when the lockfile lists no install
 *  script under node_modules/; `unsealed` when the proxy did not confirm the seal, so no third-party
 *  script ran while the upload window might still be open. */
export type RebuildOutcome = "ok" | "failed" | "timeout" | "skipped" | "unsealed";

export interface ProjectResult extends PrepareResult {
  /** The project folder relative to the workspace: "." for the root, else e.g. "app" or "web/client". */
  readonly path: string;
  readonly rebuild?: RebuildOutcome;
}

/** One entry per discovered project, root first then by path. A repo with no
 *  lockfile has one entry: `{ path: ".", result: "skipped", reason: "no_lockfile" }`.
 *  Skipped up front: `workspace_member`, `too_many_projects`. */
export interface PrepareDependenciesResult {
  readonly projects: readonly ProjectResult[];
  /** Set (with `projects: []`) only when the projects could not be planned at all: `internal_error` or `timeout`. */
  readonly reason?: string;
}

export interface DependencyCacheTimeouts {
  /** Each small proxy call (lookup, seal): 120 s. */
  readonly httpMs: number;
  /** The lockfile plan request (a cold proxy checks every package first): 10 min, still bounded by `totalMs`. */
  readonly planMs: number;
  /** Pause before sending a plan again after the proxy's 503 `wardby_plan_incomplete` (it resumes where it stopped). */
  readonly planRetryPauseMs: number;
  readonly transferMs: number;
  readonly transferMsPerMiB: number;
  readonly installMs: number;
  /** Packing a snapshot: 5 min, plus `tarMsPerMiB` (0.5 s) per MiB of the installed tree; never past the upload deadline. */
  readonly tarMs: number;
  readonly tarMsPerMiB: number;
  readonly totalMs: number;
  readonly killGraceMs: number;
  readonly settleMs: number;
  /** Each `npm rebuild` after the seal. */
  readonly rebuildMs: number;
  /** The proxy's upload window (WARDBY_DEPENDENCY_CACHE_UPLOAD_SECONDS), measured from this module's start;
   *  a snapshot is not uploaded once less than `uploadMarginMs` of it is left (`upload_window_passed`,
   *  log only). Independent of `totalMs`: past the window a run still restores and installs, it only
   *  stops uploading. A lookup's `uploadExpiresInMs`, if a proxy reports one, wins when sooner. */
  readonly uploadWindowMs: number;
  readonly uploadMarginMs: number;
}

export type DependencyCacheLog = (event: string, fields: Record<string, unknown>) => void;

export interface DependencyCacheEvent {
  readonly event: string;
  readonly [field: string]: unknown;
}

export declare const DEFAULT_TIMEOUTS: Readonly<DependencyCacheTimeouts>;
export declare const DEFAULT_BUDGET_MB: number;
export declare const MAX_ARCHIVE_ENTRIES: number;
export declare const MAX_PROJECTS: number;
/** The least room a cold install needs when this project's tree size is unknown (`budget_too_small` below it). */
export declare const MIN_INSTALL_BUDGET_BYTES: number;
/** Plan requests one project may send (retries of an incomplete plan included). */
export declare const MAX_PLAN_ATTEMPTS: number;
/** Plan requests the cache sends in one run, leaving the rest of REGISTRY_PLAN_MAX_PER_RUN to the agent's npm. */
export declare const MAX_PLAN_REQUESTS_PER_RUN: number;

export interface PrepareDependenciesOptions {
  readonly workspace: string;
  /** Required: the agent-equivalent shell env (registry settings: npm_config_registry, npm_config_userconfig,
   *  WARDBY_NPM_PLAN_REGISTRY, PATH), never the driver's secrets. `npm rebuild` gets only PATH, HOME, LANG,
   *  TMPDIR and npm_config_* / NPM_CONFIG_* / WARDBY_NPM_* from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The proxy origin; defaults to the one npm_config_registry / WARDBY_NPM_PLAN_REGISTRY names. */
  readonly proxyUrl?: string;
  /** The registry token; defaults to the npmrc's _authToken for that registry. */
  readonly token?: string;
  readonly npmPath?: string;
  readonly log?: DependencyCacheLog;
  /** Workspace disk budget in bytes; defaults to CODING_DISK_MB, else DEFAULT_BUDGET_MB. */
  readonly budgetBytes?: number;
  /** What the workspace used when `budgetBytes` was measured (dependencyCacheBudget's `usedBytes`); the
   *  snapshot step re-measures and counts the growth from it. Measured at the start when omitted. */
  readonly usedBytes?: number;
  /** Tests only: the cold-install floor; defaults to MIN_INSTALL_BUDGET_BYTES. */
  readonly minInstallBytes?: number;
  readonly timeouts?: Partial<DependencyCacheTimeouts>;
  /** The run's cancellation: aborting it ends the work like the deadline (the module still seals and settles). */
  readonly signal?: AbortSignal;
  /** Tests only: hooks into the flow. */
  readonly testHooks?: DependencyCacheTestHooks;
}

export interface DependencyCacheTestHooks {
  readonly beforeRename?: () => Promise<void>;
  readonly beforeDiscovery?: () => Promise<void>;
  /** After npm's `_cacache` was found and checked, before it is moved. */
  readonly beforeNpmCacheMove?: () => Promise<void>;
  /** After npm's `_cacache` was moved to the module's own temp, before it is removed. */
  readonly beforeNpmCacheRemove?: () => Promise<void>;
  /** After a restore's extraction, before its symlinks are verified (the temp folder it wrote). */
  readonly beforeVerifyLinks?: (temp: string) => Promise<void>;
  /** After an archive that outgrew the budget was stopped and removed. */
  readonly afterArchiveAborted?: (archive: string) => Promise<void>;
}

export declare const DEADLINE_SHARE: number;

/** How long packing a snapshot may take for a tree of `treeBytes`: `tarMs` plus `tarMsPerMiB` per MiB,
 *  cut to what is left before `uploadDeadline` (`limit: "upload_window"`). */
export declare function archiveLimit(
  timeouts: Pick<DependencyCacheTimeouts, "tarMs" | "tarMsPerMiB">,
  treeBytes: number,
  uploadDeadline: number | undefined,
  now?: number,
): { limit: "pack" | "upload_window"; limitMs: number };
/** min(DEFAULT_TIMEOUTS.totalMs, DEADLINE_SHARE × time left before `deadlineAt`), ≥ 0; the default without a usable deadline. */
export declare function dependencyCacheTimeLimit(deadlineAt: string | Date | number | undefined, now?: number): number;

export declare const MIN_BUDGET_BYTES: number;
export declare const BUDGET_MEASURE_TIMEOUT_MS: number;

export interface DependencyCacheBudgetOptions {
  readonly workspace: string;
  /** The run's workspace volume size in MiB (CodingTaskInput.diskMb / the tool setup's diskMb). */
  readonly diskMb: number | undefined;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxEntries?: number;
}

export type DependencyCacheBudget =
  | { readonly budgetBytes: number; readonly usedBytes: number; readonly reason?: undefined }
  | {
      readonly reason: "budget_unknown" | "budget_too_small";
      readonly usedBytes?: number;
      readonly budgetBytes?: undefined;
    };

/** diskMb MiB − the workspace's current usage − max(64 MiB, 5%); a skip reason when unknown or too small. Never throws. */
export declare function dependencyCacheBudget(options: DependencyCacheBudgetOptions): Promise<DependencyCacheBudget>;

export interface SealUploadWindowOptions {
  /** The same agent-equivalent env `prepareDependencies` takes (registry settings and the npmrc). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly proxyUrl?: string;
  readonly token?: string;
  /** Defaults to DEFAULT_TIMEOUTS.httpMs. */
  readonly timeoutMs?: number;
}

/** POST /cache/npm/seal on its own (idempotent on the proxy). `status` 0: no registry, or no answer. Never throws. */
export declare function sealUploadWindow(
  options: SealUploadWindowOptions,
): Promise<{ readonly status: number; readonly confirmed: boolean }>;

export declare function prepareDependencies(options: PrepareDependenciesOptions): Promise<PrepareDependenciesResult>;

/** Project folders with a committed package-lock.json, root first then by path (no cap applied). */
export declare function discoverProjects(workspace: string, signal?: AbortSignal): Promise<string[]>;

export interface PrepareProjectOptions {
  readonly workspace: string;
  readonly projectPath?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly npmPath: string;
  readonly log: DependencyCacheLog;
  readonly auth: { readonly base: string; readonly token: string } | undefined;
  /** Shared across projects: decremented by what each restore unpacks. */
  /** Shared across projects: decremented by what each restore unpacks and each install writes, and re-measured
   *  before each snapshot from `limit` (the starting budget) and `baseUsed` (the workspace's usage then). */
  readonly budget: { remaining: number; limit?: number; baseUsed?: number };
  readonly timeouts: DependencyCacheTimeouts;
  readonly signal: AbortSignal;
  /** `sealed` is set before the seal is sent (no upload starts after it);
   *  `closed` once the caller stops waiting (no workspace change after it). */
  readonly session: {
    sealed: boolean;
    closed: boolean;
    children: Set<number>;
    temps?: Set<string>;
    /** Plan requests sent so far in this run (at most MAX_PLAN_REQUESTS_PER_RUN). */
    planRequests?: number;
  };
  readonly testHooks?: DependencyCacheTestHooks;
  /** Filled from the committed lockfile before anything runs: whether `npm rebuild` is needed. */
  readonly facts?: { needsRebuild?: boolean };
  /** Epoch ms after which no snapshot upload starts. */
  readonly uploadDeadline?: number;
  /** Tests only: the cold-install floor; defaults to MIN_INSTALL_BUDGET_BYTES. */
  readonly minInstallBytes?: number;
}

export declare function prepareProject(options: PrepareProjectOptions): Promise<PrepareResult>;

export declare function scanArchive(
  file: string,
  options: { budgetBytes: number; maxEntries?: number; signal?: AbortSignal },
): Promise<{ entries: number; unpackedBytes: number }>;

export declare function extractArchive(
  file: string,
  destination: string,
  options: { budgetBytes: number; maxEntries?: number; signal?: AbortSignal },
): Promise<{ links: string[] }>;

export declare function verifyLinks(root: string, links: readonly string[], signal?: AbortSignal): Promise<void>;

export declare function checkConsistency(
  projectRoot: string,
  lockfile: { packages: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; detail: string }>;

export declare function readRegularFile(path: string, maxBytes: number): Promise<Buffer>;
export declare function readRegularFile(path: string, maxBytes: number, encoding: BufferEncoding): Promise<string>;
