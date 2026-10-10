import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../core/db.js";
import { handleReviewHostTool, type ReviewToolContext } from "../../core/review-host-tools.js";
import { DockerJobLauncher } from "../jobs/docker.js";
import { isolationNames } from "../jobs/docker-isolation.js";
import type { JobSpec } from "../jobs/types.js";
import { LocalReviewHost } from "../review-host/local.js";
import { GitVcsProvider } from "../vcs/git.js";
import { LocalRemote } from "../vcs/local-remote.js";

/**
 * End to end for `local:` repositories through the real Docker launcher: the
 * production Claude worker and tool runner run against a workspace cloned from
 * a local repository, with the same scripted model proxy the Claude Docker
 * acceptance test uses (no API key, no network). Gated like that test.
 *
 * Run: WARDBY_CLAUDE_DOCKER_TEST=1 WARDBY_CLAUDE_WORKER_IMAGE=sha256:<id>
 * WARDBY_CLAUDE_TOOL_RUNNER_IMAGE=sha256:<id> npx vitest run <this file>
 * (the whole describe is skipped when DATABASE_URL is unset, since the review half needs it). The images must be built from this
 * checkout (src/claude-coding-worker/Dockerfile, src/claude-tool-runner/Dockerfile):
 * a worker built before `local:` support rejects the task input.
 */
const execute = promisify(execFile);
const enabled = process.env.WARDBY_CLAUDE_DOCKER_TEST === "1";
const agentImage = process.env.WARDBY_CLAUDE_WORKER_IMAGE ?? "";
const toolImage = process.env.WARDBY_CLAUDE_TOOL_RUNNER_IMAGE ?? "";
const token = `${process.pid}-${Date.now()}`;
const runId = `local-repo-docker-${token}`;
const proxy = `wardby-local-repo-proxy-${token}`;
const capability = "rrp_0123456789abcdef";
const names = isolationNames(runId);
const CHANGED_FILE = "docker-e2e.txt";
const TOOL_COMMAND = `printf 'written in docker\\n' > /workspace/${CHANGED_FILE}`;

async function docker(args: string[]): Promise<string> {
  try {
    const result = await execute("docker", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    const details = error as Error & { stderr?: string; stdout?: string };
    throw new Error([details.message, details.stderr, details.stdout].filter(Boolean).join("\n"), { cause: error });
  }
}

async function cleanup(args: string[]): Promise<void> {
  try {
    await docker(args);
  } catch {
    // Idempotent cleanup after an interrupted run.
  }
}

function runFilters(id: string): string[] {
  return [
    "--filter",
    "label=io.wardby.managed=true",
    "--filter",
    `label=io.wardby.run-sha256=${createHash("sha256").update(id).digest("hex")}`,
  ];
}

async function sweep(id: string): Promise<void> {
  const lines = async (args: string[]) => (await docker(args).catch(() => "")).split("\n").filter(Boolean);
  for (const container of await lines(["container", "ls", "--all", "--quiet", ...runFilters(id)])) {
    await cleanup(["container", "rm", "--force", "--volumes", container]);
  }
  await cleanup(["network", "disconnect", "--force", isolationNames(id).network, proxy]);
  for (const network of await lines(["network", "ls", "--quiet", ...runFilters(id)])) {
    await cleanup(["network", "rm", network]);
  }
  for (const volume of await lines(["volume", "ls", "--quiet", ...runFilters(id)])) {
    await cleanup(["volume", "rm", "--force", volume]);
  }
}

const isolatedEnv = (home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  LANG: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});

function fakeProxyProgram(): string {
  return String.raw`
const http = require('node:http');
const text = process.env.FAKE_RESULT;
// Through the npm shim: two Node processes plus npm must fit in the tool runner's PID limit.
const TOOL_INPUT = { command: process.env.FAKE_TOOL_COMMAND || 'printf "%s\\n" "$npm_config_registry"; npm --version', timeout_ms: 30000 };
let turn = 0;
function toolSse(id, name, input) { return [
  { type: 'message_start', message: { id: 'msg_wardby_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } },
  { type: 'message_stop' },
].map((frame) => 'event: ' + frame.type + '\\ndata: ' + JSON.stringify(frame) + '\\n\\n').join(''); }
http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body;
  try { body = JSON.parse(raw); } catch {}
  console.log(JSON.stringify({ method: request.method, url: request.url, stream: body?.stream, messages: body?.messages, lastMessage: body?.messages?.at(-1), validCapability: request.headers['x-api-key'] === process.env.EXPECTED_CAPABILITY }));
  if (request.method === 'HEAD' && request.url === '/api/hello') return response.writeHead(200, { 'cache-control': 'no-store' }).end();
  if (request.method === 'POST' && request.url === '/v1/messages?beta=true') {
    if (body?.stream === false) {
      const structured = turn > 1;
      const id = structured ? 'toolu_structured_docker' : 'toolu_wardby_docker';
      const name = structured ? 'StructuredOutput' : 'mcp__wardby_tools__run_command';
      const input = structured ? JSON.parse(text) : TOOL_INPUT;
      return response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({
        id: 'msg_wardby_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
        content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 7 },
      }));
    }
    const payload = turn++ === 0
      ? toolSse('toolu_wardby_docker', 'mcp__wardby_tools__run_command', TOOL_INPUT)
      : toolSse('toolu_structured_docker', 'StructuredOutput', JSON.parse(text));
    return response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }).end(payload);
  }
  response.writeHead(404).end();
}).listen(8787, '0.0.0.0');
`;
}

describe.skipIf(!enabled || !agentImage || !toolImage || !process.env.DATABASE_URL)(
  "local repository end to end (Docker)",
  () => {
    let root: string | undefined;
    const db = createPrismaClient();
    let prId: string | undefined;

    afterAll(async () => {
      await sweep(runId);
      await cleanup(["container", "rm", "--force", proxy]);
      if (root) await rm(root, { recursive: true, force: true });
      if (prId) await db.localPullRequest.deleteMany({ where: { id: prId } });
      await db.$disconnect();
    }, 60_000);

    it("runs the worker on a clone, pushes wardby/run-<id> to the source, then records a review of it", async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), "wardby-local-repo-docker-")));
      const home = join(root, "home");
      const src = join(root, "repos", "src");
      const workspaces = join(root, "workspaces");
      await mkdir(home);
      await mkdir(src, { recursive: true });
      const git = async (...args: string[]) =>
        (
          await execute("git", ["-c", "commit.gpgSign=false", ...args], { cwd: src, env: isolatedEnv(home) })
        ).stdout.trim();
      await git("init", "--initial-branch=main");
      await writeFile(join(src, "README.md"), "hello\n");
      await git("add", "README.md");
      await git("commit", "-m", "c1");
      const snapshot = async () => ({
        head: await git("rev-parse", "HEAD"),
        status: await git("status", "--porcelain", "--untracked-files=all"),
        readme: await readFile(join(src, "README.md"), "utf8"),
        branches: await git("branch", "--list"),
      });
      const before = await snapshot();
      const roots = [join(root, "repos")];

      // Host side: clone the local repository into the launcher's workspace root.
      const vcs = new GitVcsProvider({ rootDir: workspaces, remote: new LocalRemote({ roots: () => roots }) });
      const workspace = await vcs.prepareWorkspace({
        runId,
        repository: `local:${src}`,
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        protectedPaths: [".github/workflows/**", "CODEOWNERS"],
      });
      const input = join(root, "input.json");
      await writeFile(
        input,
        JSON.stringify({
          schemaVersion: 1,
          runId,
          repository: `local:${src}`,
          baseRef: "main",
          headRef: `wardby/run-${runId}`,
          task: `Create ${CHANGED_FILE}.`,
          model: "claude-sonnet-5",
          budgetUsd: 0.25,
          deadlineAt: new Date(Date.now() + 90_000).toISOString(),
        }),
      );
      const output = {
        schemaVersion: 1,
        runId,
        outcome: "changes_ready",
        summary: "wrote a file",
        tests: [],
        tag: "fixture",
      };
      await docker([
        "container",
        "create",
        "--name",
        proxy,
        "--network",
        "bridge",
        "--env",
        `EXPECTED_CAPABILITY=${capability}`,
        "--env",
        `FAKE_RESULT=${JSON.stringify(output)}`,
        "--env",
        `FAKE_TOOL_COMMAND=${TOOL_COMMAND}`,
        "--entrypoint",
        "node",
        agentImage,
        "-e",
        fakeProxyProgram(),
      ]);
      await docker(["container", "start", proxy]);

      const launcher = new DockerJobLauncher({
        stateRoot: join(root, "state"),
        workspaceRoot: workspaces,
        proxyContainer: proxy,
        resolveCapability: async () => capability,
        isRunActive: async () => false,
      });
      const spec: JobSpec = {
        kind: "coding-agent",
        provider: "claude-code",
        runId,
        image: agentImage,
        toolImage,
        inputArtifact: input,
        timeoutSec: 90,
        limits: { cpus: 1, memoryMb: 512, pids: 128, diskMb: 64 },
        labels: {},
      };
      const handle = await launcher.launch(spec);
      let status = await launcher.status(handle);
      for (let attempt = 0; attempt < 800 && (status.state === "pending" || status.state === "running"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        status = await launcher.status(handle);
      }
      if (status.state === "failed") {
        throw new Error(
          `worker_failed:${JSON.stringify(status)}:collect:${JSON.stringify(await launcher.collect(handle).catch((e) => String(e)))}:tool:${await docker(["container", "logs", names.toolContainer]).catch(() => "")}:${await docker(["container", "logs", names.workerContainer])}:proxy:${await docker(["container", "logs", proxy])}`,
        );
      }
      expect(status).toEqual({ state: "succeeded" });
      const collected = await launcher.collect(handle);
      expect(collected.exitCode).toBe(0);
      expect(JSON.parse(collected.resultArtifact ?? "{}")).toMatchObject({ outcome: "changes_ready" });
      // Same step the container executor takes before finalizeChanges.
      await launcher.materializeWorkspace(handle, workspace.workspacePath);
      await launcher.remove(handle);

      // Host side: commit and push the worker's changes back to the source repository.
      const result = await vcs.finalizeChanges(workspace);
      expect(result).toMatchObject({
        outcome: "branch_pushed",
        headRef: `wardby/run-${runId}`,
        baseCommit: before.head,
      });
      if (result.outcome !== "branch_pushed") throw new Error("unreachable");
      expect(await git("rev-parse", `wardby/run-${runId}`)).toBe(result.commitSha);
      expect(await git("show", `wardby/run-${runId}:${CHANGED_FILE}`)).toBe("written in docker");
      await vcs.cleanup(workspace);

      // The source checkout is untouched apart from the new branch.
      const after = await snapshot();
      expect({ ...after, branches: undefined }).toEqual({ ...before, branches: undefined });
      expect(after.branches.split("\n").map((line) => line.replace(/^[*\s]+/, ""))).toEqual(
        expect.arrayContaining(["main", `wardby/run-${runId}`]),
      );
      expect(await readFile(join(src, "README.md"), "utf8")).toBe("hello\n");
      expect(
        await readFile(join(src, CHANGED_FILE)).then(
          () => true,
          () => false,
        ),
      ).toBe(false);

      // Review half: no engine: the repo_* review tools are driven directly over the produced branch.
      const pr = await db.localPullRequest.create({
        data: { repository: `local:${src}`, branch: `wardby/run-${runId}`, base: "main" },
      });
      prId = pr.id;
      const agentId = `local-repo-docker-reviewer-${token}`;
      const ctx: ReviewToolContext = {
        agentId,
        links: [{ provider: "local", repository: `local:${src}`, access: "write", checkName: null, waitForCi: false }],
        hosts: { local: new LocalReviewHost({ db, roots: () => roots }) },
        runCheck: null,
        markRunCheckCompleted: async () => {},
        authorize: async () => ({ ok: true }),
        db,
      };
      const read = JSON.parse(
        await handleReviewHostTool(
          "repo_pr_read",
          JSON.stringify({ repository: `local:${src}`, prNumber: pr.number }),
          ctx,
        ),
      ) as { head?: { sha?: string }; files?: { filename: string }[] };
      expect(JSON.stringify(read)).toContain(CHANGED_FILE);
      const published = JSON.parse(
        await handleReviewHostTool(
          "repo_publish_review",
          JSON.stringify({
            repository: `local:${src}`,
            prNumber: pr.number,
            headSha: result.commitSha,
            verdict: "APPROVE",
            summary: "looks fine",
            body: "The change adds one file.",
          }),
          ctx,
        ),
      ) as { error?: unknown };
      expect(published.error).toBeUndefined();
      const reviews = await db.localReview.findMany({ where: { pullRequestId: pr.id } });
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({ agentId, headSha: result.commitSha, verdict: "APPROVE" });
    }, 180_000);
  },
);
