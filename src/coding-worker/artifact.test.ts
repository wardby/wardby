import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBoundedRegularFile, readCodingInput, writeCodingOutputAtomic } from "./artifact.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function root() {
  const path = await mkdtemp(join(tmpdir(), "wardby-worker-"));
  roots.push(path);
  return path;
}

describe("coding worker artifacts", () => {
  it("validates the bounded input before use", async () => {
    const directory = await root();
    const path = join(directory, "input.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        runId: "r1",
        repository: "OpenAI/Example",
        baseRef: "main",
        headRef: "wardby/run-r1",
        task: "Fix it",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        deadlineAt: "2026-09-07T13:00:00.000Z",
      }),
    );
    expect(await readCodingInput(path)).toMatchObject({ runId: "r1", repository: "openai/example" });
  });

  it("rejects symlink and oversized inputs before parsing", async () => {
    const directory = await root();
    const target = join(directory, "target");
    const link = join(directory, "link");
    await writeFile(target, "{}");
    await import("node:fs/promises").then(({ symlink }) => symlink(target, link));
    await expect(readCodingInput(link)).rejects.toThrow("coding_input_invalid_file");
    const oversized = join(directory, "oversized");
    await writeFile(oversized, "x".repeat(64 * 1024 + 1));
    await expect(readCodingInput(oversized)).rejects.toThrow("coding_input_invalid_file");
  });

  it("reads a file at exactly the limit and refuses anything that is not a regular file", async () => {
    const directory = await root();
    const exact = join(directory, "exact");
    await writeFile(exact, "y".repeat(16));
    expect(await readBoundedRegularFile(exact, 16, "bounded_invalid")).toBe("y".repeat(16));
    await expect(readBoundedRegularFile(exact, 15, "bounded_invalid")).rejects.toThrow("bounded_invalid");
    await expect(readBoundedRegularFile(directory, 16, "bounded_invalid")).rejects.toThrow("bounded_invalid");
  });

  it("atomically writes a private, versioned result with no leftover temporary file", async () => {
    const directory = await root();
    const path = join(directory, "output", "result.json");
    await writeCodingOutputAtomic(path, {
      schemaVersion: 1,
      runId: "r1",
      outcome: "no_changes",
      summary: "No changes required.",
      tests: [],
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ schemaVersion: 1, runId: "r1" });
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await expect((await import("node:fs/promises")).readdir(join(directory, "output"))).resolves.toEqual([
      "result.json",
    ]);
  });
});
