/**
 * A deploy across two real processes: the lead starts under application version xv1 (one
 * process), that process is SIGKILLed while the lead waits, and a second process under xv2 runs
 * the reconciler. DBOS reads its application version from DBOS__APPVERSION once per process, so
 * this is the only way to exercise the real version gate (dbos.database.test.ts approximates it in
 * one process by rewriting workflow_status.application_version).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../core/db.js";
import { PARENT_LOST_REASON } from "../../core/lost-run-children.js";
import { STEPS_CHANGED_REASON, versionMismatchReason } from "./dbos-status.js";
import type { HarnessArgs, HarnessSummary } from "./dbos-version-harness.test-support.js";

const HARNESS = fileURLToPath(new URL("./dbos-version-harness.test-support.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCHEMA = "dbos_xver";
const OLD = "xv1";
const NEW = "xv2";
const CASE_TIMEOUT_MS = 60_000;

interface Harness {
  /** Resolves with the line's remainder once the harness prints `XVER <prefix>…`. */
  line: (prefix: string, timeoutMs?: number) => Promise<string>;
  /** Resolves when the process has exited. */
  exited: Promise<number | null>;
  kill: () => Promise<void>;
  stderr: () => string;
}

function runHarness(mode: "start" | "recover", version: string, args: HarnessArgs, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(
    process.execPath,
    ["--conditions=wardby-source", "--import", "tsx", HARNESS, mode, JSON.stringify(args)],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL,
        DBOS__APPVERSION: version,
        DBOS_SCHEMA: SCHEMA,
        LOG_LEVEL: process.env.XVER_LOG_LEVEL ?? "warn",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const lines: string[] = [];
  const waiters: Array<() => void> = [];
  let buffered = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffered += chunk;
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    for (const part of parts) if (part.startsWith("XVER ")) lines.push(part.slice(5));
    for (const wake of waiters.splice(0)) wake();
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    err = (err + chunk).slice(-8_000);
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  let done = false;
  void exited.then(() => {
    done = true;
    for (const wake of waiters.splice(0)) wake();
  });

  const harness: Harness = {
    async line(prefix, timeoutMs = 40_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = lines.find((l) => l === prefix || l.startsWith(`${prefix} `));
        if (found !== undefined) return found.slice(prefix.length).trim();
        if (done) throw new Error(`${mode} harness exited before printing "${prefix}". stderr:\n${err}`);
        if (Date.now() > deadline) throw new Error(`${mode} harness never printed "${prefix}". stderr:\n${err}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 200);
        });
      }
    },
    exited,
    async kill() {
      if (!done) child.kill("SIGKILL");
      await exited;
    },
    stderr: () => err,
  };
  return harness;
}

describe.skipIf(!process.env.DATABASE_URL)("DbosExecutor across two application versions (two processes)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID().slice(0, 8);
  const created: string[] = [];
  const running: Harness[] = [];

  afterAll(async () => {
    for (const harness of running) await harness.kill();
    await db.run.deleteMany({ where: { agentId: { in: created } } });
    await db.agent.deleteMany({ where: { id: { in: created } } });
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await db.$disconnect();
  });

  beforeAll(async () => {
    // Every run of this file starts from a clean DBOS schema (each process migrates it at launch).
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  });

  /** A lead delegating to `coders` coding sub-agents, bound as `coder`, `coder2`, … */
  async function seed(name: string, coders: number, parallel = false) {
    const lead = `xver-${name}-lead-${suffix}`;
    const kids = Array.from({ length: coders }, (_, i) => `xver-${name}-coder${i}-${suffix}`);
    await db.agent.create({
      data: {
        id: lead,
        name: lead,
        systemPrompt: "LEAD",
        model: "m",
        budgetUsd: 1,
        maxTurns: 5,
        ...(parallel ? { maxDelegationsPerRun: coders, parallelDelegations: true } : {}),
      },
    });
    created.push(lead);
    for (const kid of kids) {
      await db.agent.create({
        data: {
          id: kid,
          name: kid,
          kind: "coding",
          systemPrompt: "unused for coding agents",
          model: "gpt-5.6-luna",
          budgetUsd: 0.5,
          maxTurns: 3,
          codingProfile: {
            create: {
              repository: "your-org/your-repo",
              protectedPaths: [],
              allowWebhookTaskOverride: true,
              timeoutSec: 600,
            },
          },
        },
      });
      created.push(kid);
    }
    const boundNames = kids.map((_, i) => (i === 0 ? "coder" : `coder${i + 1}`));
    await db.agentSubAgent.createMany({
      data: kids.map((kid, i) => ({ parentAgentId: lead, childAgentId: kid, boundName: boundNames[i] })),
    });
    const run = await db.run.create({ data: { agentId: lead, executionManaged: true } });
    const args: HarnessArgs = {
      leadRunId: run.id,
      agentIds: [lead, ...kids],
      delegations: boundNames.map((bound, i) => [i === 0 ? "c1" : `c${i + 1}`, `delegate_to_${bound}`]),
    };
    return { runId: run.id, args };
  }

  /** Runs the old version until the lead waits where the case wants it, then kills it outright. */
  async function startAndKill(args: HarnessArgs, beforeKill?: () => Promise<void>) {
    const old = runHarness("start", OLD, args);
    running.push(old);
    await old.line("ready");
    await beforeKill?.();
    await old.kill();
  }

  function recoverUnderNewVersion(args: HarnessArgs, env?: NodeJS.ProcessEnv) {
    const next = runHarness("recover", NEW, args, env);
    running.push(next);
    return next;
  }

  async function summaryOf(harness: Harness): Promise<HarnessSummary> {
    return JSON.parse(await harness.line("summary")) as HarnessSummary;
  }

  const settle = (id: string, finalText: string) =>
    db.run.update({ where: { id }, data: { status: "succeeded", finalText, finishedAt: new Date() } });

  it(
    "forks a lead waiting on its coding child, re-attaches that child, and finishes with its result",
    async () => {
      const { runId, args } = await seed("fork", 1);
      await startAndKill(args);
      const [child] = await db.run.findMany({ where: { parentRunId: runId } });

      const next = recoverUnderNewVersion(args);
      await next.line("recovered");
      await settle(child.id, "built");
      const summary = await summaryOf(next);

      expect(summary.status).toBe("succeeded");
      // Only the post-delegation turn: the replayed turn 1 came from the old version's record.
      expect(summary.llmCalls).toBe(1);
      expect(summary.children.map((c) => c.id)).toEqual([child.id]);
      expect(summary.children[0].parentCallId).toBe("c1");
      expect(summary.startedChildren).toEqual([]);
      expect(summary.executionWorkflowId).toBeTruthy();
      expect(summary.executionWorkflowId).not.toBe(runId);
      expect(summary.toolResults).toHaveLength(1);
      expect(summary.toolResults[0]).toContain('"finalText":"built"');
      expect(summary.finalText).toContain('"finalText":"built"');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "takes over a lead whose coding child finished while no process ran it",
    async () => {
      const { runId, args } = await seed("finished", 1);
      await startAndKill(args);
      const [child] = await db.run.findMany({ where: { parentRunId: runId } });
      await settle(child.id, "built");

      const summary = await summaryOf(recoverUnderNewVersion(args));

      expect(summary.status).toBe("succeeded");
      expect(summary.llmCalls).toBe(1);
      expect(summary.children.map((c) => c.id)).toEqual([child.id]);
      expect(summary.startedChildren).toEqual([]);
      expect(summary.executionWorkflowId).toBeTruthy();
      expect(summary.executionWorkflowId).not.toBe(runId);
      expect(summary.toolResults[0]).toContain('"finalText":"built"');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "ends the lead lost with the steps-changed reason when the new version's steps differ, and stops its child",
    async () => {
      const { runId, args } = await seed("steps", 1);
      await startAndKill(args);
      const [child] = await db.run.findMany({ where: { parentRunId: runId } });

      const summary = await summaryOf(recoverUnderNewVersion(args, { XVER_EXTRA_STEP: "1" }));

      expect(summary.status).toBe("lost");
      expect(summary.error).toBe(STEPS_CHANGED_REASON);
      // It was forked (the decision is made on the recorded steps), then its replay refused.
      expect(summary.executionWorkflowId).toBeTruthy();
      expect(summary.llmCalls).toBe(0);
      expect(summary.children).toEqual([
        { id: child.id, status: "cancelled", error: PARENT_LOST_REASON, parentCallId: "c1" },
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "ends a lead that was mid-turn lost with the version mismatch, without forking it",
    async () => {
      const { args } = await seed("midturn", 1);
      await startAndKill({ ...args, midTurn: true });

      const summary = await summaryOf(recoverUnderNewVersion(args));

      expect(summary.status).toBe("lost");
      expect(summary.error).toBe(versionMismatchReason(OLD, NEW));
      expect(summary.executionWorkflowId).toBeNull();
      expect(summary.llmCalls).toBe(0);
      expect(summary.children).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "takes over parallel delegations where one finished under the old version, and both results reach the lead",
    async () => {
      const { runId, args } = await seed("parallel", 2, true);
      const childOf = async (callId: string) =>
        db.run.findFirstOrThrow({ where: { parentRunId: runId, parentCallId: callId } });
      await startAndKill(args, async () => {
        // The first child finishes while the old version still runs: its delegate step is recorded.
        await settle((await childOf("c1")).id, "built-a");
        const deadline = Date.now() + 20_000;
        for (;;) {
          const recorded = await db.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM ${SCHEMA}.operation_outputs
              WHERE workflow_uuid = $1 AND function_name = 'turn:1:tool:0' AND completed_at_epoch_ms IS NOT NULL`,
            runId,
          );
          if (recorded[0].n > 0) break;
          if (Date.now() > deadline) throw new Error("the old version never recorded the first delegate step");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      });
      const second = await childOf("c2");

      const next = recoverUnderNewVersion(args);
      await next.line("recovered");
      await settle(second.id, "built-b");
      const summary = await summaryOf(next);

      expect(summary.status).toBe("succeeded");
      expect(summary.llmCalls).toBe(1);
      expect(summary.startedChildren).toEqual([]);
      expect(summary.children).toHaveLength(2);
      expect(summary.executionWorkflowId).toBeTruthy();
      expect(summary.toolResults).toHaveLength(2);
      expect(summary.toolResults.join("\n")).toContain('"finalText":"built-a"');
      expect(summary.toolResults.join("\n")).toContain('"finalText":"built-b"');
    },
    CASE_TIMEOUT_MS,
  );
});
