// TEST ONLY (wardby-sim). The simulated Bitbucket Cloud: repositories with files at any commit,
// pull requests, comments, build statuses and effective permissions. Shapes follow Atlassian's
// public API documentation (unverified against a recorded response).

/** A repository access token: one repository, no workspace endpoints. */
export const SIM_BITBUCKET_REPO_TOKEN = "sim-bitbucket-repo-token";
/** A workspace access token: the permission endpoint as well. */
export const SIM_BITBUCKET_WORKSPACE_TOKEN = "sim-bitbucket-workspace-token";

export interface BitbucketPullRequest {
  id: number;
  title: string;
  description: string;
  author: string;
  state: string;
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
}

export interface BitbucketComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  path: string | null;
  line: number | null;
  parentId: number | null;
  resolved: boolean;
}

export interface BitbucketStatus {
  key: string;
  state: string;
  url: string | null;
}

export interface BitbucketRepo {
  fullName: string;
  files: Record<string, string>;
  pullRequests: Map<number, BitbucketPullRequest>;
  comments: Map<number, BitbucketComment[]>;
  statuses: Map<string, BitbucketStatus[]>;
  diff: string;
}

export class BitbucketState {
  private readonly repos = new Map<string, BitbucketRepo>();
  private readonly permissions = new Map<string, string>();
  readonly tokens = new Map<string, { kind: "repository"; repository: string } | { kind: "workspace" }>();

  reset(): void {
    this.repos.clear();
    this.permissions.clear();
    this.tokens.clear();
  }

  repo(fullName: string): BitbucketRepo | undefined {
    return this.repos.get(fullName);
  }

  addRepo(fullName: string, options: { files?: Record<string, string>; diff?: string } = {}): BitbucketRepo {
    const repo: BitbucketRepo = {
      fullName,
      files: options.files ?? {},
      pullRequests: new Map(),
      comments: new Map(),
      statuses: new Map(),
      diff: options.diff ?? "diff --git a/README.md b/README.md\n",
    };
    this.repos.set(fullName, repo);
    this.tokens.set(SIM_BITBUCKET_REPO_TOKEN, { kind: "repository", repository: fullName });
    this.tokens.set(SIM_BITBUCKET_WORKSPACE_TOKEN, { kind: "workspace" });
    return repo;
  }

  addPullRequest(
    fullName: string,
    pr: Partial<BitbucketPullRequest> & Pick<BitbucketPullRequest, "id">,
  ): BitbucketPullRequest {
    const repo = this.repos.get(fullName);
    if (!repo) throw new Error("no such repository");
    const full: BitbucketPullRequest = {
      title: "A pull request",
      description: "",
      author: "sim-account",
      state: "OPEN",
      draft: false,
      headRef: "feature",
      headSha: "0".repeat(40),
      baseRef: "main",
      ...pr,
    };
    repo.pullRequests.set(full.id, full);
    return full;
  }

  setPermission(fullName: string, accountId: string, permission: string): void {
    this.permissions.set(`${fullName}\u0000${accountId}`, permission);
  }

  permission(fullName: string, accountId: string): string | undefined {
    return this.permissions.get(`${fullName}\u0000${accountId}`);
  }
}
