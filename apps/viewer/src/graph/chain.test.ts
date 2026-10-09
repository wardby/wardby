import { describe, expect, it } from "vitest";
import type { GraphRun, Outcome, RunTrigger } from "../api/types";
import { chainLinks, prKey } from "./chain";

const t = (n: number) => new Date(Date.UTC(2026, 9, 6, 10, n)).toISOString();

function run(id: string, overrides: Partial<GraphRun> = {}): GraphRun {
  return {
    id,
    parentRunId: null,
    agentId: "a",
    agentName: id,
    agentKind: "native",
    model: "m",
    codingProvider: null,
    nativeExecutionMode: null,
    warmWorkerName: null,
    declaredServices: [],
    status: "succeeded",
    trigger: { kind: "manual" },
    turns: 1,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    budgetUsd: 1,
    startedAt: t(0),
    finishedAt: null,
    heartbeatAt: null,
    outcomes: [],
    services: [],
    ...overrides,
  } as GraphRun;
}

const pr = (n: number, repo = "o/r"): Outcome => ({
  kind: "pull_request",
  provider: "github",
  repository: repo,
  number: n,
  url: `https://github.com/${repo}/pull/${n}`,
  state: "open",
  at: null,
});
const check = (n: number, completed = true): Outcome => ({
  kind: "check",
  provider: "github",
  repository: "o/r",
  number: n,
  completed,
  at: null,
});
const review = (n: number, repo = "o/r"): RunTrigger => ({
  kind: "code_host",
  provider: "github",
  repository: repo,
  number: n,
  event: "review",
});
const mention = (n: number): RunTrigger => ({
  kind: "code_host",
  provider: "github",
  repository: "o/r",
  number: n,
  event: "mention",
});
const webhook: RunTrigger = { kind: "webhook" };

describe("prKey", () => {
  it("normalises the repository and needs a number", () => {
    expect(prKey("github", "O/R", 6)).toBe("github:o/r#6");
    expect(prKey("github", "o/r", null)).toBeNull();
  });
});

describe("chainLinks", () => {
  it("links a review to the PR its builder opened", () => {
    const runs = [
      run("deliver", { startedAt: t(0), trigger: { kind: "issue", provider: "github", issueKey: "o/r#5", url: null } }),
      run("build", { parentRunId: "deliver", startedAt: t(1), outcomes: [pr(6)] }),
      run("rev", { startedAt: t(5), trigger: review(6), outcomes: [check(6, false)] }),
    ];
    expect(chainLinks(runs, ["deliver", "rev"])).toEqual([{ from: "o:build:0", toRunId: "rev", label: "review" }]);
  });

  it("chains review → fix → re-review in time order", () => {
    const runs = [
      run("build", { startedAt: t(0), outcomes: [pr(6)] }),
      run("rev1", { startedAt: t(5), trigger: review(6), outcomes: [check(6, false)] }),
      run("fix", { startedAt: t(8), trigger: webhook }),
      run("fixbuild", { parentRunId: "fix", startedAt: t(9), outcomes: [pr(6)] }),
      run("rev2", { startedAt: t(15), trigger: review(6), outcomes: [check(6)] }),
    ];
    expect(chainLinks(runs, ["build", "rev1", "fix", "rev2"])).toEqual([
      { from: "o:build:0", toRunId: "rev1", label: "review" },
      { from: "o:rev1:0", toRunId: "fix", label: "fix" },
      { from: "o:fixbuild:0", toRunId: "rev2", label: "review" },
    ]);
  });

  it("links an @wardby mention on the PR", () => {
    const runs = [
      run("build", { startedAt: t(0), outcomes: [pr(6)] }),
      run("m", { startedAt: t(3), trigger: mention(6) }),
    ];
    expect(chainLinks(runs, ["build", "m"])).toEqual([{ from: "o:build:0", toRunId: "m", label: "mention" }]);
  });

  it("leaves a webhook fix round with no PR in its tree alone", () => {
    const runs = [
      run("build", { startedAt: t(0), outcomes: [pr(6)] }),
      run("fix", { startedAt: t(4), trigger: webhook }),
    ];
    expect(chainLinks(runs, ["build", "fix"])).toEqual([]);
  });

  it("never links backwards in time, across repos or PR numbers", () => {
    const runs = [
      run("early", { startedAt: t(0), trigger: review(6) }),
      run("build", { startedAt: t(1), outcomes: [pr(6)] }),
      run("other-pr", { startedAt: t(2), trigger: review(7) }),
      run("other-repo", { startedAt: t(3), trigger: review(6, "o/x") }),
    ];
    expect(chainLinks(runs, ["early", "build", "other-pr", "other-repo"])).toEqual([]);
  });

  it("matches repositories case-insensitively", () => {
    const runs = [
      run("build", { startedAt: t(0), outcomes: [pr(6, "O/R")] }),
      run("rev", { startedAt: t(1), trigger: review(6, "o/r") }),
    ];
    expect(chainLinks(runs, ["build", "rev"])).toHaveLength(1);
  });

  it("anchors on the run that opened the PR, not a later push", () => {
    const runs = [
      run("opener", { startedAt: t(0), outcomes: [pr(6)] }),
      run("pusher-root", { startedAt: t(2), trigger: webhook }),
      run("pusher", { parentRunId: "pusher-root", startedAt: t(3), outcomes: [pr(6)] }),
    ];
    expect(chainLinks(runs, ["opener", "pusher-root"])).toEqual([
      { from: "o:opener:0", toRunId: "pusher-root", label: "fix" },
    ]);
  });

  it("continues from a review run with no check outcome", () => {
    const runs = [
      run("build", { startedAt: t(0), outcomes: [pr(6)] }),
      run("rev1", { startedAt: t(2), trigger: review(6), status: "failed" }),
      run("rev2", { startedAt: t(4), trigger: review(6), outcomes: [check(6)] }),
    ];
    expect(chainLinks(runs, ["build", "rev1", "rev2"])).toEqual([
      { from: "o:build:0", toRunId: "rev1", label: "review" },
      { from: "r:rev1", toRunId: "rev2", label: "review" },
    ]);
  });

  it("gives a root about two PRs to the one opened first", () => {
    const runs = [
      run("open6", { startedAt: t(0), outcomes: [pr(6)] }),
      run("open7", { startedAt: t(1), outcomes: [pr(7)] }),
      run("fix", { startedAt: t(3), trigger: webhook }),
      run("fixbuild", { parentRunId: "fix", startedAt: t(4), outcomes: [pr(7), pr(6)] }),
    ];
    expect(chainLinks(runs, ["open6", "open7", "fix"])).toEqual([{ from: "o:open6:0", toRunId: "fix", label: "fix" }]);
  });

  it("never claims a root that started before the PR was opened", () => {
    const runs = [
      run("rev", { startedAt: t(0), trigger: review(6) }),
      run("build", { startedAt: t(5), outcomes: [pr(6)] }),
    ];
    expect(chainLinks(runs, ["rev", "build"])).toEqual([]);
  });

  it("continues from a check rather than a comment or the PR box in the same run", () => {
    const comment: Outcome = { kind: "code_host_comment", provider: "github", repository: "o/r", number: 6, at: null };
    const runs = [
      run("build", { startedAt: t(0), outcomes: [pr(6)] }),
      run("rev1", { startedAt: t(2), trigger: review(6), outcomes: [comment, check(6)] }),
      run("rev2", { startedAt: t(4), trigger: review(6) }),
    ];
    expect(chainLinks(runs, ["build", "rev1", "rev2"])[1]).toEqual({
      from: "o:rev1:1",
      toRunId: "rev2",
      label: "review",
    });
  });

  it("never links back to its own source when trees start at the same instant", () => {
    const runs = [
      run("a", { startedAt: t(0), trigger: review(7), outcomes: [pr(6)] }),
      run("b", { startedAt: t(0), trigger: review(6), outcomes: [pr(7)] }),
    ];
    const links = chainLinks(runs, ["a", "b"]);
    expect(links).toHaveLength(1);
  });
});
