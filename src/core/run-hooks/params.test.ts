import { describe, expect, it } from "vitest";
import { buildHookEvent, hookFinalText, HOOK_FINAL_TEXT_CUT_NOTE, MAX_HOOK_FINAL_TEXT_CHARS } from "./params.js";

describe("hookFinalText", () => {
  it("masks every secret value by exact value", () => {
    const got = hookFinalText("token sk-live-abc123 and again sk-live-abc123", ["sk-live-abc123"]);
    expect(got.finalText).toBe("token [REDACTED] and again [REDACTED]");
    expect(got.finalTextTruncated).toBe(false);
  });

  it("keeps null as null", () => {
    expect(hookFinalText(null, ["x"])).toEqual({ finalText: null, finalTextTruncated: false });
  });

  it("cuts text past the limit and ends it with a note", () => {
    const got = hookFinalText("a".repeat(MAX_HOOK_FINAL_TEXT_CHARS + 10), []);
    expect(got.finalTextTruncated).toBe(true);
    expect(got.finalText!.length).toBeLessThanOrEqual(MAX_HOOK_FINAL_TEXT_CHARS);
    expect(got.finalText!.endsWith(HOOK_FINAL_TEXT_CUT_NOTE)).toBe(true);
  });

  it("masks before cutting, so a secret straddling the cut never survives in part", () => {
    const secret = "s3cr3t-value-xyz";
    const text = "a".repeat(MAX_HOOK_FINAL_TEXT_CHARS - HOOK_FINAL_TEXT_CUT_NOTE.length - 5) + secret + "tail";
    expect(hookFinalText(text, [secret]).finalText).not.toContain(secret.slice(0, 5));
  });
});

describe("buildHookEvent", () => {
  const row = {
    id: "ev1",
    kind: "run_completed",
    runId: "r1",
    createdAt: new Date("2026-11-09T07:08:39.000Z"),
    payload: { kind: "run_completed", status: "succeeded", agentName: "auditor", costUsd: "3.21" },
  };

  it("wraps the stored payload under data, without its kind", () => {
    expect(buildHookEvent(row, { id: "a1", name: "auditor" })).toEqual({
      schemaVersion: 1,
      kind: "run_completed",
      eventId: "ev1",
      occurredAt: "2026-11-09T07:08:39.000Z",
      agent: { id: "a1", name: "auditor" },
      runId: "r1",
      data: { status: "succeeded", agentName: "auditor", costUsd: "3.21" },
    });
  });

  it("adds the final text only when given", () => {
    const got = buildHookEvent(row, { id: "a1", name: "auditor" }, { finalText: "report", finalTextTruncated: false });
    expect(got).toMatchObject({ finalText: "report", finalTextTruncated: false });
  });

  it("marks a test event", () => {
    expect(buildHookEvent(row, { id: "a1", name: "auditor" }, undefined, true)).toMatchObject({ test: true });
  });
});
