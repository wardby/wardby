/**
 * What a bridge keeps of its child processes' output, and the little that may leave the actor:
 *
 * - The agent bridge keeps the worker's last stdout+stderr lines in memory only (WORKER_OUTPUT_TAIL)
 *   and sends nothing of them but the one fixed diagnostic `parseWorkerDiagnosticLine` accepts (the
 *   same rule as the shared parser in providers/jobs/worker-diagnostic.ts; constants.test.ts checks
 *   they agree).
 * - On a failure, a bridge posts a bounded stderr tail (DIAGNOSTICS_TAIL) for the operator's logs,
 *   redacted line by line, by exact value, against every secret value delivered to that process.
 *
 * Only Node built-ins and sibling files are imported: the image carries dist/substrate-bridge/ alone.
 */
import { MAX_CODING_OUTPUT_ISSUES, REDACTED, SAFE_CODING_OUTPUT_ISSUE, SAFE_WORKER_DIAGNOSTIC } from "./constants.js";

/** Stands in for a line too long to keep: a piece of it is never kept, so a value is never cut in half. */
export const LINE_OMITTED = "[line omitted]";

/**
 * One stream's line splitter: it completes lines and hands them to its LineTail. A line longer than
 * the tail's byte bound is never buffered beyond it: it becomes LINE_OMITTED.
 */
export class LineFeed {
  private partial = "";
  private overflowing = false;

  constructor(
    private readonly maxBytes: number,
    private readonly keep: (line: string) => void,
  ) {}

  push(chunk: string | Buffer): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) {
        this.append(text.slice(start));
        return;
      }
      this.append(text.slice(start, newline));
      this.finishLine();
      start = newline + 1;
    }
  }

  /** The stream ended: an unfinished last line counts as a line. */
  end(): void {
    if (this.partial !== "" || this.overflowing) this.finishLine();
  }

  private append(piece: string): void {
    if (this.overflowing) return;
    this.partial += piece;
    if (Buffer.byteLength(this.partial) > this.maxBytes) {
      this.partial = "";
      this.overflowing = true;
    }
  }

  private finishLine(): void {
    const line = this.overflowing ? LINE_OMITTED : this.partial.replace(/\r$/, "");
    this.partial = "";
    this.overflowing = false;
    this.keep(line);
  }
}

/**
 * The last complete lines of one or more streams, in the order they completed, within `maxLines` and
 * `maxBytes` (lines joined by "\n"). Each line is transformed (redacted) only once complete, so a value
 * split across chunks is still seen whole. A line longer than `maxBytes` is replaced by LINE_OMITTED.
 * `push`/`end` feed the default stream; `feed()` adds another (stdout and stderr each get one, so
 * their unfinished lines never mix).
 */
export class LineTail {
  private readonly kept: string[] = [];
  private keptBytes = 0;
  private readonly main: LineFeed;

  constructor(
    private readonly maxLines: number,
    private readonly maxBytes: number,
    private readonly transform: (line: string) => string = (line) => line,
  ) {
    this.main = this.feed();
  }

  feed(): LineFeed {
    return new LineFeed(this.maxBytes, (line) => this.keepLine(line));
  }

  push(chunk: string | Buffer): void {
    this.main.push(chunk);
  }

  end(): void {
    this.main.end();
  }

  /** Feeds a stream into a new feed of this tail; resolves once it ended (or failed). */
  follow(stream: NodeJS.ReadableStream): Promise<void> {
    const feed = this.feed();
    return new Promise((resolve) => {
      stream.on("data", (chunk: string | Buffer) => feed.push(chunk));
      const done = (): void => {
        feed.end();
        resolve();
      };
      stream.once("end", done);
      stream.once("error", done);
      stream.once("close", done);
    });
  }

  lines(): string[] {
    return [...this.kept];
  }

  text(): string {
    return this.kept.join("\n");
  }

  private keepLine(raw: string): void {
    let line = raw === LINE_OMITTED ? raw : this.transform(raw);
    if (Buffer.byteLength(line) > this.maxBytes) line = LINE_OMITTED;
    this.kept.push(line);
    this.keptBytes += Buffer.byteLength(line) + (this.kept.length > 1 ? 1 : 0);
    while (this.kept.length > this.maxLines || this.keptBytes > this.maxBytes) {
      const dropped = this.kept.shift()!;
      this.keptBytes -= Buffer.byteLength(dropped) + (this.kept.length > 0 ? 1 : 0);
    }
  }
}

/** `text` with every non-empty value replaced by REDACTED, longest value first. */
export function redactExact(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of [...new Set(values)].filter((v) => v !== "").sort((a, b) => b.length - a.length)) {
    out = out.split(value).join(REDACTED);
  }
  return out;
}

const REGISTRY_TOKEN = /rrg_[A-Za-z0-9_-]+/g;
const SECRET_ENV_NAME = /TOKEN|AUTH|PASSWORD|SECRET|KEY/i;

/**
 * The secret values the tool setup delivers to the tool runner: every registry-only token (`rrg_…`)
 * in its env values and file contents, and the whole value of any env entry named like a credential.
 * Unparsable setup: none (the runner is never started with one).
 */
export function secretValuesOfToolSetup(toolSetup: string): string[] {
  let parsed: { env?: unknown; files?: unknown };
  try {
    parsed = JSON.parse(toolSetup) as { env?: unknown; files?: unknown };
  } catch {
    return [];
  }
  const values = new Set<string>();
  const scan = (text: string): void => {
    for (const found of text.matchAll(REGISTRY_TOKEN)) values.add(found[0]);
  };
  if (parsed?.env && typeof parsed.env === "object") {
    for (const [name, value] of Object.entries(parsed.env as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      scan(value);
      if (SECRET_ENV_NAME.test(name) && value.length >= 8) values.add(value);
    }
  }
  if (Array.isArray(parsed?.files)) {
    for (const file of parsed.files as unknown[]) {
      const content = (file as { content?: unknown } | null)?.content;
      if (typeof content === "string") scan(content);
    }
  }
  return [...values];
}

export interface WorkerDiagnostic {
  diagnostic: string;
  diagnosticIssues?: string[];
}

/** The bridge's copy of providers/jobs/worker-diagnostic.ts parseWorkerDiagnosticLine (kept equal by constants.test.ts). */
export function parseWorkerDiagnosticLine(line: string): WorkerDiagnostic | undefined {
  let value: { error?: unknown; issues?: unknown } | null;
  try {
    value = JSON.parse(line) as { error?: unknown; issues?: unknown } | null;
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const { error, issues } = value;
  if (typeof error !== "string" || !SAFE_WORKER_DIAGNOSTIC.test(error)) return undefined;
  const safeIssues =
    Array.isArray(issues) &&
    issues.length > 0 &&
    issues.length <= MAX_CODING_OUTPUT_ISSUES &&
    issues.every((issue) => typeof issue === "string" && SAFE_CODING_OUTPUT_ISSUE.test(issue))
      ? (issues as string[])
      : undefined;
  return { diagnostic: error, ...(safeIssues ? { diagnosticIssues: [...safeIssues] } : {}) };
}

/** Scanning from the last line back: the first that is a safe worker diagnostic. */
export function findWorkerDiagnostic(lines: readonly string[]): WorkerDiagnostic | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const found = parseWorkerDiagnosticLine(lines[i]);
    if (found) return found;
  }
  return undefined;
}

/** Resolves when `promise` settles or after `ms`, whichever is first (never rejects). */
export function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
