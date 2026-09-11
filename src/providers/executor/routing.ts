import type { CodingImageSelector, Executor, ExecutionRecoveryResult, PersistedExecutionHandle } from "./types.js";

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

  /**
   * Recovery is routed by the run's agent kind, exactly like start/stop: a
   * native run's handle belongs to the native executor (e.g. a DBOS
   * workflow handle), a coding run's to the container executor. Routing by
   * handle backend would need this class to know every backend name.
   */
  async recover(handle: PersistedExecutionHandle): Promise<ExecutionRecoveryResult> {
    const kind = await this.resolver.kindForRun(handle.runId);
    if (kind === "native") {
      if (!this.native.recover) return { state: "lost", reason: "native_recovery_unavailable" };
      return this.native.recover(handle);
    }
    if (!this.coding.recover) return { state: "lost", reason: "coding_recovery_unavailable" };
    return this.coding.recover(handle);
  }

  /** Lifecycle fans out to both executors; each is optional on the seam. */
  async launch(): Promise<void> {
    await this.native.launch?.();
    await this.coding.launch?.();
  }

  async close(): Promise<void> {
    await this.coding.close?.();
    await this.native.close?.();
  }

  resolveCodingWorkerImage(selector: CodingImageSelector): string {
    if (!this.coding.resolveCodingWorkerImage) throw new Error("coding_execution_not_configured");
    return this.coding.resolveCodingWorkerImage(selector);
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
