// TEST ONLY (wardby-sim). The simulated GitHub's state: the App and its installations,
// issued tokens, repositories (content in GitStore), pull requests, issues, comments,
// reactions, reviews, review comments and threads, check runs, commit statuses, branch
// protection and webhook subscriptions.
import { randomBytes } from "node:crypto";
import type { StatePart } from "../state.js";
import type { GitStore } from "./git-store.js";

export type Permission = "read" | "write";

export interface SimUser {
  login: string;
  id: number;
  type: "User" | "Bot";
}

export interface SimApp {
  id: number;
  slug: string;
  ownerLogin: string;
  /** PEM (SPKI) public key App JWTs are verified with; absent = any JWT-shaped bearer is the App. */
  publicKeyPem?: string;
}

export interface SimInstallation {
  id: number;
  account: string;
  /** The most this installation may grant (what the owner accepted). */
  permissions: Record<string, Permission>;
}

export interface IssuedToken {
  token: string;
  /** A stable id for the call log ("tok-3"); the token value itself is never recorded. */
  id: string;
  installationId: number;
  permissions: Record<string, Permission>;
  repositories: string[];
  expiresAt: number;
  revoked: boolean;
}

export interface SimRepo {
  id: number;
  nodeId: string;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  installationId: number;
  /** login (lower case) → that user's role on the repository. */
  collaborators: Map<string, { user: SimUser; role: "admin" | "maintain" | "write" | "triage" | "read" }>;
  nextNumber: number;
}

export interface SimPull {
  repo: string;
  number: number;
  id: number;
  nodeId: string;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergedBy: SimUser | null;
  user: SimUser;
  headRef: string;
  /** The head when the PR closed; an open PR reads its branch live. */
  headShaAtClose: string | null;
  baseRef: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  autoMerge: { method: "merge" | "squash" } | null;
  /** Who enabled auto-merge (the merge is theirs). */
  autoMergeBy?: SimUser;
}

export interface SimIssue {
  repo: string;
  number: number;
  id: number;
  nodeId: string;
  title: string;
  body: string | null;
  state: "open" | "closed";
  stateReason: "completed" | "not_planned" | "reopened" | null;
  user: SimUser;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** A pull request is an issue too; set when this number is a PR. */
  isPull: boolean;
}

export interface SimComment {
  id: number;
  nodeId: string;
  repo: string;
  issueNumber: number;
  body: string;
  user: SimUser;
  /** The App id when an installation token wrote it (`performed_via_github_app`). */
  viaApp: number | null;
  authorAssociation: string;
  createdAt: string;
  updatedAt: string;
}

export interface SimReaction {
  id: number;
  subject: { kind: "issue" | "issue_comment" | "review_comment"; repo: string; id: number };
  content: string;
  user: SimUser;
  createdAt: string;
}

export interface SimReview {
  id: number;
  nodeId: string;
  repo: string;
  pull: number;
  user: SimUser;
  viaApp: number | null;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  body: string;
  commitId: string;
  submittedAt: string;
}

export interface SimReviewComment {
  id: number;
  nodeId: string;
  repo: string;
  pull: number;
  reviewId: number | null;
  threadId: string;
  path: string;
  line: number | null;
  side: "LEFT" | "RIGHT";
  body: string;
  user: SimUser;
  viaApp: number | null;
  inReplyTo: number | null;
  commitId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SimThread {
  id: string;
  repo: string;
  pull: number;
  path: string;
  line: number | null;
  /** The head the thread's first comment was made on; a later head outdates it. */
  commitId: string;
  resolved: boolean;
  commentIds: number[];
}

export interface SimCheckRun {
  id: number;
  repo: string;
  headSha: string;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  externalId: string | null;
  detailsUrl: string | null;
  output: { title: string | null; summary: string | null; text: string | null };
  appId: number;
  startedAt: string;
  completedAt: string | null;
}

export interface SimStatus {
  id: number;
  repo: string;
  sha: string;
  state: "error" | "failure" | "pending" | "success";
  context: string;
  description: string | null;
  targetUrl: string | null;
  createdAt: string;
}

export interface BranchProtection {
  /** Check run names (or status contexts) that must conclude success on the head. */
  requiredChecks: string[];
  requiredApprovals: number;
  /** A push to the PR head dismisses earlier approvals. */
  dismissStaleReviews: boolean;
  /** Pushes straight to the branch are refused (only merges through a PR land). */
  blockPushes: boolean;
}

export interface WebhookSubscription {
  url: string;
  secret: string;
  /** Event names delivered; empty = every event. */
  events: string[];
}

export class GitHubState implements StatePart {
  app: SimApp;
  readonly installations = new Map<number, SimInstallation>();
  readonly tokens = new Map<string, IssuedToken>();
  readonly users = new Map<string, SimUser>();
  readonly repos = new Map<string, SimRepo>();
  readonly pulls = new Map<string, SimPull>();
  readonly issues = new Map<string, SimIssue>();
  readonly comments = new Map<number, SimComment>();
  readonly reactions: SimReaction[] = [];
  readonly reviews = new Map<number, SimReview>();
  readonly reviewComments = new Map<number, SimReviewComment>();
  readonly threads = new Map<string, SimThread>();
  readonly checkRuns = new Map<number, SimCheckRun>();
  readonly statuses: SimStatus[] = [];
  readonly protection = new Map<string, BranchProtection>();
  readonly webhooks: WebhookSubscription[] = [];
  private ids = 1000;
  private tokenSeq = 0;
  /** A clock the tests can move (token expiry, timestamps). */
  now: () => number = () => Date.now();
  /**
   * Called for every state change GitHub would send a webhook for (set by webhooks.ts;
   * a no-op without subscriptions). `payload` lacks repository/sender/installation, which
   * the emitter adds.
   */
  emit: (event: string, payload: Record<string, unknown>, repo: SimRepo, sender: SimUser) => void = () => undefined;
  /** Run when a check run or commit status on a commit changes (events.ts: check_suite; protection.ts: auto-merge). */
  readonly checkListeners: ((repo: SimRepo, sha: string) => Promise<void> | void)[] = [];
  /** Run after a branch moves (a push, a scripted commit, a merge): webhooks, stale reviews, auto-merge. */
  readonly pushListeners: ((
    repo: SimRepo,
    branch: string,
    before: string | null,
    after: string | null,
    pusher: SimUser,
  ) => Promise<void> | void)[] = [];
  /** Run after a review is submitted (protection.ts: auto-merge). */
  readonly reviewListeners: ((repo: SimRepo, pull: number) => Promise<void> | void)[] = [];

  async checkChanged(repo: SimRepo, sha: string): Promise<void> {
    for (const listener of this.checkListeners) await listener(repo, sha);
  }

  async pushed(
    repo: SimRepo,
    branch: string,
    before: string | null,
    after: string | null,
    pusher: SimUser,
  ): Promise<void> {
    for (const listener of this.pushListeners) await listener(repo, branch, before, after, pusher);
  }

  async reviewed(repo: SimRepo, pull: number): Promise<void> {
    for (const listener of this.reviewListeners) await listener(repo, pull);
  }

  constructor(
    readonly git: GitStore,
    private readonly defaults: { app: SimApp },
  ) {
    this.app = { ...defaults.app };
  }

  reset(): void {
    this.app = { ...this.defaults.app };
    for (const map of [
      this.installations,
      this.tokens,
      this.users,
      this.repos,
      this.pulls,
      this.issues,
      this.comments,
      this.reviews,
      this.reviewComments,
      this.threads,
      this.checkRuns,
      this.protection,
    ]) {
      map.clear();
    }
    this.reactions.length = 0;
    this.statuses.length = 0;
    this.webhooks.length = 0;
    this.ids = 1000;
    this.tokenSeq = 0;
    this.now = () => Date.now();
    this.git.clear();
  }

  nextId(): number {
    this.ids += 1;
    return this.ids;
  }

  iso(): string {
    return new Date(this.now()).toISOString();
  }

  botUser(): SimUser {
    return { login: `${this.app.slug}[bot]`, id: 900_000 + this.app.id, type: "Bot" };
  }

  user(login: string): SimUser {
    const key = login.toLowerCase();
    let user = this.users.get(key);
    if (!user) {
      user = { login, id: 100_000 + this.users.size + 1, type: login.endsWith("[bot]") ? "Bot" : "User" };
      this.users.set(key, user);
    }
    return user;
  }

  repo(fullName: string): SimRepo | undefined {
    return this.repos.get(fullName.toLowerCase());
  }

  issueKey(repo: string, number: number): string {
    return `${repo.toLowerCase()}#${number}`;
  }

  pull(repo: string, number: number): SimPull | undefined {
    return this.pulls.get(this.issueKey(repo, number));
  }

  issue(repo: string, number: number): SimIssue | undefined {
    return this.issues.get(this.issueKey(repo, number));
  }

  mintToken(installationId: number, permissions: Record<string, Permission>, repositories: string[]): IssuedToken {
    this.tokenSeq += 1;
    const token: IssuedToken = {
      // GitHub's shape: "ghs_" and 36 base62-ish characters.
      token: `ghs_${randomBytes(27).toString("base64url").replace(/[-_]/g, "x").slice(0, 36)}`,
      id: `tok-${this.tokenSeq}`,
      installationId,
      permissions,
      repositories,
      expiresAt: this.now() + 60 * 60 * 1000,
      revoked: false,
    };
    this.tokens.set(token.token, token);
    return token;
  }

  /** A live (unrevoked, unexpired) installation token, or undefined. */
  liveToken(token: string): IssuedToken | undefined {
    const issued = this.tokens.get(token);
    if (!issued || issued.revoked || issued.expiresAt <= this.now()) return undefined;
    return issued;
  }

  /** The pull request's current head commit: the branch while open, the recorded one after. */
  async headSha(pull: SimPull): Promise<string | null> {
    if (pull.state === "closed" && pull.headShaAtClose) return pull.headShaAtClose;
    return this.git.resolve(pull.repo, `refs/heads/${pull.headRef}`);
  }

  /** The users a role on a repository maps to, as webhooks' `author_association` shows it. */
  association(repo: SimRepo, login: string): string {
    if (login.toLowerCase() === repo.owner.toLowerCase()) return "OWNER";
    const collaborator = repo.collaborators.get(login.toLowerCase());
    // GitHub shows any invited collaborator, whatever the role, as COLLABORATOR.
    if (collaborator) return "COLLABORATOR";
    return "NONE";
  }
}
