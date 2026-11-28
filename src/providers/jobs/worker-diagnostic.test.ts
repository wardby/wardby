import { describe, expect, it } from "vitest";
import { parseWorkerDiagnosticLine, workerDiagnosticOf } from "./worker-diagnostic.js";

describe("worker diagnostics", () => {
  it("keeps a fixed code and drops anything else", () => {
    expect(parseWorkerDiagnosticLine('{"error":"coding_turn_failed"}')).toEqual({ diagnostic: "coding_turn_failed" });
    expect(parseWorkerDiagnosticLine('{"error":"Bad Thing: secret"}')).toBeUndefined();
    expect(parseWorkerDiagnosticLine("not json")).toBeUndefined();
  });

  it("keeps the join seq of a stopped workflow (#657), as a positive integer, and on that code only", () => {
    expect(parseWorkerDiagnosticLine('{"error":"coding_workflow_stopped","joinSeq":12}')).toEqual({
      diagnostic: "coding_workflow_stopped",
      diagnosticJoinSeq: 12,
    });
    for (const joinSeq of ["12", 0, -1, 1.5, 2 ** 60, null]) {
      expect(workerDiagnosticOf("coding_workflow_stopped", undefined, joinSeq)).toEqual({
        diagnostic: "coding_workflow_stopped",
      });
    }
    expect(workerDiagnosticOf("coding_turn_failed", undefined, 12)).toEqual({ diagnostic: "coding_turn_failed" });
  });
});
