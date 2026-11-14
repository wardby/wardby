import {
  type AgentEvent,
  RelayBackpressureError,
  type RelayStore,
  RelayUnknownError,
  type ToolEvent,
} from "./relay-store.js";

interface Queued<E> {
  event: E;
  bytes: number;
}

interface ChannelState {
  agentSeen: number;
  toolSeen: number;
  agentSeq: number;
  queue: Queued<AgentEvent>[];
}

interface RunState {
  maxBytes: number;
  toolSeq: number;
  nextChannel: number;
  bytes: number;
  tool: Queued<ToolEvent>[];
  channels: Map<string, ChannelState>;
  waiters: Set<() => void>;
}

/** In-memory RelayStore: the unit-test double for the relay routes. Never logs line content. */
export class MemoryRelayStore implements RelayStore {
  private readonly runs = new Map<string, RunState>();

  /** Makes a run known to the store (the Prisma store's SubstrateRun row). */
  register(token: string, maxBytes: number): void {
    this.runs.set(token, {
      maxBytes,
      toolSeq: 0,
      nextChannel: 1,
      bytes: 0,
      tool: [],
      channels: new Map(),
      waiters: new Set(),
    });
  }

  private run(token: string): RunState {
    const run = this.runs.get(token);
    if (!run) throw new RelayUnknownError();
    return run;
  }

  private channel(run: RunState, channel: string): ChannelState {
    const state = run.channels.get(channel);
    if (!state) throw new RelayUnknownError();
    return state;
  }

  private wake(run: RunState): void {
    for (const waiter of [...run.waiters]) waiter();
  }

  private pushTool(run: RunState, event: DistributiveOmit<ToolEvent, "seq">, bytes: number): void {
    run.toolSeq += 1;
    run.bytes += bytes;
    run.tool.push({ event: { ...event, seq: run.toolSeq }, bytes });
    this.wake(run);
  }

  private pushAgent(
    run: RunState,
    channel: ChannelState,
    event: DistributiveOmit<AgentEvent, "seq">,
    bytes: number,
  ): void {
    channel.agentSeq += 1;
    run.bytes += bytes;
    channel.queue.push({ event: { ...event, seq: channel.agentSeq }, bytes });
    this.wake(run);
  }

  async openChannel(runToken: string): Promise<string> {
    const run = this.run(runToken);
    const id = `c${run.nextChannel}`;
    run.nextChannel += 1;
    run.channels.set(id, { agentSeen: 0, toolSeen: 0, agentSeq: 0, queue: [] });
    this.pushTool(run, { type: "open", channel: id }, 0);
    return id;
  }

  async fromAgent(runToken: string, channel: string, sendSeq: number, line: string): Promise<void> {
    const run = this.run(runToken);
    const state = this.channel(run, channel);
    if (sendSeq <= state.agentSeen) return;
    const bytes = Buffer.byteLength(line);
    if (run.bytes + bytes > run.maxBytes) throw new RelayBackpressureError();
    state.agentSeen = sendSeq;
    this.pushTool(run, { type: "line", channel, line }, bytes);
  }

  async closeFromAgent(runToken: string, channel: string): Promise<void> {
    const run = this.run(runToken);
    this.channel(run, channel);
    this.pushTool(run, { type: "close", channel }, 0);
  }

  async fromTool(runToken: string, channel: string, sendSeq: number, line: string): Promise<void> {
    const run = this.run(runToken);
    const state = this.channel(run, channel);
    if (sendSeq <= state.toolSeen) return;
    const bytes = Buffer.byteLength(line);
    if (run.bytes + bytes > run.maxBytes) throw new RelayBackpressureError();
    state.toolSeen = sendSeq;
    this.pushAgent(run, state, { type: "line", line }, bytes);
  }

  async closeFromTool(runToken: string, channel: string): Promise<void> {
    const run = this.run(runToken);
    this.pushAgent(run, this.channel(run, channel), { type: "close" }, 0);
  }

  async requestCollect(runToken: string): Promise<void> {
    this.pushTool(this.run(runToken), { type: "collect" }, 0);
  }

  pollTool(runToken: string, after: number, waitMs: number, signal?: AbortSignal): Promise<ToolEvent[]> {
    return this.poll(runToken, (run) => run.tool, after, waitMs, signal);
  }

  pollAgent(
    runToken: string,
    channel: string,
    after: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<AgentEvent[]> {
    return this.poll(runToken, (run) => this.channel(run, channel).queue, after, waitMs, signal);
  }

  private async poll<E extends { seq: number }>(
    runToken: string,
    select: (run: RunState) => Queued<E>[],
    after: number,
    waitMs: number,
    signal: AbortSignal | undefined,
  ): Promise<E[]> {
    const run = this.run(runToken);
    const take = (): E[] => {
      const queue = select(run);
      const acked = queue.filter((q) => q.event.seq <= after);
      for (const q of acked) run.bytes -= q.bytes;
      const remaining = queue.filter((q) => q.event.seq > after);
      queue.splice(0, queue.length, ...remaining);
      return remaining.map((q) => q.event);
    };
    const first = take();
    if (first.length > 0 || waitMs <= 0 || signal?.aborted) return first;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        run.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      run.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
    return take();
  }

  async dropRelay(runToken: string): Promise<void> {
    const run = this.run(runToken);
    run.tool = [];
    run.channels.clear();
    run.toolSeq = 0;
    run.nextChannel = 1;
    run.bytes = 0;
    this.wake(run);
  }
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
