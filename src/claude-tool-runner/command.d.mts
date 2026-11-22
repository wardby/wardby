// Types for command.mjs, so the launcher's tests can check they build within the tool runner's limits.
export declare const MAX_OUTPUT_BYTES: number;
export declare const MAX_COMMAND_BYTES: number;
export declare const LEGACY_DEFAULT_TIMEOUT_MS: number;
export declare const MAX_TIMEOUT_MS: number;
export declare const MIN_COMMAND_TIMEOUT_MS: number;
export declare const MAX_COMMAND_TIMEOUT_MS: number;
export declare const KILL_GRACE_MS: number;
export declare const TOOL_SETUP_ENV: string;
export declare const SHIM_DIRECTORY: string;
export declare const COMMAND_AGENT: string;
export declare const TOOLCHAIN_FAILURES: ReadonlySet<string>;
export declare const MAX_ENV_ENTRIES: number;
export declare const MAX_ENV_VALUE_BYTES: number;
export declare const MAX_FILES: number;
export declare const MAX_FILE_BYTES: number;
export declare const MAX_SETUP_BYTES: number;

export interface ToolSetup {
  readonly env: Readonly<Record<string, string>>;
  readonly files: ReadonlyArray<{ path: string; content: string; mode: number }>;
  /** Present (true) only on a dependency-cache run. */
  readonly dependencyCache?: true;
  /** With dependencyCache only: the workspace volume size in MiB. */
  readonly diskMb?: number;
  /** With dependencyCache only: an adopted warm round; prepare answers reused_workspace. */
  readonly workspaceReused?: true;
  /** The run's run_command time limits, from the launcher; absent from an older one. */
  readonly commandTimeouts?: Readonly<{ defaultMs: number; maxMs: number }>;
  /** The run's toolchain (#599): every command is forwarded to its command agent. */
  readonly toolchain?: Readonly<{ address: string; tokenFile: string }>;
}

export declare function commandTimeoutLimits(setup?: ToolSetup): { defaultMs: number; maxMs: number };

export declare function toolEnvironment(workspacePath?: string): Record<string, string>;
export declare function toolchainEnvironment(setup?: ToolSetup, workspacePath?: string): Record<string, string>;
export declare function commandEnvironment(setup?: ToolSetup, workspacePath?: string): Record<string, string>;
export declare function prepareCommandWorkspace(setup?: ToolSetup, workspacePath?: string): Promise<void>;
export declare function parseToolSetup(raw: string | undefined, workspacePath?: string): ToolSetup;
export declare function runCommand(
  command: string,
  timeoutMs: number,
  workspacePath?: string,
  setup?: ToolSetup,
  options?: {
    spawn?: typeof import("node:child_process").spawn;
    lookup?: (
      access: import("../coding-worker/registry-refusals.mjs").RegistryAccess | undefined,
      since?: Date,
    ) => Promise<import("../coding-worker/registry-refusals.mjs").RecentRefusal[]>;
  },
): Promise<{ code: number; output: string }>;
export declare function withPackageRefusals(
  result: { code: number; output: string },
  env: Record<string, string | undefined>,
  startedAt: number,
  lookup?: (
    access: import("../coding-worker/registry-refusals.mjs").RegistryAccess | undefined,
    since?: Date,
  ) => Promise<import("../coding-worker/registry-refusals.mjs").RecentRefusal[]>,
): Promise<{ code: number; output: string }>;
