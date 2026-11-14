export type ToolEvent =
  | { seq: number; type: "open"; channel: string }
  | { seq: number; type: "line"; channel: string; line: string }
  | { seq: number; type: "close"; channel: string }
  | { seq: number; type: "collect" };
export type AgentEvent = { seq: number; type: "line"; line: string } | { seq: number; type: "close" };

export class RelayBackpressureError extends Error {
  readonly code = "relay_backpressure";
  constructor() {
    super("relay_backpressure");
  }
}
export class RelayUnknownError extends Error {
  readonly code = "relay_unknown"; // unknown run or channel
  constructor() {
    super("relay_unknown");
  }
}

/** Default cap on undelivered relay line text per run. */
export const DEFAULT_MAX_BUFFERED_BYTES_PER_RUN = 8 * 1024 * 1024;

/** Line relay between a run's agent-side and tool-side socket bridges. Never logs line content. */
export interface RelayStore {
  /** The run must have a SubstrateRun row (created by the launcher). Returns "c1", "c2", ... */
  openChannel(runToken: string): Promise<string>;
  /** Ignored when sendSeq <= the last accepted sendSeq for (channel, agent→tool). */
  fromAgent(runToken: string, channel: string, sendSeq: number, line: string): Promise<void>;
  closeFromAgent(runToken: string, channel: string): Promise<void>;
  fromTool(runToken: string, channel: string, sendSeq: number, line: string): Promise<void>;
  closeFromTool(runToken: string, channel: string): Promise<void>;
  requestCollect(runToken: string): Promise<void>;
  /** Deletes events with seq <= after, then returns newer ones, waiting up to waitMs for the first. */
  pollTool(runToken: string, after: number, waitMs: number, signal?: AbortSignal): Promise<ToolEvent[]>;
  pollAgent(
    runToken: string,
    channel: string,
    after: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<AgentEvent[]>;
  /** Deletes the run's channels and events (not its SubstrateRun row). */
  dropRelay(runToken: string): Promise<void>;
}
