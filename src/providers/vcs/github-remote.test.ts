import { describe, expect, it, vi } from "vitest";
import type { GitHubRepositoryAccess } from "./github.js";
import { GitHubRemote } from "./github-remote.js";

const CONTINUATION = {
  runId: "run-2",
  repository: "openai/example",
  baseRef: "main",
  headRef: "wardby/run-run-1",
  continuation: { rootRunId: "run-1" },
};

function remoteWith(openPullRequestBase?: GitHubRepositoryAccess["openPullRequestBase"]): GitHubRemote {
  const github = {
    withRepositoryToken: vi.fn(),
    createOrFindDraftPullRequest: vi.fn(),
    ...(openPullRequestBase ? { openPullRequestBase } : {}),
  } as unknown as GitHubRepositoryAccess;
  return new GitHubRemote({ github });
}

describe("GitHubRemote.notifyContinuationFinished and a target-branch merge", () => {
  function remoteRecordingBodies(): { remote: GitHubRemote; bodies: string[] } {
    const bodies: string[] = [];
    const github = {
      withRepositoryToken: vi.fn(),
      createOrFindDraftPullRequest: vi.fn(),
      updateContinuationStatusComment: vi.fn(async (input: { body: string }) => {
        bodies.push(input.body);
      }),
      completeContinuationCheckRun: vi.fn(async () => undefined),
    } as unknown as GitHubRepositoryAccess;
    return { remote: new GitHubRemote({ github }), bodies };
  }

  it("says what was merged on success, and names the file left with markers on failure", async () => {
    const { remote, bodies } = remoteRecordingBodies();
    await remote.notifyContinuationFinished(CONTINUATION, "succeeded", {
      agentName: "builder",
      mergeSentence: "Merged `main` @ `0123456` into this branch; no conflicts.",
    });
    await remote.notifyContinuationFinished(CONTINUATION, "failed", {
      agentName: "builder",
      conflictMarkersSentence: "`a.ts` still has conflict markers after merging this pull request's target branch.",
    });
    await remote.notifyContinuationFinished(CONTINUATION, "budget_exhausted", {
      agentName: "builder",
      changesPushed: { pullRequestNumber: 7 },
      mergeSentence: "Merged `main` @ `0123456` into this branch; no conflicts.",
    });
    expect(bodies[2]).toMatch(/^⚠️ builder \(wardby run run-2\) ran out of budget before finishing\./);
    expect(bodies[2]).toContain(" Merged `main` @ `0123456` into this branch; no conflicts.");
    bodies.pop();
    expect(bodies).toEqual([
      "✅ builder (wardby run run-2) finished. Merged `main` @ `0123456` into this branch; no conflicts.",
      "❌ builder (wardby run run-2) could not push its changes: `a.ts` still has conflict markers after merging this pull request's target branch.",
    ]);
  });

  it("names the repository of kept changes that are in another of the run's repositories", async () => {
    const { remote, bodies } = remoteRecordingBodies();
    await remote.notifyContinuationFinished(CONTINUATION, "budget_exhausted", {
      agentName: "builder",
      changesPushed: { pullRequestNumber: 7, repository: "openai/tools" },
    });
    expect(bodies[0]).toContain("The changes so far are in openai/tools#7;");
  });
});

describe("GitHubRemote.pullRequestBase", () => {
  it("asks for the root run's open PR and returns its current base", async () => {
    const lookup = vi.fn(async () => ({ number: 42, baseRef: "release/2" }));
    await expect(remoteWith(lookup).pullRequestBase(CONTINUATION)).resolves.toEqual({ ref: "release/2" });
    expect(lookup).toHaveBeenCalledWith({
      runId: "run-1",
      repository: "openai/example",
      baseRef: "main",
      headRef: "wardby/run-run-1",
    });
  });

  it("returns null for a fresh run, a client without the lookup, a fork or closed PR, and a failed lookup", async () => {
    const lookup = vi.fn(async () => ({ number: 42, baseRef: "main" }));
    await expect(remoteWith(lookup).pullRequestBase({ ...CONTINUATION, continuation: undefined })).resolves.toBeNull();
    expect(lookup).not.toHaveBeenCalled();
    await expect(remoteWith().pullRequestBase(CONTINUATION)).resolves.toBeNull();
    await expect(remoteWith(async () => null).pullRequestBase(CONTINUATION)).resolves.toBeNull();
    await expect(
      remoteWith(async () => {
        throw new Error("github_api_error:503");
      }).pullRequestBase(CONTINUATION),
    ).resolves.toBeNull();
  });
});

describe("GitHubRemote branch only (#586)", () => {
  const prepared = {
    runId: "run-1",
    repository: "acme/app",
    baseRef: "main",
    headRef: "wardby/run-run-1",
  } as never;

  it("links the branch and a compare page pre-filled with the run's title and description", () => {
    const links = remoteWith().branchLinks(prepared, {
      summary: "Fixes the blank card.",
      commit: { type: "fix", title: "use floor for the joke index" },
    });
    expect(links.branchUrl).toBe("https://github.com/acme/app/tree/wardby/run-run-1");
    const compare = new URL(links.compareUrl);
    expect(compare.origin + compare.pathname).toBe("https://github.com/acme/app/compare/main...wardby/run-run-1");
    expect(compare.searchParams.get("expand")).toBe("1");
    expect(compare.searchParams.get("title")).toBe("fix: use floor for the joke index");
    expect(compare.searchParams.get("body")).toBe("Fixes the blank card.");
  });

  it("leaves the description out of a compare link that would be too long", () => {
    const links = remoteWith().branchLinks(prepared, { summary: "x".repeat(10_000), commit: { title: "t" } });
    expect(links.compareUrl.length).toBeLessThanOrEqual(8000);
    const compare = new URL(links.compareUrl);
    expect(compare.searchParams.has("body")).toBe(false);
    expect(compare.searchParams.get("title")).toBeTruthy();
  });

  it("skips the open-pull-request check when the root pushed only a branch", async () => {
    const findOpenPullRequest = vi.fn(async () => null);
    const remote = new GitHubRemote({
      github: { withRepositoryToken: vi.fn(), createOrFindDraftPullRequest: vi.fn(), findOpenPullRequest } as never,
    });
    await expect(
      remote.assertContinuationOpen({ ...CONTINUATION, continuation: { rootRunId: "run-1", branchOnly: true } }),
    ).resolves.toBeUndefined();
    expect(findOpenPullRequest).not.toHaveBeenCalled();
    // A root that opened a pull request still needs it open.
    await expect(remote.assertContinuationOpen(CONTINUATION)).rejects.toThrow();
  });
});
