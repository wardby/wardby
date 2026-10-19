import { beforeEach, describe, expect, it, vi } from "vitest";
import { PatchCursorError, ReviewHostError, type CiView, type CodeReviewHost } from "../providers/review-host/types.js";
import { ReviewReadLedger } from "./review-reads.js";
import { collectRelatedPullRequests } from "./related-pull-requests.js";
import { handleReviewHostTool, resolveLink, type RepositoryLink, type ReviewToolContext } from "./review-host-tools.js";

vi.mock("./related-pull-requests.js", async (orig) => ({
  ...(await orig<typeof import("./related-pull-requests.js")>()),
  collectRelatedPullRequests: vi.fn(async () => ({ pullRequests: [] })),
}));

const SHA = "0123456789abcdef0123456789abcdef01234567";
const WRITE: RepositoryLink = {
  provider: "github",
  repository: "chfields/knock-knock-jokes",
  access: "write",
  checkName: "wardby review",
  waitForCi: false,
};
const READ: RepositoryLink = {
  provider: "github",
  repository: "chfields/other",
  access: "read",
  checkName: null,
  waitForCi: false,
};

function fakeHost(): CodeReviewHost {
  return {
    provider: "github",
    repositoryPermission: vi.fn(async () => ({ level: "write" as const, login: "octo" })),
    readPullRequest: vi.fn(async () => ({ number: 7 }) as never),
    pullRequestHead: vi.fn(),
    readFile: vi.fn(async () => ({ kind: "not_found" as const, path: "x" })),
    listFiles: vi.fn(),
    readIssue: vi.fn(async () => ({ kind: "not_found" as const, number: 1 })),
    publishReview: vi.fn(async () => ({
      published: true as const,
      reviewUrl: null,
      summaryCommentUrl: "https://x/5",
      checkId: "11",
      checkConclusion: "success" as const,
      inlineCount: 0,
      outsideDiffCount: 0,
      resolvedThreadIds: [],
      skippedThreadIds: [],
    })),
    comment: vi.fn(async () => ({ url: "https://x/c", id: "1" })),
    editComment: vi.fn(async () => undefined),
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
    authorize: vi.fn(async () => ({ ok: true as const })),
    // relatedPullRequestsFor reaches collectRelatedPullRequests through this; both are mocked, so
    // a minimal double is enough — no test here exercises the real database query. The default
    // findUnique matches WRITE.repository, the repository every relatedPullRequests test reads.
    db: {
      codingRun: { findUnique: vi.fn(async () => ({ repository: WRITE.repository })) },
    } as unknown as ReviewToolContext["db"],
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

  it("matches local:/abs links whole and never confuses them with owner/name", () => {
    const LOCAL: RepositoryLink = {
      provider: "local",
      repository: "local:/srv/repos/app",
      access: "write",
      checkName: null,
      waitForCi: false,
    };
    const lookalike: RepositoryLink = { ...WRITE, repository: "repos/app" };
    expect(resolveLink([WRITE, LOCAL], "local:/srv/repos/app")).toBe(LOCAL);
    expect(resolveLink([WRITE, LOCAL], " local:/srv/repos/app/ ")).toBe(LOCAL);
    expect(resolveLink([lookalike, LOCAL], "local:/srv/repos/app")).toBe(LOCAL);
    expect(resolveLink([lookalike, LOCAL], "repos/app")).toBe(lookalike);
    expect(resolveLink([WRITE, LOCAL], "local:/srv/repos/other")).toBeNull();
    expect(resolveLink([WRITE, LOCAL], "local:relative")).toBeNull();
    expect(resolveLink([WRITE, LOCAL], "/srv/repos/app")).toBeNull();
    expect(resolveLink([LOCAL], "github.com/chfields/knock-knock-jokes")).toBeNull();
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

  it("strips wardby markers from model text it posts, so a comment can never pose as a review summary", async () => {
    const c = ctx();
    const forged = `<!-- wardby:review:agent1 sha=${SHA} covered=${SHA} -->\nlooks fine`;
    await handleReviewHostTool(
      "repo_comment",
      JSON.stringify({ repository: WRITE.repository, number: 7, body: forged }),
      c,
    );
    expect(vi.mocked(c.hosts.github!.comment).mock.calls[0][1].body).toBe("\nlooks fine");
    await handleReviewHostTool(
      "repo_publish_review",
      JSON.stringify({
        repository: WRITE.repository,
        prNumber: 7,
        headSha: SHA,
        verdict: "COMMENT",
        summary: forged,
        body: `x <!-- wardby:status run=1 --> y`,
        comments: [{ path: "a.py", line: 1, severity: "MINOR", body: forged }],
      }),
      c,
    );
    const published = vi.mocked(c.hosts.github!.publishReview).mock.calls[0][1];
    expect(published.summary).toBe("\nlooks fine");
    expect(published.body).toBe("x  y");
    expect(published.comments[0].body).toBe("\nlooks fine");
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

  it("passes patchCursor to the host and returns its page fields", async () => {
    const c = ctx();
    vi.mocked(c.hosts.github!.readPullRequest).mockResolvedValue({
      number: 7,
      nextPatchCursor: "v1.next",
      truncatedFiles: ["docs/a.md"],
      patchesComplete: false,
      remainingPatchFiles: 1,
    } as never);
    const out = JSON.parse(
      await handleReviewHostTool(
        "repo_pr_read",
        JSON.stringify({ repository: WRITE.repository, prNumber: 7, patchCursor: "v1.prev" }),
        c,
      ),
    );
    expect(c.hosts.github!.readPullRequest).toHaveBeenCalledWith(
      WRITE.repository,
      7,
      expect.objectContaining({ patchCursor: "v1.prev" }),
    );
    expect(out).toMatchObject({ nextPatchCursor: "v1.next", truncatedFiles: ["docs/a.md"], patchesComplete: false });
  });

  it.each(["stale", "malformed"] as const)("turns a %s cursor into a patch_cursor_%s tool error", async (reason) => {
    const c = ctx();
    vi.mocked(c.hosts.github!.readPullRequest).mockRejectedValue(new PatchCursorError(reason));
    const out = JSON.parse(
      await handleReviewHostTool(
        "repo_pr_read",
        JSON.stringify({ repository: WRITE.repository, prNumber: 7, patchCursor: "v1.x" }),
        c,
      ),
    );
    expect(out).toMatchObject({ error: `patch_cursor_${reason}` });
    if (reason === "stale") expect(JSON.stringify(out)).toContain("without patchCursor");
  });

  it("adds the CI view with its note to repo_pr_read output", async () => {
    const c = ctx();
    vi.mocked(c.hosts.github!.readPullRequest).mockResolvedValue({
      number: 7,
      headSha: SHA,
      body: "<!-- wardby:r -->",
      ci: { headSha: SHA, state: "none", checks: [], truncated: false, statusesUnavailable: false },
    } as never);
    const out = JSON.parse(
      await handleReviewHostTool(
        "repo_pr_read",
        JSON.stringify({ repository: "chfields/knock-knock-jokes", prNumber: 7 }),
        c,
      ),
    );
    expect(out.ci).toMatchObject({ state: "none", sandboxInstallIncomplete: false });
    expect(out.ci.note).toMatch(/^No CI checks/);
  });

  describe("repo_pr_read relatedPullRequests", () => {
    beforeEach(() => {
      vi.mocked(collectRelatedPullRequests).mockClear();
    });

    it("computes it fresh from the marker run, including a sibling opened after the PR body was written", async () => {
      const h = fakeHost();
      h.pullRequestOrigin = vi.fn(async () => ({
        headSha: SHA,
        isFork: false,
        state: "open",
        labels: [],
        markerRunId: "run_lead",
      }));
      h.readPullRequest = vi.fn(async () => ({ number: 7, state: "open", merged: false, draft: false }) as never);
      const c = ctx({ hosts: { github: h } });
      vi.mocked(collectRelatedPullRequests).mockResolvedValueOnce({
        pullRequests: [
          {
            repository: WRITE.repository,
            number: 7,
            openedAt: new Date(),
            openedByRunId: "run_a",
            state: "open",
            mergeOrder: 1,
          },
          // Opened after the PR body was last written: only a fresh, call-time lookup sees it.
          {
            repository: "chfields/other-repo",
            number: 9,
            openedAt: new Date(),
            openedByRunId: "run_b",
            state: "open",
            mergeOrder: 2,
          },
        ],
      });
      const out = JSON.parse(
        await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), c),
      );
      expect(out.relatedPullRequests).toEqual([
        { repository: WRITE.repository, number: 7, state: "open", mergeOrder: 1, self: true },
        { repository: "chfields/other-repo", number: 9, state: "open", mergeOrder: 2, self: false },
      ]);
      expect(collectRelatedPullRequests).toHaveBeenCalledWith(c.db, "run_lead");
    });

    it("returns none for a human pull request (no recognized marker)", async () => {
      const h = fakeHost();
      h.pullRequestOrigin = vi.fn(async () => ({ headSha: SHA, isFork: false, state: "open", labels: [] }));
      const c = ctx({ hosts: { github: h } });
      const out = JSON.parse(
        await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), c),
      );
      expect(out.relatedPullRequests).toEqual([]);
      expect(collectRelatedPullRequests).not.toHaveBeenCalled();
    });

    it("returns none when the host can't say (no pullRequestOrigin, e.g. a local repository)", async () => {
      const c = ctx(); // fakeHost() has no pullRequestOrigin
      const out = JSON.parse(
        await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), c),
      );
      expect(out.relatedPullRequests).toEqual([]);
    });

    it("fails open to relatedPullRequests: [] when the lookup errors, and still returns the pull request", async () => {
      const h = fakeHost();
      h.pullRequestOrigin = vi.fn(async () => ({
        headSha: SHA,
        isFork: false,
        state: "open",
        labels: [],
        markerRunId: "run_lead",
      }));
      vi.mocked(collectRelatedPullRequests).mockRejectedValueOnce(new Error("db down"));
      const c = ctx({ hosts: { github: h } });
      const out = JSON.parse(
        await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), c),
      );
      expect(out.relatedPullRequests).toEqual([]);
      expect(out.number).toBe(7);
    });

    it("never follows a marker whose CodingRun opened in a different repository", async () => {
      const h = fakeHost();
      h.pullRequestOrigin = vi.fn(async () => ({
        headSha: SHA,
        isFork: false,
        state: "open",
        labels: [],
        markerRunId: "run_elsewhere",
      }));
      const findUnique = vi.fn(async () => ({ repository: "chfields/other-repo" }));
      const c = ctx({
        hosts: { github: h },
        db: { codingRun: { findUnique } } as unknown as ReviewToolContext["db"],
      });
      const out = JSON.parse(
        await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), c),
      );
      expect(out.relatedPullRequests).toEqual([]);
      expect(findUnique).toHaveBeenCalledWith({ where: { runId: "run_elsewhere" }, select: { repository: true } });
      expect(collectRelatedPullRequests).not.toHaveBeenCalled();
    });

    it.each([
      { view: { state: "closed", merged: true, draft: false }, expected: "merged" },
      { view: { state: "closed", merged: false, draft: false }, expected: "closed" },
      { view: { state: "closed", merged: false, draft: true }, expected: "closed" },
      { view: { state: "open", merged: false, draft: true }, expected: "draft" },
      { view: { state: "open", merged: false, draft: false }, expected: "open" },
    ])(
      "derives the self entry's state ($expected) from the pull request just read, not the stored state",
      async ({ view, expected }) => {
        const h = fakeHost();
        h.pullRequestOrigin = vi.fn(async () => ({
          headSha: SHA,
          isFork: false,
          state: "open",
          labels: [],
          markerRunId: "run_lead",
        }));
        h.readPullRequest = vi.fn(async () => ({ number: 7, ...view }) as never);
        const c = ctx({ hosts: { github: h } });
        vi.mocked(collectRelatedPullRequests).mockResolvedValueOnce({
          pullRequests: [
            // A stored state that disagrees with the live view: the view wins for self.
            { repository: WRITE.repository, number: 7, openedAt: new Date(), openedByRunId: "run_a", state: "open" },
            {
              repository: "chfields/other-repo",
              number: 9,
              openedAt: new Date(),
              openedByRunId: "run_b",
              state: "merged",
            },
          ],
        });
        const out = JSON.parse(
          await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), c),
        );
        expect(out.relatedPullRequests).toEqual([
          { repository: WRITE.repository, number: 7, state: expected, self: true },
          { repository: "chfields/other-repo", number: 9, state: "merged", self: false },
        ]);
      },
    );

    it("gives the self entry a state even with none stored, and omits it on a sibling with none stored", async () => {
      const h = fakeHost();
      h.pullRequestOrigin = vi.fn(async () => ({
        headSha: SHA,
        isFork: false,
        state: "open",
        labels: [],
        markerRunId: "run_lead",
      }));
      h.readPullRequest = vi.fn(async () => ({ number: 7, state: "open", merged: false, draft: false }) as never);
      const c = ctx({ hosts: { github: h } });
      vi.mocked(collectRelatedPullRequests).mockResolvedValueOnce({
        pullRequests: [
          { repository: WRITE.repository, number: 7, openedAt: new Date(), openedByRunId: "run_a" },
          { repository: "chfields/other-repo", number: 9, openedAt: new Date(), openedByRunId: "run_b" },
        ],
      });
      const out = JSON.parse(
        await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), c),
      );
      expect(out.relatedPullRequests).toEqual([
        { repository: WRITE.repository, number: 7, state: "open", self: true },
        { repository: "chfields/other-repo", number: 9, self: false },
      ]);
      expect(h.readPullRequest).toHaveBeenCalledTimes(1);
    });
  });

  it("publishes with the run's check id, and records the check completed", async () => {
    const c = ctx({
      runCheck: { provider: "github", repository: WRITE.repository, checkId: "11", headSha: SHA, prNumber: 7 },
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
      // No ledger: nothing shows the review read every file.
      coveredSha: null,
    });
    expect(c.markRunCheckCompleted).toHaveBeenCalledOnce();
  });

  it("records the verdict and review text when it completes the run's own check", async () => {
    const c = ctx({
      runCheck: { provider: "github", repository: WRITE.repository, checkId: "11", headSha: SHA, prNumber: 7 },
    });
    await handleReviewHostTool(
      "repo_publish_review",
      JSON.stringify({
        repository: WRITE.repository,
        prNumber: 7,
        headSha: SHA,
        verdict: "CHANGES_REQUESTED",
        summary: "needs work",
        body: "## Findings\n- [MAJOR] x",
      }),
      c,
    );
    expect(c.markRunCheckCompleted).toHaveBeenCalledWith({
      verdict: "CHANGES_REQUESTED",
      body: "needs work\n\n## Findings\n- [MAJOR] x",
    });
  });

  it("records whether CI was unfinished when it publishes a COMMENT on its own check", async () => {
    for (const [state, pending] of [
      ["pending", true],
      ["none", true],
      ["passing", false],
    ] as const) {
      const h = fakeHost();
      h.readCi = vi.fn(async () => ({ headSha: SHA, state, checks: [], truncated: false, statusesUnavailable: false }));
      const c = ctx({
        hosts: { github: h },
        runCheck: { provider: "github", repository: WRITE.repository, checkId: "11", headSha: SHA, prNumber: 7 },
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
      expect(c.markRunCheckCompleted).toHaveBeenCalledWith({ verdict: "COMMENT", body: "s\n\nb", ciPending: pending });
      expect(h.readCi).toHaveBeenCalledWith(WRITE.repository, SHA);
      // #210's ordering: on a link without waitForCi, CI is read only after
      // the review is published, never before (restores main's behaviour).
      expect(vi.mocked(h.publishReview).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(h.readCi).mock.invocationCallOrder[0],
      );
    }
  });

  it("passes resolveThreadIds through, and rejects malformed ids", async () => {
    const c = ctx();
    const args = {
      repository: WRITE.repository,
      prNumber: 7,
      headSha: SHA,
      verdict: "APPROVE",
      summary: "ok",
      body: "fine",
    };
    await handleReviewHostTool(
      "repo_publish_review",
      JSON.stringify({ ...args, resolveThreadIds: ["PRRT_kwDOabc", "PRRT_x-y="] }),
      c,
    );
    expect(vi.mocked(c.hosts.github!.publishReview).mock.calls[0][1].resolveThreadIds).toEqual([
      "PRRT_kwDOabc",
      "PRRT_x-y=",
    ]);
    await handleReviewHostTool("repo_publish_review", JSON.stringify({ ...args, resolveThreadIds: [] }), c);
    expect(vi.mocked(c.hosts.github!.publishReview).mock.calls[1][1]).not.toHaveProperty("resolveThreadIds");
    const bad = JSON.parse(
      await handleReviewHostTool("repo_publish_review", JSON.stringify({ ...args, resolveThreadIds: ["../../x"] }), c),
    );
    expect(bad).toMatchObject({ error: "invalid_arguments" });
    expect(c.hosts.github!.publishReview).toHaveBeenCalledTimes(2);
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
      runCheck: { provider: "github", repository: "chfields/elsewhere", checkId: "11", headSha: SHA, prNumber: 7 },
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
    const c = ctx({
      runCheck: { provider: "github", repository: WRITE.repository, checkId: "11", headSha: OLD, prNumber: 7 },
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
      runCheck: { provider: "github", repository: WRITE.repository, checkId: "11", headSha: SHA, prNumber: 7 },
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

describe("handleReviewHostTool waitForCi publish gate", () => {
  const WAIT: RepositoryLink = { ...WRITE, waitForCi: true };
  const runCheck = {
    provider: "github" as const,
    repository: WAIT.repository,
    checkId: "11",
    headSha: SHA,
    prNumber: 7,
  };
  const publish = (verdict: "APPROVE" | "CHANGES_REQUESTED" | "COMMENT") =>
    JSON.stringify({
      repository: WAIT.repository,
      prNumber: 7,
      headSha: SHA,
      verdict,
      summary: "s",
      body: "b",
    });
  const ciView = (state: CiView["state"], checks: CiView["checks"] = []): CiView => ({
    headSha: SHA,
    state,
    checks,
    truncated: false,
    statusesUnavailable: false,
  });

  it("refuses an APPROVE when CI is failing, naming the failing checks, without publishing or completing", async () => {
    const h = fakeHost();
    h.readCi = vi.fn(async () =>
      ciView("failing", [
        { name: "build", kind: "check_run", status: "completed", conclusion: "failure", app: "github-actions" },
        { name: "lint", kind: "check_run", status: "completed", conclusion: "success", app: "github-actions" },
      ]),
    );
    const c = ctx({ links: [WAIT], hosts: { github: h }, runCheck });
    const result = JSON.parse(await handleReviewHostTool("repo_publish_review", publish("APPROVE"), c));
    expect(result).toMatchObject({ error: "ci_failing" });
    expect(result.message).toContain("build");
    expect(result.message).not.toContain("lint");
    expect(h.publishReview).not.toHaveBeenCalled();
    expect(c.markRunCheckCompleted).not.toHaveBeenCalled();
  });

  it("caps the failing checks named in the ci_failing message at 5", async () => {
    const h = fakeHost();
    const failing = Array.from({ length: 7 }, (_, i) => ({
      name: `check-${i}`,
      kind: "check_run" as const,
      status: "completed" as const,
      conclusion: "failure",
      app: "github-actions",
    }));
    h.readCi = vi.fn(async () => ciView("failing", failing));
    const c = ctx({ links: [WAIT], hosts: { github: h }, runCheck });
    const result = JSON.parse(await handleReviewHostTool("repo_publish_review", publish("APPROVE"), c));
    expect(result.error).toBe("ci_failing");
    for (let i = 0; i < 5; i++) expect(result.message).toContain(`check-${i}`);
    expect(result.message).not.toContain("check-5");
    expect(result.message).not.toContain("check-6");
  });

  it("refuses an APPROVE when CI is still pending, without publishing or completing", async () => {
    const h = fakeHost();
    h.readCi = vi.fn(async () => ciView("pending"));
    const c = ctx({ links: [WAIT], hosts: { github: h }, runCheck });
    const result = JSON.parse(await handleReviewHostTool("repo_publish_review", publish("APPROVE"), c));
    expect(result).toMatchObject({ error: "ci_pending" });
    expect(h.publishReview).not.toHaveBeenCalled();
    expect(c.markRunCheckCompleted).not.toHaveBeenCalled();
  });

  it("publishes an APPROVE when CI is passing", async () => {
    const h = fakeHost();
    h.readCi = vi.fn(async () =>
      ciView("passing", [{ name: "build", kind: "check_run", status: "completed", conclusion: "success", app: null }]),
    );
    const c = ctx({ links: [WAIT], hosts: { github: h }, runCheck });
    const result = JSON.parse(await handleReviewHostTool("repo_publish_review", publish("APPROVE"), c));
    expect(result).toMatchObject({ published: true });
    expect(h.publishReview).toHaveBeenCalledOnce();
    expect(c.markRunCheckCompleted).toHaveBeenCalledWith({ verdict: "APPROVE", body: "s\n\nb" });
  });

  it.each(["none", "inconclusive", "unavailable"] as const)(
    "publishes an APPROVE when CI state is %s (not a clear pass, but not failing or pending)",
    async (state) => {
      const h = fakeHost();
      h.readCi = vi.fn(async () => ciView(state));
      const c = ctx({ links: [WAIT], hosts: { github: h }, runCheck });
      const result = JSON.parse(await handleReviewHostTool("repo_publish_review", publish("APPROVE"), c));
      expect(result).toMatchObject({ published: true });
      expect(h.publishReview).toHaveBeenCalledOnce();
      expect(c.markRunCheckCompleted).toHaveBeenCalledWith({ verdict: "APPROVE", body: "s\n\nb" });
    },
  );

  it("does not gate COMMENT or CHANGES_REQUESTED verdicts, even with CI failing", async () => {
    for (const verdict of ["COMMENT", "CHANGES_REQUESTED"] as const) {
      const h = fakeHost();
      h.readCi = vi.fn(async () =>
        ciView("failing", [
          { name: "build", kind: "check_run", status: "completed", conclusion: "failure", app: null },
        ]),
      );
      const c = ctx({ links: [WAIT], hosts: { github: h }, runCheck });
      const result = JSON.parse(await handleReviewHostTool("repo_publish_review", publish(verdict), c));
      expect(result).toMatchObject({ published: true });
      expect(h.publishReview).toHaveBeenCalledOnce();
      expect(c.markRunCheckCompleted).toHaveBeenCalledOnce();
    }
  });

  it("does not gate an APPROVE on a link without waitForCi, even when CI is failing", async () => {
    const h = fakeHost();
    h.readCi = vi.fn(async () =>
      ciView("failing", [{ name: "build", kind: "check_run", status: "completed", conclusion: "failure", app: null }]),
    );
    const c = ctx({ links: [WRITE], hosts: { github: h }, runCheck });
    const result = JSON.parse(await handleReviewHostTool("repo_publish_review", publish("APPROVE"), c));
    expect(result).toMatchObject({ published: true });
    expect(h.publishReview).toHaveBeenCalledOnce();
    expect(h.readCi).not.toHaveBeenCalled();
    expect(c.markRunCheckCompleted).toHaveBeenCalledOnce();
  });

  it("publishes the APPROVE when readCi throws, treating it as no gate", async () => {
    const h = fakeHost();
    h.readCi = vi.fn(async () => {
      throw new Error("transient");
    });
    const c = ctx({ links: [WAIT], hosts: { github: h }, runCheck });
    const result = JSON.parse(await handleReviewHostTool("repo_publish_review", publish("APPROVE"), c));
    expect(result).toMatchObject({ published: true });
    expect(h.publishReview).toHaveBeenCalledOnce();
    expect(c.markRunCheckCompleted).toHaveBeenCalledWith({ verdict: "APPROVE", body: "s\n\nb" });
  });
});

describe("handleReviewHostTool check binding (E-08/H5-4)", () => {
  const publish = (prNumber: number) =>
    JSON.stringify({
      repository: WRITE.repository,
      prNumber,
      headSha: SHA,
      verdict: "APPROVE",
      summary: "ok",
      body: "fine",
    });

  it("never creates a check for a run with no check of its own, even on a linked check name", async () => {
    const c = ctx();
    await handleReviewHostTool("repo_publish_review", publish(7), c);
    const input = vi.mocked(c.hosts.github!.publishReview).mock.calls[0][1];
    expect(input.checkName).toBeUndefined();
    expect(input.checkId).toBeUndefined();
  });

  it("publishes comments only, touching no check, on a PR the run was not dispatched for", async () => {
    const c = ctx({
      runCheck: { provider: "github", repository: WRITE.repository, checkId: "11", headSha: SHA, prNumber: 7 },
    });
    const result = JSON.parse(await handleReviewHostTool("repo_publish_review", publish(8), c));
    expect(result).toMatchObject({ published: true });
    const input = vi.mocked(c.hosts.github!.publishReview).mock.calls[0][1];
    expect(input.prNumber).toBe(8);
    expect(input.checkName).toBeUndefined();
    expect(input.checkId).toBeUndefined();
    expect(c.hosts.github!.completeCheck).not.toHaveBeenCalled();
    expect(c.markRunCheckCompleted).not.toHaveBeenCalled();
  });

  it("treats a legacy run check with no recorded PR as not bound to any PR", async () => {
    const c = ctx({
      runCheck: { provider: "github", repository: WRITE.repository, checkId: "11", headSha: SHA, prNumber: null },
    });
    await handleReviewHostTool("repo_publish_review", publish(7), c);
    const input = vi.mocked(c.hosts.github!.publishReview).mock.calls[0][1];
    expect(input.checkName).toBeUndefined();
    expect(input.checkId).toBeUndefined();
  });
});

describe("handleReviewHostTool repository authorization (H5-1)", () => {
  it("re-authorizes the link before every host call and refuses without touching the host", async () => {
    const authorize = vi.fn(async () => ({ ok: false as const, reason: "identity_not_linked" as const }));
    const c = ctx({ authorize });
    const calls: Array<[string, Record<string, unknown>]> = [
      ["repo_pr_read", { repository: WRITE.repository, prNumber: 7 }],
      ["repo_read_file", { repository: WRITE.repository, path: "a.py" }],
      ["repo_list_files", { repository: WRITE.repository }],
      ["repo_issue_read", { repository: WRITE.repository, number: 3 }],
      ["repo_comment", { repository: WRITE.repository, number: 7, body: "hi" }],
      [
        "repo_publish_review",
        { repository: WRITE.repository, prNumber: 7, headSha: SHA, verdict: "COMMENT", summary: "s", body: "b" },
      ],
    ];
    for (const [name, args] of calls) {
      const result = JSON.parse(await handleReviewHostTool(name, JSON.stringify(args), c)) as {
        error: string;
        message: string;
      };
      expect(result.error, name).toBe("repository_access_denied");
      expect(result.message).toMatch(/link_host_account/);
    }
    expect(authorize).toHaveBeenCalledTimes(calls.length);
    expect(authorize).toHaveBeenCalledWith(WRITE);
    const host = c.hosts.github!;
    for (const fn of [
      host.readPullRequest,
      host.readFile,
      host.listFiles,
      host.readIssue,
      host.comment,
      host.publishReview,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("fails closed when the authorization itself throws", async () => {
    const c = ctx({
      authorize: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const result = JSON.parse(
      await handleReviewHostTool("repo_list_files", JSON.stringify({ repository: WRITE.repository }), c),
    ) as { error: string };
    expect(result.error).toBe("repository_access_denied");
    expect(c.hosts.github!.listFiles).not.toHaveBeenCalled();
  });
});

describe("repo_read_file output", () => {
  it("serializes the numbered content and omits the raw text field", async () => {
    const c = ctx();
    vi.mocked(c.hosts.github!.readFile).mockResolvedValueOnce({
      kind: "file",
      path: "a.py",
      ref: "main",
      totalLines: 2,
      startLine: 1,
      endLine: 2,
      truncated: false,
      content: "1: x\n2: y",
      text: "x\ny",
    });
    const out = await handleReviewHostTool(
      "repo_read_file",
      JSON.stringify({ repository: WRITE.repository, path: "a.py" }),
      c,
    );
    expect(out).toBe(
      '{"kind":"file","path":"a.py","ref":"main","totalLines":2,"startLine":1,"endLine":2,"truncated":false,"content":"1: x\\n2: y"}',
    );
  });
});

describe("handleReviewHostTool transient re-check failures (M-2)", () => {
  it("reports a distinct repository_access_unavailable error when GitHub can't be asked", async () => {
    const c = ctx({ authorize: vi.fn(async () => ({ ok: false as const, reason: "check_unavailable" as const })) });
    const result = JSON.parse(
      await handleReviewHostTool("repo_list_files", JSON.stringify({ repository: WRITE.repository }), c),
    ) as { error: string; message: string };
    expect(result.error).toBe("repository_access_unavailable");
    expect(result.message).toMatch(/could not be reached/);
    expect(c.hosts.github!.listFiles).not.toHaveBeenCalled();
  });
});

describe("repo_issue_read", () => {
  const ISSUE = {
    kind: "issue" as const,
    number: 3,
    title: "Add a joke",
    state: "open" as const,
    body: "- [ ] tests",
    bodyTruncated: false,
    labels: ["enhancement"],
    author: "octo",
    url: "https://github.com/chfields/knock-knock-jokes/issues/3",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    comments: [],
    totalComments: 0,
    truncated: false,
  };
  const read = (c: ReviewToolContext, repository: string, number = 3) =>
    handleReviewHostTool("repo_issue_read", JSON.stringify({ repository, number }), c);

  it("returns the issue without its kind on a linked repository, read links included", async () => {
    const c = ctx();
    vi.mocked(c.hosts.github!.readIssue!).mockResolvedValue(ISSUE);
    const { kind: _kind, ...shown } = ISSUE;
    expect(JSON.parse(await read(c, READ.repository))).toEqual(shown);
    expect(c.hosts.github!.readIssue).toHaveBeenCalledWith(READ.repository, 3);
    expect(c.authorize).toHaveBeenCalledWith(READ);
  });

  it("refuses an unlinked repository without touching the host", async () => {
    const c = ctx();
    expect(JSON.parse(await read(c, "someone/else"))).toMatchObject({ error: "repository_not_linked" });
    expect(c.hosts.github!.readIssue).not.toHaveBeenCalled();
  });

  it("refuses a pull request number and reports a missing issue", async () => {
    const c = ctx();
    vi.mocked(c.hosts.github!.readIssue!).mockResolvedValueOnce({ kind: "pull_request", number: 7 });
    expect(JSON.parse(await read(c, WRITE.repository, 7))).toMatchObject({
      error: "is_pull_request",
      message: expect.stringMatching(/repo_pr_read/),
    });
    vi.mocked(c.hosts.github!.readIssue!).mockResolvedValueOnce({ kind: "not_found", number: 99 });
    expect(JSON.parse(await read(c, WRITE.repository, 99))).toMatchObject({ error: "issue_not_found" });
  });

  it("refuses a host without issues (a local repository)", async () => {
    const LOCAL: RepositoryLink = {
      provider: "local",
      repository: "local:/srv/repos/app",
      access: "read",
      checkName: null,
      waitForCi: false,
    };
    const { readIssue: _readIssue, ...localHost } = fakeHost();
    const c = ctx({ links: [LOCAL], hosts: { local: { ...localHost, provider: "local" } } });
    expect(JSON.parse(await read(c, LOCAL.repository))).toMatchObject({ error: "issues_unavailable" });
  });

  it("rejects malformed arguments", async () => {
    const c = ctx();
    expect(
      JSON.parse(
        await handleReviewHostTool("repo_issue_read", JSON.stringify({ repository: WRITE.repository, number: 0 }), c),
      ),
    ).toMatchObject({ error: "invalid_arguments" });
  });
});

describe("handleReviewHostTool unread-files publish guard", () => {
  const codeFile = (filename: string, patchStatus: string) => ({
    filename,
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: "x",
    patchStatus,
    patchTruncated: patchStatus !== "complete",
  });
  const publishArgs = (verdict: string) => ({
    repository: WRITE.repository,
    prNumber: 7,
    headSha: SHA,
    verdict,
    summary: "s",
    body: "b",
  });
  const pageHost = () => {
    const h = fakeHost();
    h.readPullRequest = vi.fn(
      async () =>
        ({
          number: 7,
          headSha: SHA,
          files: [codeFile("src/a.ts", "later_page")],
          nextPatchCursor: "v1.c",
        }) as never,
    );
    return h;
  };

  it("refuses APPROVE while a code file of this head is unread, allows CHANGES_REQUESTED and COMMENT", async () => {
    const c = ctx({ hosts: { github: pageHost() }, reads: new ReviewReadLedger() });
    await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), c);
    const out = JSON.parse(
      await handleReviewHostTool("repo_publish_review", JSON.stringify(publishArgs("APPROVE")), c),
    );
    expect(out).toMatchObject({ error: "unread_files" });
    expect(JSON.stringify(out)).toContain("src/a.ts");
    expect(out.message).toContain("publish CHANGES_REQUESTED and name the files you did not review");
    expect(out.message).toContain("If the pull request has moved on, repo_pr_read returns the new headSha");
    // An unfinished review must be able to block the merge: COMMENT completes the check as neutral.
    for (const verdict of ["CHANGES_REQUESTED", "COMMENT"]) {
      const published = JSON.parse(
        await handleReviewHostTool("repo_publish_review", JSON.stringify(publishArgs(verdict)), c),
      );
      expect(published.error).toBeUndefined();
    }
  });

  it("refuses APPROVE with file_list_truncated when the host cut the file list, allows CHANGES_REQUESTED and COMMENT", async () => {
    const h = fakeHost();
    // Every listed file was delivered in full, so only the cut stands in the way.
    h.readPullRequest = vi.fn(
      async () =>
        ({
          number: 7,
          headSha: SHA,
          files: [codeFile("src/a.ts", "complete")],
          nextPatchCursor: null,
          fileListComplete: false,
        }) as never,
    );
    const c = ctx({ hosts: { github: h }, reads: new ReviewReadLedger() });
    const read = JSON.parse(
      await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), c),
    );
    expect(read.fileListComplete).toBe(false);
    const out = JSON.parse(
      await handleReviewHostTool("repo_publish_review", JSON.stringify(publishArgs("APPROVE")), c),
    );
    expect(out).toMatchObject({ error: "file_list_truncated" });
    expect(out.message).toContain("call repo_pr_read again without it");
    expect(out.message).toContain("publish CHANGES_REQUESTED (or COMMENT)");
    expect(h.publishReview).not.toHaveBeenCalled();
    for (const verdict of ["CHANGES_REQUESTED", "COMMENT"]) {
      const published = JSON.parse(
        await handleReviewHostTool("repo_publish_review", JSON.stringify(publishArgs(verdict)), c),
      );
      expect(published.error).toBeUndefined();
    }
  });

  it("refuses APPROVE with full_read_required after only a compare from a base the host never returned", async () => {
    const base = "b".repeat(40);
    let trusted: string | null = null;
    const h = fakeHost();
    h.readPullRequest = vi.fn(
      async () =>
        ({
          number: 7,
          headSha: SHA,
          files: [codeFile("src/a.ts", "complete")],
          nextPatchCursor: null,
          comparedFrom: base,
          lastReviewedSha: trusted,
          lastCoveredSha: trusted,
          fileListComplete: true,
        }) as never,
    );
    const c = ctx({ hosts: { github: h }, reads: new ReviewReadLedger() });
    const readSince = () =>
      handleReviewHostTool(
        "repo_pr_read",
        JSON.stringify({ repository: WRITE.repository, prNumber: 7, sinceSha: base }),
        c,
      );
    await readSince();
    const out = JSON.parse(
      await handleReviewHostTool("repo_publish_review", JSON.stringify(publishArgs("APPROVE")), c),
    );
    expect(out).toMatchObject({ error: "full_read_required" });
    expect(out.message).toContain("call repo_pr_read without sinceSha");
    expect(h.publishReview).not.toHaveBeenCalled();
    for (const verdict of ["CHANGES_REQUESTED", "COMMENT"]) {
      const published = JSON.parse(
        await handleReviewHostTool("repo_publish_review", JSON.stringify(publishArgs(verdict)), c),
      );
      expect(published.error).toBeUndefined();
    }
    // A fresh attempt whose compare base is the head the host returned may approve the delta.
    trusted = base;
    const fresh = ctx({ hosts: { github: h }, reads: new ReviewReadLedger() });
    await handleReviewHostTool(
      "repo_pr_read",
      JSON.stringify({ repository: WRITE.repository, prNumber: 7, sinceSha: base }),
      fresh,
    );
    const approved = JSON.parse(
      await handleReviewHostTool("repo_publish_review", JSON.stringify(publishArgs("APPROVE")), fresh),
    );
    expect(approved.error).toBeUndefined();
  });

  it("records the head as covered only when the review read every file, so a cut review cannot be approved by a later delta", async () => {
    const H1 = "b".repeat(40);
    // Run 1: the whole list is cut; the agent publishes CHANGES_REQUESTED as told.
    let view: Record<string, unknown> = {
      number: 7,
      headSha: SHA,
      files: [codeFile("src/a.ts", "complete")],
      nextPatchCursor: null,
      comparedFrom: null,
      lastReviewedSha: null,
      lastCoveredSha: null,
      fileListComplete: false,
    };
    const h = fakeHost();
    h.readPullRequest = vi.fn(async () => view as never);
    const run1 = ctx({ hosts: { github: h }, reads: new ReviewReadLedger() });
    await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), run1);
    await handleReviewHostTool("repo_publish_review", JSON.stringify(publishArgs("CHANGES_REQUESTED")), run1);
    expect(vi.mocked(h.publishReview).mock.calls.at(-1)![1]).toMatchObject({ coveredSha: null });

    // Run 2: a one-file delta from the last reviewed head (not covered) is complete, yet APPROVE is refused.
    view = { ...view, comparedFrom: H1, lastReviewedSha: H1, lastCoveredSha: null, fileListComplete: true };
    const run2 = ctx({ hosts: { github: h }, reads: new ReviewReadLedger() });
    await handleReviewHostTool(
      "repo_pr_read",
      JSON.stringify({ repository: WRITE.repository, prNumber: 7, sinceSha: H1 }),
      run2,
    );
    const out = JSON.parse(
      await handleReviewHostTool("repo_publish_review", JSON.stringify(publishArgs("APPROVE")), run2),
    );
    expect(out).toMatchObject({ error: "full_read_required" });

    // A whole, uncut read with every file read covers the head, whatever the verdict.
    view = { ...view, comparedFrom: null, fileListComplete: true };
    const run3 = ctx({ hosts: { github: h }, reads: new ReviewReadLedger() });
    await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), run3);
    await handleReviewHostTool("repo_publish_review", JSON.stringify(publishArgs("CHANGES_REQUESTED")), run3);
    expect(vi.mocked(h.publishReview).mock.calls.at(-1)![1]).toMatchObject({ coveredSha: SHA });
  });

  it("refuses APPROVE with full_read_required for a delta read saved before compare bases were recorded", async () => {
    const H1 = "b".repeat(40);
    const h = fakeHost();
    h.readPullRequest = vi.fn(
      async () =>
        ({
          number: 7,
          headSha: SHA,
          files: [codeFile("src/a.ts", "complete")],
          nextPatchCursor: null,
          comparedFrom: H1,
          lastReviewedSha: H1,
          lastCoveredSha: null,
          fileListComplete: true,
        }) as never,
    );
    const before = new ReviewReadLedger();
    const c0 = ctx({ hosts: { github: h }, reads: before });
    await handleReviewHostTool(
      "repo_pr_read",
      JSON.stringify({ repository: WRITE.repository, prNumber: 7, sinceSha: H1 }),
      c0,
    );
    // The sandbox session as an older gateway saved it: no bases.
    const state = JSON.parse(JSON.stringify(before.toJSON())) as { heads: Record<string, Record<string, unknown>> };
    for (const head of Object.values(state.heads)) {
      delete head.bases;
      delete head.trustedBases;
      delete head.basesKnown;
    }
    const c = ctx({ hosts: { github: h }, reads: ReviewReadLedger.fromJSON(state) });
    const out = JSON.parse(
      await handleReviewHostTool("repo_publish_review", JSON.stringify(publishArgs("APPROVE")), c),
    );
    expect(out).toMatchObject({ error: "full_read_required" });
    await handleReviewHostTool("repo_publish_review", JSON.stringify(publishArgs("CHANGES_REQUESTED")), c);
    expect(vi.mocked(h.publishReview).mock.calls.at(-1)![1]).toMatchObject({ coveredSha: null });
  });

  it("allows APPROVE once a later read of the head lists every file", async () => {
    const h = fakeHost();
    let complete = false;
    h.readPullRequest = vi.fn(
      async () =>
        ({
          number: 7,
          headSha: SHA,
          files: [codeFile("src/a.ts", "complete")],
          nextPatchCursor: null,
          fileListComplete: complete,
        }) as never,
    );
    const c = ctx({ hosts: { github: h }, reads: new ReviewReadLedger() });
    await handleReviewHostTool(
      "repo_pr_read",
      JSON.stringify({ repository: WRITE.repository, prNumber: 7, sinceSha: "b".repeat(40) }),
      c,
    );
    complete = true;
    await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), c);
    const out = JSON.parse(
      await handleReviewHostTool("repo_publish_review", JSON.stringify(publishArgs("APPROVE")), c),
    );
    expect(out.error).toBeUndefined();
  });

  it("allows the verdict once the file was read with repo_read_file at the head", async () => {
    const h = pageHost();
    h.readFile = vi.fn(async () => ({
      kind: "file" as const,
      path: "src/a.ts",
      ref: SHA,
      totalLines: 1,
      startLine: 1,
      endLine: 1,
      truncated: false,
      content: "1: x",
      text: "x",
    }));
    const c = ctx({ hosts: { github: h }, reads: new ReviewReadLedger() });
    await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), c);
    await handleReviewHostTool(
      "repo_read_file",
      JSON.stringify({ repository: WRITE.repository, path: "src/a.ts", ref: SHA }),
      c,
    );
    const out = JSON.parse(
      await handleReviewHostTool("repo_publish_review", JSON.stringify(publishArgs("APPROVE")), c),
    );
    expect(out.error).toBeUndefined();
  });

  it("a not_found repo_read_file does not satisfy the guard", async () => {
    const c = ctx({ hosts: { github: pageHost() }, reads: new ReviewReadLedger() });
    await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), c);
    await handleReviewHostTool(
      "repo_read_file",
      JSON.stringify({ repository: WRITE.repository, path: "src/a.ts", ref: SHA }),
      c,
    );
    const out = JSON.parse(
      await handleReviewHostTool("repo_publish_review", JSON.stringify(publishArgs("APPROVE")), c),
    );
    expect(out).toMatchObject({ error: "unread_files" });
  });

  it("does not gate a PR number or head this attempt never read", async () => {
    const c = ctx({ hosts: { github: pageHost() }, reads: new ReviewReadLedger() });
    await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), c);
    const otherPr = { ...publishArgs("APPROVE"), prNumber: 8 };
    const otherHead = { ...publishArgs("APPROVE"), headSha: "f".repeat(40) };
    for (const args of [otherPr, otherHead]) {
      const out = JSON.parse(await handleReviewHostTool("repo_publish_review", JSON.stringify(args), c));
      expect(out.error).toBeUndefined();
    }
  });

  it("does not gate a head whose first page this attempt never read (only a cursor page reached it)", async () => {
    const c = ctx({ hosts: { github: pageHost() }, reads: new ReviewReadLedger() });
    await handleReviewHostTool(
      "repo_pr_read",
      JSON.stringify({ repository: WRITE.repository, prNumber: 7, patchCursor: "v1.c" }),
      c,
    );
    const out = JSON.parse(
      await handleReviewHostTool("repo_publish_review", JSON.stringify(publishArgs("APPROVE")), c),
    );
    expect(out.error).toBeUndefined();
  });

  it("does not block APPROVE on a removed code file without a patch", async () => {
    const h = fakeHost();
    h.readPullRequest = vi.fn(
      async () =>
        ({
          number: 7,
          headSha: SHA,
          files: [{ ...codeFile("src/gone.ts", "unavailable"), status: "removed" }],
          nextPatchCursor: null,
        }) as never,
    );
    const c = ctx({ hosts: { github: h }, reads: new ReviewReadLedger() });
    await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), c);
    const out = JSON.parse(
      await handleReviewHostTool("repo_publish_review", JSON.stringify(publishArgs("APPROVE")), c),
    );
    expect(out.error).toBeUndefined();
  });
});
