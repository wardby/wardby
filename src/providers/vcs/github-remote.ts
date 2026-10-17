import { budgetStoppedChangesSentence, CONTINUATION_CLOSED_ERROR } from "../../coding/continuation-wording.js";
import { normalizeGitHubRepository, normalizeGitRef } from "../../coding/protocol.js";
import { logger } from "../../core/logger.js";
import { validateChangedPath } from "./git.js";
import {
  isLockfilePath,
  type GitHubRepositoryAccess,
  type PullRequestResult,
  type RepositoryFileInput,
  type UpdateDescriptionInput,
} from "./github.js";
import type { GitRemote, PublishInput, PublishResult } from "./remote.js";
import type {
  ContinuationFinishedDetails,
  ContinuationOutcome,
  ContinuationTarget,
  DescriptionWriteOutcome,
  FinalizeChangesDetails,
  PreparedWorkspace,
} from "./types.js";

export interface GitHubRemoteOptions {
  github: GitHubRepositoryAccess;
  /** Test-only transport override; production composition always uses github.com. */
  cloneUrlForRepository?: (repository: string) => string;
  /** Test-only delay override for assertContinuationOpen's single retry wait. */
  sleep?: (milliseconds: number) => Promise<void>;
}

/** How long assertContinuationOpen waits before its single retry on a transient open-PR check failure. */
const CONTINUATION_OPEN_RETRY_DELAY_MS = 1_000;

/** Human-readable label for continuation status notifications -- falls back to the opaque run id alone when no agent name is known. */
function runLabel(agentName: string | undefined, runId: string): string {
  return agentName ? `${agentName} (wardby run ${runId})` : `wardby run ${runId}`;
}

/** github.com through a GitHub App: installation tokens for git, draft pull requests after a push. */
export class GitHubRemote implements GitRemote {
  readonly gitConfig: readonly string[] = [];
  private readonly cloneUrlForRepository: (repository: string) => string;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: GitHubRemoteOptions) {
    this.cloneUrlForRepository =
      options.cloneUrlForRepository ?? ((repository) => `https://github.com/${repository}.git`);
    this.sleep =
      options.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  }

  normalizeRepository(repository: string): string {
    return normalizeGitHubRepository(repository);
  }

  cloneUrl(repository: string): string {
    const cloneUrl = this.cloneUrlForRepository(repository);
    if (!this.options.cloneUrlForRepository && cloneUrl !== `https://github.com/${repository}.git`) {
      throw new Error("vcs_remote_invalid");
    }
    return cloneUrl;
  }

  withAccess<T>(repository: string, fn: (token: string | undefined) => Promise<T>): Promise<T> {
    return this.options.github.withRepositoryToken(repository, fn);
  }

  conflictError(): Error {
    return new Error("vcs_head_ref_conflict");
  }

  /**
   * A continuation never pushes to a pull request that is no longer open.
   * Fresh runs (no `continuation`) skip this, and so does a GitHub client
   * that exposes no `findOpenPullRequest` (optional on GitHubRepositoryAccess).
   *
   * GitHub's answer is trusted only when it is definite: a found open PR
   * proceeds normally, and a confirmed "no open PR" (a successful call that
   * returns null) refuses outright with CONTINUATION_CLOSED_ERROR. A
   * transient failure -- network error, 5xx, timeout, rate limit, anything
   * that makes the call itself throw rather than answer -- is retried once;
   * if it throws again, this proceeds as if the pull request were still
   * open and logs a warning, rather than failing the run on an unconfirmed
   * answer (especially not here, right before the push, after all the
   * work is already done).
   */
  async assertContinuationOpen(input: {
    repository: string;
    baseRef: string;
    headRef: string;
    continuation?: { rootRunId: string };
  }): Promise<void> {
    if (!input.continuation || !this.options.github.findOpenPullRequest) return;
    const request = {
      runId: input.continuation.rootRunId,
      repository: input.repository,
      baseRef: input.baseRef,
      headRef: input.headRef,
    };
    let open: PullRequestResult | null;
    try {
      open = await this.options.github.findOpenPullRequest(request);
    } catch {
      await this.sleep(CONTINUATION_OPEN_RETRY_DELAY_MS);
      try {
        open = await this.options.github.findOpenPullRequest(request);
      } catch (error) {
        logger.warn(
          { err: error, runId: request.runId, repository: request.repository },
          "continuation open-PR check failed twice in a row; proceeding as if the pull request is still open",
        );
        return;
      }
    }
    if (!open) throw new Error(CONTINUATION_CLOSED_ERROR);
  }

  /** See VcsProvider.continuationPullRequestDraft: GitHub's draft flag on the root run's open PR. Never throws. */
  async continuationPullRequestDraft(workspace: PreparedWorkspace): Promise<boolean | undefined> {
    const github = this.options.github;
    if (!workspace.continuation || !github.openPullRequestDraft) return undefined;
    try {
      const draft = await github.openPullRequestDraft({
        runId: workspace.continuation.rootRunId,
        repository: workspace.repository,
        baseRef: workspace.baseRef,
        headRef: workspace.headRef,
      });
      return draft ?? undefined;
    } catch (error) {
      logger.warn({ err: error, runId: workspace.runId }, "could not read the continuation pull request's draft state");
      return undefined;
    }
  }

  /** A continuation's description comment, written before the push (see GitRemote.proposeDescriptionBeforePush). Never throws. */
  async proposeDescriptionBeforePush({
    workspace: prepared,
    details,
    changedPaths,
    commitSha,
  }: PublishInput & { commitSha: string }): Promise<void> {
    const github = this.options.github;
    if (!prepared.continuation || !details?.description || !github.proposeDescriptionComment) return;
    try {
      await github.proposeDescriptionComment(
        this.descriptionInput(
          { ...prepared, continuation: prepared.continuation },
          { ...details, description: details.description },
          changedPaths,
          commitSha,
        ),
      );
    } catch (error) {
      logger.warn({ err: error, runId: prepared.runId }, "pre-push description comment failed");
    }
  }

  async publish({ workspace: prepared, details, changedPaths, commitSha }: PublishInput): Promise<PublishResult> {
    // Revision-in-place: identify the PR by the run that originally opened
    // it (createOrFindDraftPullRequest's marker-based lookup keys on that
    // run's id), not this run's own -- this finds the existing open PR and
    // returns it rather than creating a new one, since headRef/baseRef
    // already match it exactly. No other change needed here: pushing a new
    // commit onto that branch already updates the PR natively -- which is
    // also why a PR a person has since marked ready for review is accepted
    // (acceptReadyForReview) rather than failing an already-pushed run.
    const pullRequest = await this.options.github.createOrFindDraftPullRequest({
      runId: prepared.continuation?.rootRunId ?? prepared.runId,
      ...(prepared.continuation ? { acceptReadyForReview: true } : {}),
      repository: prepared.repository,
      baseRef: prepared.baseRef,
      headRef: prepared.headRef,
      summary: details?.summary,
      tests: details?.tests,
      tag: details?.tag,
      packages: details?.packages,
      packageRefusals: details?.packageRefusals,
      ...(details?.packageAudit ? { packageAudit: details.packageAudit } : {}),
      ...(details?.restoredDependencies?.length ? { restoredDependencies: details.restoredDependencies } : {}),
      changedLockfiles: changedPaths.filter(isLockfilePath),
      ...(details?.issue ? { issue: details.issue } : {}),
      ...(details?.issueNumber !== undefined ? { issueNumber: details.issueNumber } : {}),
      ...(details?.related ? { related: details.related } : {}),
    });
    let description: DescriptionWriteOutcome | undefined;
    if (prepared.continuation) {
      description = await this.updateDescription(prepared, details, changedPaths, commitSha);
    } else if (pullRequest.descriptionSha256) {
      description = { kind: "written", sha256: pullRequest.descriptionSha256 };
    }
    return {
      kind: "pull_request",
      number: pullRequest.number,
      url: pullRequest.url,
      ...(description ? { description } : {}),
    };
  }

  /** The no-push path: a fix round that changed nothing still re-derives its PR description. */
  async refreshDescription(
    workspace: ContinuationTarget,
    details: FinalizeChangesDetails,
  ): Promise<DescriptionWriteOutcome | undefined> {
    // No push: the head is the commit the workspace was checked out at.
    return this.updateDescription(workspace, details, [], workspace.baseCommit);
  }

  /** Never throws: a description problem must not fail an already-pushed run. */
  private async updateDescription(
    prepared: ContinuationTarget,
    details: FinalizeChangesDetails | undefined,
    changedPaths: readonly string[],
    headSha: string | undefined,
  ): Promise<DescriptionWriteOutcome | undefined> {
    const github = this.options.github;
    if (!prepared.continuation || !details?.description || !github.updatePullRequestDescription) return undefined;
    try {
      return await github.updatePullRequestDescription(
        this.descriptionInput(
          { ...prepared, continuation: prepared.continuation },
          { ...details, description: details.description },
          changedPaths,
          headSha,
        ),
      );
    } catch (error) {
      logger.warn({ err: error, runId: prepared.runId }, "pull request description update failed");
      return { kind: "skipped", reason: "error" };
    }
  }

  private descriptionInput(
    prepared: ContinuationTarget & { continuation: { rootRunId: string } },
    details: FinalizeChangesDetails & { description: NonNullable<FinalizeChangesDetails["description"]> },
    changedPaths: readonly string[],
    headSha: string | undefined,
  ): UpdateDescriptionInput {
    return {
      rootRunId: prepared.continuation.rootRunId,
      runId: prepared.runId,
      repository: prepared.repository,
      baseRef: prepared.baseRef,
      headRef: prepared.headRef,
      ...(headSha && /^[0-9a-f]{40}$/.test(headSha) ? { headSha } : {}),
      summary: details.summary,
      tests: details.tests,
      tag: details.tag,
      packages: details.packages,
      packageRefusals: details.packageRefusals,
      ...(details.packageAudit ? { packageAudit: details.packageAudit } : {}),
      ...(details.restoredDependencies?.length ? { restoredDependencies: details.restoredDependencies } : {}),
      changedLockfiles: changedPaths.filter(isLockfilePath),
      ...(details.issue ? { issue: details.issue } : {}),
      ...(details.issueNumber !== undefined ? { issueNumber: details.issueNumber } : {}),
      baseline: details.description.baseline,
    };
  }

  /**
   * Best-effort "wardby is working on this PR" signal (see VcsProvider) --
   * whole body wrapped so this can NEVER throw or otherwise affect the
   * real coding run, mirroring docker.ts's readWorkerFailureDiagnostic
   * ("diagnostics are optional and must never affect terminal cleanup").
   * No-op for a fresh (non-continuation) workspace: there's no PR to
   * attach anything to until its one commit lands.
   */
  async notifyContinuationStarted(workspace: PreparedWorkspace, details?: { agentName?: string }): Promise<void> {
    if (!workspace.continuation) return;
    try {
      const identity = {
        runId: workspace.runId,
        rootRunId: workspace.continuation.rootRunId,
        repository: workspace.repository,
        baseRef: workspace.baseRef,
        headRef: workspace.headRef,
      };
      await Promise.allSettled([
        this.options.github.upsertContinuationStatusComment({
          ...identity,
          body: `🔄 ${runLabel(details?.agentName, workspace.runId)} is working on this PR...`,
        }),
        this.options.github.createContinuationCheckRun({
          repository: workspace.repository,
          headSha: workspace.baseCommit,
          runId: workspace.runId,
        }),
      ]);
    } catch {
      // Best-effort observability only -- must never affect the real run.
    }
  }

  /**
   * Companion to notifyContinuationStarted -- finds and updates whatever
   * that call created, never creates fresh state itself (see
   * upsertContinuationStatusComment vs updateContinuationStatusComment,
   * and createContinuationCheckRun vs completeContinuationCheckRun in
   * github.ts). Safe to call more than once for the same run. Same
   * never-throw contract as notifyContinuationStarted.
   */
  async notifyContinuationFinished(
    workspace: ContinuationTarget,
    outcome: ContinuationOutcome,
    details?: ContinuationFinishedDetails,
  ): Promise<void> {
    if (!workspace.continuation) return;
    try {
      const identity = {
        runId: workspace.runId,
        rootRunId: workspace.continuation.rootRunId,
        repository: workspace.repository,
        baseRef: workspace.baseRef,
        headRef: workspace.headRef,
      };
      const label = runLabel(details?.agentName, workspace.runId);
      const summarySuffix = details?.summary ? `\n\n${details.summary}` : "";
      const budgetSuffix = details?.budgetSentence ? ` ${details.budgetSentence}` : "";
      const body =
        outcome === "succeeded"
          ? `✅ ${label} finished.${details?.overrunSentence ? ` ${details.overrunSentence}` : ""}${summarySuffix}`
          : outcome === "budget_exhausted" && details?.changesPushed
            ? `⚠️ ${label} ran out of budget before finishing.${budgetSuffix} ${budgetStoppedChangesSentence(
                details.changesPushed.pullRequestNumber
                  ? `#${details.changesPushed.pullRequestNumber}`
                  : "this pull request",
                false,
              )}${summarySuffix}`
            : outcome === "budget_exhausted"
              ? `❌ ${label} ran out of budget.${budgetSuffix}${summarySuffix}`
              : details?.serviceSentence
                ? `❌ ${label} could not start: ${details.serviceSentence}${summarySuffix}`
                : details?.providerSentence
                  ? `❌ ${label} could not run: ${details.providerSentence}${summarySuffix}`
                  : details?.protectedPathSentence
                    ? `❌ ${label} could not open its changes: ${details.protectedPathSentence}${summarySuffix}`
                    : `❌ ${label} failed.${summarySuffix}`;
      await Promise.allSettled([
        this.options.github.updateContinuationStatusComment({ ...identity, body }),
        this.options.github.completeContinuationCheckRun({
          repository: workspace.repository,
          ...(workspace.baseCommit ? { headSha: workspace.baseCommit } : { headRef: workspace.headRef }),
          runId: workspace.runId,
          outcome: outcome === "succeeded" ? "succeeded" : "failed",
        }),
      ]);
    } catch {
      // Best-effort observability only -- must never affect the real run.
    }
  }

  async readRepositoryFile(input: RepositoryFileInput): Promise<string | null> {
    const github = this.options.github;
    if (!github.readFileAtRef) throw new Error("vcs_read_file_unsupported");
    return github.readFileAtRef({
      repository: normalizeGitHubRepository(input.repository),
      ref: normalizeGitRef(input.ref),
      path: validateChangedPath(input.path),
      maxBytes: input.maxBytes,
    });
  }
}
