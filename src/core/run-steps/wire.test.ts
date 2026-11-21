import { describe, expect, it } from "vitest";
import { parseRunStepPost } from "./wire.js";
import { MAX_RESULT_OUTPUT_CHARS, MAX_STEP_TEXT_CHARS } from "./types.js";

describe("parseRunStepPost (detail fields)", () => {
  it("accepts an input on a tool step and an output tail on a result", () => {
    const post = parseRunStepPost({
      runId: "r1",
      steps: [
        {
          kind: "tool",
          callId: "c1",
          tool: "Bash",
          text: "ls",
          truncated: false,
          input: '{"command":"ls"}',
          inputTruncated: false,
        },
      ],
      results: [{ callId: "c1", status: "ok", output: "a\nb", outputCut: true }],
    });
    expect(post?.batch.results[0]).toEqual({ callId: "c1", status: "ok", output: "a\nb", outputCut: true });
  });

  it("refuses an output past its bound, and an input on a said step", () => {
    expect(
      parseRunStepPost({
        runId: "r1",
        steps: [],
        results: [{ callId: "c1", status: "ok", output: "x".repeat(MAX_RESULT_OUTPUT_CHARS + 1) }],
      }),
    ).toBeUndefined();
    expect(
      parseRunStepPost({
        runId: "r1",
        steps: [{ kind: "said", callId: "s1", text: "hi", truncated: false, input: "x" }],
        results: [],
      }),
    ).toBeUndefined();
  });

  it("refuses an oversize input on a tool step and an extra key on a result", () => {
    expect(
      parseRunStepPost({
        runId: "r1",
        steps: [
          {
            kind: "tool",
            callId: "c1",
            tool: "Bash",
            text: "ls",
            truncated: false,
            input: "x".repeat(MAX_STEP_TEXT_CHARS + 1),
          },
        ],
        results: [],
      }),
    ).toBeUndefined();
    expect(
      parseRunStepPost({ runId: "r1", steps: [], results: [{ callId: "c1", status: "ok", extra: "x" }] }),
    ).toBeUndefined();
  });
});

describe("parseRunStepPost (workflow runs, #582)", () => {
  const tree = {
    phases: [{ index: 1, title: "Triage: Intake" }],
    agents: [{ id: "ab1d62e7e65c99f79", label: "intake", phaseIndex: 1, state: "done", attempt: 1 }],
  };
  it("keeps a step's sub-agent and the workflow tree", () => {
    const post = parseRunStepPost({
      runId: "r1",
      steps: [{ kind: "said", callId: "s1", text: "hi", truncated: false, agent: "ab1d62e7e65c99f79" }],
      results: [],
      workflow: tree,
    });
    expect(post?.batch.steps[0]).toMatchObject({ agent: "ab1d62e7e65c99f79" });
    expect(post?.batch.workflow).toEqual(tree);
  });
  it("refuses a malformed sub-agent id, an unknown field, or too many agents", () => {
    const base = { runId: "r1", steps: [], results: [] };
    expect(
      parseRunStepPost({ ...base, steps: [{ kind: "said", callId: "s1", text: "x", truncated: false, agent: "a b" }] }),
    ).toBeUndefined();
    expect(parseRunStepPost({ ...base, workflow: { ...tree, extra: true } })).toBeUndefined();
    const many = Array.from({ length: 1001 }, (_, i) => ({ ...tree.agents[0], id: `a${i}` }));
    expect(parseRunStepPost({ ...base, workflow: { phases: [], agents: many } })).toBeUndefined();
  });
});
