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
 * exit (flushStderrRedaction), and early once it grows past MAX_PENDING_STDERR_CHARS.
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
 * A pending line longer than this (64 KiB of text) is redacted and emitted without waiting for
 * its "\n", so an unterminated stream cannot grow the buffer without bound. Only a secret value
 * that straddles that cut would escape redaction; no real secret value is anywhere near this long.
 */
export const MAX_PENDING_STDERR_CHARS = 64 * 1024;

let installed = false;
let pending = "";
let rawWrite: ((chunk: string) => boolean) | undefined;
const bytes = new StringDecoder("utf8");

/** Emits the buffered remainder, redacted and ended with "\n". Safe to call any number of times. */
export function flushStderrRedaction(): void {
  if (!rawWrite) return;
  const rest = pending + bytes.end();
  pending = "";
  if (rest) rawWrite(`${redactReceivedSecrets(rest)}\n`);
}

/** Adds `text` to the buffer and returns what is ready to emit (complete lines, or an over-long remainder). */
function takeReady(text: string): string {
  pending += text;
  const end = pending.lastIndexOf("\n") + 1;
  let ready = pending.slice(0, end);
  pending = pending.slice(end);
  if (pending.length > MAX_PENDING_STDERR_CHARS) {
    ready += pending;
    pending = "";
  }
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
    const text =
      typeof chunk === "string"
        ? encoding && !/^utf-?8$/i.test(encoding)
          ? bytes.write(Buffer.from(chunk, encoding))
          : chunk
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
}
