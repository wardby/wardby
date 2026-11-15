import { expect, it } from "vitest";
import { LineSplitter } from "./lines.js";

it("splits across chunk boundaries and keeps a partial tail", () => {
  const s = new LineSplitter(1024);
  expect(s.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
  expect(s.push(":2}\n")).toEqual(['{"b":2}']);
});

it("rejects an over-long line", () => {
  const s = new LineSplitter(4);
  expect(() => s.push("12345")).toThrow("bridge_line_too_long");
});

it("skips empty lines", () => {
  const s = new LineSplitter(16);
  expect(s.push("a\n\n\nb\n")).toEqual(["a", "b"]);
});
