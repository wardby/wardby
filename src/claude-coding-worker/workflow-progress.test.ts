import { describe, expect, it, vi } from "vitest";
import * as core from "../core/run-steps/types.js";
import {
  AGENT_REF,
  AGENT_STATE,
  MAX_AGENTS,
  MAX_LABEL_CHARS,
  MAX_PHASES,
  WORKFLOW_PROGRESS_ROUTE,
  WorkflowProgressReporter,
  workflowTreeOf,
} from "./workflow-progress.js";
import { WORKFLOW_PROGRESS_PATH } from "../providers/coding-proxy/server.js";

// The shape Claude Code sends in task_progress.workflow_progress (seen in a real run's trace).
const progress = [
  { type: "workflow_phase", index: 1, title: "Triage: Intake" },
  { type: "workflow_phase", index: 2, title: "Triage: Investigate" },
  {
    type: "workflow_agent",
    index: 1,
    label: "intake",
    phaseIndex: 1,
    phaseTitle: "Triage: Intake",
    agentId: "ab1d62e7e65c99f79",
    model: "claude-haiku-4-5",
    state: "done",
    attempt: 1,
    promptPreview: "Triage intake for SIM-1. Read tickets/SIM-1.md.",
    lastToolSummary: "Empty card displayed",
  },
  { type: "workflow_agent", label: "duplicates", phaseIndex: 2, agentId: "c0ffee1234", state: "start", attempt: 1 },
];

describe("workflowTreeOf (#582)", () => {
  it("keeps phases and sub-agents, never the prompt preview or tool summaries", () => {
    const tree = workflowTreeOf(progress);
    expect(tree).toEqual({
      phases: [
        { index: 1, title: "Triage: Intake" },
        { index: 2, title: "Triage: Investigate" },
      ],
      agents: [
        { id: "ab1d62e7e65c99f79", label: "intake", phaseIndex: 1, state: "done", attempt: 1 },
        { id: "c0ffee1234", label: "duplicates", phaseIndex: 2, state: "start", attempt: 1 },
      ],
    });
    expect(JSON.stringify(tree)).not.toContain("Triage intake for SIM-1");
    expect(JSON.stringify(tree)).not.toContain("Empty card");
  });

  it("skips agents with a malformed id, keeps the latest entry of a retried agent, bounds labels", () => {
    const tree = workflowTreeOf([
      { type: "workflow_agent", label: "bad", agentId: "has space", state: "start" },
      { type: "workflow_agent", label: "x".repeat(500), agentId: "a1", state: "start", attempt: 1 },
      { type: "workflow_agent", label: "fix", agentId: "a1", state: "Weird-State", attempt: 2 },
    ]);
    expect(tree?.agents).toEqual([{ id: "a1", label: "fix", phaseIndex: null, state: "unknown", attempt: 2 }]);
    expect(
      workflowTreeOf([{ type: "workflow_agent", label: "y".repeat(500), agentId: "a2" }])?.agents[0].label,
    ).toHaveLength(MAX_LABEL_CHARS);
    expect(workflowTreeOf(null)).toBeNull();
    expect(workflowTreeOf([])).toBeNull();
  });

  it("uses the same bounds and route as the control plane and the proxy", () => {
    expect(AGENT_REF.source).toBe(core.STEP_AGENT_REF.source);
    expect(AGENT_STATE.source).toBe(core.WORKFLOW_AGENT_STATE.source);
    expect([MAX_PHASES, MAX_AGENTS, MAX_LABEL_CHARS]).toEqual([
      core.MAX_WORKFLOW_PHASES,
      core.MAX_WORKFLOW_AGENTS,
      core.MAX_WORKFLOW_LABEL_CHARS,
    ]);
    expect(`/${WORKFLOW_PROGRESS_ROUTE}`).toBe(WORKFLOW_PROGRESS_PATH);
  });
});

describe("WorkflowProgressReporter (#582)", () => {
  it("posts the latest tree to the proxy with the run's capability, and only when it changed", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const reporter = new WorkflowProgressReporter({
      proxyBaseUrl: "http://wardby-proxy:8787/",
      capability: "rrp_test_capability",
      fetchImpl: fetchImpl,
    });
    reporter.update(progress);
    reporter.update(progress);
    await reporter.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://wardby-proxy:8787/wardby/workflow-progress");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("rrp_test_capability");
    expect(JSON.parse(init.body as string).agents).toHaveLength(2);
    await reporter.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never throws when the proxy cannot be reached or an event is malformed", async () => {
    const reporter = new WorkflowProgressReporter({
      proxyBaseUrl: "http://wardby-proxy:8787/",
      capability: "rrp_test_capability",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    reporter.update({ not: "a list" });
    reporter.update(progress);
    await expect(reporter.flush()).resolves.toBeUndefined();
  });
});
