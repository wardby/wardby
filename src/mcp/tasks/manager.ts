/**
 * Task manager: maps a Run's lifecycle onto the MCP Tasks extension
 * (io.modelcontextprotocol/tasks, schema 2026-07-28 — field names verified
 * against the extension's own reference TypeScript, not guessed). A "run"
 * task's live status/result is always DERIVED from Run.status on read —
 * the persisted Task row's own `status` column is the task's independent
 * lifecycle stamp, mutated only by createRunTask (-> working) and
 * cancelTask (-> cancelled, a terminal task-level state that intentionally
 * doesn't unwind even if the underlying run later finishes on its own —
 * cancellation is cooperative and eventually consistent, per the
 * extension's own spec language).
 */
import type { PrismaClient, RunStatus, Task } from "#prisma";
import { INTERNAL_ERROR } from "@modelcontextprotocol/server";
import { publicCodingRunResult } from "../../coding/protocol.js";

export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

interface TaskFields {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
}

export type CreateTaskResult = TaskFields & { resultType: "task" };

export type GetTaskResult =
  | (TaskFields & { resultType: "complete"; status: "working" })
  | (TaskFields & { resultType: "complete"; status: "input_required"; inputRequests: Record<string, unknown> })
  | (TaskFields & { resultType: "complete"; status: "completed"; result: Record<string, unknown> })
  | (TaskFields & { resultType: "complete"; status: "failed"; error: JsonRpcErrorObject })
  | (TaskFields & { resultType: "complete"; status: "cancelled" });

const DEFAULT_POLL_INTERVAL_MS = 1000;

export function createTaskResult(row: Task, ttlMs: number): CreateTaskResult {
  return {
    resultType: "task",
    taskId: row.id,
    status: "working",
    createdAt: row.createdAt.toISOString(),
    lastUpdatedAt: row.updatedAt.toISOString(),
    ttlMs,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  };
}

/** Starts a run-backed task: persists the Task row BEFORE returning, so a client's first tasks/get always finds it. */
export async function createRunTask(
  runId: string,
  principalId: string,
  db: PrismaClient,
  ttlMs: number,
): Promise<CreateTaskResult> {
  const row = await db.task.create({
    data: {
      kind: "run",
      runId,
      principalId,
      status: "working",
      ttlAt: new Date(Date.now() + ttlMs),
    },
  });
  return createTaskResult(row, ttlMs);
}

function mapTerminalRunStatus(
  status: Extract<RunStatus, "succeeded" | "budget_exhausted" | "refused" | "failed" | "lost">,
  run: {
    tokensIn: number;
    tokensOut: number;
    costUsd: unknown;
    error: string | null;
    finalText: string | null;
    codingRun?: { result: unknown } | null;
  },
): { status: "completed"; result: Record<string, unknown> } | { status: "failed"; error: JsonRpcErrorObject } {
  const usage = { tokensIn: run.tokensIn, tokensOut: run.tokensOut, costUsd: Number(run.costUsd) };
  const codingResult = publicCodingRunResult(run.codingRun?.result);
  if (codingResult) return { status: "completed", result: codingResult };
  switch (status) {
    case "succeeded":
      return { status: "completed", result: { finalText: run.finalText ?? "", usage } };
    case "budget_exhausted":
      // A successful terminal, not an error — the run did what the budget allowed.
      return { status: "completed", result: { summary: run.finalText ?? "", usage, budgetExhausted: true } };
    case "refused":
      return {
        status: "completed",
        result: { refusalReason: run.error ?? "", usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 } },
      };
    case "failed":
    case "lost":
      return { status: "failed", error: { code: INTERNAL_ERROR, message: run.error ?? `Run ${status}.` } };
  }
}

/** Reads a task's current state, deriving a run task's status from the live Run.status. */
export async function getTask(taskId: string, db: PrismaClient): Promise<GetTaskResult> {
  const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  const base = {
    resultType: "complete" as const,
    taskId: task.id,
    createdAt: task.createdAt.toISOString(),
    lastUpdatedAt: task.updatedAt.toISOString(),
    ttlMs: task.ttlAt.getTime() - Date.now(),
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  };

  if (task.status === "cancelled") {
    return { ...base, status: "cancelled" };
  }

  if (!task.runId) {
    throw new Error(`Task "${taskId}" has kind "${task.kind}" with no runId — only kind:"run" tasks are supported.`);
  }
  const run = await db.run.findUniqueOrThrow({
    where: { id: task.runId },
    include: { codingRun: { select: { result: true } } },
  });

  switch (run.status) {
    case "pending":
    case "running":
      return { ...base, status: "working", statusMessage: `cost so far: $${Number(run.costUsd).toFixed(6)}` };
    case "cancelled":
      return { ...base, status: "cancelled" };
    case "succeeded":
    case "budget_exhausted":
    case "refused":
    case "failed":
    case "lost": {
      const mapped = mapTerminalRunStatus(run.status, run);
      return { ...base, ...mapped };
    }
  }
}

/**
 * Cooperatively stops a task's underlying run (best-effort — cancellation
 * is eventually consistent). A no-op when the run has already reached a
 * terminal status on its own; the stop hook is never called for a run
 * that's already finished.
 */
export async function cancelTask(
  taskId: string,
  db: PrismaClient,
  stopRun: (runId: string) => Promise<void>,
): Promise<void> {
  const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  if (task.status === "cancelled" || !task.runId) return;

  const run = await db.run.findUniqueOrThrow({ where: { id: task.runId } });
  if (run.status !== "pending" && run.status !== "running") {
    // Already terminal — nothing to cancel.
    return;
  }

  await stopRun(task.runId);
  await db.task.update({ where: { id: taskId }, data: { status: "cancelled" } });
}
