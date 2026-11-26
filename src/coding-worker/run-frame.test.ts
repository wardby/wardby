import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingTaskInput } from "../coding/protocol.js";
import { safeOutputIssues, safeWorkerErrorCode } from "./errors.js";
import {
  boundedTaskPrompt,
  finishBudgetExhausted,
  finishWorkerRun,
  parseAgentOutput,
  prepareWorkerRun,
  type RunFrameOptions,
} from "./run-frame.js";

const input: CodingTaskInput = {
  schemaVersion: 1,
  runId: "run_frame",
  repository: "openai/example",
  baseRef: "main",
  headRef: "wardby/run-run_frame",
  task: "Add hello.txt",
  model: "google-ai-studio.gemini-4-neon",
  budgetUsd: 1,
  deadlineAt: "2099-01-01T00:00:00.000Z",
};
const valid = {
  schemaVersion: 1,
  runId: "run_frame",
  outcome: "changes_ready",
  summary: "Added hello.txt",
  tag: null,
  commitType: "feat",
  commitScope: null,
  commitTitle: "add hello.txt",
  pullRequest: null,
  tests: [],
};

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function options(extra: Partial<RunFrameOptions> = {}): Promise<RunFrameOptions> {
  root = await mkdtemp(join(tmpdir(), "wardby-run-frame-"));
  return {
    input,
    workspace: root,
    planRoot: join(root, "plan"),
    proxyBaseUrl: "http://wardby-proxy:8787",
    capability: "rrp_0123456789abcdefFAKE",
    signal: new AbortController().signal,
    ...extra,
  };
}

describe("run frame", () => {
  it("keeps the Codex prompt wording the scripted model and wardby-sim read", () => {
    expect(boundedTaskPrompt("Do it", "run_1", "note")).toBe(
      "Complete this software-engineering task in the current workspace.\n\nTask:\nDo it\n\nnote\n\nThe final JSON runId must be run_1.",
    );
  });

  it("prepares the agent environment: shims first on PATH, workspace TMPDIR, registry config, no capability", async () => {
    const o = await options();
    const run = await prepareWorkerRun(o);
    expect(run.agentEnvironment.PATH.startsWith("/opt/wardby/bin:")).toBe(true);
    expect(run.agentEnvironment.TMPDIR).toBe(`${o.workspace}/.cache/tmp`);
    expect(JSON.stringify(run.agentEnvironment)).not.toContain(o.capability);
    expect(run.note).toContain("wardby-packages");
    expect(run.dependencyCache).toBeUndefined();
  });

  it("parses a valid answer and refuses an invalid one or another run's", () => {
    expect(parseAgentOutput(JSON.stringify(valid), "run_frame").outcome).toBe("changes_ready");
    const invalid = (() => {
      try {
        parseAgentOutput(JSON.stringify({ ...valid, tests: "none" }), "run_frame");
      } catch (error) {
        return error;
      }
    })();
    expect(safeWorkerErrorCode(invalid)).toBe("coding_output_invalid");
    expect(safeOutputIssues(invalid)).toEqual(["tests:invalid_type"]);
    expect(() => parseAgentOutput(JSON.stringify({ ...valid, runId: "other" }), "run_frame")).toThrow(
      "coding_output_run_mismatch",
    );
  });

  it("finishes with the completed progress event and the dependency cache report", async () => {
    const onProgress = vi.fn();
    const o = await options({ onProgress });
    const run = await prepareWorkerRun(o);
    const output = await finishWorkerRun(
      o,
      { ...run, dependencyCache: { projects: [], reason: "timeout" } },
      parseAgentOutput(JSON.stringify(valid), "run_frame"),
    );
    expect(output).toMatchObject({ outcome: "changes_ready", dependencyCache: { projects: [], reason: "timeout" } });
    expect(onProgress).toHaveBeenLastCalledWith({
      schemaVersion: 1,
      runId: "run_frame",
      type: "completed",
      outcome: "changes_ready",
    });
  });

  it("finishes a budget stop with the shared summary and keeps the work", async () => {
    const o = await options();
    const output = await finishBudgetExhausted(o, await prepareWorkerRun(o));
    expect(output).toEqual({
      schemaVersion: 1,
      runId: "run_frame",
      outcome: "budget_exhausted",
      summary: "The coding budget was exhausted before the task could complete.",
      tests: [],
    });
  });

  it("writes no file that holds the capability", async () => {
    const o = await options();
    await prepareWorkerRun(o);
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(join(o.workspace, ".cache"), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      expect(await readFile(join(entry.parentPath, entry.name), "utf8")).not.toContain(o.capability);
    }
  });
});
