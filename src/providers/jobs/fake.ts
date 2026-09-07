import { isDeepStrictEqual } from "node:util";
import type { JobHandle, JobLauncher, JobResult, JobSpec, JobStatus } from "./types.js";

const BACKEND = "fake";
const TERMINAL_STATES = new Set<JobStatus["state"]>(["succeeded", "failed", "stopped", "lost"]);

export interface FakeJobPlan {
  /** Status returned by each successive poll; the final entry remains stable. */
  statusScript?: JobStatus[];
  result?: JobResult;
}

interface FakeJobRecord {
  handle: JobHandle;
  spec: JobSpec;
  status: JobStatus;
  statusScript: JobStatus[];
  statusCursor: number;
  result?: JobResult;
  plannedResult?: JobResult;
  removed: boolean;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function resultFor(status: JobStatus): JobResult {
  switch (status.state) {
    case "succeeded": return { exitCode: 0, reason: "completed" };
    case "failed": return { exitCode: 1, reason: "failed" };
    case "stopped": return { exitCode: 143, reason: "stopped" };
    case "lost": return { exitCode: 1, reason: "lost" };
    default: throw new Error("job_not_terminal");
  }
}

function statusFor(result: JobResult): JobStatus {
  switch (result.reason) {
    case "completed": return { state: "succeeded" };
    case "stopped": return { state: "stopped" };
    case "lost": return { state: "lost" };
    case "failed": return { state: "failed" };
    case "timed_out": return { state: "failed", reason: "timed_out" };
  }
}

export class FakeJobLauncher implements JobLauncher {
  private readonly jobs = new Map<string, FakeJobRecord>();
  private readonly runIds = new Map<string, string>();
  private readonly plans: FakeJobPlan[] = [];
  private nextId = 1;

  queuePlan(plan: FakeJobPlan): void {
    this.plans.push(clone(plan));
  }

  async launch(spec: JobSpec): Promise<JobHandle> {
    const existingId = this.runIds.get(spec.runId);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (!existing) throw new Error("job_state_corrupt");
      if (!isDeepStrictEqual(existing.spec, spec)) throw new Error("job_spec_conflict");
      return clone(existing.handle);
    }

    const handle = { backend: BACKEND, id: `job-${String(this.nextId++).padStart(4, "0")}` };
    const plan = this.plans.shift() ?? {};
    const statusScript = plan.statusScript?.length ? clone(plan.statusScript) : [{ state: "pending" as const }];
    const record: FakeJobRecord = {
      handle,
      spec: clone(spec),
      status: { state: "pending" },
      statusScript,
      statusCursor: 0,
      plannedResult: plan.result ? clone(plan.result) : undefined,
      removed: false,
    };
    this.jobs.set(handle.id, record);
    this.runIds.set(spec.runId, handle.id);
    return clone(handle);
  }

  async status(handle: JobHandle): Promise<JobStatus> {
    const record = this.requireRecord(handle);
    if (!TERMINAL_STATES.has(record.status.state)) {
      const scripted = record.statusScript[Math.min(record.statusCursor, record.statusScript.length - 1)];
      record.statusCursor += 1;
      this.transition(record, scripted, TERMINAL_STATES.has(scripted.state) ? record.plannedResult : undefined);
    }
    return clone(record.status);
  }

  async collect(handle: JobHandle): Promise<JobResult> {
    const record = this.requireRecord(handle);
    if (!TERMINAL_STATES.has(record.status.state) || !record.result) throw new Error("job_not_terminal");
    return clone(record.result);
  }

  async stop(handle: JobHandle, _reason?: string): Promise<void> {
    const record = this.findRecord(handle);
    if (!record || record.removed || TERMINAL_STATES.has(record.status.state)) return;
    this.transition(record, { state: "stopped" });
  }

  async remove(handle: JobHandle): Promise<void> {
    const record = this.findRecord(handle);
    if (!record || record.removed) return;
    if (!TERMINAL_STATES.has(record.status.state)) throw new Error("job_not_terminal");
    record.removed = true;
  }

  async finish(handle: JobHandle, result: JobResult = { exitCode: 0, reason: "completed" }): Promise<void> {
    const record = this.requireRecord(handle);
    this.transition(record, statusFor(result), result);
  }

  async lose(handle: JobHandle): Promise<void> {
    const record = this.requireRecord(handle);
    this.transition(record, { state: "lost" });
  }

  private transition(record: FakeJobRecord, next: JobStatus, result?: JobResult): void {
    if (TERMINAL_STATES.has(record.status.state)) return;
    if (record.status.state === "running" && next.state === "pending") {
      throw new Error("job_illegal_transition");
    }
    if (result && statusFor(result).state !== next.state) throw new Error("job_result_status_mismatch");
    record.status = clone(next);
    if (TERMINAL_STATES.has(next.state)) {
      record.result = clone(result ?? resultFor(next));
    }
  }

  private findRecord(handle: JobHandle): FakeJobRecord | undefined {
    if (handle.backend !== BACKEND) throw new Error("job_backend_mismatch");
    return this.jobs.get(handle.id);
  }

  private requireRecord(handle: JobHandle): FakeJobRecord {
    const record = this.findRecord(handle);
    if (!record) throw new Error("job_not_found");
    if (record.removed) throw new Error("job_removed");
    return record;
  }
}
