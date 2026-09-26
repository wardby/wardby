import { describe, expect, it, vi } from "vitest";
import type { RunStatus } from "#prisma";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import { completeHostStatus, outcomeBody, postMentionStatus, workingBody } from "./host-status.js";

const REPO = "chfields/knock-knock-jokes";

function host(): CodeReviewHost & { comment: ReturnType<typeof vi.fn>; editComment: ReturnType<typeof vi.fn> } {
  return {
    provider: "github",
    repositoryPermission: vi.fn(),
    readPullRequest: vi.fn(),
    pullRequestHead: vi.fn(),
    readFile: vi.fn(),
    listFiles: vi.fn(),
    publishReview: vi.fn(),
    comment: vi.fn(async () => ({ url: "https://x/c", id: "501" })),
    editComment: vi.fn(async () => undefined),
    acknowledge: vi.fn(),
    startCheck: vi.fn(),
    completeCheck: vi.fn(),
  };
}

type StatusRow = {
  runId: string;
  provider: string;
  repository: string;
  number: number;
  commentKind: string;
  commentId: string;
  completedAt: Date | null;
};

function db(opts: { row?: StatusRow | null; children?: unknown[]; run?: { id: string; status: string } | null } = {}) {
  return {
    runHostStatus: {
      create: vi.fn(async () => undefined),
      findUnique: vi.fn(async () => opts.row ?? null),
      update: vi.fn(async () => undefined),
    },
    run: {
      findMany: vi.fn(async () => opts.children ?? []),
      findUnique: vi.fn(async () => opts.run ?? null),
    },
  };
}

const row = (over: Partial<StatusRow> = {}): StatusRow => ({
  runId: "r1",
  provider: "github",
  repository: REPO,
  number: 71,
  commentKind: "conversation",
  commentId: "501",
  completedAt: null,
  ...over,
});

const child = (result: unknown) => ({ codingRun: { result } });

describe("outcomeBody", () => {
  const run = (status: RunStatus, finalText: string | null = null) => ({ id: "r1", status, finalText });

  it("links the pull requests a coding sub-run opened or updated", () => {
    const body = outcomeBody(run("succeeded"), REPO, [
      { outcome: "pull_request_opened", repository: REPO, pullRequestNumber: 73 },
      { outcome: "pull_request_updated", repository: REPO, pullRequestNumber: 68 },
      { outcome: "pull_request_opened", repository: "other/repo", pullRequestNumber: 5 },
    ]);
    expect(body).toContain("✅ Opened #73");
    expect(body).toContain("Pushed changes to #68");
    expect(body).toContain("Opened other/repo#5");
    expect(body).toContain("`r1`");
  });

  it("shows the agent's reply, quoted and without live @-mentions, when no pull request came out", () => {
    const body = outcomeBody(run("succeeded", "Which file?\n@chfields please say"), REPO, []);
    expect(body).toMatch(/^✅ Finished without opening a pull request\./);
    expect(body).toContain("> Which file?\n> @​chfields please say");
  });

  it("truncates a long reply", () => {
    const body = outcomeBody(run("succeeded", "x".repeat(5000)), REPO, []);
    expect(body.length).toBeLessThan(2500);
    expect(body).toContain("…");
  });

  it("reports a run that did not succeed by its status, never its error text", () => {
    for (const status of ["failed", "lost", "budget_exhausted", "cancelled", "refused"] as const) {
      const body = outcomeBody(run(status, "secret-ish internal detail"), REPO, []);
      expect(body).toMatch(/^❌ /);
      expect(body).toContain(`\`${status}\``);
      expect(body).not.toContain("secret-ish");
    }
  });

  it("still links a pull request a failed run managed to open", () => {
    const body = outcomeBody(run("failed"), REPO, [
      { outcome: "pull_request_opened", repository: REPO, pullRequestNumber: 80 },
    ]);
    expect(body).toMatch(/^❌ /);
    expect(body).toContain("Opened #80");
  });
});

describe("postMentionStatus", () => {
  const event = { repository: REPO, number: 71 };

  it("posts the working comment and records it", async () => {
    const h = host();
    const d = db({ run: { id: "r1", status: "running" } });
    await postMentionStatus(d as never, h, event, "r1", undefined);
    expect(h.comment).toHaveBeenCalledWith(REPO, { number: 71, body: workingBody("r1") });
    expect(d.runHostStatus.create).toHaveBeenCalledWith({
      data: {
        runId: "r1",
        provider: "github",
        repository: REPO,
        number: 71,
        commentKind: "conversation",
        commentId: "501",
      },
    });
    expect(h.editComment).not.toHaveBeenCalled();
  });

  it("replies in the review thread for an inline mention", async () => {
    const h = host();
    const d = db({ run: { id: "r1", status: "running" } });
    await postMentionStatus(d as never, h, { ...event, replyToReviewCommentId: "88" }, "r1", undefined);
    expect(h.comment).toHaveBeenCalledWith(REPO, { number: 71, body: workingBody("r1"), replyToReviewCommentId: "88" });
    expect(d.runHostStatus.create).toHaveBeenCalledWith({ data: expect.objectContaining({ commentKind: "inline" }) });
  });

  it("completes the comment at once when the run already ended", async () => {
    const h = host();
    const d = db({ run: { id: "r1", status: "failed" }, row: row() });
    d.run.findUnique.mockResolvedValue({ id: "r1", status: "failed", finalText: null } as never);
    await postMentionStatus(d as never, h, event, "r1", { github: h });
    expect(h.editComment).toHaveBeenCalledWith(REPO, expect.objectContaining({ id: "501", kind: "conversation" }));
  });

  it("never throws when the host refuses", async () => {
    const h = host();
    h.comment.mockRejectedValue(new Error("boom"));
    const d = db();
    await expect(postMentionStatus(d as never, h, event, "r1", undefined)).resolves.toBeUndefined();
    expect(d.runHostStatus.create).not.toHaveBeenCalled();
  });
});

describe("completeHostStatus", () => {
  const finished = { id: "r1", status: "succeeded", finalText: "done" } as const;

  it("edits the comment with the outcome and marks it complete", async () => {
    const h = host();
    const d = db({
      row: row(),
      children: [child({ outcome: "pull_request_opened", repository: REPO, pullRequestNumber: 73 }), child(null)],
    });
    await completeHostStatus(d as never, finished, { github: h });
    expect(d.run.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { parentRunId: "r1" } }));
    expect(h.editComment).toHaveBeenCalledWith(REPO, {
      kind: "conversation",
      id: "501",
      body: expect.stringContaining("Opened #73"),
    });
    expect(d.runHostStatus.update).toHaveBeenCalledWith({
      where: { runId: "r1" },
      data: { completedAt: expect.any(Date) },
    });
  });

  it("does nothing for a run without a status comment, or one already completed", async () => {
    for (const r of [null, row({ completedAt: new Date() })]) {
      const h = host();
      const d = db({ row: r });
      await completeHostStatus(d as never, finished, { github: h });
      expect(h.editComment).not.toHaveBeenCalled();
      expect(d.runHostStatus.update).not.toHaveBeenCalled();
    }
  });

  it("ignores malformed coding results", async () => {
    const h = host();
    const d = db({
      row: row(),
      children: [child({ outcome: "pull_request_opened", pullRequestNumber: "73" }), child("junk")],
    });
    await completeHostStatus(d as never, finished, { github: h });
    expect(h.editComment.mock.calls[0][1].body).toMatch(/^✅ Finished without opening a pull request\./);
  });

  it("never throws when the edit fails, and leaves the row open for the reconciler", async () => {
    const h = host();
    h.editComment.mockRejectedValue(new Error("boom"));
    const d = db({ row: row() });
    await expect(completeHostStatus(d as never, finished, { github: h })).resolves.toBeUndefined();
    expect(d.runHostStatus.update).not.toHaveBeenCalled();
  });

  it("does nothing without hosts", async () => {
    const d = db({ row: row() });
    await completeHostStatus(d as never, finished, undefined);
    expect(d.runHostStatus.findUnique).not.toHaveBeenCalled();
  });
});
