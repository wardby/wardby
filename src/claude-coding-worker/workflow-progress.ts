/**
 * A workflow run's phases and sub-agents (#582), for the run's steps. Claude Code's task_progress
 * events carry `workflow_progress`: the script's phases and each sub-agent with the id its model
 * requests send (x-claude-code-agent-id), so the coding proxy can group every step under its phase
 * and agent. This reads that list into a small bounded tree and posts it to the proxy, which relays
 * it with the run's steps. Prompt previews and tool summaries are never sent.
 *
 * Best effort: a report that fails is dropped, never the run. Reports are coalesced (the latest
 * tree wins) and at most one is in flight.
 */
import type { WorkflowProgress } from "../core/run-steps/types.js";

// The worker image ships this folder, not core/: these mirror core/run-steps/types.ts (a test keeps them equal).
export const AGENT_REF = /^[A-Za-z0-9_-]{1,64}$/;
export const AGENT_STATE = /^[a-z_]{1,24}$/;
export const MAX_PHASES = 64;
export const MAX_AGENTS = 1_000;
export const MAX_LABEL_CHARS = 200;
/** The proxy route (src/providers/coding-proxy/server.ts WORKFLOW_PROGRESS_PATH). */
export const WORKFLOW_PROGRESS_ROUTE = "wardby/workflow-progress";
const REPORT_TIMEOUT_MS = 5_000;
const MIN_INTERVAL_MS = 1_000;

const text = (value: unknown): string => (typeof value === "string" ? value.slice(0, MAX_LABEL_CHARS) : "");
const int = (value: unknown, max: number): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null;

/** The tree in one task_progress event's workflow_progress, or null when it holds none. */
export function workflowTreeOf(progress: unknown): WorkflowProgress | null {
  if (!Array.isArray(progress)) return null;
  const phases: WorkflowProgress["phases"] = [];
  const agents = new Map<string, WorkflowProgress["agents"][number]>();
  for (const item of progress) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "workflow_phase" && phases.length < MAX_PHASES) {
      const index = int(entry.index, 10_000);
      if (index !== null) phases.push({ index, title: text(entry.title) });
    } else if (entry.type === "workflow_agent" && agents.size < MAX_AGENTS) {
      const id = typeof entry.agentId === "string" && AGENT_REF.test(entry.agentId) ? entry.agentId : null;
      if (id === null) continue;
      // The same agent again (a retry): the later entry is the current one.
      agents.set(id, {
        id,
        label: text(entry.label),
        phaseIndex: int(entry.phaseIndex, 10_000),
        state: typeof entry.state === "string" && AGENT_STATE.test(entry.state) ? entry.state : "unknown",
        attempt: int(entry.attempt, 1_000) ?? 0,
      });
    }
  }
  if (phases.length === 0 && agents.size === 0) return null;
  return { phases, agents: [...agents.values()] };
}

export interface WorkflowProgressReporterOptions {
  /** The coding proxy's base URL, ending in "/". */
  proxyBaseUrl: string;
  /** The run's capability, sent as x-api-key as on its model requests. */
  capability: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Posts the latest tree to the proxy: coalesced, one at a time, never throwing. */
export class WorkflowProgressReporter {
  private latest: string | undefined;
  private sent: string | undefined;
  private inflight: Promise<void> | undefined;
  private lastSentAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: WorkflowProgressReporterOptions) {}

  /** Records the tree in a task_progress event; posts it when it changed. */
  update(progress: unknown): void {
    try {
      const tree = workflowTreeOf(progress);
      if (!tree) return;
      const body = JSON.stringify(tree);
      if (body === this.latest) return;
      this.latest = body;
      this.schedule();
    } catch {
      // A malformed event is skipped.
    }
  }

  /** Sends the latest tree if it was not sent yet, and waits (bounded) for it. Never rejects. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inflight?.catch(() => undefined);
    if (this.latest !== undefined && this.latest !== this.sent) await this.send();
  }

  private schedule(): void {
    if (this.timer || this.inflight) return;
    const now = (this.options.now ?? Date.now)();
    const wait = Math.max(0, this.lastSentAt + MIN_INTERVAL_MS - now);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.send().then(() => {
        if (this.latest !== this.sent) this.schedule();
      });
    }, wait);
    this.timer.unref?.();
  }

  private send(): Promise<void> {
    const body = this.latest;
    if (body === undefined || body === this.sent) return Promise.resolve();
    this.lastSentAt = (this.options.now ?? Date.now)();
    const run = (async () => {
      try {
        await (this.options.fetchImpl ?? fetch)(`${this.options.proxyBaseUrl}${WORKFLOW_PROGRESS_ROUTE}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": this.options.capability },
          body,
          signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
        });
        this.sent = body;
      } catch {
        // Dropped: progress is never a reason to fail the run.
      }
    })();
    this.inflight = run.finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }
}

/** Where a run's workflow is, for the status line (#657). */
export type WorkflowPhaseState = "not_started" | "running" | "completed" | "failed" | "stopped";

// Control characters (C0 and DEL) become spaces, so a phase title stays one plain line.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]+/g;
const plain = (value: string, max: number): string => value.replace(CONTROL, " ").trim().slice(0, max);

/**
 * The "Workflow status: ..." line added to each joined message in a workflow run (#657), so the
 * lead can answer how the workflow is going without reading files. Built only from the script's
 * phase titles, the sub-agents' states and the launch's task id, in fixed wording: never a prompt,
 * a label, a step's text or a result.
 */
export function workflowStatusLine(
  state: WorkflowPhaseState,
  tree: WorkflowProgress | null,
  taskId?: string,
  launches = 1,
): string {
  const task = taskId && AGENT_REF.test(taskId) ? ` (task id ${taskId})` : "";
  const restart = launches > 1 ? `, launch ${launches}` : "";
  if (state === "not_started") return "Workflow status: not started yet.";
  if (state !== "running") return `Workflow status: ${state}${restart}${task}.`;
  const parts: string[] = [];
  const phases = tree?.phases ?? [];
  const agents = tree?.agents ?? [];
  // The phase of the latest agent that is not done, else of the latest agent.
  const active = [...agents].reverse().find((a) => a.state !== "completed" && a.state !== "done") ?? agents.at(-1);
  if (phases.length > 0) {
    const index = active?.phaseIndex ?? null;
    const position = index === null ? -1 : phases.findIndex((p) => p.index === index);
    if (position >= 0) {
      const title = plain(phases[position].title, 80);
      parts.push(`phase ${position + 1} of ${phases.length}${title ? ` (${title})` : ""}`);
    } else {
      parts.push(`${phases.length} phases`);
    }
  }
  if (agents.length > 0) {
    const counts = new Map<string, number>();
    for (const agent of agents) counts.set(agent.state, (counts.get(agent.state) ?? 0) + 1);
    parts.push(`agents: ${[...counts].map(([name, n]) => `${n} ${name.replace(/_/g, " ")}`).join(", ")}`);
  }
  return `Workflow status: running${restart}${task}${parts.length > 0 ? `; ${parts.join("; ")}` : ""}.`;
}
