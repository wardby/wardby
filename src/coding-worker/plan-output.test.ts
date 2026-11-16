import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePlanFilesOutputJson } from "../coding/protocol.js";
import { writePlanFilesOutputAtomic } from "./artifact.js";
import { collectPlanFolder } from "./plan-folder.mjs";
import { collectPlanOutput, shouldCollectPlan } from "./plan-output.js";

describe("plan output", () => {
  it("wraps the folder in the protocol shape and writes it atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wardby-plan-out-"));
    const root = join(dir, "plan");
    await mkdir(root);
    await writeFile(join(root, "plan.md"), "# Plan\n");
    const output = await collectPlanOutput("run_123", () => collectPlanFolder(root));
    expect(output).toMatchObject({ schemaVersion: 1, runId: "run_123", status: "ok", skipped: [] });
    await writePlanFilesOutputAtomic(join(dir, "out", "plan-files.json"), output);
    const parsed = parsePlanFilesOutputJson(await readFile(join(dir, "out", "plan-files.json"), "utf8"));
    expect(parsed.status === "ok" && parsed.files[0].path).toBe("plan.md");
  });

  it("a throwing collector is plan_files_failed, never the error text", async () => {
    const output = await collectPlanOutput("run_123", async () => {
      throw new Error("ENOENT /tmp/wardby-plan/sk-test-FAKE-0000000000000000");
    });
    expect(output).toEqual({ schemaVersion: 1, runId: "run_123", status: "error", error: "plan_files_failed" });
  });

  it("collects only for a plan run or a folder with entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wardby-plan-should-"));
    const base = {};
    expect(await shouldCollectPlan(base, join(dir, "missing"))).toBe(false);
    await mkdir(join(dir, "empty"));
    expect(await shouldCollectPlan(base, join(dir, "empty"))).toBe(false);
    await writeFile(join(dir, "empty", "a.md"), "x");
    expect(await shouldCollectPlan(base, join(dir, "empty"))).toBe(true);
  });
});
