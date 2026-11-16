import { describe, expect, it } from "vitest";
import {
  CODING_PROTOCOL_VERSION,
  CodingTaskInputSchema,
  isSafePlanPath,
  MAX_CODING_BASE_INPUT_BYTES,
  MAX_CODING_INPUT_BYTES,
  MAX_PLAN_FILES_WIRE_BYTES,
  parsePlanFilesOutputJson,
  PLAN_FILES_LIMITS,
  PLAN_FOLDER_PATH,
} from "./protocol.js";

const input = {
  schemaVersion: CODING_PROTOCOL_VERSION,
  runId: "run_123",
  repository: "openai/example",
  baseRef: "main",
  headRef: "wardby/run-run_123",
  task: "Plan it.",
  model: "gpt-6",
  budgetUsd: 1,
  deadlineAt: "2026-11-16T13:00:00.000Z",
};
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("plan files: protocol", () => {
  it("names a folder outside the checkout and fixed limits", () => {
    expect(PLAN_FOLDER_PATH).toBe("/tmp/wardby-plan");
    expect(PLAN_FOLDER_PATH.startsWith("/workspace")).toBe(false);
    expect(PLAN_FILES_LIMITS).toEqual({
      maxFiles: 200,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 8 * 1024 * 1024,
      maxPathBytes: 512,
      maxDepth: 4,
      maxSkipped: 50,
    });
    expect(MAX_CODING_INPUT_BYTES).toBe(MAX_CODING_BASE_INPUT_BYTES + MAX_PLAN_FILES_WIRE_BYTES);
  });

  it.each(["plan.md", "screens/manifest.json", "screens/boards/home.html", "a/b/c/d.md"])("accepts %s", (path) => {
    expect(isSafePlanPath(path)).toBe(true);
  });

  it.each([
    "",
    "/etc/passwd",
    "../x.md",
    "a/../b.md",
    "./a.md",
    "a//b.md",
    "a\\b.md",
    "a/b/c/d/e.md",
    ".hidden.md",
    "a/.git/config",
    "bad\u0001name.md",
    "x".repeat(513),
  ])("refuses %j", (path) => {
    expect(isSafePlanPath(path)).toBe(false);
  });

  it("an input without planFiles is unchanged, and one with files parses", () => {
    expect(CodingTaskInputSchema.parse(input)).not.toHaveProperty("planFiles");
    const parsed = CodingTaskInputSchema.parse({
      ...input,
      planFiles: { files: [{ path: "plan.md", contentBase64: b64("# Plan\n") }] },
    });
    expect(parsed.planFiles?.files[0].path).toBe("plan.md");
  });

  it("refuses duplicate paths, unsafe paths, and more than the total", () => {
    const file = { path: "plan.md", contentBase64: b64("x") };
    expect(() => CodingTaskInputSchema.parse({ ...input, planFiles: { files: [file, file] } })).toThrow();
    expect(() =>
      CodingTaskInputSchema.parse({ ...input, planFiles: { files: [{ ...file, path: "../plan.md" }] } }),
    ).toThrow();
    const big = Buffer.alloc(PLAN_FILES_LIMITS.maxFileBytes, 97).toString("base64");
    const files = Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.md`, contentBase64: big }));
    expect(() => CodingTaskInputSchema.parse({ ...input, planFiles: { files } })).toThrow();
  });

  it("parses an ok and an error output, and refuses mixed shapes", () => {
    const ok = parsePlanFilesOutputJson(
      JSON.stringify({
        schemaVersion: 1,
        runId: "run_123",
        status: "ok",
        files: [{ path: "plan.md", contentBase64: b64("# P") }],
        skipped: ["link.md"],
        skippedUnnamed: 0,
      }),
    );
    expect(ok.status).toBe("ok");
    const error = parsePlanFilesOutputJson(
      JSON.stringify({ schemaVersion: 1, runId: "run_123", status: "error", error: "plan_too_large" }),
    );
    expect(error).toEqual({ schemaVersion: 1, runId: "run_123", status: "error", error: "plan_too_large" });
    expect(() =>
      parsePlanFilesOutputJson(
        JSON.stringify({ schemaVersion: 1, runId: "r", status: "error", error: "plan_too_large", files: [] }),
      ),
    ).toThrow();
  });

  it("refuses an output over the wire limit before parsing it", () => {
    expect(() => parsePlanFilesOutputJson(" ".repeat(MAX_PLAN_FILES_WIRE_BYTES + 1))).toThrow(
      "coding_artifact_size_limit",
    );
  });
});
