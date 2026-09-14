export interface VcsPrepareInput {
  runId: string;
  repository: string;
  baseRef: string;
  headRef: string;
  protectedPaths: string[];
  /**
   * Revision-in-place (see
   * docs/private/2026-09-13-coding-pr-revision-in-place-design.md): set
   * when headRef is an EXISTING branch to continue rather than a fresh one
   * to create off baseRef. `rootRunId` is the id of the run that originally
   * opened the PR headRef belongs to (used for PR lookup identity, since
   * GitHub's find-by-marker keys on that run's id, not this one's) -- the
   * caller (dispatch.ts) must already have verified, against the database,
   * that this run is legitimately allowed to continue that branch before
   * ever setting this; this layer trusts it exactly as much as it already
   * trusts baseRef, no more, and cannot independently re-verify a database
   * fact.
   */
  continuation?: { rootRunId: string };
}

/** Trusted paths are returned by the provider, never accepted from worker output. */
export interface PreparedWorkspace {
  id: string;
  runId: string;
  repository: string;
  baseRef: string;
  headRef: string;
  /** For a fresh workspace, the commit baseRef pointed at when cloned. For
   * a continuation, the tip of the branch being continued at clone time --
   * each round is independently validated against its own agent's rules at
   * commit time (see design doc §8.3), so there's no need to re-derive or
   * re-validate the PR's true original root here; "where this round
   * started" is the only anchor the single-new-commit and protected-path
   * checks need. */
  baseCommit: string;
  workspacePath: string;
  gitMetadataPath: string;
  protectedPaths: string[];
  continuation?: { rootRunId: string };
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
    }
  | {
      /** Revision-in-place: pushed a new commit onto an existing open PR's
       * branch instead of opening a new one. */
      outcome: "pull_request_updated";
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
  /**
   * Best-effort "reevo is working on this" signal for a continuation
   * (see docs/private/2026-09-13-coding-pr-revision-in-place-design.md) --
   * a no-op when `workspace.continuation` is unset, since a fresh run has
   * no PR to attach anything to until its one commit lands. Optional
   * because this is a GitHub-specific concept, not a universal VCS one --
   * a future non-GitHub provider (or a test double) can simply omit it,
   * mirroring `Executor.resolveCodingWorkerImage?` (dispatch.ts calls it
   * with `?.()`). Implementations MUST NOT throw: this is strictly
   * observability, never allowed to affect the real coding run.
   * `details.agentName`, when present, is the human-readable agent name
   * (e.g. "knock-knock-implement") surfaced alongside the opaque run id --
   * particularly useful for the cross-agent case, where the agent
   * continuing the PR isn't the one that originally opened it.
   */
  notifyContinuationStarted?(workspace: PreparedWorkspace, details?: { agentName?: string }): Promise<void>;
  /**
   * Companion to `notifyContinuationStarted` -- must find and update
   * whatever that call created, never create fresh state itself (a
   * "finished" status with no preceding "in progress" one would be
   * confusing, and could happen if the process crashed between the two
   * calls). Safe to call more than once for the same run. Same
   * never-throw contract as `notifyContinuationStarted`. `details.summary`,
   * when present, is the agent's own already-validated/redacted summary
   * (the same text that goes in the PR body -- see
   * `FinalizeChangesDetails.summary`) so the "done" status reflects what
   * actually happened instead of a caller having to go find out.
   */
  notifyContinuationFinished?(
    workspace: PreparedWorkspace,
    outcome: "succeeded" | "failed",
    details?: { summary?: string; agentName?: string },
  ): Promise<void>;
}
