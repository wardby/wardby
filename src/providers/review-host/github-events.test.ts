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
      comment: { id: 88, body: "@wardby is this safe?", author_association: "COLLABORATOR", user: { login: "dev", type: "User" } },
    };
    expect(normalizeGitHubEvent("pull_request_review_comment", reviewComment, APP)).toMatchObject({
      kind: "mention",
      isPullRequest: true,
      comment: { kind: "inline", id: "88" },
      replyToReviewCommentId: "88",
    });
  });

  it("ignores unknown events and malformed payloads", () => {
    expect(normalizeGitHubEvent("push", { repository }, APP)).toBeNull();
    expect(normalizeGitHubEvent("pull_request", { action: "opened" }, APP)).toBeNull();
  });
});
