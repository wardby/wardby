import type { CodingProvider } from "../../coding/provider.js";
import type { CodingImageSelector, Executor, ExecutionRecoveryResult, PersistedExecutionHandle } from "./types.js";

/**
 * Which executor owns a run: a coding run, a native run in the control plane
 * (in-process or DBOS), or a native run in an isolated sandbox worker. Read
 * from the run's own row (agent kind plus Run.nativeExecutionMode), never from
 * the agent's current setting, so a setting change reaches only later runs.
 */
export type ExecutionTarget = "native" | "native-sandbox" | "coding";

export interface ExecutionKindResolver {
  kindForRun(runId: string): Promise<ExecutionTarget | null>;
}

/**
 * Keeps native execution unchanged while routing coding runs to isolation and
 * sandbox-mode native runs to the native sandbox executor.
 *
 * With no sandbox executor composed in, a sandbox run goes to the native
 * executor, whose runner refuses to execute it (executeRun fails it before
 * any spend, closing its host check and status comments): fail closed through
 * the one path that already finishes a run properly, never a silent run in
 * the control plane.
 */
export class RoutingExecutor implements Executor {
  constructor(
    private readonly resolver: ExecutionKindResolver,
    private readonly native: Executor,
    private readonly coding: Executor,
    private readonly sandbox?: Executor,
  ) {}

  private async route(runId: string): Promise<{ target: ExecutionTarget; executor: Executor } | null> {
    const target = await this.resolver.kindForRun(runId);
    if (target === "native") return { target, executor: this.native };
    if (target === "native-sandbox") return { target, executor: this.sandbox ?? this.native };
    if (target === "coding") return { target, executor: this.coding };
    return null;
  }

  async start(runId: string): Promise<void> {
    const routed = await this.route(runId);
    if (!routed) throw new Error("executor_run_not_found");
    return routed.executor.start(runId);
  }

  async stop(runId: string, reason?: string): Promise<void> {
    const routed = await this.route(runId);
    if (routed) return routed.executor.stop(runId, reason);
  }

  /**
   * Recovery is routed by the run's target, exactly like start/stop: a native
   * run's handle belongs to the native executor (e.g. a DBOS workflow handle),
   * a sandbox run's to the sandbox executor, a coding run's to the container
   * executor. Routing by handle backend would need this class to know every
   * backend name.
   */
  async recover(handle: PersistedExecutionHandle): Promise<ExecutionRecoveryResult> {
    const routed = await this.route(handle.runId);
    const target = routed?.target ?? "coding";
    const executor = routed?.executor ?? this.coding;
    if (!executor.recover) {
      const reason =
        target === "native"
          ? "native_recovery_unavailable"
          : target === "native-sandbox" && this.sandbox
            ? "native_sandbox_recovery_unavailable"
            : target === "native-sandbox"
              ? "native_recovery_unavailable"
              : "coding_recovery_unavailable";
      return { state: "lost", reason };
    }
    return executor.recover(handle);
  }

  /** Only coding runs wait in the coding queue, so only the coding executor is asked. */
  async cleanupQueueTimeout(runId: string): Promise<void> {
    await this.coding.cleanupQueueTimeout?.(runId);
  }

  /** Each distinct executor once, in a fixed order: native, coding, sandbox. */
  private distinct(): Executor[] {
    return [this.native, this.coding, this.sandbox].filter(
      (executor, index, all): executor is Executor => executor !== undefined && all.indexOf(executor) === index,
    );
  }

  /** Lifecycle fans out to every distinct executor; each hook is optional on the seam. */
  async launch(): Promise<void> {
    for (const executor of this.distinct()) await executor.launch?.();
  }

  /** Fans out like `launch`. */
  async warmUp(): Promise<void> {
    for (const executor of this.distinct()) await executor.warmUp?.();
  }

  /** Reverse of `launch`. */
  async close(): Promise<void> {
    for (const executor of this.distinct().reverse()) await executor.close?.();
  }

  resolveCodingWorkerImage(selector: CodingImageSelector): string {
    if (!this.coding.resolveCodingWorkerImage) throw new Error("coding_execution_not_configured");
    return this.coding.resolveCodingWorkerImage(selector);
  }

  resolveCodingToolImage(selector: CodingImageSelector): string | null {
    if (!this.coding.resolveCodingToolImage) throw new Error("coding_execution_not_configured");
    return this.coding.resolveCodingToolImage(selector);
  }

  async readCodingServiceDeclaration(input: { repository: string; baseRef: string }): Promise<string | null> {
    if (!this.coding.readCodingServiceDeclaration) return null;
    return this.coding.readCodingServiceDeclaration(input);
  }

  async readCodingRepositoryFile(input: {
    repository: string;
    baseRef: string;
    path: string;
    maxBytes: number;
  }): Promise<string | null> {
    if (!this.coding.readCodingRepositoryFile) return null;
    return this.coding.readCodingRepositoryFile(input);
  }

  supportsNativeSandbox(): boolean {
    return this.sandbox !== undefined;
  }

  supportsCodingServices(provider: CodingProvider): boolean {
    return this.coding.supportsCodingServices?.(provider) === true;
  }
}

export class PrismaExecutionKindResolver implements ExecutionKindResolver {
  constructor(
    private readonly db: {
      run: {
        findUnique(input: {
          where: { id: string };
          select: { nativeExecutionMode: true; agent: { select: { kind: true } } };
        }): Promise<{ nativeExecutionMode: string | null; agent: { kind: string } } | null>;
      };
    },
  ) {}

  async kindForRun(runId: string): Promise<ExecutionTarget | null> {
    const run = await this.db.run.findUnique({
      where: { id: runId },
      select: { nativeExecutionMode: true, agent: { select: { kind: true } } },
    });
    if (run?.agent.kind === "coding") return "coding";
    if (run?.agent.kind !== "native") return null;
    // Null = a run from before the snapshot existed: the control plane, as it always ran.
    return run.nativeExecutionMode === "sandbox" ? "native-sandbox" : "native";
  }
}
