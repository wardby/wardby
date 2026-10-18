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
