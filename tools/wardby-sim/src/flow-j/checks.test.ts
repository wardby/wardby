import { describe, expect, it } from "vitest";
import type { Inspect } from "../flow-g/checks.js";
import type { RecordedCall } from "../state.js";
import {
  checkBuilt,
  checkDuplicateAnswered,
  checkLedger,
  checkMergeWriteBack,
  checkOneRequestComment,
  checkPullRequestLinked,
  checkTriggered,
  spendAmounts,
  unverifiedJiraEventsUsed,
  type JiraInspectIssue,
  type RunRow,
} from "./checks.js";

const BOT = "bot-1";
const PR = "https://github.com/acme/widgets/pull/1";
const URL = "https://sim-site.atlassian.net/browse/WID-1";

const run = (over: Partial<RunRow>): RunRow => ({
  id: "r1",
  agent: "delivery",
  status: "succeeded",
  costUsd: 0.01,
  parentRunId: null,
  budgetUsd: 10,
  usageUsd: 0.01,
  proxyUsd: null,
  workItem: "jira:WID-1",
  attributionSource: "issue_event",
  ...over,
});

const comment = (text: string, over: Partial<JiraInspectIssue["comments"][number]> = {}) => ({
  id: "c1",
  author: BOT,
  text,
  mentions: [],
  edits: 1,
  history: ["👀 Working on it."],
  visibility: null,
  ...over,
});

const issue = (over: Partial<JiraInspectIssue> = {}): JiraInspectIssue => ({
  key: "WID-1",
  status: "Done",
  labels: [],
  assignee: BOT,
  transitions: [
    { by: BOT, from: "To Do", to: "In Review" },
    { by: BOT, from: "In Review", to: "Done" },
  ],
  comments: [
    comment(
      `✅ Opened acme/widgets#1 <${PR}>.\nAgent spend: $0.017 this run · $0.017 on this issue so far\nwardby run r1`,
    ),
    comment(`✅ Pull request acme/widgets#1 <${PR}> was merged. Moved to Done.`, { id: "c2", edits: 0 }),
  ],
  remoteLinks: [
    {
      id: 1,
      globalId: "wardby:pr:github:acme/widgets#1",
      object: { url: PR, title: "acme/widgets#1", status: { resolved: true } },
      writes: 2,
    },
  ],
  ...over,
});

const call = (over: Partial<RecordedCall>): RecordedCall => ({
  seq: 1,
  at: "",
  service: "github",
  method: "POST",
  path: "/repos/acme/widgets/pulls",
  query: "",
  status: 201,
  auth: "token",
  ...over,
});

const github = (body: string): Inspect => ({
  issues: [],
  pulls: [{ number: 1, state: "open", draft: false, merged: false, head: "h", base: "main", body }],
  comments: [],
  reactions: [],
  reviews: [],
  checkRuns: [],
});

describe("Flow J checks", () => {
  it("J1: one delivery run, tied to the issue by its status row and attribution", () => {
    expect(checkTriggered([run({})], "delivery", "WID-1", [{ runId: "r1", issueKey: "WID-1" }])).toEqual([]);
    expect(checkTriggered([run({}), run({ id: "r2" })], "delivery", "WID-1", [])).toContain(
      "expected one delivery run, got 2",
    );
    expect(
      checkTriggered([run({ workItem: null })], "delivery", "WID-1", [{ runId: "r1", issueKey: "WID-1" }])[0],
    ).toMatch(/attributed to null/);
    expect(
      checkTriggered([run({ attributionSource: "explicit" })], "delivery", "WID-1", [
        { runId: "r1", issueKey: "WID-1" },
      ])[0],
    ).toMatch(/source is explicit/);
  });

  it("duplicate: answered 202, one run", () => {
    expect(checkDuplicateAnswered([{ status: 202 }], 1)).toEqual([]);
    expect(checkDuplicateAnswered([], 1)).toEqual(["the duplicate delivery was not sent"]);
    expect(checkDuplicateAnswered([{ status: 202 }], 2)[0]).toMatch(/one delivery run/);
  });

  it("J2: exactly one request comment, edited, footer, PR link; literal markdown reported apart", () => {
    expect(checkOneRequestComment(issue(), BOT, "r1", PR)).toEqual([]);
    const two = issue({ comments: [...issue().comments, comment("👀 Working on it.\nwardby run r1", { id: "c3" })] });
    expect(checkOneRequestComment(two, BOT, "r1", PR)[0]).toBe("expected one request comment by the bot, got 2");
    const unedited = issue({ comments: [comment(`x <${PR}>\nwardby run r1`, { edits: 0 })] });
    expect(checkOneRequestComment(unedited, BOT, "r1", PR)).toEqual([
      "the status comment was never edited with the outcome",
    ]);
    const ticks = issue({ comments: [comment(`x <${PR}>\nwardby run \`r1\``)] });
    expect(checkOneRequestComment(ticks, BOT, "r1", PR)).toEqual([
      'the footer shows literal markdown: "wardby run `r1`"',
    ]);
    const wrong = issue({ comments: [comment("x\nwardby run r9")] });
    expect(checkOneRequestComment(wrong, BOT, "r1", PR)).toEqual([
      "the footer names run r9, expected r1",
      `the request comment does not link ${PR}`,
    ]);
  });

  it("J3: the builder succeeded and its PR changes the scripted file", () => {
    expect(checkBuilt([run({ agent: "builder" })], "builder", ["jokes/flow-j.txt"], "jokes/flow-j.txt")).toEqual([]);
    expect(checkBuilt([run({ agent: "builder", status: "failed" })], "builder", [], "jokes/flow-j.txt")).toHaveLength(
      2,
    );
  });

  it("J4: PR body names and links the issue, a check run, one web link, the opened move", () => {
    const calls = [call({}), call({ seq: 2, path: "/repos/acme/widgets/check-runs" })];
    const opts = { repo: "acme/widgets", issueUrl: URL, openedStatus: "In Review" };
    expect(checkPullRequestLinked(calls, github(`Resolves Jira issue [WID-1](${URL})`), issue(), opts)).toEqual([]);
    const problems = checkPullRequestLinked(
      [call({})],
      github("no link"),
      issue({ remoteLinks: [], transitions: [] }),
      opts,
    );
    expect(problems).toEqual([
      "the PR body does not name WID-1",
      `the PR body does not link ${URL}`,
      "no check run created",
      `expected one web link to ${PR} on WID-1, got 0`,
      'WID-1 was never moved to "In Review" when the PR opened',
    ]);
  });

  it("J8: resolved link, merged status, one merged comment, the pair merged", () => {
    const opts = { prUrl: PR, mergedStatus: "Done", pairs: [{ state: "merged" }] };
    expect(checkMergeWriteBack(issue(), BOT, opts)).toEqual([]);
    const bad = issue({
      status: "In Review",
      comments: [issue().comments[0]],
      remoteLinks: [{ id: 1, globalId: "g", object: { url: PR, title: "t" }, writes: 1 }],
    });
    expect(checkMergeWriteBack(bad, BOT, { ...opts, pairs: [{ state: "open" }] })).toHaveLength(4);
  });

  it("J9: costs match their ledgers and budgets; Jira's spend is the run tree's", () => {
    const runs = [
      run({ costUsd: 0.01008, usageUsd: 0.01008 }),
      run({
        id: "r2",
        agent: "builder",
        parentRunId: "r1",
        costUsd: 0.00672,
        usageUsd: 0.00672,
        proxyUsd: 0.00672,
        attributionSource: "inherited",
      }),
      run({ id: "r3", agent: "reviewer", costUsd: 0.01344, usageUsd: 0.01344, attributionSource: "linked_pr" }),
    ];
    const text = "Agent spend: $0.017 this run · $0.017 on this issue so far\nwardby run r1";
    expect(checkLedger(runs, "r1", text, "WID-1")).toEqual([]);
    expect(checkLedger(runs, "r1", text.replace("0.017 this", "0.031 this"), "WID-1")[0]).toMatch(
      /Jira shows \$0.031 this run/,
    );
    const off = [
      { ...runs[0], usageUsd: 0.02 },
      { ...runs[1], proxyUsd: 0.5, costUsd: 6, usageUsd: 6, budgetUsd: 5 },
    ];
    const problems = checkLedger(off, "r1", text, "WID-1");
    expect(problems.some((p) => p.includes("Σ model usage"))).toBe(true);
    expect(problems.some((p) => p.includes("Σ proxy ledger"))).toBe(true);
    expect(problems.some((p) => p.includes("over its budget"))).toBe(true);
    expect(checkLedger(runs, "r1", "no spend\nwardby run r1", "WID-1")).toEqual([
      "the request comment has no spend line",
    ]);
  });

  it("parses the spend line and lists the Jira events used", () => {
    expect(spendAmounts("Agent spend: $1.23 this run · $4.50 on this issue so far")).toEqual({ run: 1.23, issue: 4.5 });
    expect(unverifiedJiraEventsUsed([{ event: "comment_created" }, { event: "push" }])).toEqual(["comment_created"]);
  });
});
