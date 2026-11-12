/**
 * The fork-sync scenario (#537, docs/agent-recipes.md "fork sync") shared by the Docker and kind
 * end-to-end tests: three `local:` repositories with a real conflict, the coding agent and its two
 * read links, the scripted model, the ContainerExecutor wiring and the assertions. Only the job
 * launcher (and how the scripted proxy runs and is read) differs between the two.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import type { PrismaClient } from "#prisma";
import { dispatchRun } from "../../core/dispatch.js";
import { createRepoAccessGate } from "../../core/repo-access.js";
import type { WorkspaceJobLauncher } from "../jobs/types.js";
import { GitVcsProvider } from "../vcs/git.js";
import { LocalRemote } from "../vcs/local-remote.js";
import { RoutingVcsProvider } from "../vcs/routing.js";
import {
  ContainerExecutor,
  PrismaContainerExecutionStore,
  RunCapabilityVault,
  type CodingSessionController,
  type ProvisioningClaim,
} from "./container.js";

const execute = promisify(execFile);

/** The capability the fake session hands out and the scripted proxy expects. */
export const FORK_SYNC_CAPABILITY = "rrp_0123456789abcdef";

/**
 * The fork-sync merge for Claude Code (its tool runner has no git, and /repos copies no .git):
 * <U1> is replaced by the scripted model with upstream's full commit from the task. Prints the
 * diff3 and read-only-touch exit codes, then deletes its marker so it is never committed.
 */
export const CLAUDE_MERGE_COMMAND = [
  "touch /repos/base/x; echo $? > /workspace/.ro.rc",
  "for f in app.txt new.txt; do",
  "  if [ -f /repos/upstream/$f ] && [ -f /workspace/$f ]; then",
  "    diff3 -m -E /workspace/$f /repos/base/$f /repos/upstream/$f > /tmp/m; echo $? > /tmp/diff3.rc",
  "    cp /tmp/m /workspace/$f",
  "  elif [ -f /repos/upstream/$f ]; then",
  "    cp /repos/upstream/$f /workspace/$f",
  "  fi",
  "done",
  "sed -i '/^<<<<<<< /d;/^=======$/d;/^>>>>>>> /d' /workspace/app.txt",
  "printf '%s\\n' <U1> > /workspace/upstream-sync",
  'echo "diff3.rc=$(cat /tmp/diff3.rc) ro.rc=$(cat /workspace/.ro.rc)"',
  "rm /workspace/.ro.rc",
].join("\n");

/** The fork-sync final answer; the scripted model adds the run id from the task. */
export const FORK_SYNC_RESULT = {
  schemaVersion: 1,
  outcome: "changes_ready",
  summary: "Merged upstream into the fork.",
  tests: [],
  tag: "fixture",
};

/** What the run's task asks for. */
export const FORK_SYNC_TASK =
  "Merge what changed between /repos/base and /repos/upstream into the fork, then write upstream's full commit into upstream-sync.";

/**
 * The scripted model, as a Node program listening on 8787 (the coding proxy's port): one
 * run_command (FAKE_TOOL_COMMAND with <U1> replaced by the full commit on the task's
 * "Extra repository /repos/upstream" line), then the final JSON (FAKE_RESULT with the task's run
 * id). Every request is logged as one JSON line, so the tool result the model was sent (the
 * command's output) is read from the proxy's logs. A Codex Responses request is held open, so a
 * Codex worker stays up while a test inspects it.
 */
export function forkSyncProxyProgram(): string {
  return String.raw`
const http = require('node:http');
// Stateless per request (one long-lived proxy may serve several runs): the run id and upstream's
// commit come from the request's own task, and the turn from whether the command's result is in it.
function fromTask(body) {
  const text = JSON.stringify(body?.messages ?? []);
  return {
    runId: /The final JSON runId must be ([A-Za-z0-9_-]+)\./.exec(text)?.[1] ?? '',
    upstream: /Extra repository \/repos\/upstream: [^"]*? at ([0-9a-f]{40}), read-only\./.exec(text)?.[1] ?? 'missing',
    answered: text.includes('"tool_use_id":"toolu_fork_sync"'),
  };
}
const toolInput = (task) => ({ command: process.env.FAKE_TOOL_COMMAND.split('<U1>').join(task.upstream), timeout_ms: 60000 });
const result = (task) => ({ ...JSON.parse(process.env.FAKE_RESULT), runId: task.runId });
function toolSse(id, name, input) { return [
  { type: 'message_start', message: { id: 'msg_wardby_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } },
  { type: 'message_stop' },
].map((frame) => 'event: ' + frame.type + '\n' + 'data: ' + JSON.stringify(frame) + '\n\n').join(''); }
http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
  console.log(JSON.stringify({ method: request.method, url: request.url, stream: body?.stream, messages: body?.messages, validCapability: request.headers['x-api-key'] === process.env.EXPECTED_CAPABILITY }));
  if (request.method === 'HEAD' && request.url === '/api/hello') return response.writeHead(200, { 'cache-control': 'no-store' }).end();
  if (request.method === 'POST' && request.url === '/v1/messages?beta=true') {
    const task = fromTask(body);
    const id = task.answered ? 'toolu_structured_fork_sync' : 'toolu_fork_sync';
    const name = task.answered ? 'StructuredOutput' : 'mcp__wardby_tools__run_command';
    const input = task.answered ? result(task) : toolInput(task);
    if (body?.stream === false) {
      return response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({
        id: 'msg_wardby_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
        content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 7 },
      }));
    }
    return response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }).end(toolSse(id, name, input));
  }
  if (request.method === 'POST' && request.url.startsWith('/v1/responses')) return;
  response.writeHead(404).end();
}).listen(8787, '0.0.0.0');
`;
}

/** The proxy's environment: the capability it checks, the final answer and the merge command. */
export function forkSyncProxyEnv(): Record<string, string> {
  return {
    EXPECTED_CAPABILITY: FORK_SYNC_CAPABILITY,
    FAKE_RESULT: JSON.stringify(FORK_SYNC_RESULT),
    FAKE_TOOL_COMMAND: CLAUDE_MERGE_COMMAND,
  };
}

/** The run's claim and job handle stay in memory: a stored handle counts as a taken coding slot for other tests. */
export class InMemorySlotStore extends PrismaContainerExecutionStore {
  constructor(private readonly prisma: PrismaClient) {
    super(prisma);
  }
  override async claimProvisioning(runId: string): Promise<ProvisioningClaim> {
    await this.prisma.run.update({ where: { id: runId }, data: { status: "running" } });
    return "claimed";
  }
  override async persistHandle(): Promise<void> {}
}

export interface ForkSyncRepositories {
  root: string;
  /** The trusted local roots (LOCAL_REPO_ROOTS). */
  roots: string[];
  upstream: string;
  fork: string;
  u0: string;
  u1: string;
  git: (dir: string, ...args: string[]) => Promise<string>;
  gitRaw: (dir: string, ...args: string[]) => Promise<string>;
}

/**
 * Under a fresh root: `upstream` with U0 (app.txt a/b/c) and U1 (app.txt a/B-upstream/c, new.txt);
 * `fork` cloned at U0, with F1 (app.txt a/B-fork/c, upstream-sync = U0). Both changed line 2.
 */
export async function forkSyncRepositories(prefix: string): Promise<ForkSyncRepositories> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const home = join(root, "home");
  const repos = join(root, "repos");
  const upstream = join(repos, "upstream");
  const fork = join(repos, "fork");
  await mkdir(home);
  await mkdir(upstream, { recursive: true });
  const env: NodeJS.ProcessEnv = {
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
  };
  const gitRaw = async (dir: string, ...args: string[]) =>
    (await execute("git", ["-c", "commit.gpgSign=false", ...args], { cwd: dir, env })).stdout;
  const git = async (dir: string, ...args: string[]) => (await gitRaw(dir, ...args)).trim();
  await git(upstream, "init", "--initial-branch=main");
  await writeFile(join(upstream, "app.txt"), "a\nb\nc\n");
  await git(upstream, "add", "app.txt");
  await git(upstream, "commit", "-m", "U0");
  const u0 = await git(upstream, "rev-parse", "HEAD");
  await git(repos, "clone", "--quiet", upstream, fork);
  await writeFile(join(upstream, "app.txt"), "a\nB-upstream\nc\n");
  await writeFile(join(upstream, "new.txt"), "new upstream file\n");
  await git(upstream, "add", "app.txt", "new.txt");
  await git(upstream, "commit", "-m", "U1");
  const u1 = await git(upstream, "rev-parse", "HEAD");
  await writeFile(join(fork, "app.txt"), "a\nB-fork\nc\n");
  await writeFile(join(fork, "upstream-sync"), `${u0}\n`);
  await git(fork, "add", "app.txt", "upstream-sync");
  await git(fork, "commit", "-m", "F1");
  return { root, roots: [repos], upstream, fork, u0, u1, git, gitRaw };
}

/** A Claude Code agent whose default is local:<fork>, with `base` (ref from upstream-sync) and `upstream` (main), both in the default set. */
export async function createForkSyncAgent(
  db: PrismaClient,
  input: { agentId: string; ownerId: string; repos: ForkSyncRepositories },
): Promise<void> {
  const { agentId, ownerId, repos } = input;
  await db.agent.create({
    data: {
      id: agentId,
      name: agentId,
      systemPrompt: "Keep the fork in sync with its upstream.",
      model: "claude-sonnet-5",
      budgetUsd: 1,
      kind: "coding",
      ownerId,
      codingProfile: {
        create: {
          provider: "claude-code",
          repository: `local:${repos.fork}`,
          defaultTask: FORK_SYNC_TASK,
          protectedPaths: [".github/workflows/**", "CODEOWNERS"],
          timeoutSec: 300,
          repositoryAuthorizedVia: "local_root",
        },
      },
    },
  });
  for (const [name, link] of [
    ["base", { refFromFile: "upstream-sync" }],
    ["upstream", { ref: "main" }],
  ] as const) {
    await db.agentRepository.create({
      data: {
        agentId,
        name,
        provider: "local",
        repository: `local:${repos.upstream}`,
        access: "read",
        inDefaultSet: true,
        authorizedVia: "local_root",
        ...link,
      },
    });
  }
}

/**
 * The production ContainerExecutor over `jobs`, with the real local VCS and repository-access gate;
 * only the model sessions are fake (they hand out FORK_SYNC_CAPABILITY). `onSession` sees each run id.
 */
export function forkSyncExecutor(input: {
  db: PrismaClient;
  jobs: WorkspaceJobLauncher;
  repos: ForkSyncRepositories;
  workspaceRoot: string;
  agentImage: string;
  toolImage: string;
  onSession?: (runId: string) => void;
}): ContainerExecutor {
  const { db, repos } = input;
  const sessions: CodingSessionController = {
    createSession: async ({ runId }) => {
      input.onSession?.(runId);
      return { id: `session-${runId}`, capability: FORK_SYNC_CAPABILITY };
    },
    cancelSession: async () => {},
  };
  return new ContainerExecutor({
    store: new InMemorySlotStore(db),
    jobs: input.jobs,
    vcs: new RoutingVcsProvider({
      github: null,
      local: new GitVcsProvider({
        rootDir: input.workspaceRoot,
        remote: new LocalRemote({ roots: () => repos.roots }),
      }),
    }),
    sessions,
    capabilities: new RunCapabilityVault(),
    artifactRoot: join(repos.root, "artifacts"),
    credentialRef: "env:OPENAI_API_KEY",
    anthropicCredentialRef: "env:ANTHROPIC_API_KEY",
    claudeWorkerImage: input.agentImage,
    claudeToolRunnerImage: input.toolImage,
    limits: { cpus: 1, memoryMb: 1024, pids: 256, diskMb: 256 },
    maxDiskMb: 1024,
    repoAccess: createRepoAccessGate({ db, hosts: {}, localRoots: () => repos.roots }),
  });
}

async function snapshot(repos: ForkSyncRepositories, dir: string) {
  return {
    refs: await repos.git(dir, "for-each-ref", "--format=%(refname) %(objectname)"),
    status: await repos.git(dir, "status", "--porcelain", "--untracked-files=all", "--ignored"),
    files: (await repos.git(dir, "ls-files", "--others", "--cached")).split("\n").sort(),
  };
}

/**
 * Dispatches the fork sync (awaiting the run), then asserts the whole scenario: the run succeeded;
 * the proxy saw both extras' full commits in the task and the command reported diff3.rc=1 and a
 * refused read-only write; the fork's wardby/run-<id> holds exactly the merge; the upstream was
 * never written; the rows carry U0 and U1. `proxyLog` reads the scripted proxy's output.
 */
export async function runAndAssertForkSync(input: {
  db: PrismaClient;
  executor: ContainerExecutor;
  agentId: string;
  repos: ForkSyncRepositories;
  /** The scripted proxy's output; only this run's lines are read. */
  proxyLog: () => Promise<string>;
}): Promise<string> {
  const { db, repos } = input;
  const { upstream, fork, u0, u1, git, gitRaw } = repos;
  const upstreamBefore = await snapshot(repos, upstream);
  const forkMainBefore = await git(fork, "rev-parse", "main");

  const dispatched = await dispatchRun({ db, executor: input.executor, agentId: input.agentId, awaitExecution: true });
  const runId = dispatched!.run.id;
  const run = await db.run.findUniqueOrThrow({
    where: { id: runId },
    select: { status: true, error: true, codingRun: { select: { headRef: true } } },
  });
  // One JSON line per request; this run's carry its id in the task.
  const proxyLog = (await input.proxyLog())
    .split("\n")
    .filter((line) => line.includes(`The final JSON runId must be ${runId}.`))
    .join("\n");
  if (run.status !== "succeeded") throw new Error(`run_${run.status}: ${run.error}\nproxy:\n${proxyLog}`);

  const requests = proxyLog
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as { method: string; url: string; validCapability: boolean })
    .filter((r) => r.method === "POST");
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((r) => r.validCapability)).toBe(true);
  // The task carried each extra's full commit; the scripted model copied upstream's from there.
  expect(proxyLog).toContain(`Extra repository /repos/base: local:${upstream} at ${u0}, read-only.`);
  expect(proxyLog).toContain(`Extra repository /repos/upstream: local:${upstream} at ${u1}, read-only.`);
  // The command's output, in the tool result the model was sent: a real conflict, and a refused write.
  const markers = /diff3\.rc=(\d+) ro\.rc=(\d+)/.exec(proxyLog);
  expect(markers, proxyLog).not.toBeNull();
  expect(markers![1]).toBe("1");
  expect(Number(markers![2])).not.toBe(0);

  // The fork's branch holds exactly the merge, on top of the fork's main.
  const branch = `wardby/run-${runId}`;
  expect(run.codingRun?.headRef).toBe(branch);
  expect(await gitRaw(fork, "show", `${branch}:app.txt`)).toBe("a\nB-fork\nB-upstream\nc\n");
  expect(await gitRaw(fork, "show", `${branch}:new.txt`)).toBe(await gitRaw(upstream, "show", `${u1}:new.txt`));
  expect(await gitRaw(fork, "show", `${branch}:upstream-sync`)).toBe(`${u1}\n`);
  expect((await git(fork, "ls-tree", "-r", "--name-only", branch)).split("\n").sort()).toEqual([
    "app.txt",
    "new.txt",
    "upstream-sync",
  ]);
  expect(await git(fork, "rev-parse", `${branch}^`)).toBe(forkMainBefore);
  expect(await git(fork, "rev-parse", "main")).toBe(forkMainBefore);

  // The upstream (the source of both read-only copies) was never written.
  expect(await snapshot(repos, upstream)).toEqual(upstreamBefore);
  // U0 is no branch tip upstream: the base copy was fetched by commit.
  expect(await git(upstream, "for-each-ref", "--points-at", u0, "--format=%(refname)")).toBe("");

  // The rows carry what dispatch resolved: base at the marker's U0, upstream at main's U1.
  const rows = await db.codingRunRepository.findMany({ where: { runId }, orderBy: { position: "asc" } });
  expect(rows).toEqual([
    expect.objectContaining({
      name: "base",
      access: "read",
      repository: `local:${upstream}`,
      refFromFile: "upstream-sync",
      requestedRef: u0,
      resolvedSha: u0,
    }),
    expect.objectContaining({
      name: "upstream",
      access: "read",
      repository: `local:${upstream}`,
      refFromFile: null,
      requestedRef: "main",
      resolvedSha: u1,
    }),
  ]);
  return runId;
}
