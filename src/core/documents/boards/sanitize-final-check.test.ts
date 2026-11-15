import { describe, expect, it, vi } from "vitest";

// A DOMPurify that lets a script through, so the defence-in-depth re-parse is what catches it.
vi.mock("dompurify", () => ({
  default: () => ({
    sanitize: () => "<p>x</p><script>alert(1)</script>",
    addHook: () => {},
    removed: [],
  }),
}));

const { sanitizeBoard, sanitizeFragment } = await import("./sanitize.js");
const { BoardFormatError } = await import("./errors.js");
const { BoardFormatError: FormatsError } = await import("./format.js");

describe("the sanitiser's final check", () => {
  it("throws BoardFormatError (one error type for board_format_invalid) with fixed text only", () => {
    expect(FormatsError).toBe(BoardFormatError);
    for (const run of [
      () => sanitizeBoard("<!doctype html><title>t</title><body><p>FAKE-SECRET-1</p></body>"),
      () => sanitizeFragment("<p>FAKE-SECRET-2</p>", { images: "drop" }),
    ]) {
      let err: unknown;
      try {
        run();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BoardFormatError);
      expect((err as Error).message).toBe("board_format_invalid");
      expect((err as InstanceType<typeof BoardFormatError>).problems).toEqual([
        "the board failed the final safety check",
      ]);
    }
  });
});
