import type { Prisma, PrismaClient } from "#prisma";
import {
  type AgentEvent,
  DEFAULT_MAX_BUFFERED_BYTES_PER_RUN,
  RelayBackpressureError,
  type RelayStore,
  RelayUnknownError,
  type ToolEvent,
} from "./relay-store.js";

const DEFAULT_POLL_INTERVAL_MS = 200;
const TOOL_QUEUE = "tool";

interface RunCounters {
  toolSeq: number;
  nextChannel: number;
  relayBytes: number;
}

/**
 * Postgres-backed RelayStore, safe across proxy replicas: every write locks the run's
 * SubstrateRun row first, which serializes seq assignment and byte accounting per run.
 * Line text is repository tool traffic: it is stored and returned, never logged.
 */
export class PrismaRelayStore implements RelayStore {
  private readonly maxBytes: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly db: PrismaClient,
    options: { maxBufferedBytesPerRun?: number; pollIntervalMs?: number } = {},
  ) {
    this.maxBytes = options.maxBufferedBytesPerRun ?? DEFAULT_MAX_BUFFERED_BYTES_PER_RUN;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /** Runs `fn` in a transaction holding the run row's lock. */
  private locked<T>(token: string, fn: (tx: Prisma.TransactionClient, run: RunCounters) => Promise<T>): Promise<T> {
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<RunCounters[]>`
        SELECT "toolSeq", "nextChannel", "relayBytes" FROM "SubstrateRun" WHERE "token" = ${token} FOR UPDATE`;
      const run = rows[0];
      if (!run) throw new RelayUnknownError();
      return fn(tx, run);
    });
  }

  private async requireChannel(tx: Prisma.TransactionClient, token: string, channel: string) {
    const row = await tx.substrateRelayChannel.findUnique({
      where: { runToken_channel: { runToken: token, channel } },
    });
    if (!row) throw new RelayUnknownError();
    return row;
  }

  private appendTool(
    tx: Prisma.TransactionClient,
    token: string,
    run: RunCounters,
    event: { type: string; channel?: string; line?: string },
    bytes: number,
  ): Promise<unknown> {
    const seq = run.toolSeq + 1;
    return Promise.all([
      tx.substrateRun.update({
        where: { token },
        data: { toolSeq: seq, relayBytes: run.relayBytes + bytes },
      }),
      tx.substrateRelayEvent.create({
        data: { runToken: token, queue: TOOL_QUEUE, seq, type: event.type, channel: event.channel, line: event.line },
      }),
    ]);
  }

  async openChannel(runToken: string): Promise<string> {
    return this.locked(runToken, async (tx, run) => {
      const id = `c${run.nextChannel}`;
      await tx.substrateRun.update({ where: { token: runToken }, data: { nextChannel: run.nextChannel + 1 } });
      await tx.substrateRelayChannel.create({ data: { runToken, channel: id } });
      await this.appendTool(tx, runToken, run, { type: "open", channel: id }, 0);
      return id;
    });
  }

  async fromAgent(runToken: string, channel: string, sendSeq: number, line: string): Promise<void> {
    await this.locked(runToken, async (tx, run) => {
      const row = await this.requireChannel(tx, runToken, channel);
      if (sendSeq <= row.agentSeen) return;
      const bytes = Buffer.byteLength(line);
      if (run.relayBytes + bytes > this.maxBytes) throw new RelayBackpressureError();
      await tx.substrateRelayChannel.update({
        where: { runToken_channel: { runToken, channel } },
        data: { agentSeen: sendSeq },
      });
      await this.appendTool(tx, runToken, run, { type: "line", channel, line }, bytes);
    });
  }

  async closeFromAgent(runToken: string, channel: string): Promise<void> {
    await this.locked(runToken, async (tx, run) => {
      await this.requireChannel(tx, runToken, channel);
      await this.appendTool(tx, runToken, run, { type: "close", channel }, 0);
    });
  }

  async fromTool(runToken: string, channel: string, sendSeq: number, line: string): Promise<void> {
    await this.locked(runToken, async (tx, run) => {
      const row = await this.requireChannel(tx, runToken, channel);
      if (sendSeq <= row.toolSeen) return;
      const bytes = Buffer.byteLength(line);
      if (run.relayBytes + bytes > this.maxBytes) throw new RelayBackpressureError();
      const seq = row.agentSeq + 1;
      await tx.substrateRelayChannel.update({
        where: { runToken_channel: { runToken, channel } },
        data: { toolSeen: sendSeq, agentSeq: seq },
      });
      await tx.substrateRun.update({ where: { token: runToken }, data: { relayBytes: run.relayBytes + bytes } });
      await tx.substrateRelayEvent.create({ data: { runToken, queue: channel, seq, type: "line", line } });
    });
  }

  async closeFromTool(runToken: string, channel: string): Promise<void> {
    await this.locked(runToken, async (tx) => {
      const row = await this.requireChannel(tx, runToken, channel);
      const seq = row.agentSeq + 1;
      await tx.substrateRelayChannel.update({
        where: { runToken_channel: { runToken, channel } },
        data: { agentSeq: seq },
      });
      await tx.substrateRelayEvent.create({ data: { runToken, queue: channel, seq, type: "close" } });
    });
  }

  async requestCollect(runToken: string): Promise<void> {
    await this.locked(runToken, async (tx, run) => {
      await this.appendTool(tx, runToken, run, { type: "collect" }, 0);
    });
  }

  async pollTool(runToken: string, after: number, waitMs: number, signal?: AbortSignal): Promise<ToolEvent[]> {
    const rows = await this.poll(runToken, TOOL_QUEUE, after, waitMs, signal);
    return rows.map((r): ToolEvent => {
      switch (r.type) {
        case "open":
          return { seq: r.seq, type: "open", channel: r.channel ?? "" };
        case "line":
          return { seq: r.seq, type: "line", channel: r.channel ?? "", line: r.line ?? "" };
        case "close":
          return { seq: r.seq, type: "close", channel: r.channel ?? "" };
        default:
          return { seq: r.seq, type: "collect" };
      }
    });
  }

  async pollAgent(
    runToken: string,
    channel: string,
    after: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<AgentEvent[]> {
    const rows = await this.poll(runToken, channel, after, waitMs, signal, channel);
    return rows.map((r): AgentEvent =>
      r.type === "line" ? { seq: r.seq, type: "line", line: r.line ?? "" } : { seq: r.seq, type: "close" },
    );
  }

  private async poll(
    runToken: string,
    queue: string,
    after: number,
    waitMs: number,
    signal: AbortSignal | undefined,
    channel?: string,
  ) {
    // Acknowledge: delete what the receiver handled and release its bytes.
    await this.locked(runToken, async (tx, run) => {
      if (channel !== undefined) await this.requireChannel(tx, runToken, channel);
      const sums = await tx.$queryRaw<{ bytes: number }[]>`
        SELECT COALESCE(SUM(octet_length("line")), 0)::int AS bytes FROM "SubstrateRelayEvent"
        WHERE "runToken" = ${runToken} AND "queue" = ${queue} AND "seq" <= ${after}`;
      const freed = sums[0]?.bytes ?? 0;
      if (freed > 0 || after > 0) {
        await tx.substrateRelayEvent.deleteMany({ where: { runToken, queue, seq: { lte: after } } });
        if (freed > 0) {
          await tx.substrateRun.update({
            where: { token: runToken },
            data: { relayBytes: Math.max(0, run.relayBytes - freed) },
          });
        }
      }
    });
    const deadline = Date.now() + waitMs;
    for (;;) {
      const rows = await this.db.substrateRelayEvent.findMany({
        where: { runToken, queue, seq: { gt: after } },
        orderBy: { seq: "asc" },
      });
      if (rows.length > 0) return rows;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal?.aborted) return [];
      await sleep(Math.min(this.pollIntervalMs, remaining), signal);
      if (signal?.aborted) return [];
    }
  }

  async dropRelay(runToken: string): Promise<void> {
    await this.locked(runToken, async (tx) => {
      await tx.substrateRelayEvent.deleteMany({ where: { runToken } });
      await tx.substrateRelayChannel.deleteMany({ where: { runToken } });
      await tx.substrateRun.update({
        where: { token: runToken },
        data: { toolSeq: 0, nextChannel: 1, relayBytes: 0 },
      });
    });
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
