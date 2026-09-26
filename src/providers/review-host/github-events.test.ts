import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeGitHubEvent, verifyGitHubSignature } from "./github-events.js";

const APP = { id: 777, slug: "wardby" };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const repository = { full_name: "ChFields/Knock-Knock-Jokes" };

describe("verifyGitHubSignature", () => {
  const body = '{"a":1}';
  const sig = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  it("accepts the exact body and rejects a re-serialised one, a wrong secret, and a missing header", () => {
    expect(verifyGitHubSignature(body, sig, "s3cret")).toBe(true);
    expect(verifyGitHubSignature('{"a": 1}', sig, "s3cret")).toBe(false);
    expect(verifyGitHubSignature(body, sig, "other")).toBe(false);
    expect(verifyGitHubSignature(body, undefined, "s3cret")).toBe(false);
    expect(verifyGitHubSignature(body, "sha256=zz", "s3cret")).toBe(false);
  });
});

describe("normalizeGitHubEvent", () => {
  const pr = (action: string, headRepo = "chfields/knock-knock-jokes") => ({
    action,
    repository,
    pull_request: { number: 7, head: { sha: SHA, repo: { full_name: headRepo } } },
  });

  it("maps PR opened/synchronize/reopened/ready_for_review and flags forks", () => {
    for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
      expect(normalizeGitHubEvent("pull_request", pr(action), APP)).toEqual({
        kind: "pr_updated",
        provider: "github",
        repository: "chfields/knock-knock-jokes",
        prNumber: 7,
        headSha: SHA,
        isFork: false,
      });
    }
    expect(normalizeGitHubEvent("pull_request", pr("opened", "stranger/x"), APP)).toMatchObject({ isFork: true });
    expect(normalizeGitHubEvent("pull_request", pr("closed"), APP)).toBeNull();
  });

  it("maps a rerequested check only when our App owns it", () => {
    const check = (appId: number) => ({
      action: "rerequested",
      repository,
      check_run: { name: "wardby review", head_sha: SHA, app: { id: appId }, pull_requests: [{ number: 7 }] },
    });
    expect(normalizeGitHubEvent("check_run", check(777), APP)).toEqual({
      kind: "check_rerun",
      provider: "github",
      repository: "chfields/knock-knock-jokes",
      prNumber: 7,
      headSha: SHA,
      checkName: "wardby review",
    });
    expect(normalizeGitHubEvent("check_run", check(1), APP)).toBeNull();
  });

  it("maps mentions from trusted humans only", () => {
    const comment = (body: string, association = "OWNER", type = "User") => ({
      action: "created",
      repository,
      issue: { number: 7, pull_request: { url: "x" } },
      comment: { id: 4, body, author_association: association, user: { login: "chfields", type } },
    });
    expect(normalizeGitHubEvent("issue_comment", comment("@wardby review"), APP)).toEqual({
      kind: "mention",
      provider: "github",
      repository: "chfields/knock-knock-jokes",
      number: 7,
      isPullRequest: true,
      comment: { kind: "conversation", id: "4" },
      body: "@wardby review",
      author: "chfields",
    });
    expect(normalizeGitHubEvent("issue_comment", comment("no mention"), APP)).toBeNull();
    expect(normalizeGitHubEvent("issue_comment", comment("email me@wardby.com"), APP)).toBeNull();
    expect(normalizeGitHubEvent("issue_comment", comment("@wardby hi", "NONE"), APP)).toBeNull();
    expect(normalizeGitHubEvent("issue_comment", comment("@wardby hi", "OWNER", "Bot"), APP)).toBeNull();

    const reviewComment = {
      action: "created",
      repository,
      pull_request: { number: 7 },
      comment: {
        id: 88,
        body: "@wardby is this safe?",
        author_association: "COLLABORATOR",
        user: { login: "dev", type: "User" },
      },
    };
    expect(normalizeGitHubEvent("pull_request_review_comment", reviewComment, APP)).toMatchObject({
      kind: "mention",
      isPullRequest: true,
      comment: { kind: "inline", id: "88" },
      replyToReviewCommentId: "88",
    });
  });

  it("carries the parent issue/PR title and body with a comment mention", () => {
    const onIssue = {
      action: "created",
      repository,
      issue: { number: 3, title: "Add a joke", body: "Please add one about cats." },
      comment: { id: 4, body: "@wardby take this", author_association: "MEMBER", user: { login: "dev", type: "User" } },
    };
    expect(normalizeGitHubEvent("issue_comment", onIssue, APP)).toEqual({
      kind: "mention",
      provider: "github",
      repository: "chfields/knock-knock-jokes",
      number: 3,
      isPullRequest: false,
      comment: { kind: "conversation", id: "4" },
      body: "@wardby take this",
      author: "dev",
      subject: { title: "Add a joke", body: "Please add one about cats." },
    });
    const inline = {
      action: "created",
      repository,
      pull_request: { number: 7, title: "Cats", body: null },
      comment: { id: 88, body: "@wardby why?", author_association: "OWNER", user: { login: "dev", type: "User" } },
    };
    expect(normalizeGitHubEvent("pull_request_review_comment", inline, APP)).toMatchObject({
      subject: { title: "Cats", body: "" },
    });
  });

  describe("continuation of a PR a coding run opened", () => {
    const APP_BOT = { login: "wardby[bot]", type: "Bot" };
    const onPr = (
      prBody: string,
      event: "issue_comment" | "pull_request_review_comment" = "issue_comment",
      prAuthor: { login: string; type: string } = APP_BOT,
    ) => {
      const comment = {
        id: 4,
        body: "@wardby fix it",
        author_association: "OWNER",
        user: { login: "dev", type: "User" },
      };
      const pr = { number: 7, title: "T", body: prBody, user: prAuthor };
      return event === "issue_comment"
        ? { action: "created", repository, issue: { ...pr, pull_request: {} }, comment }
        : { action: "created", repository, pull_request: pr, comment };
    };

    it("only trusts the marker on a PR the App itself opened", () => {
      const marker = "<!-- wardby:r1 -->\nbody";
      expect(
        normalizeGitHubEvent(
          "issue_comment",
          onPr(marker, "issue_comment", { login: "Wardby[BOT]", type: "Bot" }),
          APP,
        ),
      ).toMatchObject({ priorRunId: "r1" });
      for (const author of [
        { login: "chfields", type: "User" },
        { login: "stranger", type: "User" },
        { login: "wardby[bot]", type: "User" },
        { login: "other-app[bot]", type: "Bot" },
        { login: "wardby", type: "Bot" },
      ]) {
        for (const event of ["issue_comment", "pull_request_review_comment"] as const) {
          const result = normalizeGitHubEvent(event, onPr(marker, event, author), APP);
          expect(result).toMatchObject({ kind: "mention", number: 7 });
          expect(result).not.toHaveProperty("priorRunId");
        }
      }
      // A fork-style PR (head in another repository) by a human carries no hint either.
      const fork = onPr(marker, "pull_request_review_comment", { login: "stranger", type: "User" });
      (fork.pull_request as Record<string, unknown>).head = { repo: { full_name: "stranger/knock-knock-jokes" } };
      expect(normalizeGitHubEvent("pull_request_review_comment", fork, APP)).not.toHaveProperty("priorRunId");
      const noAuthor = onPr(marker);
      delete (noAuthor.issue as { user?: unknown }).user;
      expect(normalizeGitHubEvent("issue_comment", noAuthor, APP)).not.toHaveProperty("priorRunId");
    });

    it("reads the run id from the wardby marker at the top of the PR body", () => {
      expect(
        normalizeGitHubEvent("issue_comment", onPr("<!-- wardby:run_Abc-123 -->\n\n## Summary"), APP),
      ).toMatchObject({
        priorRunId: "run_Abc-123",
      });
      expect(
        normalizeGitHubEvent(
          "pull_request_review_comment",
          onPr("<!-- wardby:r1 -->\nbody", "pull_request_review_comment"),
          APP,
        ),
      ).toMatchObject({ priorRunId: "r1" });
    });

    it("accepts the legacy marker", () => {
      expect(normalizeGitHubEvent("issue_comment", onPr("<!-- reevo-run:legacy42 -->\nx"), APP)).toMatchObject({
        priorRunId: "legacy42",
      });
    });

    it("ignores an invalid, misplaced, or issue-only marker", () => {
      for (const body of [
        "<!-- wardby:../../etc -->",
        "<!-- wardby:-leading -->",
        `<!-- wardby:${"a".repeat(129)} -->`,
        "text first\n<!-- wardby:r1 -->",
        "<!-- wardby: r1 -->",
      ]) {
        expect(normalizeGitHubEvent("issue_comment", onPr(body), APP)).not.toHaveProperty("priorRunId");
      }
      const onIssue = onPr("<!-- wardby:r1 -->");
      delete (onIssue.issue as { pull_request?: unknown }).pull_request;
      expect(normalizeGitHubEvent("issue_comment", onIssue, APP)).not.toHaveProperty("priorRunId");
    });
  });

  describe("issues opened/edited", () => {
    const issue = (
      action: string,
      title: string,
      body: string | null,
      extra: { changes?: unknown; association?: string; type?: string; sender?: string } = {},
    ) => ({
      action,
      repository,
      issue: {
        number: 12,
        title,
        body,
        author_association: extra.association ?? "OWNER",
        user: { login: "chfields", type: extra.type ?? "User" },
      },
      sender: { login: extra.sender ?? "chfields", type: extra.type ?? "User" },
      ...(extra.changes ? { changes: extra.changes } : {}),
    });

    it("maps an issue opened with a mention in its body or title, acknowledged on the issue itself", () => {
      expect(normalizeGitHubEvent("issues", issue("opened", "Jokes", "@wardby please add a joke"), APP)).toEqual({
        kind: "mention",
        provider: "github",
        repository: "chfields/knock-knock-jokes",
        number: 12,
        isPullRequest: false,
        comment: { kind: "subject", id: "12" },
        body: "@wardby please add a joke",
        author: "chfields",
        subject: { title: "Jokes", body: "@wardby please add a joke" },
      });
      expect(normalizeGitHubEvent("issues", issue("opened", "@wardby add a joke", null), APP)).toMatchObject({
        comment: { kind: "subject", id: "12" },
        body: "",
        subject: { title: "@wardby add a joke", body: "" },
      });
      expect(normalizeGitHubEvent("issues", issue("opened", "Jokes", "no mention"), APP)).toBeNull();
      expect(normalizeGitHubEvent("issues", issue("closed", "Jokes", "@wardby hi"), APP)).toBeNull();
    });

    it("maps an edit only when it newly adds the mention", () => {
      const added = issue("edited", "Jokes", "@wardby go", { changes: { body: { from: "go" } } });
      expect(normalizeGitHubEvent("issues", added, APP)).toMatchObject({ kind: "mention", number: 12 });
      const titleAdded = issue("edited", "@wardby Jokes", "go", { changes: { title: { from: "Jokes" } } });
      expect(normalizeGitHubEvent("issues", titleAdded, APP)).toMatchObject({ kind: "mention" });

      const already = issue("edited", "Jokes", "@wardby go now", { changes: { body: { from: "@wardby go" } } });
      expect(normalizeGitHubEvent("issues", already, APP)).toBeNull();
      const titleOnlyEdit = issue("edited", "Jokes v2", "@wardby go", { changes: { title: { from: "Jokes" } } });
      expect(normalizeGitHubEvent("issues", titleOnlyEdit, APP)).toBeNull();
      const noChanges = issue("edited", "Jokes", "@wardby go");
      expect(normalizeGitHubEvent("issues", noChanges, APP)).toBeNull();
    });

    it("ignores untrusted, bot, and other-user edits", () => {
      expect(
        normalizeGitHubEvent("issues", issue("opened", "J", "@wardby hi", { association: "NONE" }), APP),
      ).toBeNull();
      expect(
        normalizeGitHubEvent("issues", issue("opened", "J", "@wardby hi", { association: "CONTRIBUTOR" }), APP),
      ).toBeNull();
      expect(normalizeGitHubEvent("issues", issue("opened", "J", "@wardby hi", { type: "Bot" }), APP)).toBeNull();
      const bySomeoneElse = issue("edited", "J", "@wardby hi", { changes: { body: { from: "hi" } }, sender: "other" });
      expect(normalizeGitHubEvent("issues", bySomeoneElse, APP)).toBeNull();
    });
  });

  it("ignores unknown events and malformed payloads", () => {
    expect(normalizeGitHubEvent("push", { repository }, APP)).toBeNull();
    expect(normalizeGitHubEvent("pull_request", { action: "opened" }, APP)).toBeNull();
  });
});
