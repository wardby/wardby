export interface VcsPrepareInput {
  runId: string;
  repository: string;
  baseRef: string;
  headRef: string;
  protectedPaths: string[];
}

/** Trusted paths are returned by the provider, never accepted from worker output. */
export interface PreparedWorkspace {
  id: string;
  runId: string;
  repository: string;
  baseRef: string;
  headRef: string;
  baseCommit: string;
  workspacePath: string;
  gitMetadataPath: string;
  protectedPaths: string[];
}

/** Already-validated/redacted agent-authored fields (coding/protocol.ts) surfaced in the opened PR, if any. */
export interface FinalizeChangesDetails {
  summary?: string;
  tests?: readonly { command: string; outcome: "passed" | "failed" | "skipped" }[];
  tag?: string;
}

export type FinalizeChangesResult =
  | {
      outcome: "no_changes";
      repository: string;
      baseRef: string;
      baseCommit: string;
    }
  | {
      outcome: "pull_request_opened";
      repository: string;
      baseRef: string;
      baseCommit: string;
      headRef: string;
      commitSha: string;
      pullRequestNumber: number;
      pullRequestUrl: string;
    };

export interface VcsProvider {
  prepareWorkspace(input: VcsPrepareInput): Promise<PreparedWorkspace>;
  recoverWorkspace(input: VcsPrepareInput): Promise<PreparedWorkspace | null>;
  finalizeChanges(workspace: PreparedWorkspace, details?: FinalizeChangesDetails): Promise<FinalizeChangesResult>;
  cleanup(workspace: PreparedWorkspace): Promise<void>;
}
