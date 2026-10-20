// TEST ONLY (wardby-sim). GitHub's git smart HTTP, served by `git http-backend` (git >= 2.38)
// over the simulated repositories, mounted at /github/git:
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /{owner}/{repo}.git/git-upload-pack
//   POST /{owner}/{repo}.git/git-receive-pack
//
// Basic auth only, with a live installation token as the password (any username, as GitHub
// takes "x-access-token"): Contents: read to fetch, Contents: write to push, and only for the
// repositories the token covers. A push that moves a branch fires `push` and
// `pull_request.synchronize` (events.ts) and dismisses stale approvals (protection.ts). A
// branch whose protection blocks pushes refuses the update in a pre-receive hook, with
// GitHub's GH006 message.
import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { header, matchPath, type SimRequest, type SimResponse } from "../http.js";
import type { RouteDef } from "../router.js";
import type { RouteContext, SimService } from "../service.js";
import type { SimState } from "../state.js";
import type { GitHubState } from "./state.js";

export const GITHUB_GIT_PREFIX = "/github/git";

const PRE_RECEIVE = `#!/bin/sh
# wardby-sim: refuse updates to branches whose protection blocks pushes (GitHub's GH006).
status=0
while read old new ref; do
  branch=\${ref#refs/heads/}
  if [ -f "$GIT_DIR/wardby-sim-protected" ] && grep -qxF "$branch" "$GIT_DIR/wardby-sim-protected"; then
    echo "error: GH006: Protected branch update failed for $ref." >&2
    status=1
  fi
done
exit $status
`;

/** Writes the hook and the protected-branch list into a repository (protection.ts calls it). */
export function writeProtectionHook(gh: GitHubState, fullName: string): void {
  const dir = gh.git.dir(fullName);
  const hook = join(dir, "hooks", "pre-receive");
  writeFileSync(hook, PRE_RECEIVE);
  chmodSync(hook, 0o755);
  const blocked = [...gh.protection.entries()]
    .filter(([key, rule]) => key.startsWith(`${fullName.toLowerCase()}:`) && rule.blockPushes)
    .map(([key]) => key.slice(fullName.length + 1));
  writeFileSync(join(dir, "wardby-sim-protected"), blocked.length > 0 ? `${blocked.join("\n")}\n` : "");
}

function unauthorized(): SimResponse {
  return {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="GitHub"', "content-type": "text/plain" },
    body: "Invalid username or token. Password authentication is not supported for Git operations.\n",
  };
}

function basicPassword(req: SimRequest): string | null {
  const value = header(req, "authorization");
  const match = value ? /^Basic\s+(.+)$/i.exec(value) : null;
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon === -1 ? null : decoded.slice(colon + 1);
}

/** Runs one CGI request through git http-backend and parses its CGI response. */
function httpBackend(gitRoot: string, req: SimRequest, pathInfo: string, remoteUser: string): Promise<SimResponse> {
  let input = req.rawBody;
  // git sends gzip bodies for large upload-pack requests; decode here so http-backend sees raw.
  if ((header(req, "content-encoding") ?? "").toLowerCase() === "gzip") input = gunzipSync(input);
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: tmpdir(),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_PROJECT_ROOT: gitRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: pathInfo,
        QUERY_STRING: req.query.toString(),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: header(req, "content-type") ?? "",
        CONTENT_LENGTH: String(input.length),
        REMOTE_USER: remoteUser,
        REMOTE_ADDR: "127.0.0.1",
        ...(header(req, "git-protocol") ? { GIT_PROTOCOL: header(req, "git-protocol")! } : {}),
      },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", () => {
      const raw = Buffer.concat(out);
      const split = raw.indexOf("\r\n\r\n");
      const sep = split === -1 ? raw.indexOf("\n\n") : split;
      const sepLength = split === -1 ? 2 : 4;
      if (sep === -1) {
        resolve({ status: 500, headers: { "content-type": "text/plain" }, body: Buffer.concat(err).toString("utf8") });
        return;
      }
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of raw.subarray(0, sep).toString("utf8").split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === "status") status = Number(value.split(" ")[0]);
        else headers[name] = value;
      }
      resolve({ status, headers, body: raw.subarray(sep + sepLength) });
    });
    child.stdin.end(input);
  });
}

const ROUTES: RouteDef[] = [
  { method: "GET", pattern: "/{owner}/{repo}/info/refs" },
  { method: "POST", pattern: "/{owner}/{repo}/git-upload-pack" },
  { method: "POST", pattern: "/{owner}/{repo}/git-receive-pack" },
];

export function createGitService(gh: GitHubState): SimService {
  return {
    name: "github-git",
    prefix: GITHUB_GIT_PREFIX,
    routes: () => ROUTES,
    init: (_state: SimState) => undefined,
    async handle(req: SimRequest, ctx: RouteContext): Promise<SimResponse | undefined> {
      const route = ROUTES.find((r) => r.method === req.method && matchPath(r.pattern, req.path));
      if (!route) return undefined;
      const params = matchPath(route.pattern, req.path)!;
      if (!params.repo.endsWith(".git")) return undefined;
      const fullName = `${params.owner}/${params.repo.slice(0, -4)}`;
      const repo = gh.repo(fullName);
      const push = route.pattern.endsWith("git-receive-pack") || req.query.get("service") === "git-receive-pack";
      const password = basicPassword(req);
      const token = password ? gh.liveToken(password) : undefined;
      if (!token) return unauthorized();
      ctx.principal(`installation:${token.installationId}:${token.id}`);
      if (
        !repo ||
        !token.repositories.includes(repo.fullName.toLowerCase()) ||
        token.installationId !== repo.installationId
      ) {
        return { status: 404, headers: { "content-type": "text/plain" }, body: "Repository not found.\n" };
      }
      const contents = token.permissions.contents;
      if (contents !== "write" && (push || contents !== "read")) {
        return {
          status: 403,
          headers: { "content-type": "text/plain" },
          body: `Permission to ${repo.fullName}.git denied to ${gh.app.slug}[bot].\n`,
        };
      }
      const pathInfo = `/${repo.fullName.toLowerCase()}.git${req.path.slice(req.path.indexOf(".git") + 4)}`;
      const before = route.pattern.endsWith("git-receive-pack") ? await gh.git.branches(repo.fullName) : null;
      const response = await httpBackend(gh.git.root, req, pathInfo, `${gh.app.slug}[bot]`);
      if (before) {
        const after = await gh.git.branches(repo.fullName);
        const pusher = gh.botUser();
        for (const [branch, sha] of after) {
          if (before.get(branch) !== sha) await gh.pushed(repo, branch, before.get(branch) ?? null, sha, pusher);
        }
        for (const [branch, sha] of before) {
          if (!after.has(branch)) await gh.pushed(repo, branch, sha, null, pusher);
        }
      }
      return response;
    },
  };
}
