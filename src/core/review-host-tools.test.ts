import { describe, expect, it, vi } from "vitest";
import { ReviewHostError, type CodeReviewHost } from "../providers/review-host/types.js";
import { handleReviewHostTool, resolveLink, type RepositoryLink, type ReviewToolContext } from "./review-host-tools.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const WRITE: RepositoryLink = {
  provider: "github",
  repository: "chfields/knock-knock-jokes",
  access: "write",
  checkName: "wardby review",
};
const READ: RepositoryLink = { provider: "github", repository: "chfields/other", access: "read", checkName: null };

function fakeHost(): CodeReviewHost {
  return {
    provider: "github",
    repositoryPermission: vi.fn(async () => ({ level: "write" as const, login: "octo" })),
    readPullRequest: vi.fn(async () => ({ number: 7 }) as never),
    pullRequestHead: vi.fn(),
    readFile: vi.fn(async () => ({ kind: "not_found" as const, path: "x" })),
    listFiles: vi.fn(),
    publishReview: vi.fn(async () => ({
      published: true as const,
      reviewUrl: null,
      summaryCommentUrl: "https://x/5",
      checkId: "11",
      checkConclusion: "success" as const,
      inlineCount: 0,
      outsideDiffCount: 0,
    })),
    comment: vi.fn(async () => ({ url: "https://x/c" })),
    acknowledge: vi.fn(),
    startCheck: vi.fn(),
    completeCheck: vi.fn(),
  };
}

function ctx(overrides: Partial<ReviewToolContext> = {}): ReviewToolContext {
  return {
    agentId: "agent1",
    links: [WRITE, READ],
    hosts: { github: fakeHost() },
    runCheck: null,
    markRunCheckCompleted: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("resolveLink", () => {
  it("accepts bare and host-qualified names, case-insensitively", () => {
    expect(resolveLink([WRITE], "ChFields/Knock-Knock-Jokes")).toBe(WRITE);
    expect(resolveLink([WRITE], "github.com/chfields/knock-knock-jokes")).toBe(WRITE);
    expect(resolveLink([WRITE], "chfields/nope")).toBeNull();
    expect(resolveLink([WRITE], "not a repo")).toBeNull();
  });
});

describe("handleReviewHostTool", () => {
  it("rejects an unlinked repository and a write tool on a read link", async () => {
    const c = ctx();
    expect(
      JSON.parse(await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: "x/y", prNumber: 1 }), c)),
    ).toMatchObject({
      error: "repository_not_linked",
    });
    expect(
      JSON.parse(
        await handleReviewHostTool(
          "repo_comment",
          JSON.stringify({ repository: "chfields/other", number: 1, body: "hi" }),
          c,
        ),
      ),
    ).toMatchObject({ error: "write_access_required" });
    expect(c.hosts.github!.comment).not.toHaveBeenCalled();
  });

  it("passes the agent marker to reads and applies the default patch budget", async () => {
    const c = ctx();
    await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), c);
    expect(c.hosts.github!.readPullRequest).toHaveBeenCalledWith(WRITE.repository, 7, {
      sinceSha: undefined,
      maxPatchChars: 60_000,
      agentMarker: "agent1",
    });
  });

  it("publishes with the run's check id, and records the check completed", async () => {
    const c = ctx({ runCheck: { provider: "github", repository: WRITE.repository, checkId: "11", headSha: SHA } });
    const result = JSON.parse(
      await handleReviewHostTool(
        "repo_publish_review",
        JSON.stringify({
          repository: WRITE.repository,
          prNumber: 7,
          headSha: SHA,
          verdict: "APPROVE",
          summary: "ok",
          body: "fine",
        }),
        c,
      ),
    );
    expect(result).toMatchObject({ published: true, checkId: "11" });
    expect(c.hosts.github!.publishReview).toHaveBeenCalledWith(WRITE.repository, {
      prNumber: 7,
      headSha: SHA,
      verdict: "APPROVE",
      summary: "ok",
      body: "fine",
      comments: [],
      agentMarker: "agent1",
      checkName: "wardby review",
      checkId: "11",
    });
    expect(c.markRunCheckCompleted).toHaveBeenCalledOnce();
  });

  it("publishes with neither a check name nor a check id when the link has no check name and the run no check", async () => {
    const UNCHECKED: RepositoryLink = { ...WRITE, checkName: null };
    const c = ctx({ links: [UNCHECKED] });
    await handleReviewHostTool(
      "repo_publish_review",
      JSON.stringify({
        repository: WRITE.repository,
        prNumber: 7,
        headSha: SHA,
        verdict: "COMMENT",
        summary: "s",
        body: "b",
      }),
      c,
    );
    const input = vi.mocked(c.hosts.github!.publishReview).mock.calls[0][1];
    expect(input.checkName).toBeUndefined();
    expect(input.checkId).toBeUndefined();
    expect(c.markRunCheckCompleted).not.toHaveBeenCalled();
  });

  it("does not hand another repository's run check to publish", async () => {
    const c = ctx({
      runCheck: { provider: "github", repository: "chfields/elsewhere", checkId: "11", headSha: SHA },
    });
    await handleReviewHostTool(
      "repo_publish_review",
      JSON.stringify({
        repository: WRITE.repository,
        prNumber: 7,
        headSha: SHA,
        verdict: "COMMENT",
        summary: "s",
        body: "b",
      }),
      c,
    );
    expect(vi.mocked(c.hosts.github!.publishReview).mock.calls[0][1].checkId).toBeUndefined();
    expect(c.markRunCheckCompleted).not.toHaveBeenCalled();
  });

  it("supersedes the run's check when the review is of a different head, then publishes without it", async () => {
    const OLD = "89abcdef0123456789abcdef0123456789abcdef";
    const c = ctx({ runCheck: { provider: "github", repository: WRITE.repository, checkId: "11", headSha: OLD } });
    const result = JSON.parse(
      await handleReviewHostTool(
        "repo_publish_review",
        JSON.stringify({
          repository: WRITE.repository,
          prNumber: 7,
          headSha: SHA,
          verdict: "APPROVE",
          summary: "ok",
          body: "fine",
        }),
        c,
      ),
    );
    expect(result).toMatchObject({ published: true });
    expect(c.hosts.github!.completeCheck).toHaveBeenCalledWith(WRITE.repository, {
      checkId: "11",
      conclusion: "neutral",
      title: "Superseded by a newer push",
      summary: "This run reviewed a newer commit; see that commit's check.",
    });
    expect(c.markRunCheckCompleted).toHaveBeenCalledOnce();
    const input = vi.mocked(c.hosts.github!.publishReview).mock.calls[0][1];
    expect(input.checkId).toBeUndefined();
    expect(input.checkName).toBe("wardby review");
    expect(vi.mocked(c.hosts.github!.completeCheck).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(c.hosts.github!.publishReview).mock.invocationCallOrder[0],
    );
  });

  it("returns the published result even when recording the check completed fails", async () => {
    const c = ctx({
      runCheck: { provider: "github", repository: WRITE.repository, checkId: "11", headSha: SHA },
      markRunCheckCompleted: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const result = JSON.parse(
      await handleReviewHostTool(
        "repo_publish_review",
        JSON.stringify({
          repository: WRITE.repository,
          prNumber: 7,
          headSha: SHA,
          verdict: "APPROVE",
          summary: "ok",
          body: "fine",
        }),
        c,
      ),
    );
    expect(result).toMatchObject({ published: true, checkId: "11" });
    expect(c.markRunCheckCompleted).toHaveBeenCalledOnce();
  });

  it("enforces limits and returns host errors as JSON, never throwing", async () => {
    const c = ctx();
    const tooMany = Array.from({ length: 51 }, () => ({ path: "a", line: 1, severity: "MINOR", body: "x" }));
    expect(
      JSON.parse(
        await handleReviewHostTool(
          "repo_publish_review",
          JSON.stringify({
            repository: WRITE.repository,
            prNumber: 7,
            headSha: SHA,
            verdict: "COMMENT",
            summary: "s",
            body: "b",
            comments: tooMany,
          }),
          c,
        ),
      ),
    ).toMatchObject({ error: "invalid_arguments" });

    vi.mocked(c.hosts.github!.readFile).mockRejectedValueOnce(new ReviewHostError("host_not_installed"));
    expect(
      JSON.parse(
        await handleReviewHostTool("repo_read_file", JSON.stringify({ repository: WRITE.repository, path: "a.py" }), c),
      ),
    ).toEqual({ error: "host_not_installed", message: "host_not_installed" });

    expect(JSON.parse(await handleReviewHostTool("repo_read_file", "{bad", c))).toMatchObject({
      error: "invalid_arguments_json",
    });
  });

  it("reports host_not_configured when the link's provider has no host", async () => {
    expect(
      JSON.parse(
        await handleReviewHostTool(
          "repo_list_files",
          JSON.stringify({ repository: WRITE.repository }),
          ctx({ hosts: {} }),
        ),
      ),
    ).toMatchObject({ error: "host_not_configured" });
  });
});
