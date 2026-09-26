import { describe, expect, it } from "vitest";
import { JsonMemberTooLarge, scanTopLevelMember, TopLevelMemberScanner } from "./json-scan.js";

function streamOf(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

const doc = JSON.stringify({
  name: "pkg",
  versions: {
    "1.0.0": { description: 'a "time": {"1.0.0": "fake"} inside a string \\ with escapes', time: { nested: 1 } },
  },
  "ti\\me": { decoy: true },
  time: { created: "2020-01-01T00:00:00.000Z", "1.0.0": "2020-01-02T00:00:00.000Z" },
  readme: "é ".repeat(1000),
});

describe("scanTopLevelMember", () => {
  it.each([1, 2, 7, 64, 100_000])("finds the top-level member across %i-byte chunks", async (chunkSize) => {
    const time = await scanTopLevelMember(streamOf(doc, chunkSize), "time", { maxBytes: 1e6, maxValueLength: 1e6 });
    expect(time).toEqual({ created: "2020-01-01T00:00:00.000Z", "1.0.0": "2020-01-02T00:00:00.000Z" });
  });

  it("ignores the same key nested or inside strings, and yields undefined when absent", async () => {
    const without = JSON.stringify({ versions: { a: { time: { x: 1 } } }, note: '"time":{"a":1}' });
    expect(await scanTopLevelMember(streamOf(without, 5), "time", { maxBytes: 1e6, maxValueLength: 1e6 })).toBe(
      undefined,
    );
  });

  it("yields undefined for a member that is not an object and for a document that is not an object", async () => {
    expect(await scanTopLevelMember(streamOf('{"time":"x"}', 3), "time", { maxBytes: 1e6, maxValueLength: 1e6 })).toBe(
      undefined,
    );
    expect(await scanTopLevelMember(streamOf("[1,2]", 3), "time", { maxBytes: 1e6, maxValueLength: 1e6 })).toBe(
      undefined,
    );
  });

  it("stops reading once the member is captured", async () => {
    let pulls = 0;
    const text = `{"time":{"a":"b"},"rest":"${"x".repeat(10_000)}"}`;
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        const start = (pulls - 1) * 16;
        if (start >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(start, start + 16));
      },
    });
    expect(await scanTopLevelMember(stream, "time", { maxBytes: 1e6, maxValueLength: 1e6 })).toEqual({ a: "b" });
    expect(pulls).toBeLessThan(5);
  });

  it("bounds the bytes read and the captured value", async () => {
    await expect(
      scanTopLevelMember(streamOf(doc, 64), "time", { maxBytes: 100, maxValueLength: 1e6 }),
    ).rejects.toBeInstanceOf(JsonMemberTooLarge);
    await expect(
      scanTopLevelMember(streamOf(doc, 64), "time", { maxBytes: 1e6, maxValueLength: 10 }),
    ).rejects.toBeInstanceOf(JsonMemberTooLarge);
  });

  it("keeps no reference to skipped content", () => {
    const scanner = new TopLevelMemberScanner("time", 100);
    scanner.push('{"versions":{"a":"');
    scanner.push("x".repeat(100_000));
    scanner.push('"},"time":{"a":"t"}}');
    expect(scanner.done).toBe(true);
    expect(scanner.value).toEqual({ a: "t" });
  });
});
