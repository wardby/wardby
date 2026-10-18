import { describe, expect, it } from "vitest";
import { holdsValueFragment } from "../sandbox/secret-fragments.test-support.js";
import { StderrRedactionBuffer } from "./stderr-redaction.js";

// Fake values only; assertions compare booleans, so a failure never prints a value.
const RAW = ["abcabcabc", "s3cr3ts", "ab\ncd\nab", "fake-zz-zz"];
const VALUES = [...new Set(RAW.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))];
const FILLER = "xyq \n";

/** A small deterministic PRNG (mulberry32), so a failing seed reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whole values and filler, then (sometimes) a value's proper prefix at the very end. */
function stream(next: () => number): string {
  let text = "";
  const pieces = 1 + Math.floor(next() * 40);
  for (let i = 0; i < pieces; i += 1) {
    if (next() < 0.5) text += VALUES[Math.floor(next() * VALUES.length)];
    else for (let n = Math.floor(next() * 6); n > 0; n -= 1) text += FILLER[Math.floor(next() * FILLER.length)];
  }
  if (next() < 0.5) {
    const value = VALUES[Math.floor(next() * VALUES.length)];
    text += value.slice(0, 1 + Math.floor(next() * (value.length - 1)));
  }
  return text;
}

/** Feeds `text` in random chunks and returns the whole emitted stream, checking the buffer's bound on the way. */
function feed(
  buffer: StderrRedactionBuffer,
  text: string,
  next: () => number,
  bound: number,
): { out: string; bounded: boolean } {
  let out = "";
  let bounded = true;
  const longest = Math.max(...VALUES.map((value) => value.length));
  for (let at = 0; at < text.length;) {
    const size = 1 + Math.floor(next() * 12);
    out += buffer.write(text.slice(at, at + size));
    at += size;
    if (buffer.pendingLength > bound + longest + size) bounded = false;
  }
  return { out: out + buffer.flush(), bounded };
}

describe("StderrRedactionBuffer", () => {
  it("never emits a character of a remembered value, under any chunking and bound", () => {
    for (let seed = 1; seed <= 3000; seed += 1) {
      const next = rng(seed);
      const bound = [4, 8, 16, 64][seed % 4];
      const text = stream(next);
      const { out, bounded } = feed(new StderrRedactionBuffer(() => VALUES, bound), text, next, bound);
      const unmasked = out.replaceAll("[REDACTED]", "");
      // Everything but the markers is filler: no value character survived.
      const onlyFiller = [...unmasked].every((char) => FILLER.includes(char));
      expect({ seed, onlyFiller, fragment: holdsValueFragment(out, VALUES), bounded }).toEqual({
        seed,
        onlyFiller: true,
        fragment: false,
        bounded: true,
      });
    }
  });

  it("passes text through unchanged when no value is remembered", () => {
    const buffer = new StderrRedactionBuffer(() => []);
    expect(buffer.write("one\ntwo")).toBe("one\n");
    expect(buffer.flush()).toBe("two\n");
  });

  it("emits complete lines at once and holds only a possible value start", () => {
    const buffer = new StderrRedactionBuffer(() => ["fake-zz-zz"]);
    expect(buffer.write("plain line\nnext fa")).toBe("plain line\n");
    expect(buffer.write("ke-zz-zz done\n")).toBe("next [REDACTED] done\n");
  });

  it("masks the held suffix and a carried span on flush (fail closed)", () => {
    const buffer = new StderrRedactionBuffer(() => ["abcabcabc"], 4);
    const out = buffer.write("abcabcabcab") + buffer.flush();
    expect(holdsValueFragment(out, ["abcabcabc"])).toBe(false);
    expect(out.replaceAll("[REDACTED]", "") === "\n").toBe(true);
  });

  it("applies a value remembered after its text was buffered", () => {
    const values: string[] = [];
    const buffer = new StderrRedactionBuffer(() => values);
    expect(buffer.write("held fake-z")).toBe("");
    values.push("fake-zz-zz");
    expect(buffer.write("z-zz\n")).toBe("held [REDACTED]\n");
  });
});
