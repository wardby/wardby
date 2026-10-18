/**
 * repo_publish_review's unread_files check holds in both execution modes: a review run that read
 * only the first page of a large pull request is refused an APPROVE whether it runs in the
 * control plane or as a sandbox worker process over HTTP, where the gateway rebuilds the tools
 * for every request and so must carry what earlier requests read. Real PostgreSQL and a real git
 * repository; skipped without DATABASE_URL.
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { NativeEngine } from "../core/engine-native.js";
import { createRepoAccessGate } from "../core/repo-access.js";
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
        maxTurns: 4,
        ownerId,
      },
    });
    await db.agentRepository.create({
      data: { agentId, provider: "local", repository, access: "write", authorizedVia: "local_root" },
    });

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
    await db.localPullRequest.deleteMany({ where: { id: prId } });
    await db.$disconnect();
    await rm(base, { recursive: true, force: true });
  });

  /** Reads the first page only, then tries to approve, then answers. */
  const turns = (): LlmStreamEvent[][] => [
    [
      { type: "tool_call", id: "call_1", name: "repo_pr_read", argsJson: JSON.stringify({ repository, prNumber }) },
      { type: "done", stopReason: "tool_use", usage: usage(400, 30) },
    ],
    [
      {
        type: "tool_call",
        id: "call_2",
        name: "repo_publish_review",
        argsJson: JSON.stringify({
          repository,
          prNumber,
          headSha,
          verdict: "APPROVE",
          summary: "lgtm",
          body: "Looks fine.",
        }),
      },
      { type: "done", stopReason: "tool_use", usage: usage(500, 30) },
    ],
    [
      { type: "text", delta: "Done." },
      { type: "done", stopReason: "end_turn", usage: usage(520, 12) },
    ],
  ];

  async function runIn(mode: "control_plane" | "sandbox") {
    current = scriptedModel(turns());
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
    const publishResult = current.requests[2]?.messages.filter((m) => m.role === "tool").at(-1)?.content ?? "";
    return { finished, publishResult: String(publishResult) };
  }

  it.each(["control_plane", "sandbox"] as const)("refuses an APPROVE of unread code in %s mode", async (mode) => {
    const { finished, publishResult } = await runIn(mode);
    expect(finished.status).toBe("succeeded");
    expect(publishResult).toContain("unread_files");
    expect(publishResult).toContain("src/big.js");
    expect(publishResult).not.toContain('"published":true');
  });
});
