/**
 * A streaming scan for one top-level member of a JSON object document,
 * without ever holding the document: only the wanted member's value text is
 * kept (bounded), and every other value, however large, is skipped as it
 * streams past. Used to read an npm packument's `time` (per-version publish
 * times), which comes after `versions` and can follow tens of MB of it.
 *
 * It is a tokenizer, not a validator: it tracks strings, escapes and
 * nesting depth, which is all that locating a top-level member needs. The
 * captured value is then parsed with JSON.parse, so a malformed value
 * throws there. A document that is not an object, or that ends before the
 * member closes, yields null.
 */

/** Longest top-level key compared; a longer one cannot be the wanted key. */
const MAX_KEY_LENGTH = 256;

export class JsonMemberTooLarge extends Error {}

export class TopLevelMemberScanner {
  private depth = 0;
  private inString = false;
  private escape = false;
  /** At depth 1, the next string is a key. */
  private expectKey = false;
  private collectingKey = false;
  private key = "";
  private lastKey: string | undefined;
  /** After `"<wanted>":`, waiting for the value's first character. */
  private pending = false;
  private capturing = false;
  private captured: string[] = [];
  private capturedLength = 0;
  private finished = false;
  private result: unknown = undefined;
  private started = false;

  constructor(
    private readonly wanted: string,
    private readonly maxValueLength: number,
  ) {}

  /** True once the member was captured (or proven absent or not an
   *  object), so the caller may stop reading. */
  get done(): boolean {
    return this.finished;
  }

  /** The member's value, parsed; undefined while scanning or when absent. */
  get value(): unknown {
    return this.result;
  }

  /** Feeds the next decoded text. Throws JsonMemberTooLarge when the
   *  member's value exceeds its bound. */
  push(text: string): void {
    if (this.finished) return;
    let segmentStart = this.capturing ? 0 : -1;
    const length = text.length;
    let i = 0;
    while (i < length) {
      if (this.inString) {
        if (this.escape) {
          this.escape = false;
          if (this.collectingKey) this.appendKey(text[i]);
          i += 1;
          continue;
        }
        // Skip ahead to the next quote or backslash: the bulk of a
        // packument is string content, never looked at char by char.
        const quote = text.indexOf('"', i);
        const backslash = text.indexOf("\\", i);
        const stop = quote < 0 ? backslash : backslash < 0 ? quote : Math.min(quote, backslash);
        if (stop < 0) {
          if (this.collectingKey) this.appendKey(text.slice(i));
          break;
        }
        if (this.collectingKey) this.appendKey(text.slice(i, stop));
        if (stop === backslash) {
          this.escape = true;
          if (this.collectingKey) this.appendKey("\\");
          i = stop + 1;
          continue;
        }
        this.inString = false;
        if (this.collectingKey) {
          this.collectingKey = false;
          this.lastKey = this.key;
        }
        i = stop + 1;
        continue;
      }
      const c = text[i];
      if (c === " " || c === "\n" || c === "\r" || c === "\t") {
        i += 1;
        continue;
      }
      if (!this.started) {
        this.started = true;
        if (c !== "{") return this.finish(undefined);
      }
      if (this.pending) {
        this.pending = false;
        if (c !== "{") return this.finish(undefined);
        this.capturing = true;
        segmentStart = i;
      }
      if (c === '"') {
        this.inString = true;
        if (this.depth === 1 && this.expectKey) {
          this.collectingKey = true;
          this.key = "";
          this.expectKey = false;
        }
      } else if (c === "{" || c === "[") {
        this.depth += 1;
        if (this.depth === 1) this.expectKey = true;
      } else if (c === "}" || c === "]") {
        this.depth -= 1;
        if (this.capturing && this.depth === 1) {
          this.capture(text.slice(segmentStart, i + 1));
          return this.finish(JSON.parse(this.captured.join("")) as unknown);
        }
        if (this.depth === 0) return this.finish(undefined);
      } else if (c === ":") {
        if (this.depth === 1 && this.lastKey === this.wanted) this.pending = true;
      } else if (c === ",") {
        if (this.depth === 1) {
          this.expectKey = true;
          this.lastKey = undefined;
        }
      }
      i += 1;
    }
    if (this.capturing && segmentStart >= 0) this.capture(text.slice(segmentStart));
  }

  private appendKey(part: string): void {
    if (this.key.length <= MAX_KEY_LENGTH) this.key += part.slice(0, MAX_KEY_LENGTH + 1 - this.key.length);
  }

  private capture(part: string): void {
    this.capturedLength += part.length;
    if (this.capturedLength > this.maxValueLength) throw new JsonMemberTooLarge(`"${this.wanted}" is too large`);
    this.captured.push(part);
  }

  private finish(value: unknown): void {
    this.finished = true;
    this.result = value;
    this.captured = [];
  }
}

/** Reads `stream` (UTF-8 JSON) until the top-level member `wanted` has
 *  been captured, then cancels the rest. Returns its parsed value, or
 *  undefined when the document has no such object-valued member. At most
 *  `maxBytes` of the stream are read; more throws JsonMemberTooLarge. */
export async function scanTopLevelMember(
  stream: ReadableStream<Uint8Array>,
  wanted: string,
  limits: { maxBytes: number; maxValueLength: number },
): Promise<unknown> {
  const scanner = new TopLevelMemberScanner(wanted, limits.maxValueLength);
  const decoder = new TextDecoder("utf-8");
  const reader = stream.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        scanner.push(decoder.decode());
        return scanner.value;
      }
      bytes += value.byteLength;
      if (bytes > limits.maxBytes) throw new JsonMemberTooLarge(`the document is larger than ${limits.maxBytes} bytes`);
      scanner.push(decoder.decode(value, { stream: true }));
      if (scanner.done) return scanner.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
