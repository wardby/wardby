// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { render } from "../../scripts/gen-types.mjs";
import type { GraphRun, GraphSnapshot, RunDetail, ViewerEvent } from "./types";

describe("generated API types", () => {
  it("are up to date with the published schemas (run `npm run gen:types` and commit)", async () => {
    const onDisk = readFileSync(fileURLToPath(new URL("./generated.ts", import.meta.url)), "utf8");
    expect(onDisk, "run `npm run gen:types` and commit").toBe(await render());
  });

  it("accepts sample values of each top-level type", () => {
    // Type-level: a shape mismatch fails `tsc -b` (npm run build).
    const run = {
      id: "r1",
      parentRunId: null,
      agentId: "a1",
      agentName: "agent",
      agentKind: "native",
      model: "m",
      codingProvider: null,
      nativeExecutionMode: "sandbox",
      warmWorkerName: null,
      declaredServices: [],
      status: "running",
      trigger: { kind: "manual" },
      turns: 1,
      tokensIn: 2,
      tokensOut: 3,
      costUsd: 0.1,
      budgetUsd: 1,
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: null,
      heartbeatAt: null,
      outcomes: [],
      services: [],
    } satisfies GraphRun;
    const snapshot = {
      generatedAt: "2026-01-01T00:00:00Z",
      since: "2026-01-01T00:00:00Z",
      limit: 10,
      truncated: false,
      runs: [run],
      spend: { todayUsd: 0, groups: [] },
    } satisfies GraphSnapshot;
    const detail = {
      ...run,
      error: null,
      finalText: null,
      childRunIds: [],
      coding: null,
    } satisfies RunDetail;
    const event = { kind: "outcome", runId: "r1", source: "pull_request" } satisfies ViewerEvent;
    expect([snapshot.runs.length, detail.id, event.kind]).toEqual([1, "r1", "outcome"]);
  });
});
