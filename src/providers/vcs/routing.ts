import { codeProviderOf } from "../../coding/code-host.js";
import { LocalRepoError, isLocalRepository } from "../../coding/local-repo.js";
import type { RepositoryFileInput } from "./types.js";
import type {
  ContinuationFinishedDetails,
  ContinuationOutcome,
  ContinuationTarget,
  DescriptionWriteOutcome,
  FinalizeChangesDetails,
  FinalizeChangesResult,
  PreparedWorkspace,
  VcsPrepareInput,
  VcsProvider,
} from "./types.js";

/** Keeps the `vcs_github_not_configured` code prefix that error matching and categorization key on. */
export const VCS_GITHUB_NOT_CONFIGURED_ERROR =
  "vcs_github_not_configured: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY to run coding agents on GitHub repositories";

/** Keeps a stable code prefix for error matching. The provider name comes from a validated repository id. */
export const VCS_HOST_PROVIDER_NOT_CONFIGURED_ERROR = "vcs_host_provider_not_configured";

export interface RoutingVcsOptions {
  /** Null when no GitHub App is configured. */
  github: VcsProvider | null;
  /** Null when no local repository roots are configured. */
  local: VcsProvider | null;
  /** Registered host providers, by name. */
  hosted?: ReadonlyMap<string, VcsProvider>;
}

/**
 * One VcsProvider over every repository kind: `local:/abs/path` goes to the
 * local provider, `<provider>:<workspace>/<repo>` to the registered host
 * provider of that name, and everything else to GitHub. A kind that is not
 * configured fails only when a repository of that kind is actually used, so a
 * server with only some of them still starts. A hosted repository never falls
 * back to GitHub. The repository name is not re-resolved here: the local
 * provider verifies it against the trusted roots.
 */
export class RoutingVcsProvider implements VcsProvider {
  constructor(private readonly options: RoutingVcsOptions) {}

  private target(repository: string): VcsProvider {
    if (isLocalRepository(repository)) {
      if (!this.options.local) {
        throw new LocalRepoError(
          "local_repo_not_allowed",
          "no local repository roots are configured (LOCAL_REPO_ROOTS)",
        );
      }
      return this.options.local;
    }
    const provider = codeProviderOf(repository);
    if (provider !== "github") {
      const hosted = this.options.hosted?.get(provider);
      if (!hosted) throw new Error(`${VCS_HOST_PROVIDER_NOT_CONFIGURED_ERROR}: no host provider named ${provider}`);
      return hosted;
    }
    if (!this.options.github) throw new Error(VCS_GITHUB_NOT_CONFIGURED_ERROR);
    return this.options.github;
  }

  /** The target when configured, else null (best-effort calls that must never throw). */
  private optionalTarget(repository: string): VcsProvider | null {
    if (isLocalRepository(repository)) return this.options.local ?? null;
    const provider = codeProviderOf(repository);
    return (provider === "github" ? this.options.github : this.options.hosted?.get(provider)) ?? null;
  }

  async prepareWorkspace(input: VcsPrepareInput): Promise<PreparedWorkspace> {
    return this.target(input.repository).prepareWorkspace(input);
  }

  async recoverWorkspace(input: VcsPrepareInput): Promise<PreparedWorkspace | null> {
    return this.target(input.repository).recoverWorkspace(input);
  }

  async finalizeChanges(
    workspace: PreparedWorkspace,
    details?: FinalizeChangesDetails,
  ): Promise<FinalizeChangesResult> {
    return this.target(workspace.repository).finalizeChanges(workspace, details);
  }

  async cleanup(workspace: PreparedWorkspace): Promise<void> {
    return this.target(workspace.repository).cleanup(workspace);
  }

  async notifyContinuationStarted(workspace: PreparedWorkspace, details?: { agentName?: string }): Promise<void> {
    await this.optionalTarget(workspace.repository)?.notifyContinuationStarted?.(workspace, details);
  }

  async notifyContinuationFinished(
    workspace: ContinuationTarget,
    outcome: ContinuationOutcome,
    details?: ContinuationFinishedDetails,
  ): Promise<void> {
    await this.optionalTarget(workspace.repository)?.notifyContinuationFinished?.(workspace, outcome, details);
  }

  async refreshPullRequestDescription(
    workspace: ContinuationTarget,
    details: FinalizeChangesDetails,
  ): Promise<DescriptionWriteOutcome | undefined> {
    return this.optionalTarget(workspace.repository)?.refreshPullRequestDescription?.(workspace, details);
  }

  async continuationPullRequestDraft(workspace: PreparedWorkspace): Promise<boolean | undefined> {
    return this.optionalTarget(workspace.repository)?.continuationPullRequestDraft?.(workspace);
  }

  async readRepositoryFile(input: RepositoryFileInput): Promise<string | null> {
    return (await this.optionalTarget(input.repository)?.readRepositoryFile?.(input)) ?? null;
  }
}
