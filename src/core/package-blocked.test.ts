import { describe, expect, it, vi } from "vitest";
import { LISTING_REFUSAL_FILENAME } from "../coding/registry/report.js";
import {
  blockingRefusals,
  collectRunOutcome,
  completeHostStatus,
  isBlockedByRefusals,
  outcomeBody,
} from "./host-status.js";
import { completeIssueStatus } from "./issue-status.js";
import { renderEvent, nextStatus } from "./notification-templates.js";
import { emitRunFinishedEvents } from "./workflow-run-events.js";
import { setWorkflowEventSink } from "./workflow-events.js";

const run = { id: "r", status: "succeeded" as const, finalText: null };
const refusals = (reason: string) => [{ ecosystem: "npm", name: "pkg", reason }];

describe("package blocked status", () => {
  it.each([false, true])("preserves a succeeded run's reply despite refusals (replyAsAnswer=%s)", (replyAsAnswer) => {
    const body = outcomeBody({ ...run, finalText: "The answer is ready." }, "repo", [], [], {
      packageRefusals: refusals("wardby_graph_limit"),
      replyAsAnswer,
    });
    expect(body).toMatch(/^✅/);
    expect(body).toContain(replyAsAnswer ? "✅ The answer is ready." : "> The answer is ready.");
    expect(body).toContain("⚠️ **Dependency install incomplete.**");
    expect(body).not.toContain("no changes were made");
  });
  it.each(["failed", "budget_exhausted", "cancelled", "lost", "refused"] as const)(
    "preserves %s wording with refusals",
    (status) => {
      const body = outcomeBody({ ...run, status }, "repo", [], [], {
        packageRefusals: refusals("wardby_graph_limit"),
        budgetSentence: "Out of budget: this run's $2.00 budget was used up.",
      });
      const expected =
        status === "lost"
          ? "Interrupted before it finished"
          : status === "budget_exhausted" || status === "refused"
            ? "Out of budget: this run's $2.00 budget was used up."
            : "Stopped: the run ended with status `" + status + "`.";
      expect(body).toContain(expected);
      expect(body).not.toContain("no changes were made");
    },
  );
  it.each(["github", "jira"] as const)("completes %s status with collected refusals", async (provider) => {
    const update = vi.fn(async () => ({ count: 1 }));
    const editComment = vi.fn(async () => undefined);
    // A follow-up comment would carry the agent's long reply; a blocked status never posts one.
    const comment = vi.fn(async () => ({ id: "follow-up" }));
    const longReply = { ...run, finalText: "x".repeat(5000) };
    const status = { provider, repository: "repo", issueKey: "PROJ-1", commentId: "comment", completedAt: null };
    const db = {
      runHostStatus: { findUnique: async () => status, updateMany: update },
      runIssueStatus: { findUnique: async () => status, updateMany: update },
      agentIssueProject: { findUnique: async () => ({ access: "write" }) },
      $queryRaw: async () => [],
      run: {
        findUnique: async () => ({ agentId: "a" }),
        findMany: async () => [{ id: "c", status: "succeeded", codingRun: { result: { outcome: "no_changes" } } }],
      },
      registryFetch: {
        findMany: vi.fn(async () => [
          { ...refusals("wardby_graph_limit")[0], outcome: "refused", version: null, sizeBytes: null },
        ]),
      },
    };
    if (provider === "github") {
      await completeHostStatus(db as never, longReply, { github: { editComment, comment } } as never);
      expect(editComment).toHaveBeenCalledWith(
        "repo",
        expect.objectContaining({
          body: expect.stringContaining("no changes were made"),
        }),
      );
    } else {
      await completeIssueStatus(db as never, longReply, { jira: { editComment, comment } } as never);
      expect(editComment).toHaveBeenCalledWith(
        "PROJ-1",
        "comment",
        expect.objectContaining({
          markdown: expect.stringContaining("no changes were made"),
        }),
      );
    }
    expect(comment).not.toHaveBeenCalled();
    expect(db.registryFetch.findMany).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { commentId: "comment", completedAt: expect.any(Date) },
      }),
    );
  });
  it.each(["failed", "budget_exhausted", "cancelled", "lost", "refused"])(
    "emits run_failed with the reason for %s despite refusals",
    async (status) => {
      const sink = vi.fn();
      setWorkflowEventSink(sink);
      try {
        const db = {
          agent: { findUnique: async () => ({ name: "lead" }) },
          runHostCheck: { findUnique: async () => null },
          run: { findMany: async () => [{ id: "c", status: "succeeded", codingRun: { result: null } }] },
          registryFetch: {
            findMany: async () => [
              { ...refusals("wardby_graph_limit")[0], outcome: "refused", version: null, sizeBytes: null },
            ],
          },
        };
        await emitRunFinishedEvents(db as never, {
          ...run,
          status,
          agentId: "a",
          parentRunId: null,
          error: "failure reason",
        });
        expect(sink).toHaveBeenCalledTimes(1);
        expect(sink).toHaveBeenCalledWith(
          expect.objectContaining({
            dedupeKey: "run_failed:r",
            payload: { kind: "run_failed", agentName: "lead", status, reason: "failure reason" },
          }),
        );
      } finally {
        setWorkflowEventSink(null);
      }
    },
  );
  it.each(["wardby_graph_limit", "wardby_package_not_allowed", "wardby_package_not_allowed_pending"])(
    "explains %s and how to unblock",
    (code) => {
      const body = outcomeBody(run, "repo", [], [], { packageRefusals: refusals(code), noChanges: true });
      expect(body).toMatch(/^⛔/);
      expect(body).toContain("not on this agent's allowlist");
      expect(body).toContain(code);
      expect(body).toContain("codingProfile.packageAllowlist");
      expect(body).toContain("`@wardby`");
    },
  );
  it.each(["wardby_graph_incomplete", "wardby_upstream_error", "wardby_audit_unavailable"])(
    "tells the user to retry after %s, a check that did not finish",
    (code) => {
      const body = outcomeBody(run, "repo", [], [], { packageRefusals: refusals(code), noChanges: true });
      expect(body).toMatch(/^⛔/);
      expect(body).toContain("could not finish checking it");
      expect(body).toContain(code);
      expect(body).not.toContain("not on this agent's allowlist");
    },
  );
  it("explains a lock file entry from git or a URL", () => {
    const body = outcomeBody(run, "repo", [], [], {
      packageRefusals: refusals("wardby_lockfile_entry_unsupported"),
      noChanges: true,
    });
    expect(body).toContain("from git or a URL");
    expect(body).toContain("depend on a registry version instead");
  });
  it("blocks only a succeeded run with no pull request, a no-changes or failed child, and refusals", () => {
    const outcome = { pullRequests: [], failedChildren: [], packageRefusals: refusals("wardby_graph_limit") };
    expect(isBlockedByRefusals(run, { ...outcome, noChanges: true })).toBe(true);
    expect(isBlockedByRefusals(run, { ...outcome, failedChildren: [{ id: "c", status: "failed" }] })).toBe(true);
    // An answer with refusals along the way: not blocked.
    expect(isBlockedByRefusals(run, outcome)).toBe(false);
    expect(isBlockedByRefusals(run, { ...outcome, noChanges: true, packageRefusals: [] })).toBe(false);
    expect(isBlockedByRefusals({ status: "failed" }, { ...outcome, noChanges: true })).toBe(false);
    expect(
      isBlockedByRefusals(run, {
        ...outcome,
        noChanges: true,
        pullRequests: [
          { outcome: "pull_request_opened", repository: "repo", pullRequestNumber: 1, codeProvider: "github" },
        ],
      }),
    ).toBe(false);
  });
  it("explains version filtering without trusting free text", () => {
    const body = outcomeBody(run, "repo", [], [], { packageRefusals: refusals("wardby_version_filtered") });
    expect(body).toContain("acceptedAdvisories");
    expect(body).toContain("minReleaseAgeDays");
    expect(body).toContain("Never bypass malware");
  });
  it("keeps the PR and warns about refused packages", () => {
    const body = outcomeBody(
      run,
      "repo",
      [{ outcome: "pull_request_opened", repository: "repo", pullRequestNumber: 1, codeProvider: "github" }],
      [],
      { packageRefusals: refusals("wardby_graph_limit") },
    );
    expect(body).toContain("Opened #1");
    expect(body).toContain("⚠️");
    expect(body).toContain("`pkg`");
  });
  it("sanitizes, deduplicates and caps refusals, never echoing free text", () => {
    const bad = { ecosystem: "npm", name: "`\n@everyone<@123>", reason: "secret free text" };
    const body = outcomeBody(run, "repo", [], [], {
      packageRefusals: [bad, bad, ...Array.from({ length: 12 }, (_, i) => ({ ...bad, name: `p${i}` }))],
    });
    expect(body).not.toContain("secret free text");
    expect(body).not.toContain("@everyone");
    expect(body).not.toContain("<@123>");
    expect(body).toContain("3 more");
  });
  it("loads all coding children with one query and falls back on read failure", async () => {
    const db = {
      run: { findMany: vi.fn(async () => [{ id: "c", status: "succeeded", codingRun: { result: null } }]) },
      registryFetch: {
        findMany: vi.fn(async () => [
          { ...refusals("wardby_graph_limit")[0], outcome: "refused", version: null, sizeBytes: null },
        ]),
      },
    };
    expect((await collectRunOutcome(db as never, run)).packageRefusals).toMatchObject(refusals("wardby_graph_limit"));
    expect(db.registryFetch.findMany).toHaveBeenCalledTimes(1);
    db.registryFetch.findMany.mockRejectedValueOnce(new Error("unavailable"));
    expect((await collectRunOutcome(db as never, run)).packageRefusals).toEqual([]);
  });
  it("keeps blocked Slack sections within Slack's text limit", () => {
    const rendered = renderEvent(
      {
        kind: "run_blocked",
        agentName: "lead",
        packageRefusals: Array.from({ length: 10 }, (_, i) => ({
          ecosystem: "npm",
          name: String(i) + "x".repeat(120),
          reason: "wardby_version_filtered",
        })),
      },
      null,
    );
    for (const block of rendered.blocks as { text: { text: string } }[]) {
      expect(block.text.text.length).toBeLessThanOrEqual(3000);
    }
  });
  it("renders the blocked wording as Slack mrkdwn", () => {
    const payload = {
      kind: "run_blocked" as const,
      agentName: "lead",
      packageRefusals: refusals("wardby_graph_limit"),
    };
    const { text } = renderEvent(payload, null);
    expect(text).toContain("⛔ *Blocked by the package registry: no changes were made.*");
    expect(text).not.toContain("**");
    expect(text).toContain(
      "<https://github.com/wardby/wardby/blob/main/help/coding-packages.md|Help: package allowlist>",
    );
    expect(text).not.toContain("](");
    expect(nextStatus(null, payload)).toBe("blocked ⛔");
  });
  it("escapes Slack control characters in refused names", () => {
    const { text } = renderEvent(
      { kind: "run_blocked", agentName: "lead", packageRefusals: [{ ecosystem: "npm", name: "a&b", reason: "x" }] },
      null,
    );
    expect(text).toContain("`a&amp;b`");
  });
  const slackDb = (result: unknown, failed = false) => ({
    agent: { findUnique: async () => ({ name: "lead" }) },
    runHostCheck: { findUnique: async () => null },
    run: {
      findMany: async () => [{ id: "c", status: failed ? "failed" : "succeeded", codingRun: { result } }],
    },
    registryFetch: {
      findMany: vi.fn(async () => [
        { ...refusals("wardby_graph_limit")[0], outcome: "refused", version: null, sizeBytes: null },
      ]),
    },
  });
  const finished = (status: string) => ({ ...run, status, agentId: "a", parentRunId: null, error: null });
  it.each([
    ["a no-changes child", { outcome: "no_changes" }, false],
    ["a failed child", null, true],
  ])("emits one deduplicated run_blocked event for a succeeded run with %s", async (_, result, failed) => {
    const sink = vi.fn();
    setWorkflowEventSink(sink);
    try {
      await emitRunFinishedEvents(slackDb(result, failed) as never, finished("succeeded"));
      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink).toHaveBeenCalledWith(
        expect.objectContaining({
          dedupeKey: "run_blocked:r",
          payload: expect.objectContaining({
            kind: "run_blocked",
            agentName: "lead",
            packageRefusals: [expect.objectContaining(refusals("wardby_graph_limit")[0])],
          }),
        }),
      );
    } finally {
      setWorkflowEventSink(null);
    }
  });
  it("neither blocks nor warns on a refusal the same package was served after a retry", async () => {
    const sink = vi.fn();
    setWorkflowEventSink(sink);
    try {
      const db = slackDb({ outcome: "no_changes" });
      db.registryFetch.findMany.mockResolvedValue([
        { ...refusals("wardby_upstream_error")[0], outcome: "refused", version: null, sizeBytes: null },
        { ecosystem: "npm", name: "pkg", reason: null, outcome: "served", version: "1.0.0", sizeBytes: 10 },
      ] as never);
      const outcome = await collectRunOutcome(db as never, run);
      expect(outcome.packageRefusals).toEqual([]);
      const body = outcomeBody(run, "repo", outcome.pullRequests, outcome.failedChildren, outcome);
      expect(body).not.toContain("⛔");
      expect(body).not.toContain("⚠️");
      await emitRunFinishedEvents(db as never, finished("succeeded"));
      expect(sink).not.toHaveBeenCalled();
    } finally {
      setWorkflowEventSink(null);
    }
  });
  it("counts a listing-only refusal only for a failed child, warns a no-changes run, and never a pull request", () => {
    const listing = [
      { ecosystem: "pypi", name: "looked-at", reason: "wardby_file_not_allowed", listingOnly: true as const },
    ];
    const failedChildren = [{ id: "c", status: "failed" }];
    const pr = {
      outcome: "pull_request_opened" as const,
      repository: "repo",
      pullRequestNumber: 1,
      codeProvider: "github",
    };
    // No changes and nothing of that name served: it may be why, so a ⚠️ line, but not ⛔.
    expect(
      isBlockedByRefusals(run, { pullRequests: [], failedChildren: [], packageRefusals: listing, noChanges: true }),
    ).toBe(false);
    const noChanges = outcomeBody(run, "repo", [], [], { packageRefusals: listing, noChanges: true });
    expect(noChanges).not.toContain("⛔");
    expect(noChanges).toContain("⚠️ **Dependency install incomplete.**");
    expect(noChanges).toContain("`looked-at`");
    // A failed child: it counts toward ⛔.
    expect(isBlockedByRefusals(run, { pullRequests: [], failedChildren, packageRefusals: listing })).toBe(true);
    const failed = outcomeBody(run, "repo", [], failedChildren, { packageRefusals: listing });
    expect(failed).toMatch(/^⛔/);
    expect(failed).toContain("`looked-at`");
    // Blocked by a real refusal on a no-changes run: the listing-only one is a ⚠️ line, not in the ⛔ list.
    const both = [...listing, ...refusals("wardby_graph_limit")];
    const blocked = outcomeBody(run, "repo", [], [], { packageRefusals: both, noChanges: true });
    expect(blocked).toMatch(/^⛔/);
    expect(blocked.slice(0, blocked.indexOf("⚠️"))).not.toContain("looked-at");
    expect(blocked.slice(blocked.indexOf("⚠️"))).toContain("`looked-at`");
    expect(blockingRefusals({ pullRequests: [], failedChildren: [], packageRefusals: both })).toEqual(
      refusals("wardby_graph_limit"),
    );
    // A pull request: no warning for it, but one for a real refusal.
    const opened = outcomeBody(run, "repo", [pr], [], { packageRefusals: listing });
    expect(opened).toContain("Opened #1");
    expect(opened).not.toContain("⚠️");
    const openedBoth = outcomeBody(run, "repo", [pr], [], { packageRefusals: both });
    expect(openedBoth).toContain("⚠️");
    expect(openedBoth).not.toContain("looked-at");
  });
  it("keeps ⛔ and run_blocked when a sibling sub-run was served the package another one was refused", async () => {
    const sink = vi.fn();
    setWorkflowEventSink(sink);
    try {
      const db = {
        agent: { findUnique: async () => ({ name: "lead" }) },
        runHostCheck: { findUnique: async () => null },
        run: {
          findMany: async () => [
            { id: "a", status: "failed", codingRun: { result: null } },
            { id: "b", status: "succeeded", codingRun: { result: { outcome: "no_changes" } } },
          ],
        },
        registryFetch: {
          findMany: vi.fn(async () => [
            {
              runId: "a",
              ecosystem: "npm",
              name: "foo",
              version: null,
              outcome: "refused",
              reason: "wardby_package_not_allowed",
              sizeBytes: null,
              filename: null,
            },
            {
              runId: "b",
              ecosystem: "npm",
              name: "foo",
              version: "1.0.0",
              outcome: "served",
              reason: null,
              sizeBytes: 10,
              filename: "1.0.0.tgz",
            },
          ]),
        },
      };
      const outcome = await collectRunOutcome(db as never, run);
      expect(outcome.packageRefusals.map((r) => r.name)).toEqual(["foo"]);
      expect(outcomeBody(run, "repo", outcome.pullRequests, outcome.failedChildren, outcome)).toMatch(/^⛔/);
      await emitRunFinishedEvents(db as never, finished("succeeded"));
      expect(sink).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ kind: "run_blocked" }) }),
      );
    } finally {
      setWorkflowEventSink(null);
    }
  });
  it("sends Slack run_blocked without a listing-only refusal that does not count", async () => {
    const sink = vi.fn();
    setWorkflowEventSink(sink);
    try {
      const db = slackDb({ outcome: "no_changes" });
      db.registryFetch.findMany.mockResolvedValue([
        { ...refusals("wardby_graph_limit")[0], outcome: "refused", version: null, sizeBytes: null, filename: null },
        {
          ecosystem: "pypi",
          name: "looked-at",
          reason: "wardby_file_not_allowed",
          outcome: "refused",
          version: null,
          sizeBytes: null,
          filename: LISTING_REFUSAL_FILENAME,
        },
      ] as never);
      await emitRunFinishedEvents(db as never, finished("succeeded"));
      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0]?.[0].payload.packageRefusals).toEqual([
        expect.objectContaining(refusals("wardby_graph_limit")[0]),
      ]);
      // Only the listing-only refusal on a no-changes run: nothing is sent.
      sink.mockClear();
      db.registryFetch.findMany.mockResolvedValue([
        {
          ecosystem: "pypi",
          name: "looked-at",
          reason: "wardby_file_not_allowed",
          outcome: "refused",
          version: null,
          sizeBytes: null,
          filename: LISTING_REFUSAL_FILENAME,
        },
      ] as never);
      await emitRunFinishedEvents(db as never, finished("succeeded"));
      expect(sink).not.toHaveBeenCalled();
    } finally {
      setWorkflowEventSink(null);
    }
  });
  it("does not emit run_blocked for a succeeded run that answered despite refusals", async () => {
    const sink = vi.fn();
    setWorkflowEventSink(sink);
    try {
      await emitRunFinishedEvents(slackDb(null) as never, finished("succeeded"));
      expect(sink).not.toHaveBeenCalled();
    } finally {
      setWorkflowEventSink(null);
    }
  });
  it("reads no refusals for a run that did not succeed, and reports only its failure", async () => {
    const sink = vi.fn();
    setWorkflowEventSink(sink);
    try {
      const db = slackDb({ outcome: "no_changes" });
      await emitRunFinishedEvents(db as never, finished("failed"));
      expect(db.registryFetch.findMany).not.toHaveBeenCalled();
      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ kind: "run_failed" }) }),
      );
    } finally {
      setWorkflowEventSink(null);
    }
  });
});
