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
  finalizeChanges(workspace: PreparedWorkspace): Promise<FinalizeChangesResult>;
  cleanup(workspace: PreparedWorkspace): Promise<void>;
}
