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
  /agent           details of the agent and this run: model, budget, turns, time left, who is joined
  /prompt          the agent's system prompt
  /leave, /exit    leave the run; it finishes its work and wraps up as usual
  /quit            stop the agent (asks first): the run ends cancelled, its work is not pushed
  /help            show these commands
  Ctrl-C           leave, as /leave`;

/**
 * /help in the chat: the chat's commands only (how to start the CLI is no use once joined), each
 * command bold and its description dimmed.
 */
export function chatHelpLines(paint: Paint = PLAIN_PAINT): string[] {
  const section = JOIN_USAGE.slice(JOIN_USAGE.indexOf("In the chat:"));
  return section.split("\n").map((line, index) => {
    if (index === 0) return paint.bold(line);
    const match = /^( {2})(\S.*?)( {2,})(.*)$/.exec(line);
    return match ? `${match[1]}${paint.bold(match[2])}${match[3]}${paint.dim(match[4])}` : line;
  });
}

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
    "/agent shows the agent, /quit stops it, /help lists every command.",
  confirmQuit:
    "This stops the agent now: the run ends as cancelled, and its work is not pushed to a result branch or pull request. To let it finish and keep its work, use /leave instead.",
  notStopped: "Not stopped. Still joined.",
  stopping: "Stopping the agent...",
  left: "Left. The run finishes its work and wraps up when the agent is idle. This window keeps showing the run until it ends; press Ctrl-C to stop watching.",
  lostConnection: "Lost the connection to the Wardby server. Left the run so it is not held open.",
  lostConnectionNotLeft:
    "Lost the connection to the Wardby server and could not leave the run; it stays open until its timeout. Join it again with a new link from join_run to leave it.",
  sendFailed: "Could not send that",
  unknownCommand: "Unknown command; nothing was sent. /help lists the commands.",
} as const;

/**
 * A lone /word, like /exit: a chat command, never sent to the agent, so a mistyped or unknown
 * command is not mistaken for a message. A line with more after it ("/tmp is full", "/usr/bin") is a
 * message, except /interrupt and /i.
 */
const UNKNOWN_COMMAND = /^\/[a-z][a-z-]*$/i;
const INTERRUPT_COMMAND = /^\/(?:interrupt|i)(?:\s+|$)/;
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

/**
 * Colours for the chat's own labels and notices, never for server text (which cleanServerText has
 * already stripped of escape sequences, so an agent cannot fake a label or recolour the screen).
 * Only the basic terminal colours, which follow the terminal's own theme.
 */
export interface Paint {
  cyan: (text: string) => string;
  yellow: (text: string) => string;
  magenta: (text: string) => string;
  green: (text: string) => string;
  red: (text: string) => string;
  dim: (text: string) => string;
  bold: (text: string) => string;
}
const sgr =
  (code: number, reset: number) =>
  (text: string): string =>
    `\u001b[${code}m${text}\u001b[${reset}m`;
export const ANSI_PAINT: Paint = {
  cyan: sgr(36, 39),
  yellow: sgr(33, 39),
  magenta: sgr(35, 39),
  green: sgr(32, 39),
  red: sgr(31, 39),
  dim: sgr(2, 22),
  bold: sgr(1, 22),
};
const same = (text: string) => text;
export const PLAIN_PAINT: Paint = {
  cyan: same,
  yellow: same,
  magenta: same,
  green: same,
  red: same,
  dim: same,
  bold: same,
};

/**
 * Colour in a terminal only: NO_COLOR (any value) turns it off, FORCE_COLOR (not "0") turns it on.
 * Output a caller captures (deps.out) is always plain.
 */
export function colourWanted(env: NodeJS.ProcessEnv, stdoutIsTty: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") return true;
  return stdoutIsTty;
}

/** One step as a chat line. */
export function stepLine(step: Step, paint: Paint = PLAIN_PAINT): string {
  const summary = cleanServerText(step.summary, 300).replace(/\n/g, " ");
  const text = cleanServerText(step.detail ?? step.summary);
  switch (step.kind) {
    case "join":
      return paint.dim("· someone joined");
    case "leave":
      return paint.dim("· someone left");
    case "said":
      return labelled(paint.cyan("agent: "), text);
    case "message":
      return labelled(paint.yellow("person: "), text);
    case "interrupt":
      return labelled(paint.magenta("person (interrupt): "), text);
    case "tool": {
      const raw = step.status ? cleanServerText(step.status, 40) : "";
      const tint = raw === "ok" ? paint.green : raw === "error" ? paint.red : same;
      const status = raw ? ` ${tint(`(${raw})`)}` : "";
      return `  ${paint.dim(`${cleanServerText(step.tool ?? "tool", 128)}: ${summary}`)}${status}`;
    }
    default:
      return `  ${paint.dim(summary)}`;
  }
}

const str = (value: unknown, max: number): string => cleanServerText(value, max).replace(/\n/g, " ");

/** A duration as "1h 5m", "26m" or "40s". */
function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const usd = (value: unknown): string => {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(4)}` : "?";
};

/** /agent's answer as chat lines. */
export function agentLines(answer: Record<string, unknown>, now = Date.now(), paint: Paint = PLAIN_PAINT): string[] {
  const agent = (answer.agent ?? {}) as Record<string, unknown>;
  const run = (answer.run ?? {}) as Record<string, unknown>;
  const lines = [`${paint.bold("Agent:")} ${str(agent.name, 200)} (${str(agent.kind, 40)}, ${str(agent.model, 100)})`];
  if (agent.repository) lines.push(`  ${paint.dim("Repository:")} ${str(agent.repository, 500)}`);
  const started = Date.parse(String(run.startedAt));
  const by = run.startedBy ? ` by ${str(run.startedBy, 200)}` : "";
  lines.push(
    `  ${paint.dim("Run:")} ${str(run.status, 40)}${Number.isFinite(started) ? `, started ${duration(now - started)} ago` : ""}${by}`,
  );
  lines.push(`  ${paint.dim("Spent:")} ${usd(run.costUsd)} of ${usd(run.budgetUsd)}`);
  const turns = Number(run.turns);
  const maxTurns = typeof run.maxTurns === "number" ? ` of ${run.maxTurns} per message` : "";
  lines.push(`  ${paint.dim("Turns:")} ${Number.isFinite(turns) ? turns : "?"}${maxTurns}`);
  const deadline = Date.parse(String(run.deadlineAt));
  if (Number.isFinite(deadline) && typeof run.timeoutSec === "number") {
    lines.push(`  ${paint.dim("Time left:")} ${duration(deadline - now)} of ${duration(run.timeoutSec * 1000)}`);
  }
  const names = (value: unknown): string[] => (Array.isArray(value) ? value.map((v) => str(v, 200)) : []);
  const list = (label: string, items: string[]) => {
    if (items.length > 0) lines.push(`  ${paint.dim(`${label}:`)} ${items.join(", ")}`);
  };
  list("Tools", names(agent.tools));
  list(
    "MCP servers",
    (Array.isArray(agent.mcpServers) ? (agent.mcpServers as Record<string, unknown>[]) : []).map((m) =>
      m.host ? `${str(m.name, 200)} (${str(m.host, 200)})` : str(m.name, 200),
    ),
  );
  const subagents = names(agent.subagents);
  list(agent.parallelDelegations === true ? "Subagents (in parallel)" : "Subagents", subagents);
  list("Datastores", names(agent.datastores));
  list("Secrets", names(agent.secrets));
  list(
    "Repositories",
    (Array.isArray(agent.repositories) ? (agent.repositories as Record<string, unknown>[]) : []).map(
      (r) => `${str(r.repository, 500)} (${str(r.access, 40)})`,
    ),
  );
  if (agent.workflow) lines.push(`  ${paint.dim("Workflow:")} ${str(agent.workflow, 100)}`);
  if (typeof agent.repoSkills === "boolean") {
    lines.push(`  ${paint.dim("Repository skills:")} ${agent.repoSkills ? "loaded from the repository" : "off"}`);
  }
  const joined = Array.isArray(run.joined) ? run.joined.map((p) => str(p, 200)) : [];
  lines.push(`  ${paint.dim("Joined:")} ${joined.length > 0 ? joined.join(", ") : "nobody"}`);
  return lines;
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
  const paint =
    deps.out === undefined && colourWanted(process.env, process.stdout.isTTY === true) ? ANSI_PAINT : PLAIN_PAINT;
  /** A failure or refusal, in red. */
  const fail = (line: string) => out(paint.red(line));
  /** A notice from the chat itself, dimmed. */
  const note = (line: string) => out(paint.dim(line));
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
    ? createInterface({ input, output: process.stdout, terminal: true, prompt: paint.bold("> ") })
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
    out(`${paint.green(JOIN_MESSAGES.joined)} ${paint.dim(`(run ${cleanServerText(joined.runId, 128)})`)}`);
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
        () => note(JOIN_MESSAGES.left),
        (err: unknown) => fail(err instanceof Error ? err.message : JOIN_MESSAGES.unreachable),
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
          fail(err instanceof JoinCliError ? err.message : JOIN_MESSAGES.unreachable);
        }
      }
    })();

    async function handleLine(text: string): Promise<void> {
      {
        if (confirmQuit) {
          confirmQuit = false;
          if (/^y(es)?$/i.test(text)) {
            note(JOIN_MESSAGES.stopping);
            await expectOk(session, "stop").catch((err: unknown) =>
              fail(err instanceof Error ? err.message : JOIN_MESSAGES.unreachable),
            );
          } else {
            note(JOIN_MESSAGES.notStopped);
          }
          return;
        }
        if (text === "") return;
        if (text === "/help") {
          for (const line of chatHelpLines(paint)) out(line);
        } else if (text === "/agent") {
          for (const line of agentLines(await expectOk(session, "agent"), Date.now(), paint)) out(line);
        } else if (text === "/prompt") {
          const { systemPrompt } = await expectOk(session, "prompt");
          out(labelled(paint.bold("System prompt: "), cleanServerText(systemPrompt, 100_000)));
        } else if (text === "/leave" || text === "/exit") {
          await leave();
        } else if (text === "/quit") {
          confirmQuit = true;
          out(paint.yellow(JOIN_MESSAGES.confirmQuit));
          out(paint.bold("Stop the agent? (y/N)"));
        } else if (UNKNOWN_COMMAND.test(text) && text !== "/i" && text !== "/interrupt") {
          fail(JOIN_MESSAGES.unknownCommand);
        } else if (left) {
          note("You left this run; nothing was sent.");
        } else {
          const command = INTERRUPT_COMMAND.exec(text);
          const interrupt = command !== null;
          const message = interrupt ? text.slice(command[0].length).trim() : text;
          if (message === "") {
            if (interrupt) fail("Type your message after /interrupt (or /i), on the same line.");
            return;
          }
          const { status, json } = await session.call("send", { message, interrupt });
          if (status !== 200) fail(`${JOIN_MESSAGES.sendFailed}: ${refusalText(status, json)}`);
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
            out(stepLine(step, paint));
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
        if (!transient(err)) fail(err instanceof JoinCliError ? err.message : JOIN_MESSAGES.unreachable);
        fail(leftOk ? JOIN_MESSAGES.lostConnection : JOIN_MESSAGES.lostConnectionNotLeft);
        return 1;
      }
    }
    stopPrompt();
    rl.close();
    await typing.catch(() => undefined);
    const cost = Number(ended.costUsd);
    const status = cleanServerText(ended.status, 40);
    const tint =
      status === "succeeded" ? paint.green : status === "failed" || status === "lost" ? paint.red : paint.yellow;
    out(`${tint(`Run finished: ${status}`)}${Number.isFinite(cost) ? paint.dim(` (cost $${cost.toFixed(4)})`) : ""}`);
    if (ended.outcome) out(`Outcome: ${cleanServerText(ended.outcome, 40)}. ${cleanServerText(ended.summary, 2_000)}`);
    if (ended.pullRequestUrl) out(`Pull request: ${cleanServerText(ended.pullRequestUrl, 500)}`);
    else if (ended.branch) out(`Branch: ${cleanServerText(ended.branch, 300)}`);
    if (ended.error) out(`${paint.red("Error:")} ${cleanServerText(ended.error, 2_000)}`);
    return 0;
  } catch (err) {
    fail(err instanceof JoinCliError ? err.message : "Something went wrong while joining the run.");
    return 1;
  } finally {
    stopPrompt();
    rl.close();
  }
}
