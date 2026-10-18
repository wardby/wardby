/**
 * repo_publish_review's unread_files check holds in both execution modes: a review run that read
 * only the first page of a large pull request is refused an APPROVE whether it runs in the
 * control plane or as a sandbox worker process over HTTP, where the gateway rebuilds the tools
 * for every request and so must carry what earlier requests read. Real PostgreSQL and a real git
 * repository; skipped without DATABASE_URL. A full review (refused, pages to the end, approved)
 * also gives the model the same tool results in both modes.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { NativeEngine } from "../core/engine-native.js";
import { createRepoAccessGate } from "../core/repo-access.js";
import { handleReviewHostTool } from "../core/review-host-tools.js";
import { ReviewReadLedger } from "../core/review-reads.js";
import { executeRun, type NativeRunProviders } from "../core/runner.js";
import type { LlmStreamEvent } from "../providers/llm/types.js";
import { LocalReviewHost } from "../providers/review-host/local.js";
import { identityCipher, memoryDatastore, MODEL, noMemory, scriptedModel, usage } from "./fixtures.test-support.js";
import { createGatewayServer, NATIVE_GATEWAY_PATH } from "./http-server.js";
import { processWorkerLauncher, startSandboxRun } from "./launch.js";

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args], { env: GIT_ENV });

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const worker = processWorkerLauncher({
  command: process.execPath,
  args: ["--import", "tsx", "src/native-worker/main.ts"],
  env: {},
  cwd: REPO_ROOT,
});

describe.skipIf(!process.env.DATABASE_URL)("unread_files in both execution modes (database)", () => {
  const db = createPrismaClient();
  const tag = randomUUID().slice(0, 8);
  const ownerId = `reads-owner-${tag}`;
  const agentId = `reads-agent-${tag}`;
  let base: string;
  let repository: string;
  let prId: string;
  let prNumber: number;
  let headSha: string;
  /** The page cursors of the pull request's diff, in order (page 2 onward). */
  let cursors: string[];
  let gateway: Server;
  let gatewayUrl: string;
  const host = new LocalReviewHost({ db, roots: () => [base] });

  // Swapped per run: the gateway and the in-process path share one providers object.
  let current = scriptedModel([]);
  const providers: NativeRunProviders = {
    get llm() {
      return current.llm;
    },
    engine: new NativeEngine(),
    datastore: memoryDatastore({}),
    secrets: identityCipher,
    memory: noMemory,
    reviewHosts: { local: host },
    repoAccess: createRepoAccessGate({ db, hosts: { local: host }, localRoots: () => [base] }),
  };

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "wardby-reads-")));
    const path = join(base, "repo");
    await mkdir(join(path, "src"), { recursive: true });
    await exec("git", ["init", "--initial-branch=main", path]);
    await writeFile(join(path, "src", "app.js"), "export const a = 1;\n");
    await git(path, "add", "-A");
    await git(path, "commit", "-m", "base");
    await git(path, "checkout", "-b", "big");
    // One code file far larger than a page, so the first page delivers only part of it.
    const big = Array.from({ length: 5_000 }, (_, i) => `export const v${i} = ${i}; // ${"x".repeat(30)}`);
    await writeFile(join(path, "src", "big.js"), big.join("\n") + "\n");
    await git(path, "add", "-A");
    await git(path, "commit", "-m", "big change");
    headSha = (await git(path, "rev-parse", "HEAD")).stdout.trim();
    repository = `local:${path}`;
    const pr = await db.localPullRequest.create({ data: { repository, branch: "big", base: "main" } });
    prId = pr.id;
    prNumber = pr.number;

    await db.principal.create({ data: { id: ownerId, subject: ownerId } });
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        systemPrompt: "Review it.",
        model: MODEL,
        budgetUsd: 1,
        maxTurns: 12,
        ownerId,
      },
    });
    await db.agentRepository.create({
      data: { agentId, provider: "local", repository, access: "write", authorizedVia: "local_root" },
    });

    // The cursors are deterministic for a head: read the chain once to script the paging review.
    const ctx = {
      agentId: "cursor-probe",
      links: [{ provider: "local" as const, repository, access: "read" as const, checkName: null, waitForCi: false }],
      hosts: { local: host },
      runCheck: null,
      markRunCheckCompleted: vi.fn(async () => undefined),
      authorize: vi.fn(async () => ({ ok: true as const })),
      reads: new ReviewReadLedger(),
      db,
    };
    cursors = [];
    let cursor: string | undefined;
    do {
      const page = JSON.parse(
        await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository, prNumber, patchCursor: cursor }), ctx),
      ) as { nextPatchCursor: string | null };
      cursor = page.nextPatchCursor ?? undefined;
      if (cursor) cursors.push(cursor);
    } while (cursor);

    gateway = createGatewayServer({ db, providers, pollWindowMs: 200 });
    await new Promise<void>((done) => gateway.listen(0, "127.0.0.1", done));
    gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}${NATIVE_GATEWAY_PATH}`;
  });

  afterAll(async () => {
    gateway.closeAllConnections();
    gateway.close();
    const runs = await db.run.findMany({ where: { agentId }, select: { id: true } });
    const runIds = runs.map((r) => r.id);
    await db.runModelUsage.deleteMany({ where: { runId: { in: runIds } } });
    await db.runAttribution.deleteMany({ where: { runId: { in: runIds } } });
    await db.run.deleteMany({ where: { id: { in: runIds } } });
    await db.agentRepository.deleteMany({ where: { agentId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: ownerId } });
    await db.localReview.deleteMany({ where: { pullRequestId: prId } });
    await db.localPullRequest.deleteMany({ where: { id: prId } });
    await db.$disconnect();
    await rm(base, { recursive: true, force: true });
  });

  let calls = 0;
  const call = (name: string, args: unknown): LlmStreamEvent[] => [
    { type: "tool_call", id: `call_${++calls}`, name, argsJson: JSON.stringify(args) },
    { type: "done", stopReason: "tool_use", usage: usage(400, 30) },
  ];
  const answer = (): LlmStreamEvent[] => [
    { type: "text", delta: "Done." },
    { type: "done", stopReason: "end_turn", usage: usage(520, 12) },
  ];
  const read = (patchCursor?: string) => call("repo_pr_read", { repository, prNumber, patchCursor });
  const approve = () =>
    call("repo_publish_review", {
      repository,
      prNumber,
      headSha,
      verdict: "APPROVE",
      summary: "lgtm",
      body: "Looks fine.",
    });

  async function runIn(mode: "control_plane" | "sandbox", turns: LlmStreamEvent[][]) {
    calls = 0;
    current = scriptedModel(turns);
    // Each run reviews the pull request fresh: no earlier review of it.
    await db.localReview.deleteMany({ where: { pullRequestId: prId } });
    const run = await db.run.create({
      data: { agentId, trigger: "manual", nativeExecutionMode: mode, executionManaged: mode === "sandbox" },
    });
    if (mode === "sandbox") {
      const started = await startSandboxRun({ runId: run.id, providers, db, gatewayUrl, launcher: worker });
      if (started.kind !== "launched") throw new Error(`run ended before launch: ${started.run.status}`);
      await started.handle.exited;
    } else {
      await executeRun(run.id, providers, db);
    }
    const finished = await db.run.findUniqueOrThrow({ where: { id: run.id } });
    const conversation = current.requests.at(-1)?.messages ?? [];
    const toolResults = conversation.filter((m) => m.role === "tool").map((m) => String(m.content));
    return { finished, toolResults };
  }

  it.each(["control_plane", "sandbox"] as const)("refuses an APPROVE of unread code in %s mode", async (mode) => {
    const { finished, toolResults } = await runIn(mode, [read(), approve(), answer()]);
    expect(finished.status).toBe("succeeded");
    expect(toolResults[1]).toContain("unread_files");
    expect(toolResults[1]).toContain("src/big.js");
    expect(toolResults[1]).not.toContain('"published":true');
  });

  it("gives a full review the same tool results, verdict and outcome in both modes", async () => {
    expect(cursors.length).toBeGreaterThan(1);
    const review = () => [read(), approve(), ...cursors.map((c) => read(c)), approve(), answer()];
    const inProcess = await runIn("control_plane", review());
    const sandboxed = await runIn("sandbox", review());

    // Every read and both publishes reached the model.
    expect(inProcess.toolResults).toHaveLength(cursors.length + 3);
    // A published review's URL ends in its generated id.
    const same = (results: string[]) => results.map((r) => r.replace(/#[a-z0-9]{20,}/g, "#<review>"));
    expect(same(sandboxed.toolResults)).toEqual(same(inProcess.toolResults));
    const outcome = (r: typeof inProcess) => ({
      status: r.finished.status,
      finalText: r.finished.finalText,
      turns: r.finished.turns,
    });
    expect(outcome(sandboxed)).toEqual(outcome(inProcess));
    // Refused before paging, published after: the check holds the same way in both modes.
    for (const { toolResults } of [inProcess, sandboxed]) {
      expect(toolResults[1]).toContain("unread_files");
      expect(toolResults.at(-1)).toContain('"published":true');
    }
  });
});
