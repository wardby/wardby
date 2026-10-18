/**
 * The sandbox worker's stderr is not a redacted channel by itself: a failed worker's stderr tail
 * reaches the server's log (docker-launcher.ts), and a tool's host calls hand the worker secret
 * values (`secrets.get`). The worker knows those exact values, so it redacts them from everything
 * it writes to stderr — its own failure line and the shared logger's lines — with the same
 * redactor the console bridge uses (minimum length included). One set per worker process.
 *
 * Redaction is by line, not by write: a secret value split across two `process.stderr.write`
 * calls would pass a per-write redactor, so writes are buffered and only complete lines (through
 * their "\n") are redacted and emitted. The unterminated remainder is redacted and emitted on
 * exit or SIGTERM/SIGINT (flushStderrRedaction), and early once it grows past
 * MAX_PENDING_STDERR_CHARS. Wherever the buffer is cut, no remembered value is split by the cut
 * (see safeCut).
 *
 * The shared logger does not write through process.stderr: pino serializes each log call to one
 * whole line (ending in "\n") and hands that line to its `streamWrite` hook before writing it to
 * fd 2 itself, so the line filter below sees whole lines.
 */

import { StringDecoder } from "node:string_decoder";
import { setLogLineFilter } from "../core/logger.js";
import { redactExactSecretValues } from "../sandbox/host-functions.js";

const received = new Set<string>();

/** Records a secret value this process received, and its JSON-escaped form (as a log line holds it). */
export function rememberSecretValue(value: string): void {
  received.add(value);
  const escaped = JSON.stringify(value).slice(1, -1);
  if (escaped !== value) received.add(escaped);
}

/** `text` without any secret value this process received. */
export function redactReceivedSecrets(text: string): string {
  return received.size === 0 ? text : redactExactSecretValues(text, received);
}

/**
 * A pending line longer than this (64 KiB of text) is emitted without waiting for its "\n", so an
 * unterminated stream cannot grow the buffer without bound. The cut keeps back the last
 * (longest remembered value − 1) characters, so a value that has begun but not ended is held whole
 * until its end arrives; the buffer is therefore bounded by this plus the longest value. When the
 * safe cut falls back to 0 (a self-overlapping value repeated without a newline), the text is
 * withheld: a marker line is emitted and only the part that could still begin a value is kept.
 */
export const MAX_PENDING_STDERR_CHARS = 64 * 1024;

/** Emitted in place of buffered text that could not be split safely (see takeReady). */
export const STDERR_WITHHELD_MARKER = "[stderr withheld: output could not be split safely]\n";

/** The shared redactor's minimum: shorter values are never redacted, so they never constrain a cut. */
const MIN_REDACTED_LENGTH = 6;

/** The remembered values the redactor acts on (including escaped forms). */
const redactable = () => [...received].filter((value) => value.length >= MIN_REDACTED_LENGTH);

/**
 * `cut` moved back until no remembered value is split by it: no complete occurrence straddles
 * it, and (when `holdBack`) the last (longest value − 1) characters stay, so an occurrence still
 * being written starts after the cut. Only moves back, so it never emits more than asked.
 */
function safeCut(text: string, cut: number, holdBack: boolean): number {
  const values = redactable();
  if (values.length === 0) return cut;
  let c = cut;
  if (holdBack) c = Math.min(c, text.length - (Math.max(...values.map((v) => v.length)) - 1));
  c = Math.max(c, 0);
  for (let moved = true; moved && c > 0;) {
    moved = false;
    for (const value of values) {
      let at = text.indexOf(value, Math.max(0, c - value.length + 1));
      while (at >= 0 && at < c) {
        if (at + value.length > c) {
          c = at;
          moved = true;
          break;
        }
        at = text.indexOf(value, at + 1);
      }
    }
  }
  return c;
}

let installed = false;
let pending = "";
let rawWrite: ((chunk: string) => boolean) | undefined;
const bytes = new StringDecoder("utf8");

/** Emits the buffered remainder, redacted and ended with "\n". Safe to call any number of times. */
export function flushStderrRedaction(): void {
  if (!rawWrite) return;
  const rest = pending + bytes.end();
  pending = "";
  if (rest) rawWrite(`${redactReceivedSecrets(rest)}${rest.endsWith("\n") ? "" : "\n"}`);
}

/** Adds `text` to the buffer and returns what is ready to emit (complete lines, or an over-long remainder). */
function takeReady(text: string): string {
  pending += text;
  let cut = pending.lastIndexOf("\n") + 1;
  // A newline ends a line safely unless a remembered value itself holds one.
  const multiLine = redactable().some((value) => value.includes("\n"));
  if (multiLine) cut = safeCut(pending, cut, true);
  if (pending.length - cut > MAX_PENDING_STDERR_CHARS) {
    cut = safeCut(pending, pending.length, true);
    // A self-overlapping value can walk the cut back to 0 every time. The buffer text is then not
    // emitted at all (its tail may be the start of a value): a fixed marker line goes out instead,
    // and only the last (longest value - 1) characters, the part that could still begin a value,
    // are kept. Nothing unredacted is emitted and the buffer stays bounded.
    if (cut === 0) {
      const keep = Math.max(...redactable().map((value) => value.length)) - 1;
      pending = pending.slice(Math.max(0, pending.length - keep));
      return STDERR_WITHHELD_MARKER;
    }
  }
  const ready = pending.slice(0, cut);
  pending = pending.slice(cut);
  return ready;
}

/** Routes process.stderr writes and the shared logger's lines through redactReceivedSecrets. */
export function installStderrRedaction(): void {
  if (installed) return;
  installed = true;
  setLogLineFilter(redactReceivedSecrets);
  const write = process.stderr.write.bind(process.stderr) as (...args: unknown[]) => boolean;
  rawWrite = (chunk) => write(chunk);
  process.stderr.write = (chunk: unknown, ...rest: unknown[]) => {
    const encoding = typeof rest[0] === "string" ? (rest[0] as BufferEncoding) : undefined;
    const callback = rest.find((arg): arg is (err?: Error | null) => void => typeof arg === "function");
    // Every write goes through the one decoder, so a string after an incomplete multi-byte
    // character from an earlier byte write keeps its place.
    const text =
      typeof chunk === "string"
        ? bytes.write(Buffer.from(chunk, encoding ?? "utf8"))
        : chunk instanceof Uint8Array
          ? bytes.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
          : undefined;
    if (text === undefined) return write(chunk, ...rest);
    const ready = takeReady(text);
    if (ready) return write(redactReceivedSecrets(ready), callback);
    // Held for its line's end: the write is accepted, so its callback runs as if written.
    if (callback) process.nextTick(callback, null);
    return true;
  };
  process.on("exit", flushStderrRedaction);
  // A signal's default action would drop the buffered tail: flush it, then exit as the signal would.
  process.once("SIGTERM", () => {
    flushStderrRedaction();
    process.exit(143);
  });
  process.once("SIGINT", () => {
    flushStderrRedaction();
    process.exit(130);
  });
}
