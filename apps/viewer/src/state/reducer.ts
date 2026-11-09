import type { GraphRun, GraphSnapshot, ServiceStatus, ViewerEvent } from "../api/types";
import { formatUsd } from "../format/money";

export interface TickerItem {
  at: number;
  text: string;
}

export interface ViewerModel {
  runs: Map<string, GraphRun>;
  spend: GraphSnapshot["spend"] | null;
  truncated: boolean;
  /** From SSE status frames. */
  live: boolean;
  /** Newest first, max TICKER_MAX. */
  ticker: TickerItem[];
  /** Step events seen per run in the model; the detail panel refetches when its run's count changes. */
  stepChanges: Map<string, number>;
}

export type Action =
  | { type: "snapshot"; snapshot: GraphSnapshot }
  | { type: "event"; event: ViewerEvent; at: number; agentName?: (agentId: string) => string | undefined }
  | { type: "status"; connected: boolean }
  | { type: "reset" };

const TICKER_MAX = 50;

export const initialModel: ViewerModel = {
  runs: new Map(),
  spend: null,
  truncated: false,
  live: false,
  ticker: [],
  stepChanges: new Map(),
};

const short = (id: string): string => id.slice(-6);

function tickerText(
  event: Exclude<ViewerEvent, { kind: "step" }>,
  agentName?: (agentId: string) => string | undefined,
): string {
  switch (event.kind) {
    case "run": {
      const name = agentName?.(event.agentId);
      const line = `${short(event.runId)} ${event.status} · turn ${event.turns} · ${formatUsd(event.costUsd)}`;
      return name ? `${name} ${line}` : line;
    }
    case "service":
      return `${short(event.runId)} ${event.name} ${event.state}`;
    case "outcome":
      return `${short(event.runId)} ${event.source.replace("_", " ")}`;
  }
}

function upsertService(
  services: readonly ServiceStatus[],
  event: Extract<ViewerEvent, { kind: "service" }>,
  at: number,
) {
  const index = services.findIndex((s) => s.name === event.name);
  if (index === -1) {
    const added: ServiceStatus = {
      name: event.name,
      state: event.state,
      attempts: event.attempts,
      reason: null,
      readyAt: null,
      failedAt: null,
      createdAt: new Date(at).toISOString(),
    };
    return [...services, added];
  }
  return services.map((s, i) => (i === index ? { ...s, state: event.state, attempts: event.attempts } : s));
}

/**
 * Events with an unknown run or an outcome change nothing here: the hook sees
 * them first and refetches the graph, which is where they show up.
 */
function applyEvent(
  model: ViewerModel,
  event: Exclude<ViewerEvent, { kind: "step" }>,
  at: number,
): ViewerModel["runs"] {
  if (event.kind === "outcome") return model.runs;
  const run = model.runs.get(event.runId);
  if (!run) return model.runs;
  const updated: GraphRun =
    event.kind === "run"
      ? {
          ...run,
          status: event.status,
          turns: event.turns,
          tokensIn: event.tokensIn,
          tokensOut: event.tokensOut,
          costUsd: event.costUsd,
          finishedAt: event.finishedAt,
          parentRunId: event.parentRunId,
        }
      : { ...run, services: upsertService(run.services, event, at) };
  const runs = new Map(model.runs);
  runs.set(run.id, updated);
  return runs;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNullable = <T>(v: unknown, is: (x: unknown) => x is T): v is T | null => v === null || is(v);

/** Cheap shape check for an event off the wire, so a malformed one is dropped, not thrown on. */
export function isViewerEvent(v: unknown): v is ViewerEvent {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  if (!isString(e.runId)) return false;
  switch (e.kind) {
    case "run":
      return (
        isString(e.agentId) &&
        isString(e.status) &&
        isNum(e.turns) &&
        isNum(e.tokensIn) &&
        isNum(e.tokensOut) &&
        isNum(e.costUsd) &&
        isNullable(e.finishedAt, isString) &&
        isNullable(e.parentRunId, isString)
      );
    case "service":
      return isString(e.name) && isString(e.state) && isNullable(e.attempts, isNum);
    case "outcome":
      return isString(e.source);
    case "step":
      return (
        isNum(e.seq) &&
        (e.stepKind === "tool" || e.stepKind === "said") &&
        isNullable(e.tool, isString) &&
        isString(e.summary) &&
        isNullable(e.status, isString) &&
        isString(e.at)
      );
    default:
      return false;
  }
}

export function reduce(model: ViewerModel, action: Action): ViewerModel {
  switch (action.type) {
    case "snapshot":
      return {
        ...model,
        runs: new Map(action.snapshot.runs.map((r) => [r.id, r])),
        spend: action.snapshot.spend,
        truncated: action.snapshot.truncated,
      };
    case "event": {
      if (!isViewerEvent(action.event)) return model;
      const event = action.event;
      // A step changes no run field and is too frequent for the ticker: it only marks the run's detail stale.
      if (event.kind === "step") {
        if (!model.runs.has(event.runId)) return model;
        const stepChanges = new Map(model.stepChanges);
        stepChanges.set(event.runId, (stepChanges.get(event.runId) ?? 0) + 1);
        return { ...model, stepChanges };
      }
      const runs = applyEvent(model, event, action.at);
      const item: TickerItem = { at: action.at, text: tickerText(event, action.agentName) };
      return { ...model, runs, ticker: [item, ...model.ticker].slice(0, TICKER_MAX) };
    }
    case "status":
      return { ...model, live: action.connected };
    case "reset":
      return initialModel;
  }
}
