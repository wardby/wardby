import type { Executor, ExecutionRecoveryResult, PersistedExecutionHandle } from "./types.js";

export interface ExecutionKindResolver {
  kindForRun(runId: string): Promise<"native" | "coding" | null>;
}

/** Keeps native execution unchanged while routing coding runs to isolation. */
export class RoutingExecutor implements Executor {
  constructor(
    private readonly resolver: ExecutionKindResolver,
    private readonly native: Executor,
    private readonly coding: Executor,
  ) {}

  async start(runId: string): Promise<void> {
    const kind = await this.resolver.kindForRun(runId);
    if (kind === "native") return this.native.start(runId);
    if (kind === "coding") return this.coding.start(runId);
    throw new Error("executor_run_not_found");
  }

  async stop(runId: string, reason?: string): Promise<void> {
    const kind = await this.resolver.kindForRun(runId);
    if (kind === "native") return this.native.stop(runId, reason);
    if (kind === "coding") return this.coding.stop(runId, reason);
  }

  async recover(handle: PersistedExecutionHandle): Promise<ExecutionRecoveryResult> {
    if (!this.coding.recover) return { state: "lost", reason: "coding_recovery_unavailable" };
    return this.coding.recover(handle);
  }
}

export class PrismaExecutionKindResolver implements ExecutionKindResolver {
  constructor(
    private readonly db: {
      run: {
        findUnique(input: {
          where: { id: string };
          select: { agent: { select: { kind: true } } };
        }): Promise<{ agent: { kind: string } } | null>;
      };
    },
  ) {}

  async kindForRun(runId: string): Promise<"native" | "coding" | null> {
    const run = await this.db.run.findUnique({
      where: { id: runId },
      select: { agent: { select: { kind: true } } },
    });
    return run?.agent.kind === "native" || run?.agent.kind === "coding" ? run.agent.kind : null;
  }
}
