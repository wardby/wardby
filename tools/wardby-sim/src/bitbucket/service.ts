// TEST ONLY (wardby-sim). The simulated Bitbucket Cloud REST API 2.0 at /bitbucket/api: the read
// routes a host provider's tools call, and the effective-permission endpoint with its failures.
// Write routes and git arrive with the Wardby changes that use them.
import { header, json, text, textOf, type SimRequest, type SimResponse } from "../http.js";
import { Router } from "../router.js";
import type { ScriptAction, SimService } from "../service.js";
import type { SimState } from "../state.js";
import { BitbucketState, type BitbucketPullRequest, type BitbucketRepo } from "./state.js";

export const BITBUCKET_API_PREFIX = "/bitbucket/api";
const WEB = "https://bitbucket.org";
const API = "https://api.bitbucket.org";

function fail(status: number, message: string): SimResponse {
  return json({ type: "error", error: { message } }, status);
}

function bearer(req: SimRequest): string | undefined {
  const value = header(req, "authorization");
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

function pullRequestJson(repo: BitbucketRepo, pr: BitbucketPullRequest): Record<string, unknown> {
  return {
    type: "pullrequest",
    id: pr.id,
    title: pr.title,
    description: pr.description,
    state: pr.state,
    draft: pr.draft,
    author: { account_id: pr.author, display_name: pr.author },
    source: { branch: { name: pr.headRef }, commit: { hash: pr.headSha }, repository: { full_name: repo.fullName } },
    destination: { branch: { name: pr.baseRef }, repository: { full_name: repo.fullName } },
    links: { html: { href: `${WEB}/${repo.fullName}/pull-requests/${pr.id}` } },
  };
}

function paged(values: unknown[]): SimResponse {
  return json({ pagelen: values.length, page: 1, size: values.length, values });
}

function quoted(query: string | null, field: string): string | null {
  if (!query) return null;
  const match = new RegExp(`^${field.replaceAll(".", "\\.")}="([^"]*)"$`).exec(query);
  return match ? match[1] : null;
}

export function createBitbucketSim(): { service: SimService; state: BitbucketState } {
  const state = new BitbucketState();
  const router = new Router();

  /** The repository a call may read, or the response that refuses it. */
  const access = (req: SimRequest, workspace: string, slug: string): BitbucketRepo | SimResponse => {
    const token = bearer(req);
    const grant = token ? state.tokens.get(token) : undefined;
    if (!grant) return fail(401, "Authentication required");
    const fullName = `${workspace}/${slug}`;
    if (grant.kind === "repository" && grant.repository !== fullName) return fail(403, "Forbidden");
    return state.repo(fullName) ?? fail(404, "Repository not found");
  };
  const isRepo = (value: BitbucketRepo | SimResponse): value is BitbucketRepo => "fullName" in value;

  const onRepo = (
    pattern: string,
    handler: (req: SimRequest, repo: BitbucketRepo, params: Record<string, string>) => SimResponse,
  ) => {
    router.on("GET", `/2.0/repositories/{workspace}/{slug}${pattern}`, (req, params) => {
      const repo = access(req, params.workspace, params.slug);
      return isRepo(repo) ? handler(req, repo, params) : repo;
    });
  };

  onRepo("/pullrequests", (req, repo) => {
    const branch = quoted(req.query.get("q"), "source.branch.name");
    const all = [...repo.pullRequests.values()];
    const found = branch === null ? all : all.filter((pr) => pr.headRef === branch);
    return paged(found.map((pr) => pullRequestJson(repo, pr)));
  });
  onRepo("/pullrequests/{id}", (_req, repo, params) => {
    const pr = repo.pullRequests.get(Number(params.id));
    return pr ? json(pullRequestJson(repo, pr)) : fail(404, "Pull request not found");
  });
  onRepo("/pullrequests/{id}/diffstat", (_req, repo, params) => {
    if (!repo.pullRequests.has(Number(params.id))) return fail(404, "Pull request not found");
    return paged(
      Object.keys(repo.files).map((path) => ({
        status: "modified",
        lines_added: 1,
        lines_removed: 0,
        new: { path },
        old: { path },
      })),
    );
  });
  onRepo("/pullrequests/{id}/diff", (_req, repo, params) => {
    const pr = repo.pullRequests.get(Number(params.id));
    if (!pr) return fail(404, "Pull request not found");
    return {
      status: 302,
      headers: { location: `${API}/2.0/repositories/${repo.fullName}/diff/${pr.headSha}..${pr.baseRef}` },
    };
  });
  onRepo("/diff/{spec}", (_req, repo) => text(repo.diff));
  onRepo("/pullrequests/{id}/comments", (_req, repo, params) =>
    paged(
      (repo.comments.get(Number(params.id)) ?? []).map((c) => ({
        id: c.id,
        content: { raw: c.body },
        user: { account_id: c.author, display_name: c.author },
        created_on: c.createdAt,
        ...(c.path ? { inline: { path: c.path, to: c.line } } : {}),
        ...(c.parentId ? { parent: { id: c.parentId } } : {}),
        ...(c.resolved ? { resolution: { type: "comment_resolution" } } : {}),
      })),
    ),
  );
  onRepo("/commit/{commit}/statuses", (_req, repo, params) =>
    paged(
      (repo.statuses.get(params.commit) ?? []).map((s) => ({ key: s.key, state: s.state, url: s.url, type: "build" })),
    ),
  );
  router.on("GET", "/2.0/repositories/{workspace}/{slug}/src/{commit}/*", (req, params) => {
    const repo = access(req, params.workspace, params.slug);
    if (!isRepo(repo)) return repo;
    const path = params["*"].replace(/\/$/, "");
    const file = repo.files[path];
    if (file !== undefined) return text(file);
    const prefix = path === "" ? "" : `${path}/`;
    const children = Object.keys(repo.files).filter((p) => p.startsWith(prefix));
    if (children.length === 0) return fail(404, "Path not found");
    return paged(children.map((p) => ({ path: p, type: "commit_file", size: repo.files[p].length })));
  });

  // Effective permissions: needs workspace reach. A repository token "can't be used to manage or
  // interact with workspaces" (Atlassian's access token docs).
  router.on("GET", "/2.0/workspaces/{workspace}/permissions/repositories/{slug}", (req, params) => {
    const token = bearer(req);
    const grant = token ? state.tokens.get(token) : undefined;
    if (!grant) return fail(401, "Authentication required");
    if (grant.kind !== "workspace") return fail(403, "Forbidden");
    const fullName = `${params.workspace}/${params.slug}`;
    if (!state.repo(fullName)) return fail(404, "Repository not found");
    const account = quoted(req.query.get("q"), "user.account_id");
    if (account === null) return fail(400, "Unsupported query");
    const permission = state.permission(fullName, account);
    return paged(
      permission
        ? [
            {
              permission,
              type: "repository_permission",
              user: { account_id: account },
              repository: { full_name: fullName },
            },
          ]
        : [],
    );
  });

  const str = (args: Record<string, unknown>, key: string): string => {
    const value = textOf(args[key]);
    if (!value) throw new Error(`${key} is required`);
    return value;
  };
  const needRepo = (args: Record<string, unknown>): BitbucketRepo => {
    const repo = state.repo(str(args, "repo"));
    if (!repo) throw new Error("no such repository");
    return repo;
  };
  const actions: Record<string, ScriptAction> = {
    "bitbucket.repo": async (args) => {
      state.addRepo(str(args, "repo"), {
        ...(typeof args.files === "object" && args.files ? { files: args.files as Record<string, string> } : {}),
        ...(typeof args.diff === "string" ? { diff: args.diff } : {}),
      });
      return { repo: args.repo };
    },
    "bitbucket.pull_request": async (args) => {
      const repo = needRepo(args);
      return state.addPullRequest(repo.fullName, { ...(args as Partial<BitbucketPullRequest>), id: Number(args.id) });
    },
    "bitbucket.comment": async (args) => {
      const repo = needRepo(args);
      const pr = Number(args.pr);
      const comments = repo.comments.get(pr) ?? [];
      const comment = {
        id: comments.length + 1,
        author: textOf(args.author, "sim-account"),
        body: textOf(args.body),
        createdAt: new Date(0).toISOString(),
        path: typeof args.path === "string" ? args.path : null,
        line: typeof args.line === "number" ? args.line : null,
        parentId: typeof args.parentId === "number" ? args.parentId : null,
        resolved: args.resolved === true,
      };
      comments.push(comment);
      repo.comments.set(pr, comments);
      return comment;
    },
    "bitbucket.status": async (args) => {
      const repo = needRepo(args);
      const commit = str(args, "commit");
      repo.statuses.set(commit, [
        ...(repo.statuses.get(commit) ?? []),
        { key: str(args, "key"), state: str(args, "state"), url: typeof args.url === "string" ? args.url : null },
      ]);
      return { commit };
    },
    "bitbucket.permission": async (args) => {
      state.setPermission(str(args, "repo"), str(args, "account"), str(args, "permission"));
      return {};
    },
    "bitbucket.token": async (args) => {
      state.tokens.set(
        str(args, "token"),
        args.kind === "workspace" ? { kind: "workspace" } : { kind: "repository", repository: str(args, "repo") },
      );
      return {};
    },
  };

  const service: SimService = {
    name: "bitbucket",
    prefix: BITBUCKET_API_PREFIX,
    handle: (req, ctx) => router.handle(req, ctx),
    routes: () => router.routes(),
    actions,
    init(simState: SimState) {
      if (!simState.part("bitbucket")) simState.register("bitbucket", { reset: () => state.reset() });
    },
  };
  return { service, state };
}

export function createBitbucketService(): SimService {
  return createBitbucketSim().service;
}
