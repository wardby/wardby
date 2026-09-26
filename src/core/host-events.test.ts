import { describe, expect, it, vi } from "vitest";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import type { RepoAccessDecision, RepoAccessGate } from "./repo-access.js";
import { isReviewCommand, routeHostEvent, type HostEvent } from "./host-events.js";

// vi.mock factories are hoisted above every declaration, so shared state goes through vi.hoisted.
const { txStub } = vi.hoisted(() => ({ txStub: { runHostCheck: { create: vi.fn(async () => undefined) } } }));
vi.mock("./dispatch.js", () => ({
  dispatchRun: vi.fn(async (opts: { agentId: string; afterPersist?: (tx: unknown, run: unknown) => Promise<void> }) => {
    const run = { id: `run-${opts.agentId}`, trigger: "host_event" };
    await opts.afterPersist?.(txStub, run);
    return { run };
  }),
}));
import { dispatchRun } from "./dispatch.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = "chfields/knock-knock-jokes";

function host(): CodeReviewHost {
  return {
    provider: "github",
    repositoryPermission: vi.fn(async () => ({ level: "write" as const, login: "octo" })),
    readPullRequest: vi.fn(),
    pullRequestHead: vi.fn(async () => ({ headSha: SHA, isFork: false, state: "open" })),
    readFile: vi.fn(),
    listFiles: vi.fn(),
    publishReview: vi.fn(),
    comment: vi.fn(),
    acknowledge: vi.fn(async () => undefined),
    startCheck: vi.fn(async () => ({ checkId: "11" })),
    completeCheck: vi.fn(async () => undefined),
  };
}

const OK: RepoAccessDecision = { ok: true };

function gate(
  opts: { use?: (agentId: string) => RepoAccessDecision; commenter?: RepoAccessDecision } = {},
): RepoAccessGate & { authorizeUse: ReturnType<typeof vi.fn>; authorizeHostUser: ReturnType<typeof vi.fn> } {
  return {
    // The stub receives the link's owner as ownerId = `owner-<agentId>`.
    authorizeUse: vi.fn(async (input: { ownerId: string | null }) =>
      opts.use ? opts.use(String(input.ownerId).replace(/^owner-/, "")) : OK,
    ),
    authorizeHostUser: vi.fn(async () => opts.commenter ?? OK),
    authorizePrincipal: vi.fn(),
  };
}

function deps(
  links: Array<{ agentId: string; triggers: string[]; checkName: string | null }>,
  h = host(),
  repoAccess = gate(),
) {
  return {
    hosts: { github: h },
    executor: {} as never,
    mentionHandle: "wardby",
    repoAccess,
    db: {
      agentRepository: {
        findMany: vi.fn(async () =>
          links.map((l) => ({
            ...l,
            provider: "github",
            repository: REPO,
            access: "write",
            authorizedVia: "host_permission",
            agent: { ownerId: `owner-${l.agentId}` },
          })),
        ),
      },
    } as never,
  };
}

const pr: HostEvent = {
  kind: "pr_updated",
  provider: "github",
  repository: REPO,
  prNumber: 7,
  headSha: SHA,
  isFork: false,
};

describe("routeHostEvent", () => {
  it("starts a check, dispatches, and records the check for every pull_request agent", async () => {
    const d = deps([
      { agentId: "a1", triggers: ["pull_request"], checkName: "wardby review" },
      { agentId: "a2", triggers: ["pull_request"], checkName: "security" },
      { agentId: "a3", triggers: ["mention"], checkName: null },
    ]);
    const result = await routeHostEvent(pr, d);
    expect(result.runIds).toEqual(["run-a1", "run-a2"]);
    expect(d.hosts.github.startCheck).toHaveBeenCalledWith(REPO, { headSha: SHA, name: "wardby review" });
    expect(vi.mocked(dispatchRun).mock.calls[0][0]).toMatchObject({
      agentId: "a1",
      trigger: "host_event",
      taskOverride: `Review pull request #7 in ${REPO} (head ${SHA}).`,
    });
    expect(txStub.runHostCheck.create).toHaveBeenCalledWith({
      data: { runId: "run-a1", provider: "github", repository: REPO, checkId: "11", headSha: SHA, prNumber: 7 },
    });
  });

  it("skips fork PRs entirely", async () => {
    const d = deps([{ agentId: "a1", triggers: ["pull_request"], checkName: "wardby review" }]);
    await expect(routeHostEvent({ ...pr, isFork: true }, d)).resolves.toEqual({ runIds: [], followUps: [] });
    expect(d.hosts.github.startCheck).not.toHaveBeenCalled();
  });

  it("re-runs only the agent that owns the rerequested check", async () => {
    vi.mocked(dispatchRun).mockClear();
    const d = deps([
      { agentId: "a1", triggers: ["pull_request"], checkName: "wardby review" },
      { agentId: "a2", triggers: ["pull_request"], checkName: "security" },
    ]);
    const result = await routeHostEvent(
      { kind: "check_rerun", provider: "github", repository: REPO, prNumber: 7, headSha: SHA, checkName: "security" },
      d,
    );
    expect(result.runIds).toEqual(["run-a2"]);
  });

  it("completes the started check neutral when dispatch fails", async () => {
    vi.mocked(dispatchRun).mockResolvedValueOnce(null);
    const d = deps([{ agentId: "a1", triggers: ["pull_request"], checkName: "wardby review" }]);
    await routeHostEvent(pr, d);
    expect(d.hosts.github.completeCheck).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({ checkId: "11", conclusion: "neutral", title: "Review could not be started" }),
    );
  });

  it("routes '@wardby review' to pull_request agents on the current head, and other mentions to the mention agent", async () => {
    vi.mocked(dispatchRun).mockClear();
    const d = deps([
      { agentId: "a1", triggers: ["pull_request"], checkName: "wardby review" },
      { agentId: "a3", triggers: ["mention"], checkName: null },
    ]);
    const mention = (body: string): HostEvent => ({
      kind: "mention",
      provider: "github",
      repository: REPO,
      number: 7,
      isPullRequest: true,
      comment: { kind: "conversation", id: "4" },
      body,
      author: "chfields",
      authorId: "1001",
    });
    const review = await routeHostEvent(mention("@wardby review please"), d);
    expect(review.runIds).toEqual(["run-a1"]);
    const ask = await routeHostEvent(mention("@wardby why is this slow?"), d);
    expect(ask.runIds).toEqual(["run-a3"]);
    expect(vi.mocked(dispatchRun).mock.calls.at(-1)![0].taskOverride).toBe(
      `[GitHub PR #7]\nRepository: ${REPO}\nRequested by @chfields\n\nRequest comment:\n@wardby why is this slow?`,
    );
    for (const f of [...review.followUps, ...ask.followUps]) await f();
    expect(d.hosts.github.acknowledge).toHaveBeenCalledWith(REPO, { kind: "conversation", id: "4" });
  });
});

describe("routeHostEvent mention task text", () => {
  const base: Extract<HostEvent, { kind: "mention" }> = {
    kind: "mention",
    provider: "github",
    repository: REPO,
    number: 7,
    isPullRequest: true,
    comment: { kind: "conversation", id: "4" },
    body: "@wardby please fix the typo",
    author: "chfields",
    authorId: "1001",
  };
  async function taskFor(event: HostEvent) {
    vi.mocked(dispatchRun).mockClear();
    const d = deps([{ agentId: "a3", triggers: ["mention"], checkName: null }]);
    const result = await routeHostEvent(event, d);
    for (const f of result.followUps) await f();
    return { task: vi.mocked(dispatchRun).mock.calls[0][0].taskOverride, host: d.hosts.github };
  }

  it("includes the PR title, description, and a continuation hint", async () => {
    const { task } = await taskFor({
      ...base,
      subject: { title: "Add cat jokes", body: "<!-- wardby:run_1 -->\n\nAdds jokes." },
      priorRunId: "run_1",
    });
    expect(task).toBe(
      [
        '[This request is a follow-up on PR #7, originally opened by wardby run run_1. If you delegate, pass continuePriorRun set to exactly "run_1" so the same PR/branch is continued instead of opening a new one.]',
        "",
        "[GitHub PR #7: Add cat jokes]",
        `Repository: ${REPO}`,
        "Requested by @chfields",
        "",
        "PR description:",
        "<!-- wardby:run_1 -->\n\nAdds jokes.",
        "",
        "Request comment:",
        "@wardby please fix the typo",
      ].join("\n"),
    );
  });

  it("notes an inline review thread and omits an empty description", async () => {
    const { task } = await taskFor({
      ...base,
      comment: { kind: "inline", id: "88" },
      replyToReviewCommentId: "88",
      subject: { title: "Cats", body: "  " },
    });
    expect(task).toBe(
      [
        "[GitHub PR #7: Cats]",
        `Repository: ${REPO}`,
        "Requested by @chfields (in review thread 88)",
        "",
        "Request comment:",
        "@wardby please fix the typo",
      ].join("\n"),
    );
  });

  it("uses the issue itself as the request when the mention is in the issue", async () => {
    const { task, host: h } = await taskFor({
      ...base,
      number: 12,
      isPullRequest: false,
      comment: { kind: "subject", id: "12" },
      body: "@wardby add a knock-knock joke",
      subject: { title: "More\njokes", body: "@wardby add a knock-knock joke" },
    });
    expect(task).toBe(
      [
        "[GitHub issue #12: More jokes]",
        `Repository: ${REPO}`,
        "Requested by @chfields",
        "",
        "Issue description:",
        "@wardby add a knock-knock joke",
      ].join("\n"),
    );
    expect(h.acknowledge).toHaveBeenCalledWith(REPO, { kind: "subject", id: "12" });
  });

  it("caps the description and the comment", async () => {
    const { task } = await taskFor({
      ...base,
      body: "@wardby " + "c".repeat(9000),
      subject: { title: "T", body: "d".repeat(9000) },
    });
    expect(task).toContain(`PR description:\n${"d".repeat(8000)}\n\nRequest comment:\n`);
    expect(task!.endsWith(`\n@wardby ${"c".repeat(8000 - "@wardby ".length)}`)).toBe(true);
  });

  it("falls back to a title-less header without subject details", async () => {
    const { task } = await taskFor({ ...base, isPullRequest: false });
    expect(task).toBe(
      ["[GitHub issue #7]", `Repository: ${REPO}`, "Requested by @chfields", "", "Request comment:", base.body].join(
        "\n",
      ),
    );
  });
});

describe("isReviewCommand", () => {
  it("matches the review command only as the handle's first word", () => {
    expect(isReviewCommand("@wardby review", "wardby")).toBe(true);
    expect(isReviewCommand("hey @Wardby Review this", "wardby")).toBe(true);
    expect(isReviewCommand("@wardby reviewer?", "wardby")).toBe(false);
    expect(isReviewCommand("@wardby-dev review", "wardby")).toBe(false);
  });
});

describe("routeHostEvent repository authorization (H5-1) and mention gate (H5-3)", () => {
  const mention = (body: string): HostEvent => ({
    kind: "mention",
    provider: "github",
    repository: REPO,
    number: 7,
    isPullRequest: true,
    comment: { kind: "conversation", id: "4" },
    body,
    author: "chfields",
    authorId: "1001",
  });

  it("skips a link whose owner no longer has access, and still dispatches the authorized ones", async () => {
    vi.mocked(dispatchRun).mockClear();
    const repoAccess = gate({
      use: (agentId) => (agentId === "a2" ? { ok: false, reason: "insufficient_permission" } : OK),
    });
    const d = deps(
      [
        { agentId: "a1", triggers: ["pull_request"], checkName: "wardby review" },
        { agentId: "a2", triggers: ["pull_request"], checkName: "security" },
      ],
      host(),
      repoAccess,
    );
    const result = await routeHostEvent(pr, d);
    expect(result.runIds).toEqual(["run-a1"]);
    expect(d.hosts.github.startCheck).toHaveBeenCalledTimes(1);
    expect(d.hosts.github.startCheck).toHaveBeenCalledWith(REPO, { headSha: SHA, name: "wardby review" });
    expect(repoAccess.authorizeUse).toHaveBeenCalledWith({
      ownerId: "owner-a2",
      provider: "github",
      repository: REPO,
      required: "write",
      authorizedVia: "host_permission",
    });
  });

  it.each(["read", "triage"] as const)(
    "ignores a mention from a %s commenter: no dispatch, no reaction",
    async (level) => {
      vi.mocked(dispatchRun).mockClear();
      const repoAccess = gate({ commenter: { ok: false, reason: "insufficient_permission", level } });
      const d = deps(
        [
          { agentId: "a1", triggers: ["pull_request"], checkName: "wardby review" },
          { agentId: "a3", triggers: ["mention"], checkName: null },
        ],
        host(),
        repoAccess,
      );
      for (const body of ["@wardby review", "@wardby please fix it"]) {
        expect(await routeHostEvent(mention(body), d)).toEqual({ runIds: [], followUps: [] });
      }
      expect(dispatchRun).not.toHaveBeenCalled();
      expect(d.hosts.github.startCheck).not.toHaveBeenCalled();
      expect(d.hosts.github.pullRequestHead).not.toHaveBeenCalled();
      expect(repoAccess.authorizeHostUser).toHaveBeenCalledWith({
        provider: "github",
        repository: REPO,
        user: { id: "1001", login: "chfields" },
        required: "write",
      });
    },
  );

  it("dispatches a mention from a commenter with write access", async () => {
    vi.mocked(dispatchRun).mockClear();
    const d = deps(
      [{ agentId: "a3", triggers: ["mention"], checkName: null }],
      host(),
      gate({ commenter: { ok: true, level: "write" } }),
    );
    const result = await routeHostEvent(mention("@wardby please fix it"), d);
    expect(result.runIds).toEqual(["run-a3"]);
    expect(result.followUps).toHaveLength(1);
  });

  it("does not ask about the commenter when no agent would act on the mention", async () => {
    const repoAccess = gate();
    const d = deps([], host(), repoAccess);
    await routeHostEvent(mention("@wardby hi"), d);
    expect(repoAccess.authorizeHostUser).not.toHaveBeenCalled();
  });

  it("refuses the mention responder when its own link is no longer authorized", async () => {
    vi.mocked(dispatchRun).mockClear();
    const d = deps(
      [{ agentId: "a3", triggers: ["mention"], checkName: null }],
      host(),
      gate({ use: () => ({ ok: false, reason: "owner_required" }) }),
    );
    expect(await routeHostEvent(mention("@wardby fix"), d)).toEqual({ runIds: [], followUps: [] });
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("records the dispatched PR on a review started by '@wardby review'", async () => {
    txStub.runHostCheck.create.mockClear();
    const d = deps([{ agentId: "a1", triggers: ["pull_request"], checkName: "wardby review" }]);
    await routeHostEvent(mention("@wardby review"), d);
    expect(txStub.runHostCheck.create).toHaveBeenCalledWith({
      data: { runId: "run-a1", provider: "github", repository: REPO, checkId: "11", headSha: SHA, prNumber: 7 },
    });
  });
});
