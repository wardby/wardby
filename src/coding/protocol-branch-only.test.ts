import { describe, expect, it } from "vitest";
import {
  CODING_PROTOCOL_VERSION,
  CodingRunResultSchema,
  parseCodingAgentOutputJson,
  PullRequestNoteSchema,
} from "./protocol.js";

const output = (extra: Record<string, unknown>) =>
  JSON.stringify({
    schemaVersion: CODING_PROTOCOL_VERSION,
    runId: "run-1",
    outcome: "changes_ready",
    summary: "s",
    tests: [],
    ...extra,
  });

describe("branch only (#586)", () => {
  it("keeps pullRequest none, and drops any other value without refusing the answer", () => {
    expect(parseCodingAgentOutputJson(output({ pullRequest: "none" })).pullRequest).toBe("none");
    for (const value of ["open", null, "NONE", 1]) {
      const parsed = parseCodingAgentOutputJson(output({ pullRequest: value }));
      expect(parsed.pullRequest).toBeUndefined();
      expect(parsed.outcome).toBe("changes_ready");
    }
    expect(parseCodingAgentOutputJson(output({})).pullRequest).toBeUndefined();
  });

  it("takes each extra repository's own choice from its note", () => {
    const note = PullRequestNoteSchema.parse({
      name: "api",
      title: null,
      description: "d",
      mergeOrder: null,
      pullRequest: "none",
    });
    expect(note.pullRequest).toBe("none");
    expect(
      PullRequestNoteSchema.parse({ name: "api", description: "d", pullRequest: null }).pullRequest,
    ).toBeUndefined();
  });

  it("stores a branch_pushed result's https links, and refuses any other scheme", () => {
    const base = {
      schemaVersion: CODING_PROTOCOL_VERSION,
      outcome: "branch_pushed",
      repository: "acme/app",
      baseRef: "main",
      headRef: "wardby/run-1",
      commitSha: "a".repeat(40),
      summary: "s",
      tests: [],
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    };
    const links = {
      branchUrl: "https://github.com/acme/app/tree/wardby/run-1",
      compareUrl: "https://github.com/acme/app/compare/main...wardby/run-1?expand=1",
    };
    expect(CodingRunResultSchema.parse({ ...base, ...links })).toMatchObject(links);
    expect(CodingRunResultSchema.safeParse({ ...base, branchUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(CodingRunResultSchema.safeParse({ ...base, compareUrl: "http://github.com/x" }).success).toBe(false);
  });
});
