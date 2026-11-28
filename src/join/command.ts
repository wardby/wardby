/**
 * `wardby join -`: join a running wardby run from a terminal and talk to its agent. The link comes
 * from the join_run MCP tool: `terminal.command` is this command with the link as its argument, ready
 * to copy; with `-` the link is pasted on stdin instead, which keeps it out of shell history and the
 * process list (as `wardby resume` offers both).
 *
 * Shows the run's steps live (the agent's words, its commands with their status, and what people
 * send), sends each line typed, and ends with the run's outcome. `/interrupt text` (or `/i text`) interrupts the agent first;
 * `/leave` leaves (the run finishes its work); `/quit` stops the agent after a confirmation. Ctrl-C
 * leaves, as /leave does (a second Ctrl-C stops watching); closing the terminal (SIGHUP) or SIGTERM
 * leaves and exits. A poll that fails is retried with backoff; if the server stays unreachable or
 * refuses, the CLI tries to leave on the way out, so a lost connection does not hold the run open.
 * Only a CLI cut off for longer than its token lasts (10 minutes) cannot leave; the run then stays
 * open until its timeout.
 *
 * Runs without a database or any server configuration: node built-ins and the link helpers only.
 * The link's token is a credential: it is sent only as `Authorization: Bearer` to the join API,
 * never printed or logged; every answer carries a fresh token, kept in memory only. Server text is
 * shown with control characters removed, so it cannot drive the terminal.
 */
import { clearLine, createInterface, cursorTo, moveCursor, type Interface } from "node:readline";
import { parseArgs } from "node:util";
import { JOIN_API_PATHS, parseJoinLink, type JoinApiAction } from "../mcp/tools/join-link.js";

export const JOIN_USAGE = `usage: wardby join '<link>'
       wardby join -

Join a running wardby run from this terminal and talk to its agent. Run the join_run MCP tool
first: its terminal.command is this command with the link, ready to copy. With "-", paste the link
when asked instead (or pipe it in): this keeps it out of your shell history and the process list,
where a link given as an argument stays (its first token works for 10 minutes; the chat renews it in
memory after that).

In the chat:
  a line + Enter   send it to the agent (it reads it once it finishes what it is doing now)
  /interrupt text  interrupt: the agent stops its current turn, then handles text
  /i text          the same, shorter
  /leave           leave the run; it finishes its work and wraps up as usual
  /quit            stop the agent (asks first): the run ends cancelled, its work is not pushed
  /help            show these commands
  Ctrl-C           leave, as /leave`;

export const JOIN_MESSAGES = {
  noLink: "No link was given. Paste the terminal.link that join_run returned.",
  badLink: "That is not a Wardby join link.",
  insecureOrigin: "Refusing to use a link that points to a non-https address.",
  unreachable: "Could not reach the Wardby server.",
  linkRejected: "The join link is invalid or has expired. Ask for a new one with join_run.",
  notFound: "The run was not found, or you cannot see it.",
  noAccess: "You need execute access to this run's agent to join it.",
  joined:
    "Joined. Type a message and press Enter. /i text interrupts, /leave leaves (the run finishes its work), " +
    "/quit stops the agent, /help lists every command.",
  confirmQuit:
    "This stops the agent now: the run ends as cancelled, and its work is not pushed to a result branch or pull request. To let it finish and keep its work, use /leave instead.",
  notStopped: "Not stopped. Still joined.",
  stopping: "Stopping the agent...",
  left: "Left. The run finishes its work and wraps up when the agent is idle. This window keeps showing the run until it ends; press Ctrl-C to stop watching.",
  lostConnection: "Lost the connection to the Wardby server. Left the run so it is not held open.",
  lostConnectionNotLeft:
    "Lost the connection to the Wardby server and could not leave the run; it stays open until its timeout. Join it again with a new link from join_run to leave it.",
  sendFailed: "Could not send that",
} as const;

const MAX_LINK_BYTES = 8192;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_MS = 2_000;
/** Waits between retries of a failed poll; after the last one the CLI gives up (and leaves). */
const RETRY_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
/** How long a best-effort leave may take on the way out. */
const EXIT_LEAVE_MS = 5_000;
const TERMINAL = new Set(["succeeded", "failed", "refused", "lost", "cancelled", "budget_exhausted"]);

export interface JoinDeps {
  fetch?: typeof globalThis.fetch;
  /** The lines typed (default: standard input); the first one is the link. */
  input?: NodeJS.ReadableStream;
  out?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called with the handler for Ctrl-C, closing the terminal and termination (default: process
   * SIGINT, SIGHUP and SIGTERM). Ctrl-C leaves and keeps watching (a second one exits); SIGHUP and
   * SIGTERM leave and then exit, so a closed terminal never keeps the run open.
   */
  onSignal?: (handler: (signal: "SIGINT" | "SIGHUP" | "SIGTERM") => void) => void;
  /** Ends the process after a SIGHUP or SIGTERM (default: process.exit). */
  exit?: (code: number) => void;
  pollMs?: number;
}

class JoinCliError extends Error {
  /** The HTTP status that refused the call; 0 when the server could not be reached. */
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** A failure worth retrying: the server unreachable, a timeout, or a 5xx. */
function transient(err: unknown): boolean {
  return err instanceof JoinCliError && (err.status === 0 || err.status >= 500);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

// Whole escape sequences first (CSI, with ESC [ or the C1 form, and OSC up to BEL or ST), so none
// leaves its parameters behind; then any other C0 and C1 control character (and DEL), except newline.
// eslint-disable-next-line no-control-regex
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC = /(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
/** Bidirectional overrides and isolates, which can make text read differently from what it is. */
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;

/** Server text as plain text: escape sequences and control characters removed, length capped. */
export function cleanServerText(text: unknown, max = 8_000): string {
  return (typeof text === "string" ? text : "")
    .replace(CSI, "")
    .replace(OSC, "")
    .replace(CONTROL_CHARS, "")
    .replace(BIDI_CONTROLS, "")
    .slice(0, max);
}

/** Text after its label: every line after the first indented, so no line of it can pass for a new chat line. */
function labelled(label: string, text: string): string {
  return `${label}${text.replace(/\n/g, "\n    ")}`;
}

interface Step {
  seq: number;
  kind: string;
  tool?: string | null;
  summary?: string;
  status?: string | null;
  detail?: string | null;
}

/** One step as a chat line. */
export function stepLine(step: Step): string {
  const summary = cleanServerText(step.summary, 300).replace(/\n/g, " ");
  const text = cleanServerText(step.detail ?? step.summary);
  switch (step.kind) {
    case "join":
      return "· someone joined";
    case "leave":
      return "· someone left";
    case "said":
      return labelled("agent: ", text);
    case "message":
      return labelled("person: ", text);
    case "interrupt":
      return labelled("person (interrupt): ", text);
    case "tool": {
      const status = step.status ? ` (${cleanServerText(step.status, 40)})` : "";
      return `  ${cleanServerText(step.tool ?? "tool", 128)}: ${summary}${status}`;
    }
    default:
      return `  ${summary}`;
  }
}

/** The join API, holding the newest token. */
class JoinSession {
  constructor(
    private readonly origin: string,
    private token: string,
    private readonly doFetch: typeof globalThis.fetch,
  ) {}

  async call(action: JoinApiAction, body: unknown = {}): Promise<{ status: number; json: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.origin}${JOIN_API_PATHS[action]}`, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new JoinCliError(JOIN_MESSAGES.unreachable, 0);
    }
    let json: Record<string, unknown> = {};
    try {
      const text = await res.text();
      if (text.length <= MAX_RESPONSE_BYTES) {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
      }
    } catch {
      json = {};
    }
    // Every answer renews the session; the old token expires on its own.
    if (res.status === 200 && typeof json.token === "string" && json.token !== "") this.token = json.token;
    return { status: res.status, json };
  }
}

/** A refusal as the person sees it: fixed messages, and the server's code and cleaned message. */
function refusalText(status: number, json: Record<string, unknown>): string {
  if (status === 401) return JOIN_MESSAGES.linkRejected;
  if (status === 404) return JOIN_MESSAGES.notFound;
  if (status === 403) return JOIN_MESSAGES.noAccess;
  const code = json.error;
  if (typeof code === "string" && /^[a-z_]{1,64}$/.test(code)) {
    const message = cleanServerText(json.message, 300);
    return message || code;
  }
  return `The Wardby server answered ${status}.`;
}

async function expectOk(session: JoinSession, action: JoinApiAction, body?: unknown): Promise<Record<string, unknown>> {
  const { status, json } = await session.call(action, body);
  if (status !== 200) throw new JoinCliError(refusalText(status, json), status);
  return json;
}

/** Returns the process exit code: 0 the run ended (or you left and it ended), 1 failed, 2 usage. */
export async function joinCommand(argv: string[], deps: JoinDeps = {}): Promise<number> {
  const write = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  // In a terminal the chat keeps a "> " prompt on the bottom line: a line printed while you type
  // goes above it, and what you had typed is drawn again below (readline's prompt(true)).
  let prompter: Interface | undefined;
  const out = (line: string) => {
    if (!prompter) return void write(line);
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    write(line);
    prompter.prompt(true);
  };
  const stopPrompt = () => {
    if (!prompter) return;
    prompter = undefined;
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
  };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { help: { type: "boolean", short: "h" } } });
  } catch {
    out(JOIN_USAGE);
    return 2;
  }
  if (parsed.values.help) {
    out(JOIN_USAGE);
    return 0;
  }
  // The link as the one argument, or "-" to read it from standard input (out of history and ps).
  if (parsed.positionals.length !== 1) {
    out(JOIN_USAGE);
    return 2;
  }
  const argLink = parsed.positionals[0] === "-" ? undefined : parsed.positionals[0];
  const input = deps.input ?? process.stdin;
  const tty = input === process.stdin && process.stdin.isTTY === true;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? POLL_MS;
  // A prompt only when a person is typing into a terminal and watching it; piped input stays plain.
  const promptMode = tty && deps.out === undefined && process.stdout.isTTY === true;
  const rl: Interface = promptMode
    ? createInterface({ input, output: process.stdout, terminal: true, prompt: "> " })
    : createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  try {
    let raw: string;
    if (argLink !== undefined) {
      raw = argLink.slice(0, MAX_LINK_BYTES).trim();
    } else {
      if (tty) out("Paste the join link from join_run:");
      const first = await lines.next();
      raw = (first.done ? "" : String(first.value)).slice(0, MAX_LINK_BYTES).trim();
    }
    if (raw === "") throw new JoinCliError(JOIN_MESSAGES.noLink);
    const link = parseJoinLink(raw);
    if (!link) throw new JoinCliError(JOIN_MESSAGES.badLink);
    const origin = new URL(link.origin);
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && isLoopbackHost(origin.hostname))) {
      throw new JoinCliError(JOIN_MESSAGES.insecureOrigin);
    }
    const session = new JoinSession(link.origin, link.token, deps.fetch ?? globalThis.fetch);
    const joined = await expectOk(session, "join");
    out(`${JOIN_MESSAGES.joined} (run ${cleanServerText(joined.runId, 128)})`);
    if (promptMode) {
      prompter = rl;
      rl.prompt();
    }

    let after = 0;
    let ended: Record<string, unknown> | undefined;
    let left = false;
    let confirmQuit = false;
    let leaving: Promise<unknown> | undefined;

    const leave = () => {
      if (left || ended) return leaving;
      left = true;
      leaving = expectOk(session, "leave").then(
        () => out(JOIN_MESSAGES.left),
        (err: unknown) => out(err instanceof Error ? err.message : JOIN_MESSAGES.unreachable),
      );
      return leaving;
    };
    const exit = deps.exit ?? ((code: number) => process.exit(code));
    let interrupted = false;
    const onSignal = (signal: "SIGINT" | "SIGHUP" | "SIGTERM") => {
      // Ctrl-C leaves and keeps watching; a second Ctrl-C, or the terminal closing, exits after leaving.
      if (signal === "SIGINT" && !interrupted) {
        interrupted = true;
        void leave();
        return;
      }
      void Promise.race([leave() ?? Promise.resolve(), sleep(EXIT_LEAVE_MS)]).then(() => exit(130));
    };
    (
      deps.onSignal ??
      ((handler) => {
        for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"] as const) process.on(signal, () => handler(signal));
      })
    )(onSignal);
    // A terminal-mode readline takes Ctrl-C itself: pass it on as the signal.
    if (promptMode) rl.on("SIGINT", () => onSignal("SIGINT"));

    // What people type: each line sent while the run is going; input ending only stops sending.
    const typing = (async () => {
      for (;;) {
        const next = await lines.next();
        if (next.done || ended) return;
        try {
          if (prompter) {
            // The typed line is shown again as "person: ..." once it is sent: drop the echo.
            moveCursor(process.stdout, 0, -1);
            clearLine(process.stdout, 0);
          }
          await handleLine(String(next.value).trim());
          prompter?.prompt();
        } catch (err) {
          out(err instanceof JoinCliError ? err.message : JOIN_MESSAGES.unreachable);
        }
      }
    })();

    async function handleLine(text: string): Promise<void> {
      {
        if (confirmQuit) {
          confirmQuit = false;
          if (/^y(es)?$/i.test(text)) {
            out(JOIN_MESSAGES.stopping);
            await expectOk(session, "stop").catch((err: unknown) =>
              out(err instanceof Error ? err.message : JOIN_MESSAGES.unreachable),
            );
          } else {
            out(JOIN_MESSAGES.notStopped);
          }
          return;
        }
        if (text === "") return;
        if (text === "/help") {
          out(JOIN_USAGE);
        } else if (text === "/leave") {
          await leave();
        } else if (text === "/quit") {
          confirmQuit = true;
          out(JOIN_MESSAGES.confirmQuit);
          out("Stop the agent? (y/N)");
        } else if (left) {
          out("You left this run; nothing was sent.");
        } else {
          const command = /^\/(?:interrupt|i)(?:\s+|$)/.exec(text);
          const interrupt = command !== null;
          const message = interrupt ? text.slice(command[0].length).trim() : text;
          if (message === "") {
            if (interrupt) out("Type your message after /interrupt (or /i), on the same line.");
            return;
          }
          const { status, json } = await session.call("send", { message, interrupt });
          if (status !== 200) out(`${JOIN_MESSAGES.sendFailed}: ${refusalText(status, json)}`);
        }
      }
    }

    // The run's steps and status, until it ends. A failed poll is retried with backoff; when the
    // server stays unreachable, or refuses, the CLI leaves on the way out (best effort) so the run
    // is not held open until its timeout.
    let failures = 0;
    while (!ended) {
      try {
        for (;;) {
          const page = await expectOk(session, "steps", { after });
          const steps = Array.isArray(page.steps) ? (page.steps as Step[]) : [];
          for (const step of steps) {
            if (typeof step.seq !== "number" || step.seq <= after) continue;
            out(stepLine(step));
            after = step.seq;
          }
          if (page.next === null || page.next === undefined || steps.length === 0) break;
        }
        const status = await expectOk(session, "status");
        failures = 0;
        if (typeof status.status === "string" && TERMINAL.has(status.status)) {
          ended = status;
          break;
        }
        await sleep(pollMs);
      } catch (err) {
        if (transient(err) && failures < RETRY_MS.length) {
          await sleep(RETRY_MS[failures]);
          failures += 1;
          continue;
        }
        // A rejected link (401) cannot leave either: say so instead of trying.
        const rejected = err instanceof JoinCliError && err.status === 401;
        const leftOk =
          left ||
          (!rejected &&
            (await Promise.race([
              expectOk(session, "leave").then(
                () => true,
                () => false,
              ),
              sleep(EXIT_LEAVE_MS).then(() => false),
            ])));
        if (!transient(err)) out(err instanceof JoinCliError ? err.message : JOIN_MESSAGES.unreachable);
        out(leftOk ? JOIN_MESSAGES.lostConnection : JOIN_MESSAGES.lostConnectionNotLeft);
        return 1;
      }
    }
    stopPrompt();
    rl.close();
    await typing.catch(() => undefined);
    const cost = Number(ended.costUsd);
    out(
      `Run finished: ${cleanServerText(ended.status, 40)}${Number.isFinite(cost) ? ` (cost $${cost.toFixed(4)})` : ""}`,
    );
    if (ended.outcome) out(`Outcome: ${cleanServerText(ended.outcome, 40)}. ${cleanServerText(ended.summary, 2_000)}`);
    if (ended.pullRequestUrl) out(`Pull request: ${cleanServerText(ended.pullRequestUrl, 500)}`);
    else if (ended.branch) out(`Branch: ${cleanServerText(ended.branch, 300)}`);
    if (ended.error) out(`Error: ${cleanServerText(ended.error, 2_000)}`);
    return 0;
  } catch (err) {
    out(err instanceof JoinCliError ? err.message : "Something went wrong while joining the run.");
    return 1;
  } finally {
    stopPrompt();
    rl.close();
  }
}
