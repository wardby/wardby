import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewHostError, type CiView, type CodeReviewHost } from "../providers/review-host/types.js";
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

  it("passes the agent marker to reads and applies the default patch budget", async () => {
    const c = ctx();
    await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository: WRITE.repository, prNumber: 7 }), c);
    expect(c.hosts.github!.readPullRequest).toHaveBeenCalledWith(WRITE.repository, 7, {
      sinceSha: undefined,
      maxPatchChars: 60_000,
      agentMarker: "agent1",
    });
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

    it("sets the self entry's state to draft when the pull request just read is a draft", async () => {
      const h = fakeHost();
      h.pullRequestOrigin = vi.fn(async () => ({
        headSha: SHA,
        isFork: false,
        state: "open",
        labels: [],
        markerRunId: "run_lead",
      }));
      h.readPullRequest = vi.fn(async () => ({ number: 7, draft: true }) as never);
      const c = ctx({ hosts: { github: h } });
      vi.mocked(collectRelatedPullRequests).mockResolvedValueOnce({
        pullRequests: [
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
        { repository: WRITE.repository, number: 7, state: "draft", self: true },
        { repository: "chfields/other-repo", number: 9, state: "merged", self: false },
      ]);
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
    for (const fn of [host.readPullRequest, host.readFile, host.listFiles, host.comment, host.publishReview]) {
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
