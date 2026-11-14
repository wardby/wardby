// Types for result-bundle.mjs, so the Codex driver and the tests can import it.

export declare const RESULT_BUNDLE_NAME: "wardby-result.bundle";
export declare const BUNDLE_HEAD_REF: "refs/wardby/bundle-head";
export declare const MAX_REF_FILE_BYTES: number;
export declare const MAX_SHALLOW_BYTES: number;
export declare const BUNDLE_TIMEOUT_MS: number;

export type ResultBundleOutcome =
  | { readonly bundled: true; readonly head: string }
  | { readonly bundled: false; readonly reason: "no_head" | "no_new_commits" };

export interface CreateResultBundleOptions {
  /** The repository folder: its `.git` is read as text and the bundle is written into it. */
  readonly repoPath: string;
  readonly baseCommit: string;
  readonly excludeCommits: readonly string[];
  readonly gitBinary?: string;
  /** Where the scratch repository is made; os.tmpdir() by default. Never inside the workspace. */
  readonly scratchRoot?: string;
  readonly timeoutMs?: number;
}

export declare function resolveHistoryPath(
  path: string,
  roots?: { readonly workspace?: string; readonly reposRoot?: string },
): string | null;
export declare function readHeadCommit(gitDir: string): Promise<string | null>;
export declare function createResultBundle(options: CreateResultBundleOptions): Promise<ResultBundleOutcome>;
export declare function gitAvailable(gitBinary?: string): Promise<boolean>;
