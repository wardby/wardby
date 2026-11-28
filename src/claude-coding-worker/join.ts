/**
 * Join (phase 1, Claude Code runs): people with execute access to the agent join a running run and
 * send it messages. The control plane keeps them as the run's steps; this worker long-polls the
 * coding proxy for them (`wardby/join/poll`, relayed to the control plane's run-steps listener) and
 * feeds them into the Claude Code session as streamed user messages: a message with priority "later"
 * (a user turn of its own once the agent finishes its current answer), an interrupt with "now" (the
 * current turn stops at once). Not "next": the SDK delivers that inside the result of the tool call
 * that is running, where the agent rightly distrusts it as possible prompt injection.
 *
 * While anyone is joined the session stays open after the agent's answer, waiting for the next
 * message; it closes when the last person leaves (once the agent is idle), or at the run's
 * deadline less a margin, so the run still finishes and is collected before its timeout.
 *
 * Secrets: message text is never logged or traced here; the poll's body and answer are never
 * echoed. A failed poll is retried with a delay; the proxy saying join is unavailable stops it for
 * the rest of the run.
 */

/** The proxy route (src/providers/coding-proxy/server.ts JOIN_POLL_PATH). */
export const JOIN_POLL_ROUTE = "wardby/join/poll";
import { JOINED_MESSAGE_PREFIX, joinedMessageText } from "../core/join-wording.js";

export { JOINED_MESSAGE_PREFIX, joinedMessageText };
/** While someone is joined the proxy holds a poll up to ~25 s; this bounds one request. */
const POLL_TIMEOUT_MS = 35_000;
/** The wait between polls while nobody is joined (the control plane answers those at once). */
export const IDLE_POLL_MS = 5_000;
/** Delays after a failed poll: the last one repeats. */
const BACKOFF_MS = [2_000, 5_000];
/** Mirrors driver.ts RESULT_BUNDLE_DEADLINE_MARGIN_MS (2 min), plus a minute for the agent's last answer. */
export const JOIN_DEADLINE_MARGIN_MS = 2 * 60_000 + 60_000;
const MAX_MESSAGE_CHARS = 16_384;
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface JoinedMessage {
  text: string;
  interrupt: boolean;
}

export interface JoinEvents {
  message(message: JoinedMessage): void;
  joinedChanged(joined: boolean): void;
}

/** Where joined messages come from: the proxy in a run, a fake in tests. */
export interface JoinSource {
  start(events: JoinEvents): void;
  stop(): void;
}

export interface ProxyJoinChannelOptions {
  /** The coding proxy's base URL, ending in "/". */
  proxyBaseUrl: string;
  /** The run's capability, sent as x-api-key as on its model requests. */
  capability: string;
  /** The run's deadline (CodingTaskInput.deadlineAt); polling stops JOIN_DEADLINE_MARGIN_MS before it. */
  deadlineAt?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** The poll's answer, checked field by field; null when it is not the expected shape. */
export function parseJoinPollAnswer(
  value: unknown,
): { joined: boolean; messages: Array<{ seq: number; text: string; interrupt: boolean }> } | null {
  if (value === null || typeof value !== "object") return null;
  const answer = value as { joined?: unknown; messages?: unknown };
  if (typeof answer.joined !== "boolean" || !Array.isArray(answer.messages)) return null;
  const messages: Array<{ seq: number; text: string; interrupt: boolean }> = [];
  for (const item of answer.messages as unknown[]) {
    if (item === null || typeof item !== "object") return null;
    const m = item as { seq?: unknown; text?: unknown; interrupt?: unknown };
    if (typeof m.seq !== "number" || !Number.isInteger(m.seq) || m.seq < 1) return null;
    if (typeof m.text !== "string" || typeof m.interrupt !== "boolean") return null;
    messages.push({ seq: m.seq, text: m.text.slice(0, MAX_MESSAGE_CHARS), interrupt: m.interrupt });
  }
  return { joined: answer.joined, messages };
}

/** Long-polls the proxy for the whole run, in the background. Never throws. */
export class ProxyJoinChannel implements JoinSource {
  private readonly stopper = new AbortController();
  private after = 0;
  private joined = false;
  private running = false;
  private warned = false;

  constructor(private readonly options: ProxyJoinChannelOptions) {}

  start(events: JoinEvents): void {
    if (this.running) return;
    this.running = true;
    void this.loop(events);
  }

  stop(): void {
    this.stopper.abort();
  }

  private stopAt(): number {
    const at = this.options.deadlineAt === undefined ? Number.NaN : Date.parse(this.options.deadlineAt);
    return Number.isFinite(at) ? at - JOIN_DEADLINE_MARGIN_MS : Number.POSITIVE_INFINITY;
  }

  private async loop(events: JoinEvents): Promise<void> {
    const now = this.options.now ?? Date.now;
    const sleep = this.options.sleep ?? defaultSleep;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let failures = 0;
    while (!this.stopper.signal.aborted && now() < this.stopAt()) {
      let answer: ReturnType<typeof parseJoinPollAnswer> = null;
      try {
        const response = await fetchImpl(joinPollUrl(this.options.proxyBaseUrl), {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": this.options.capability },
          body: JSON.stringify({ after: this.after, joined: this.joined }),
          signal: AbortSignal.any([this.stopper.signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]),
        });
        // The proxy has no control-plane route for join: off for the rest of the run.
        if (response.status === 404) return;
        if (response.status === 200) answer = parseJoinPollAnswer(await response.json());
        else await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        answer = null;
        // Once per run, by name only (never a message: it could quote the URL or a body): a poll that
        // keeps failing must show in the worker's diagnostics, not retry unseen.
        if (failures === 0 && !this.stopper.signal.aborted && !this.warned) {
          this.warned = true;
          process.stderr.write(
            `${JSON.stringify({ warning: "join_poll_failed", errorName: error instanceof Error ? error.name : typeof error })}\n`,
          );
        }
      }
      if (this.stopper.signal.aborted) return;
      if (!answer) {
        await sleep(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)], this.stopper.signal);
        failures += 1;
        continue;
      }
      failures = 0;
      for (const message of answer.messages) {
        if (message.seq <= this.after) continue;
        this.after = message.seq;
        events.message({ text: message.text, interrupt: message.interrupt });
      }
      if (answer.joined !== this.joined) {
        this.joined = answer.joined;
        events.joinedChanged(answer.joined);
      }
      // The control plane holds a poll only while someone is joined; otherwise it answers at once,
      // so the worker waits before asking again (keeps the listener's connections for joined runs).
      if (!answer.joined && answer.messages.length === 0) await sleep(IDLE_POLL_MS, this.stopper.signal);
    }
  }
}

/**
 * A streamed user message, as the Agent SDK takes it (SDKUserMessage). Its content is always a list
 * of text blocks, never a plain string: the SDK keeps the message in the conversation as given, and
 * the coding proxy's request check accepts a plain-string user message only in a workflow session
 * (parseAnthropicRequest), so string content would get every later model request refused.
 */
/** The poll route on the proxy. The launchers give WARDBY_PROXY_URL without a trailing slash. */
export function joinPollUrl(proxyBaseUrl: string): string {
  return `${proxyBaseUrl.endsWith("/") ? proxyBaseUrl : `${proxyBaseUrl}/`}${JOIN_POLL_ROUTE}`;
}

export interface ClaudeUserMessage {
  type: "user";
  message: { role: "user"; content: { type: "text"; text: string }[] };
  parent_tool_use_id: null;
  priority?: "now" | "later";
}

const userMessage = (text: string, priority?: "now" | "later"): ClaudeUserMessage => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
  parent_tool_use_id: null,
  ...(priority ? { priority } : {}),
});

export interface JoinedInputOptions {
  /** The run's deadline; the input closes JOIN_DEADLINE_MARGIN_MS before it. */
  deadlineAt?: string;
  now?: () => number;
  /** Called with a fixed event name (never message text), for the run's debug trace. */
  trace?: (event: string, data?: Record<string, unknown>) => void;
}

/**
 * The session's streamed input: the task first, then each joined message. Closes (so the SDK ends
 * the session as with a string prompt) when the agent is idle and nobody is joined, or at the
 * deadline margin, or when the run ends.
 */
export class JoinedInput {
  private readonly queue: ClaudeUserMessage[] = [];
  private joined = false;
  /** A message has been handed to the session and no result has followed it yet. */
  private busy = true;
  private closed = false;
  private wake: (() => void) | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private delivered = 0;

  constructor(
    private readonly prompt: string,
    private readonly source: JoinSource,
    private readonly options: JoinedInputOptions = {},
  ) {
    const at = options.deadlineAt === undefined ? Number.NaN : Date.parse(options.deadlineAt);
    // A timer longer than setTimeout's limit (~24.8 days) would fire at once: no run is that long.
    const wait = Number.isFinite(at) ? Math.max(0, at - JOIN_DEADLINE_MARGIN_MS - (options.now ?? Date.now)()) : NaN;
    if (Number.isFinite(wait) && wait <= MAX_TIMER_MS) {
      this.deadlineTimer = setTimeout(() => {
        options.trace?.("join_deadline_reached");
        this.close();
      }, wait);
      this.deadlineTimer.unref?.();
    }
    source.start({
      message: (message) => {
        if (this.closed) return;
        this.queue.push(userMessage(joinedMessageText(message.text), message.interrupt ? "now" : "later"));
        this.signal();
      },
      joinedChanged: (joined) => {
        this.joined = joined;
        options.trace?.("join_state", { joined });
        this.maybeClose();
      },
    });
  }

  /** Whether any joined message has reached the session (later turns are joined turns). */
  get deliveredCount(): number {
    return this.delivered;
  }

  /** The session's answer for the work so far arrived: the agent is idle until the next message. */
  onResult(): void {
    if (this.queue.length === 0) this.busy = false;
    this.maybeClose();
  }

  /** Ends the input and the polling (the run is over, or the deadline margin is reached). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.source.stop();
    this.signal();
  }

  async *messages(): AsyncGenerator<ClaudeUserMessage> {
    yield userMessage(this.prompt);
    while (true) {
      while (this.queue.length > 0 && !this.closed) {
        const next = this.queue.shift() as ClaudeUserMessage;
        this.busy = true;
        this.delivered += 1;
        this.options.trace?.("join_message_delivered", { interrupt: next.priority === "now" });
        yield next;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private maybeClose(): void {
    if (!this.busy && !this.joined && this.queue.length === 0) this.close();
  }

  private signal(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
