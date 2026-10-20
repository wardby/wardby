// TEST ONLY (wardby-sim). The simulated GitHub REST API (mounted at /github/api) and the
// scripted actions a test seeds and drives it with.
import { record, textOf } from "../http.js";
import type { ScriptAction, SimService } from "../service.js";
import type { SimState } from "../state.js";
import { GitStore } from "./git-store.js";
import {
  addComment,
  addReviewComment,
  commentableLines,
  githubRestRouter,
  openPull,
  pullBody,
  pullFiles,
  registerReview,
} from "./rest.js";
import { commentJson, issueJson, reviewJson } from "./shapes.js";
import { GitHubState, type Permission, type SimApp, type SimRepo } from "./state.js";
import { SIM_APP_ID, SIM_APP_PUBLIC_KEY_PEM, SIM_APP_SLUG } from "./test-app-key.js";

export const GITHUB_API_PREFIX = "/github/api";

export interface GitHubSimOptions {
  app?: Partial<SimApp>;
  /** Where bare repositories live (default: a fresh temp dir). */
  gitRoot?: string;
}

export const DEFAULT_INSTALLATION_PERMISSIONS: Record<string, Permission> = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "write",
  statuses: "write",
  metadata: "read",
};

function str(args: Record<string, unknown>, key: string, fallback?: string): string {
  const value = args[key];
  if (typeof value === "string" && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${key} is required`);
}

function needRepo(gh: GitHubState, args: Record<string, unknown>): SimRepo {
  const repo = gh.repo(str(args, "repo"));
  if (!repo) throw new Error("no such repo");
  return repo;
}

export interface GitHubSim {
  service: SimService;
  state: GitHubState;
}

export function createGitHubSim(options: GitHubSimOptions = {}): GitHubSim {
  const app: SimApp = {
    id: options.app?.id ?? SIM_APP_ID,
    slug: options.app?.slug ?? SIM_APP_SLUG,
    ownerLogin: options.app?.ownerLogin ?? "sim-owner",
    ...(options.app && "publicKeyPem" in options.app
      ? options.app.publicKeyPem
        ? { publicKeyPem: options.app.publicKeyPem }
        : {}
      : { publicKeyPem: SIM_APP_PUBLIC_KEY_PEM }),
  };
  const gh = new GitHubState(new GitStore(options.gitRoot), { app });
  const router = githubRestRouter(gh);

  const actions: Record<string, ScriptAction> = {
    "github.install": async (args) => {
      const id = typeof args.id === "number" ? args.id : gh.nextId();
      const permissions =
        (args.permissions as Record<string, Permission> | undefined) ?? DEFAULT_INSTALLATION_PERMISSIONS;
      gh.installations.set(id, { id, account: str(args, "account"), permissions });
      gh.user(str(args, "account"));
      return { id };
    },
    "github.repo": async (args) => {
      const fullName = str(args, "repo");
      const [owner, name] = fullName.split("/");
      if (!owner || !name) throw new Error("repo must be owner/name");
      const installation =
        typeof args.installation === "number"
          ? gh.installations.get(args.installation)
          : [...gh.installations.values()].find((i) => i.account.toLowerCase() === owner.toLowerCase());
      if (!installation) throw new Error("install the App on the owner first (github.install)");
      const defaultBranch = str(args, "defaultBranch", "main");
      const id = gh.nextId();
      gh.user(owner);
      gh.repos.set(fullName.toLowerCase(), {
        id,
        nodeId: `R_sim${id}`,
        fullName,
        owner,
        name,
        private: args.private === true,
        defaultBranch,
        installationId: installation.id,
        collaborators: new Map(),
        nextNumber: 1,
      });
      await gh.git.create(fullName, defaultBranch);
      const files = (record(args.files) as Record<string, string>) ?? {};
      const sha = await gh.git.commit(fullName, {
        branch: defaultBranch,
        files: Object.keys(files).length > 0 ? files : { "README.md": `# ${name}\n` },
        message: "Initial commit",
        parent: null,
      });
      return { id, sha };
    },
    "github.commit": async (args) => {
      const repo = needRepo(gh, args);
      const branch = str(args, "branch");
      const existing = await gh.git.resolve(repo.fullName, `refs/heads/${branch}`);
      const parent = existing ?? (await gh.git.resolve(repo.fullName, str(args, "from", repo.defaultBranch)));
      if (!parent) throw new Error("no base to branch from");
      const sha = await gh.git.commit(repo.fullName, {
        branch,
        files: record(args.files) as Record<string, string | null>,
        message: str(args, "message", "Sim commit"),
        parent,
      });
      await gh.onPush?.(repo, branch, existing, sha, gh.user(str(args, "author", repo.owner)));
      return { sha };
    },
    "github.user": async (args) => {
      const user = gh.user(str(args, "login"));
      return { login: user.login, id: user.id };
    },
    "github.collaborator": async (args) => {
      const repo = needRepo(gh, args);
      const user = gh.user(str(args, "login"));
      const role = str(args, "role", "write") as "admin" | "maintain" | "write" | "triage" | "read";
      repo.collaborators.set(user.login.toLowerCase(), { user, role });
      return { login: user.login, id: user.id };
    },
    "github.issue": async (args) => {
      const repo = needRepo(gh, args);
      const user = gh.user(str(args, "author", repo.owner));
      const number = repo.nextNumber++;
      const id = gh.nextId();
      const now = gh.iso();
      const issue = {
        repo: repo.fullName.toLowerCase(),
        number,
        id,
        nodeId: `I_sim${id}`,
        title: str(args, "title"),
        body: typeof args.body === "string" ? args.body : null,
        state: "open" as const,
        stateReason: null,
        user,
        labels: Array.isArray(args.labels) ? args.labels.map(String) : [],
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        isPull: false,
      };
      gh.issues.set(gh.issueKey(repo.fullName, number), issue);
      gh.emit("issues", { action: "opened", issue: issueJson(gh, issue) }, repo, user);
      return { number };
    },
    "github.label": async (args) => {
      const repo = needRepo(gh, args);
      const issue = gh.issue(repo.fullName, Number(args.number));
      if (!issue) throw new Error("no such issue");
      const label = str(args, "label");
      if (!issue.labels.includes(label)) issue.labels.push(label);
      const sender = gh.user(str(args, "author", repo.owner));
      gh.emit(
        issue.isPull ? "pull_request" : "issues",
        {
          action: "labeled",
          label: { name: label },
          ...(issue.isPull
            ? { number: issue.number, pull_request: await pullBody(gh, gh.pull(repo.fullName, issue.number)!) }
            : { issue: issueJson(gh, issue) }),
        },
        repo,
        sender,
      );
      return { labels: issue.labels };
    },
    "github.comment": async (args) => {
      const repo = needRepo(gh, args);
      const issue = gh.issue(repo.fullName, Number(args.number));
      if (!issue) throw new Error("no such issue");
      const user = gh.user(str(args, "author"));
      const comment = addComment(gh, repo, issue.number, str(args, "body"), user, null);
      if (typeof args.authorAssociation === "string") comment.authorAssociation = args.authorAssociation;
      gh.emit(
        "issue_comment",
        { action: "created", issue: issueJson(gh, issue), comment: commentJson(gh, comment) },
        repo,
        user,
      );
      return { id: comment.id };
    },
    "github.pull": async (args) => {
      const repo = needRepo(gh, args);
      const user = gh.user(str(args, "author", repo.owner));
      const pull = openPull(gh, repo, {
        title: str(args, "title"),
        body: typeof args.body === "string" ? args.body : null,
        headRef: str(args, "head"),
        baseRef: str(args, "base", repo.defaultBranch),
        draft: args.draft === true,
        user,
      });
      gh.emit(
        "pull_request",
        { action: "opened", number: pull.number, pull_request: await pullBody(gh, pull) },
        repo,
        user,
      );
      return { number: pull.number };
    },
    "github.review": async (args) => {
      const repo = needRepo(gh, args);
      const pull = gh.pull(repo.fullName, Number(args.number));
      if (!pull) throw new Error("no such pull request");
      const user = gh.user(str(args, "author"));
      const event = str(args, "event", "COMMENT");
      const state = event === "APPROVE" ? "APPROVED" : event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED";
      const commitId = (await gh.headSha(pull))!;
      const review = registerReview(gh, repo, pull, {
        user,
        viaApp: null,
        state,
        body: str(args, "body", ""),
        commitId,
      });
      const comments = Array.isArray(args.comments) ? args.comments.map(record) : [];
      const files = await pullFiles(gh, pull);
      for (const c of comments) {
        const file = files.find((f) => f.filename === c.path);
        if (!file || !commentableLines(file.patch, "RIGHT").has(Number(c.line)))
          throw new Error("line not in the diff");
        addReviewComment(gh, repo, pull, {
          reviewId: review.id,
          path: String(c.path),
          line: Number(c.line),
          side: "RIGHT",
          body: textOf(c.body),
          user,
          viaApp: null,
          commitId,
          inReplyTo: null,
        });
      }
      gh.emit(
        "pull_request_review",
        { action: "submitted", review: reviewJson(gh, review), pull_request: await pullBody(gh, pull) },
        repo,
        user,
      );
      return { id: review.id };
    },
    "github.check": async (args) => {
      const repo = needRepo(gh, args);
      const sha = await gh.git.resolve(repo.fullName, str(args, "ref"));
      if (!sha) throw new Error("no such ref");
      const id = gh.nextId();
      const status = str(args, "status", "completed") as "queued" | "in_progress" | "completed";
      gh.checkRuns.set(id, {
        id,
        repo: repo.fullName.toLowerCase(),
        headSha: sha,
        name: str(args, "name"),
        status,
        conclusion: status === "completed" ? str(args, "conclusion", "success") : null,
        externalId: null,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        appId: typeof args.appId === "number" ? args.appId : 15368, // another App (e.g. a CI)
        startedAt: gh.iso(),
        completedAt: status === "completed" ? gh.iso() : null,
      });
      gh.onCheckChange?.(repo, sha);
      return { id, sha };
    },
    "github.status": async (args) => {
      const repo = needRepo(gh, args);
      const sha = await gh.git.resolve(repo.fullName, str(args, "ref"));
      if (!sha) throw new Error("no such ref");
      const id = gh.nextId();
      gh.statuses.push({
        id,
        repo: repo.fullName.toLowerCase(),
        sha,
        state: str(args, "state", "success") as "success",
        context: str(args, "context", "ci"),
        description: null,
        targetUrl: null,
        createdAt: gh.iso(),
      });
      gh.onCheckChange?.(repo, sha);
      return { id, sha };
    },
    "github.clock": async (args) => {
      const offset = Number(args.offsetMs ?? 0);
      gh.now = () => Date.now() + offset;
      return { now: gh.iso() };
    },
    "github.rate_limit": async (args, { state }) => {
      // GitHub's secondary rate limit: 403 with retry-after and this message.
      return state.faults.add({
        service: "github",
        method: str(args, "method", "*"),
        path: str(args, "path"),
        mode: args.mode === "sticky" ? "sticky" : "once",
        response: {
          status: 403,
          headers: { "content-type": "application/json; charset=utf-8", "retry-after": textOf(args.retryAfter, "1") },
          body: JSON.stringify({
            message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
            documentation_url:
              "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits",
            status: "403",
          }),
        },
      });
    },
    "github.inspect": async (args) => {
      const repo = needRepo(gh, args);
      const key = repo.fullName.toLowerCase();
      return {
        branches: Object.fromEntries(await gh.git.branches(repo.fullName)),
        issues: [...gh.issues.values()]
          .filter((i) => i.repo === key)
          .map((i) => ({ number: i.number, state: i.state, isPull: i.isPull, title: i.title, labels: i.labels })),
        pulls: [...gh.pulls.values()]
          .filter((p) => p.repo === key)
          .map((p) => ({
            number: p.number,
            state: p.state,
            draft: p.draft,
            merged: p.merged,
            head: p.headRef,
            base: p.baseRef,
            body: p.body,
          })),
        comments: [...gh.comments.values()]
          .filter((c) => c.repo === key)
          .map((c) => ({ id: c.id, issue: c.issueNumber, user: c.user.login, body: c.body })),
        reactions: gh.reactions
          .filter((r) => r.subject.repo === key)
          .map((r) => ({ subject: r.subject, content: r.content, user: r.user.login })),
        reviews: [...gh.reviews.values()]
          .filter((r) => r.repo === key)
          .map((r) => ({ id: r.id, pull: r.pull, user: r.user.login, state: r.state, commitId: r.commitId })),
        checkRuns: [...gh.checkRuns.values()]
          .filter((r) => r.repo === key)
          .map((r) => ({
            id: r.id,
            name: r.name,
            headSha: r.headSha,
            status: r.status,
            conclusion: r.conclusion,
            appId: r.appId,
          })),
      };
    },
  };

  const service: SimService = {
    name: "github",
    prefix: GITHUB_API_PREFIX,
    handle: (req, ctx) => router.handle(req, ctx),
    routes: () => router.routes(),
    actions,
    init: (state: SimState) => {
      if (!state.part("github")) state.register("github", gh);
    },
  };
  return { service, state: gh };
}
