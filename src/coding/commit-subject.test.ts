import { describe, expect, it } from "vitest";
import {
  COMMIT_ISSUE_KEY,
  MAX_COMMIT_SUBJECT_LENGTH,
  commitIssueKey,
  conventionalCommitMessage,
  conventionalSubject,
  normalizeCommitScope,
  normalizeCommitTitle,
  normalizeCommitType,
} from "./commit-subject.js";

describe("normalizeCommitType", () => {
  it("keeps a listed type, case-insensitively", () => {
    expect(normalizeCommitType("feat")).toBe("feat");
    expect(normalizeCommitType(" Fix ")).toBe("fix");
  });

  it("drops anything else", () => {
    for (const value of ["feature", "bugfix", "", null, undefined, 3, {}]) {
      expect(normalizeCommitType(value)).toBeUndefined();
    }
  });
});

describe("normalizeCommitScope", () => {
  it("keeps a safe scope and slugs the rest", () => {
    expect(normalizeCommitScope("webhooks")).toBe("webhooks");
    expect(normalizeCommitScope("Jira Webhooks!")).toBe("jira-webhooks");
    expect(normalizeCommitScope("a".repeat(80))).toBe("a".repeat(32));
  });

  it("drops a scope with nothing usable in it", () => {
    for (const value of ["", "!!!", "  ", null, undefined, 1]) {
      expect(normalizeCommitScope(value)).toBeUndefined();
    }
  });

  it("treats the words a model writes for no scope as no scope", () => {
    for (const value of ["null", "NULL", " None ", "undefined", "n/a", "N/A"]) {
      expect(normalizeCommitScope(value)).toBeUndefined();
    }
    expect(normalizeCommitScope("nullable")).toBe("nullable");
  });
});

describe("normalizeCommitTitle", () => {
  it("makes one plain line without a trailing period", () => {
    expect(normalizeCommitTitle("  add   retry\nto webhooks.  ")).toBe("add retry to webhooks");
  });

  it("drops a type prefix the model repeated", () => {
    expect(normalizeCommitTitle("feat: add retry")).toBe("add retry");
    expect(normalizeCommitTitle("fix(auth)!: reject expired tokens")).toBe("reject expired tokens");
    expect(normalizeCommitTitle("Feature flags: add one")).toBe("Feature flags: add one");
  });

  it("returns undefined when nothing is left", () => {
    for (const value of ["", "   ", "feat:", "\n\t", null, undefined, 2]) {
      expect(normalizeCommitTitle(value)).toBeUndefined();
    }
  });
});

describe("commitIssueKey", () => {
  it("prefers the issue key, then a tag that is itself an issue key", () => {
    expect(commitIssueKey("DEVXP-3988", "GH-42")).toBe("DEVXP-3988");
    expect(commitIssueKey(undefined, "GH-42")).toBe("GH-42");
    expect(commitIssueKey("proj-1", "GH-42")).toBe("GH-42");
  });

  it("is undefined for a tag that is only a label", () => {
    expect(commitIssueKey(undefined, "add-jokes")).toBeUndefined();
    expect(commitIssueKey(undefined, undefined)).toBeUndefined();
  });
});

describe("conventionalSubject", () => {
  const base = { runId: "run-1" };

  it("builds type(scope): title (KEY)", () => {
    expect(
      conventionalSubject({
        ...base,
        type: "feat",
        scope: "webhooks",
        title: "add retry to Jira webhook delivery",
        issueKey: "DEVXP-3988",
      }),
    ).toBe("feat(webhooks): add retry to Jira webhook delivery (DEVXP-3988)");
  });

  it("omits the scope and the key when there are none", () => {
    expect(conventionalSubject({ ...base, type: "fix", title: "reject expired tokens" })).toBe(
      "fix: reject expired tokens",
    );
  });

  it("drops a malformed key", () => {
    for (const issueKey of ["proj-1", "PROJ-0", "PROJ-1\n# x", "[PROJ-1]", "PROJ"]) {
      expect(conventionalSubject({ ...base, type: "fix", title: "x", issueKey })).toBe("fix: x");
    }
  });

  it("writes the key once when the model put it in the title too", () => {
    const base = { runId: "run-1", type: "feat", scope: "app" };
    expect(conventionalSubject({ ...base, title: "DEVXP-3988: add GET /ping endpoint", issueKey: "DEVXP-3988" })).toBe(
      "feat(app): add GET /ping endpoint (DEVXP-3988)",
    );
    expect(conventionalSubject({ ...base, title: "[DEVXP-3988] add GET /ping endpoint", issueKey: "DEVXP-3988" })).toBe(
      "feat(app): add GET /ping endpoint (DEVXP-3988)",
    );
    expect(conventionalSubject({ ...base, title: "add DEVXP-3988 ping endpoint", issueKey: "DEVXP-3988" })).toBe(
      "feat(app): add ping endpoint (DEVXP-3988)",
    );
  });

  it("uses the key the model wrote when the run has none, and leaves a different key alone", () => {
    expect(conventionalSubject({ runId: "run-1", type: "fix", title: "DEVXP-12 - reject expired tokens" })).toBe(
      "fix: reject expired tokens (DEVXP-12)",
    );
    expect(
      conventionalSubject({ runId: "run-1", type: "fix", title: "revert PAY-1 change", issueKey: "DEVXP-1" }),
    ).toBe("fix: revert PAY-1 change (DEVXP-1)");
  });

  it("uses chore for a missing or unlisted type", () => {
    expect(conventionalSubject({ ...base, title: "tidy imports" })).toBe("chore: tidy imports");
    expect(conventionalSubject({ ...base, type: "feature", title: "tidy imports" })).toBe("chore: tidy imports");
  });

  it("falls back to the run id, as chore, when there is no title", () => {
    expect(conventionalSubject({ ...base, type: "feat", scope: "auth" })).toBe("chore: Wardby run run-1");
    expect(conventionalSubject({ ...base, type: "feat", title: "  ", issueKey: "PROJ-7" })).toBe(
      "chore: Wardby run run-1 (PROJ-7)",
    );
  });

  it("cuts the title, never the key, to fit the subject length", () => {
    const subject = conventionalSubject({
      ...base,
      type: "feat",
      scope: "webhooks",
      title: "add retry with exponential backoff to the Jira webhook delivery pipeline for brief outages",
      issueKey: "DEVXP-3988",
    });
    expect(subject.length).toBeLessThanOrEqual(MAX_COMMIT_SUBJECT_LENGTH);
    expect(subject.startsWith("feat(webhooks): add retry with exponential backoff")).toBe(true);
    expect(subject.endsWith(" (DEVXP-3988)")).toBe(true);
  });

  it("stays a single line however hostile the inputs", () => {
    const subject = conventionalSubject({
      ...base,
      type: "feat\nBREAKING CHANGE: x",
      scope: "a\nb",
      title: "one\ntwo\r\nthree",
      issueKey: "PROJ-1",
    });
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it("keeps its issue key pattern in step with the VCS layer's", async () => {
    const { PR_ISSUE_KEY } = await import("../providers/vcs/github.js");
    expect(COMMIT_ISSUE_KEY.source).toBe(PR_ISSUE_KEY.source);
    expect(COMMIT_ISSUE_KEY.flags).toBe(PR_ISSUE_KEY.flags);
  });
});

describe("conventionalCommitMessage", () => {
  it("adds the run id as a trailer under a blank line", () => {
    expect(
      conventionalCommitMessage({
        runId: "cmv7itac3000101linwsx0oo1",
        type: "feat",
        scope: "webhooks",
        title: "add retry to Jira webhook delivery",
        issueKey: "DEVXP-3988",
      }),
    ).toBe("feat(webhooks): add retry to Jira webhook delivery (DEVXP-3988)\n\nWardby-Run: cmv7itac3000101linwsx0oo1");
  });

  it("is still conventional when the model gave nothing", () => {
    expect(conventionalCommitMessage({ runId: "run-1" })).toBe("chore: Wardby run run-1\n\nWardby-Run: run-1");
  });
});
