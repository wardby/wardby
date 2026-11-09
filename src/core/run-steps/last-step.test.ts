import { beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../logger.js", () => ({ logger: { child: () => ({ warn }) } }));

import { loadLastSteps, stepLine } from "./last-step.js";

describe("loadLastSteps", () => {
  beforeEach(() => warn.mockClear());

  it("never calls the database for no runs", async () => {
    const $queryRaw = vi.fn();
    expect((await loadLastSteps({ $queryRaw } as never, [])).size).toBe(0);
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it("maps the newest step of each run", async () => {
    const at = new Date("2026-11-07T12:00:00.000Z");
    const $queryRaw = vi
      .fn()
      .mockResolvedValue([
        { runId: "r1", seq: 3, at, kind: "tool", tool: "Bash", summary: "npm test", status: "exit 1" },
      ]);
    const got = await loadLastSteps({ $queryRaw } as never, ["r1", "r2"]);
    expect(got.get("r1")).toEqual({
      seq: 3,
      at: at.toISOString(),
      kind: "tool",
      tool: "Bash",
      summary: "npm test",
      status: "exit 1",
      line: "Bash: npm test (exit 1)",
    });
    expect(got.has("r2")).toBe(false);
  });

  it("never carries a stored detail text: exactly the LastStep keys", async () => {
    const at = new Date("2026-11-07T12:00:00.000Z");
    const $queryRaw = vi
      .fn()
      .mockResolvedValue([
        { runId: "r1", seq: 1, at, kind: "tool", tool: "Bash", summary: "ls", status: "ok", detail: "SHOULD-NOT-SHOW" },
      ]);
    const got = (await loadLastSteps({ $queryRaw } as never, ["r1"])).get("r1");
    expect(Object.keys(got!).sort()).toEqual(["at", "kind", "line", "seq", "status", "summary", "tool"]);
    expect(JSON.stringify(got)).not.toContain("SHOULD-NOT-SHOW");
  });

  it("returns an empty map and logs one warning without the error message when the query fails", async () => {
    const fakeSecret = "wbFake-Secret-Value-7f3a91";
    const $queryRaw = vi.fn().mockRejectedValue(new Error(`connection to ${fakeSecret} lost`));
    const got = await loadLastSteps({ $queryRaw } as never, ["r1"]);
    expect(got.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ event: "run_steps_last_step_failed", errorName: "Error" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(fakeSecret);
  });
});

describe("stepLine", () => {
  it("shows a tool and its summary, with no suffix for ok", () => {
    expect(stepLine({ kind: "tool", tool: "Bash", summary: "npm test", status: "ok" })).toBe("Bash: npm test");
  });
  it("adds a status other than ok", () => {
    expect(stepLine({ kind: "tool", tool: "Bash", summary: "npm test", status: "exit 1" })).toBe(
      "Bash: npm test (exit 1)",
    );
  });
  it("shows what the model said", () => {
    expect(stepLine({ kind: "said", tool: null, summary: "Running the tests.", status: null })).toBe(
      "said: Running the tests.",
    );
  });
  it("falls back to 'tool' when a tool step has no name", () => {
    expect(stepLine({ kind: "tool", tool: null, summary: "x", status: null })).toBe("tool: x");
  });
});
