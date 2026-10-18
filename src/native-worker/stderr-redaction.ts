/**
 * The sandbox worker's stderr is not a redacted channel by itself: a failed worker's stderr tail
 * reaches the server's log (docker-launcher.ts), and a tool's host calls hand the worker secret
 * values (`secrets.get`). The worker knows those exact values (raw and JSON-escaped), so it masks
 * them in everything it writes to stderr — its own failure line and the shared logger's lines —
 * with the shared redactor's spans (secretSpans: the union of every occurrence, overlapping ones
 * included, minimum length included). One set per worker process.
 *
 * process.stderr writes are buffered (StderrRedactionBuffer), because a value may arrive split
 * across writes. Strings and any ArrayBufferView go through one UTF-8 decoder (a string's trailing
 * high surrogate is held for the next write, so a split surrogate pair still matches); any other
 * chunk type is refused, never written raw. On each write the buffer:
 * 1. holds back `hold`: the longest suffix of the buffer that is a proper prefix of a remembered
 *    value, since those characters could still become a value;
 * 2. picks a cut `c` <= length − hold: after the last "\n" there, or, once the text after that
 *    exceeds MAX_PENDING_STDERR_CHARS, at length − hold; otherwise it emits nothing yet;
 * 3. masks spans over the whole buffer, with its first `maskedLead` characters forced into a span;
 * 4. when `c` falls inside a span [s, e), emits [s, c) as the marker and carries `maskedLead` =
 *    e − c, so the rest of that span is masked when it is emitted later;
 * 5. emits the masked text before `c` and keeps the rest.
 * Masking is safe at any cut, so no cut is ever searched for. On exit, SIGTERM/SIGINT and the
 * worker's fail path the remainder is emitted with its spans, `maskedLead` and the held suffix all
 * masked: fail closed, a possible value start is emitted as `[REDACTED]`, never raw.
 *
 * Why no value character is emitted: an occurrence that begins before `c` either ends within the
 * buffer (it is a span, masked here, and its part past `c` is carried as `maskedLead`) or runs
 * past the buffer's end, in which case the text from its start to the end is a proper prefix of
 * the value, so `hold` >= length − start and `c` <= its start, a contradiction. By induction over
 * writes, every character emitted that belongs to an occurrence is inside a masked span.
 *
 * The shared logger does not write through process.stderr: pino serializes each log call to one
 * whole line (ending in "\n") and hands that line to its `streamWrite` hook before writing it to
 * fd 2 itself, so the line filter below (the shared redactor) sees whole lines.
 */

import { StringDecoder } from "node:string_decoder";
import { setLogLineFilter } from "../core/logger.js";
import {
  maskSpans,
  mergeSpans,
  MIN_REDACTABLE_SECRET_LENGTH,
  redactExactSecretValues,
  secretSpans,
  withEscapedForms,
} from "../core/secret-spans.js";

const received = new Set<string>();

/** Records a secret value this process received, and its JSON-escaped form (as a log line holds it). */
export function rememberSecretValue(value: string): void {
  for (const form of withEscapedForms([value])) received.add(form);
}

/** `text` without any secret value this process received. */
export function redactReceivedSecrets(text: string): string {
  return received.size === 0 ? text : redactExactSecretValues(text, received);
}

/**
 * Text after the last "\n" longer than this (64 KiB) is emitted without waiting for its "\n", so an
 * unterminated stream cannot grow the buffer without bound: it stays within this plus the longest
 * remembered value plus one write.
 */
export const MAX_PENDING_STDERR_CHARS = 64 * 1024;

/** The longest suffix of `text` that is a proper prefix of one of `values`. */
function heldLength(text: string, values: readonly string[]): number {
  let hold = 0;
  for (const value of values) {
    for (let k = Math.min(value.length - 1, text.length); k > hold; k -= 1) {
      if (text.charCodeAt(text.length - k) === value.charCodeAt(0) && text.endsWith(value.slice(0, k))) {
        hold = k;
        break;
      }
    }
  }
  return hold;
}

/**
 * The stderr buffer as a value: text in (`write`), masked text out, never a remembered value's
 * character unmasked (see the module comment). `values` is read on every call, so a value
 * remembered later applies to what is still buffered.
 */
export class StderrRedactionBuffer {
  private pending = "";
  private maskedLead = 0;
  private atLineStart = true;

  constructor(
    private readonly values: () => readonly string[],
    private readonly bound = MAX_PENDING_STDERR_CHARS,
  ) {}

  /** Characters still buffered. */
  get pendingLength(): number {
    return this.pending.length;
  }

  /** Adds `text` and returns what may be emitted now (possibly ""). */
  write(text: string): string {
    this.pending += text;
    const values = this.redactable();
    const hold = heldLength(this.pending, values);
    const limit = this.pending.length - hold;
    // (lastIndexOf treats a negative start as 0, so an empty window is checked first.)
    let cut = limit > 0 ? this.pending.lastIndexOf("\n", limit - 1) + 1 : 0;
    if (this.pending.length - cut > this.bound) cut = limit;
    if (cut <= 0) return "";
    const spans = this.spans(values, []);
    const inside = spans.find(([start, end]) => start < cut && cut < end);
    this.maskedLead = inside ? inside[1] - cut : 0;
    const ready = maskSpans(
      this.pending.slice(0, cut),
      spans.filter(([start]) => start < cut).map(([start, end]): [number, number] => [start, Math.min(end, cut)]),
    );
    this.pending = this.pending.slice(cut);
    return this.emitted(ready);
  }

  /**
   * Everything still buffered, masked, fail closed (the held suffix too), ending with "\n" if output
   * is mid-line. `maskTail` masks one more character at the end: a write's trailing lone high
   * surrogate that never got its low half.
   */
  flush(maskTail = false): string {
    if (maskTail) this.pending += "\uFFFD";
    const values = this.redactable();
    const text = this.pending;
    const hold = heldLength(text, values);
    const extra: Array<[number, number]> = [];
    if (hold > 0) extra.push([text.length - hold, text.length]);
    if (maskTail) extra.push([text.length - 1, text.length]);
    const out = maskSpans(text, this.spans(values, extra));
    this.pending = "";
    this.maskedLead = 0;
    const ready = this.emitted(out);
    if (this.atLineStart) return ready;
    this.atLineStart = true;
    return `${ready}\n`;
  }

  private redactable(): string[] {
    return this.values().filter((value) => value.length >= MIN_REDACTABLE_SECRET_LENGTH);
  }

  /** Spans over the whole buffer, the carried `maskedLead` and any `extra` forced in. */
  private spans(values: readonly string[], extra: Array<[number, number]>): Array<[number, number]> {
    const forced: Array<[number, number]> = this.maskedLead > 0 ? [[0, this.maskedLead], ...extra] : extra;
    return mergeSpans([...secretSpans(this.pending, values), ...forced]);
  }

  private emitted(text: string): string {
    if (text) this.atLineStart = text.endsWith("\n");
    return text;
  }
}

const buffer = new StderrRedactionBuffer(() => [...received]);
let installed = false;
let rawWrite: ((chunk: string) => boolean) | undefined;
const bytes = new StringDecoder("utf8");
/**
 * A string write's trailing high surrogate, held for the next write: encoded alone it would become
 * U+FFFD, and a value whose non-BMP character is split between two writes would never match.
 */
let heldHighSurrogate = "";

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const UTF8_ENCODINGS = new Set([undefined, "utf8", "utf-8"]);

/** `chunk` decoded through the one byte decoder (a held high surrogate joined first); throws for any other chunk type. */
function decodeChunk(chunk: unknown, encoding: BufferEncoding | undefined): string {
  if (typeof chunk === "string" && UTF8_ENCODINGS.has(encoding?.toLowerCase())) {
    let text = heldHighSurrogate + chunk;
    heldHighSurrogate = "";
    if (text.length > 0 && isHighSurrogate(text.charCodeAt(text.length - 1))) {
      heldHighSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    return bytes.write(Buffer.from(text, "utf8"));
  }
  // Anything else ends a held surrogate's chance of a low half: it is decoded alone (as U+FFFD).
  const lone = heldHighSurrogate ? bytes.write(Buffer.from(heldHighSurrogate, "utf8")) : "";
  heldHighSurrogate = "";
  if (typeof chunk === "string") return lone + bytes.write(Buffer.from(chunk, encoding));
  if (ArrayBuffer.isView(chunk))
    return lone + bytes.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  // Never handed to the raw write: its content is unknown. The message names no content.
  throw new TypeError("process.stderr.write takes a string or bytes (an ArrayBufferView).");
}

/** Emits the buffered remainder, masked fail closed and ended with "\n". Safe to call any number of times. */
export function flushStderrRedaction(): void {
  if (!rawWrite) return;
  const lone = heldHighSurrogate !== "";
  heldHighSurrogate = "";
  const tail = bytes.end();
  const ready = (tail ? buffer.write(tail) : "") + buffer.flush(lone);
  if (ready) rawWrite(ready);
}

/** Routes process.stderr writes through the buffer, and the shared logger's lines through redactReceivedSecrets. */
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
    const text = decodeChunk(chunk, encoding);
    const ready = buffer.write(text);
    if (ready) return write(ready, callback);
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
