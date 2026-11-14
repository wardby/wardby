import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../core/db.js";
import { DockerJobLauncher } from "../jobs/docker.js";
import { isolationNames } from "../jobs/docker-isolation.js";
import type { JobSpec } from "../jobs/types.js";
import { GitVcsProvider } from "../vcs/git.js";
import { LocalRemote } from "../vcs/local-remote.js";
import {
  addUpstreamCommit,
  createForkSyncAgent,
  createHistoryForkSyncAgent,
  FORK_SYNC_CAPABILITY,
  forkSyncExecutor,
  forkSyncProxyEnv,
  forkSyncProxyProgram,
  forkSyncRepositories,
  historyProxyEnv,
  historyProxyProgram,
  mergeRunBranch,
  runAndAssertForkSync,
  runAndAssertHistorySync,
} from "./fork-sync.test-support.js";

/**
 * End to end for a fork sync (#537; docs/agent-recipes.md, help/fork-sync.md) through the real
 * Docker launcher: three `local:` repositories (the fork as the run's default, the upstream linked
 * twice read-only: `base` at the commit the fork's `upstream-sync` names, `upstream` at `main`) and
 * a real conflict on one line. Dispatch (rows resolved and written), the ContainerExecutor (clone,
 * read-only copies, launch, collect, commit, push), the repository-access gate and the database are
 * production code; the model is the scripted proxy local-repo.docker.test.ts uses (no API key, no
 * network), which takes the run id and upstream's full commit from the task.
 *
 * Run (images built from this checkout; the tags are resolved to local image IDs here):
 *   docker build -f src/claude-coding-worker/Dockerfile -t wardby-claude-worker:multi .
 *   docker build -f src/claude-tool-runner/Dockerfile -t wardby-claude-tool:multi .
 *   WARDBY_CLAUDE_DOCKER_TEST=1 WARDBY_CLAUDE_WORKER_IMAGE=wardby-claude-worker:multi
 *   WARDBY_CLAUDE_TOOL_RUNNER_IMAGE=wardby-claude-tool:multi npx vitest run <this file>
 * The Codex parity case also needs WARDBY_CODEX_WORKER_IMAGE (src/coding-worker/Dockerfile; the
 * driver base is linux/amd64 only, so build with --platform linux/amd64 on an arm64 host). It runs at
 * the launcher level: the Codex scripted path (mock-upstream.integration.test.ts) has no shell step.
 * The git-history cases (#536) run the same fork sync with `gitHistory: { depth: "full" }` and
 * upstream linked `as: "remote"`: the agent merges `upstream/main` with git, and the run pushes its
 * real merge commit. They run for Claude Code and, with WARDBY_CODEX_WORKER_IMAGE, for Codex through
 * the ContainerExecutor (the scripted model gives Codex a gpt-4.1 slug, whose classic tool set has an
 * exec_command function). The worker images must be built from this checkout: the driver and tool
 * runner carry the result bundle. For Codex, build the driver base locally
 * (src/coding-worker/Dockerfile.driver) and the worker on top of it (src/coding-worker/Dockerfile with
 * its FROM pointed at that local tag).
 * Skipped without DATABASE_URL.
 */
const execute = promisify(execFile);
const enabled = process.env.WARDBY_CLAUDE_DOCKER_TEST === "1";
const agentImageRef = process.env.WARDBY_CLAUDE_WORKER_IMAGE ?? "";
const toolImageRef = process.env.WARDBY_CLAUDE_TOOL_RUNNER_IMAGE ?? "";
const codexImageRef = process.env.WARDBY_CODEX_WORKER_IMAGE ?? "";
const token = `${process.pid}-${Date.now()}`;
const PREFIX = "multirepo-docker-";

async function docker(args: string[]): Promise<string> {
  try {
    const result = await execute("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
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

async function sweep(id: string, proxy: string): Promise<void> {
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

describe.skipIf(!enabled || !agentImageRef || !toolImageRef || !process.env.DATABASE_URL)(
  "fork sync across three local repositories (Docker)",
  () => {
    const db = createPrismaClient();
    const suffix = randomUUID().slice(0, 8);
    const owner = `${PREFIX}owner-${suffix}`;
    const proxy = `wardby-multi-repo-proxy-${token}`;
    const roots: string[] = [];
    const runIds: string[] = [];
    let agentImage = "";
    let toolImage = "";

    beforeAll(async () => {
      // The executor and launcher accept only immutable references: each tag is resolved to its image ID.
      agentImage = await docker(["image", "inspect", "--format", "{{.Id}}", agentImageRef]);
      toolImage = await docker(["image", "inspect", "--format", "{{.Id}}", toolImageRef]);
      await db.principal.create({ data: { id: owner, subject: owner } });
      const env = Object.entries(forkSyncProxyEnv()).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
      await docker([
        "container",
        "create",
        "--name",
        proxy,
        "--network",
        "bridge",
        ...env,
        "--entrypoint",
        "node",
        agentImage,
        "-e",
        forkSyncProxyProgram(),
      ]);
      await docker(["container", "start", proxy]);
    }, 60_000);

    afterAll(async () => {
      for (const id of runIds) await sweep(id, proxy);
      await cleanup(["container", "rm", "--force", proxy]);
      await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
      await db.run.deleteMany({ where: { agentId: { startsWith: PREFIX } } });
      await db.agent.deleteMany({ where: { id: { startsWith: PREFIX } } });
      await db.principal.deleteMany({ where: { id: { startsWith: PREFIX } } });
      await db.$disconnect();
    }, 120_000);

    it("the Claude tool runner has diff3, the merge command a fork sync uses without git", async () => {
      expect(await docker(["run", "--rm", "--entrypoint", "sh", toolImage, "-c", "command -v diff3"])).toMatch(
        /\/diff3$/,
      );
    }, 60_000);

    it("merges upstream into the fork through a real conflict, never writes the read-only copies, and pushes wardby/run-<id>", async () => {
      const repos = await forkSyncRepositories("wardby-multi-repo-docker-");
      roots.push(repos.root);
      const agentId = `${PREFIX}agent-${suffix}`;
      await createForkSyncAgent(db, { agentId, ownerId: owner, repos });
      const workspaceRoot = join(repos.root, "workspaces");
      const executor = forkSyncExecutor({
        db,
        repos,
        workspaceRoot,
        agentImage,
        toolImage,
        onSession: (runId) => runIds.push(runId),
        jobs: new DockerJobLauncher({
          stateRoot: join(repos.root, "state"),
          workspaceRoot,
          proxyContainer: proxy,
          resolveCapability: async () => FORK_SYNC_CAPABILITY,
          isRunActive: async () => false,
        }),
      });
      await runAndAssertForkSync({
        db,
        executor,
        agentId,
        repos,
        proxyLog: () => docker(["container", "logs", proxy]),
      });
    }, 300_000);

    describe("with git history (#536)", () => {
      const historyProxy = `wardby-git-history-proxy-${token}`;

      beforeAll(async () => {
        const env = Object.entries(historyProxyEnv()).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
        await docker([
          "container",
          "create",
          "--name",
          historyProxy,
          "--network",
          "bridge",
          ...env,
          "--entrypoint",
          "node",
          agentImage,
          "-e",
          historyProxyProgram(),
        ]);
        await docker(["container", "start", historyProxy]);
      }, 60_000);

      afterAll(async () => {
        for (const id of runIds)
          await cleanup(["network", "disconnect", "--force", isolationNames(id).network, historyProxy]);
        await cleanup(["container", "rm", "--force", historyProxy]);
      }, 60_000);

      /**
       * Two syncs: the first merges upstream's U1 through a real conflict; the PR is merged; upstream
       * adds U2; the second sync's merge-base is U1 (the first merge moved it), so it merges only U2,
       * cleanly. Each pushes one Wardby merge commit whose second parent is upstream's tip.
       */
      async function twoSyncs(input: { provider: "claude-code" | "codex"; model: string; codexImage?: string }) {
        const repos = await forkSyncRepositories(`wardby-git-history-${input.provider}-`);
        roots.push(repos.root);
        const agentId = `${PREFIX}history-${input.provider}-${suffix}`;
        await createHistoryForkSyncAgent(db, {
          agentId,
          ownerId: owner,
          repos,
          provider: input.provider,
          model: input.model,
        });
        const workspaceRoot = join(repos.root, "workspaces");
        const executor = forkSyncExecutor({
          db,
          repos,
          workspaceRoot,
          agentImage,
          toolImage,
          ...(input.codexImage ? { codexImage: input.codexImage } : {}),
          onSession: (runId) => runIds.push(runId),
          jobs: new DockerJobLauncher({
            stateRoot: join(repos.root, "state"),
            workspaceRoot,
            proxyContainer: historyProxy,
            resolveCapability: async () => FORK_SYNC_CAPABILITY,
            isRunActive: async () => false,
          }),
        });
        const proxyLog = () => docker(["container", "logs", historyProxy]);
        const { u0, u1, upstream } = repos;
        const first = await runAndAssertHistorySync({
          db,
          executor,
          agentId,
          repos,
          proxyLog,
          upstreamTip: u1,
          expectedMergeBase: u0,
          conflict: true,
          expectedFiles: {
            "app.txt": "a\nB-fork\nB-upstream\nc\n",
            "new.txt": "new upstream file\n",
            "upstream-sync": `${u1}\n`,
          },
        });
        await mergeRunBranch(repos, first);
        const u2 = await addUpstreamCommit(repos);
        await runAndAssertHistorySync({
          db,
          executor,
          agentId,
          repos,
          proxyLog,
          upstreamTip: u2,
          expectedMergeBase: u1,
          conflict: false,
          expectedFiles: {
            "app.txt": "a\nB-fork\nB-upstream\nc\n",
            "new.txt": "new upstream file, v2\n",
            "later.txt": "a later upstream file\n",
            "upstream-sync": `${u2}\n`,
          },
        });
        // The fork now has both merges in its history, and upstream's commits under their own authors.
        expect(await repos.git(repos.fork, "log", "-1", "--format=%an", u2)).toBe("Upstream Dev");
        expect(await repos.git(upstream, "rev-parse", "main")).toBe(u2);
      }

      it("Claude Code: merges upstream with git through a real conflict, then a second sync merges only what is new", async () => {
        await twoSyncs({ provider: "claude-code", model: "claude-sonnet-5" });
      }, 600_000);

      it.skipIf(!codexImageRef)(
        "Codex: merges upstream with git through a real conflict, then a second sync merges only what is new",
        async () => {
          const codexImage = await docker(["image", "inspect", "--format", "{{.Id}}", codexImageRef]);
          await twoSyncs({ provider: "codex", model: "gpt-4.1", codexImage });
        },
        600_000,
      );
    });

    it.skipIf(!codexImageRef)(
      "Codex parity (launcher level): the worker sees /repos/base and /repos/upstream read-only, and git merge-file reports the conflict",
      async () => {
        const repos = await forkSyncRepositories("wardby-multi-repo-codex-");
        roots.push(repos.root);
        const { upstream, fork, u0, u1 } = repos;
        const codexImage = await docker(["image", "inspect", "--format", "{{.Id}}", codexImageRef]);
        const runId = `${PREFIX}codex-${token}`;
        runIds.push(runId);
        const workspaceRoot = join(repos.root, "workspaces");
        const vcs = new GitVcsProvider({
          rootDir: workspaceRoot,
          remote: new LocalRemote({ roots: () => repos.roots }),
        });
        const workspace = await vcs.prepareWorkspace({
          runId,
          repository: `local:${fork}`,
          baseRef: "main",
          headRef: `wardby/run-${runId}`,
          protectedPaths: [".github/workflows/**"],
        });
        const copies = [
          await vcs.prepareReadOnlyCopy({ runId, name: "base", repository: `local:${upstream}`, commit: u0 }),
          await vcs.prepareReadOnlyCopy({ runId, name: "upstream", repository: `local:${upstream}`, commit: u1 }),
        ];
        const input = join(repos.root, "input.json");
        await writeFile(
          input,
          JSON.stringify({
            schemaVersion: 1,
            runId,
            repository: `local:${fork}`,
            baseRef: "main",
            headRef: `wardby/run-${runId}`,
            task: "Sync the fork with upstream.",
            model: "gpt-5.6-luna",
            budgetUsd: 0.25,
            deadlineAt: new Date(Date.now() + 120_000).toISOString(),
            repositories: copies.map((copy) => ({
              name: copy.name,
              path: `/repos/${copy.name}`,
              access: "read",
              repository: copy.repository,
              commit: copy.commit,
            })),
          }),
        );
        const launcher = new DockerJobLauncher({
          stateRoot: join(repos.root, "state"),
          workspaceRoot,
          proxyContainer: proxy,
          resolveCapability: async () => FORK_SYNC_CAPABILITY,
          isRunActive: async () => false,
        });
        const spec: JobSpec = {
          kind: "coding-agent",
          provider: "codex",
          runId,
          image: codexImage,
          inputArtifact: input,
          timeoutSec: 120,
          limits: { cpus: 1, memoryMb: 1024, pids: 256, diskMb: 256 },
          labels: {},
          repositories: copies.map((copy) => ({ name: copy.name, access: "read", hostPath: copy.workspacePath })),
        };
        const handle = await launcher.launch(spec);
        try {
          let status = await launcher.status(handle);
          for (let attempt = 0; attempt < 600 && status.state === "pending"; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            status = await launcher.status(handle);
          }
          expect(status.state, JSON.stringify(status)).toBe("running");
          // The scripted proxy holds the worker's model request open, so the worker is up while it is probed.
          const probe = await docker([
            "container",
            "exec",
            isolationNames(runId).workerContainer,
            "sh",
            "-c",
            [
              "test -w /workspace; echo workspace.w=$?",
              "test -w /repos/base; echo base.w=$?",
              "test -w /repos/upstream; echo upstream.w=$?",
              "touch /repos/base/x 2>/dev/null; echo base.touch=$?",
              "touch /repos/upstream/x 2>/dev/null; echo upstream.touch=$?",
              "test -e /repos/base/.git; echo base.git=$?",
              "cat /repos/base/app.txt /repos/upstream/app.txt",
              "cp /workspace/app.txt /tmp/fork-app.txt",
              "git merge-file /tmp/fork-app.txt /repos/base/app.txt /repos/upstream/app.txt; echo merge.rc=$?",
              "sed -i '/^<<<<<<< /d;/^=======$/d;/^>>>>>>> /d' /tmp/fork-app.txt; cat /tmp/fork-app.txt",
            ].join("\n"),
          ]);
          expect(probe.split("\n")).toEqual([
            "workspace.w=0",
            "base.w=1",
            "upstream.w=1",
            "base.touch=1",
            "upstream.touch=1",
            "base.git=1",
            "a",
            "b",
            "c",
            "a",
            "B-upstream",
            "c",
            "merge.rc=1",
            "a",
            "B-fork",
            "B-upstream",
            "c",
          ]);
        } finally {
          await launcher.stop(handle).catch(() => undefined);
          await launcher.remove(handle).catch(() => undefined);
          for (const copy of copies) await vcs.cleanupReadOnlyCopy(copy).catch(() => undefined);
          await vcs.cleanup(workspace).catch(() => undefined);
        }
        expect(await readFile(join(upstream, "app.txt"), "utf8")).toBe("a\nB-upstream\nc\n");
      },
      240_000,
    );
  },
);
