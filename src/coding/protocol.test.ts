import { describe, expect, it } from "vitest";
import {
  CODING_PROTOCOL_VERSION,
  CodingAgentOutputSchema,
  CodingRunResultSchema,
  CodingTaskInputSchema,
  MAX_CODING_ARTIFACT_BYTES,
  MAX_CODING_SUMMARY_BYTES,
  MAX_CODING_TASK_BYTES,
  MAX_CODING_TEST_COMMAND_BYTES,
  MAX_CODING_TESTS,
  normalizeGitHubRepository,
  normalizeGitRef,
  parseCodingAgentOutputJson,
  parseCodingRunResultJson,
  parseCodingTaskInputJson,
} from "./protocol.js";

const input = {
  schemaVersion: CODING_PROTOCOL_VERSION,
  runId: "run_123",
  repository: "OpenAI/Example.git",
  baseRef: "refs/heads/main",
  headRef: "reevo/run-run_123",
  task: "Fix the failing unit test.",
  model: "gpt-5.6-luna",
  budgetUsd: 0.25,
  deadlineAt: "2026-09-06T15:00:00Z",
};

const output = {
  schemaVersion: CODING_PROTOCOL_VERSION,
  runId: "run_123",
  outcome: "changes_ready" as const,
  summary: "Fixed the test.",
  tests: [{ command: "npm test", outcome: "passed" as const }],
};

const result = {
  schemaVersion: CODING_PROTOCOL_VERSION,
  outcome: "pull_request_opened" as const,
  repository: "openai/example",
  baseRef: "main",
  headRef: "reevo/run-run_123",
  commitSha: "A".repeat(40),
  pullRequestUrl: "https://github.com/openai/example/pull/42",
  pullRequestNumber: 42,
  summary: "Opened a draft PR.",
  tests: [{ command: "npm test", outcome: "passed" as const }],
  usage: { tokensIn: 100, tokensOut: 20, costUsd: 0.01 },
};

describe("GitHub repository normalization", () => {
  it("normalizes canonical names and uncredentialed HTTPS URLs", () => {
    expect(normalizeGitHubRepository("OpenAI/Example.git")).toBe("openai/example");
    expect(normalizeGitHubRepository("https://github.com/OpenAI/Example.git")).toBe("openai/example");
  });

  it.each([
    "https://token@github.com/openai/example",
    "https://user:secret@github.com/openai/example",
    "https://github.com/openai/example?token=secret",
    "https://github.com/openai/example/extra",
    "http://github.com/openai/example",
    "https://gitlab.com/openai/example",
    "git@github.com:openai/example.git",
    "../openai/example",
    "openai/../example",
  ])("rejects unsafe repository %s", (repository) => {
    expect(() => normalizeGitHubRepository(repository)).toThrow();
  });
});

describe("Git ref normalization", () => {
  it("normalizes a full branch ref without invoking a shell", () => {
    expect(normalizeGitRef("refs/heads/feature/safe-name")).toBe("feature/safe-name");
  });

  it.each([
    "-c core.hooksPath=/tmp/pwn",
    "../main",
    "feature/../../main",
    "feature//name",
    "feature name",
    "feature~1",
    "feature^2",
    "feature:evil",
    "feature?evil",
    "feature*evil",
    "feature[evil",
    "feature\\evil",
    "feature@{evil",
    ".hidden/main",
    "feature/name.lock",
    "feature\u0000evil",
  ])("rejects malicious ref %s", (ref) => {
    expect(() => normalizeGitRef(ref)).toThrow();
  });
});

describe("CodingTaskInputSchema", () => {
  it("normalizes trusted identifiers and rejects unknown keys", () => {
    expect(CodingTaskInputSchema.parse(input)).toMatchObject({ repository: "openai/example", baseRef: "main" });
    expect(() => CodingTaskInputSchema.parse({ ...input, credential: "secret" })).toThrow();
  });

  it("requires a deterministic head ref", () => {
    expect(() => CodingTaskInputSchema.parse({ ...input, headRef: "attacker/branch" })).toThrow(/runId/);
  });

  it("enforces task bytes and control-character rules", () => {
    expect(() => CodingTaskInputSchema.parse({ ...input, task: "x".repeat(MAX_CODING_TASK_BYTES + 1) })).toThrow();
    expect(() => CodingTaskInputSchema.parse({ ...input, task: "safe\u0000hidden" })).toThrow();
    expect(() => CodingTaskInputSchema.parse({ ...input, task: "😀".repeat(MAX_CODING_TASK_BYTES / 2) })).toThrow();
  });
});

describe("CodingAgentOutputSchema", () => {
  it("bounds summary, test count, and command bytes", () => {
    expect(() =>
      CodingAgentOutputSchema.parse({ ...output, summary: "x".repeat(MAX_CODING_SUMMARY_BYTES + 1) }),
    ).toThrow();
    expect(() =>
      CodingAgentOutputSchema.parse({ ...output, tests: Array(MAX_CODING_TESTS + 1).fill(output.tests[0]) }),
    ).toThrow();
    expect(() =>
      CodingAgentOutputSchema.parse({
        ...output,
        tests: [{ command: "x".repeat(MAX_CODING_TEST_COMMAND_BYTES + 1), outcome: "failed" }],
      }),
    ).toThrow();
  });

  it("redacts token-shaped values before returning untrusted output", () => {
    const untrustedOutput = {
      ...output,
      summary: "leaked sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456",
      tests: [{ command: "echo ghp_abcdefghijklmnopqrstuvwxyz123456", outcome: "failed" }],
    };
    const parsed = parseCodingAgentOutputJson(JSON.stringify(untrustedOutput));
    expect(parsed.summary).toBe("leaked [REDACTED]");
    expect(parsed.tests[0].command).toBe("echo [REDACTED]");
    expect(CodingAgentOutputSchema.parse(untrustedOutput).summary).toBe("leaked [REDACTED]");
  });

  it("rejects unknown output and nested test keys", () => {
    expect(() => CodingAgentOutputSchema.parse({ ...output, rawLog: "unsafe" })).toThrow();
    expect(() =>
      CodingAgentOutputSchema.parse({
        ...output,
        tests: [{ ...output.tests[0], environment: "secret" }],
      }),
    ).toThrow();
  });
});

describe("CodingRunResultSchema", () => {
  it("binds PR URL, repository, number, and fields to the PR outcome", () => {
    expect(CodingRunResultSchema.parse(result)).toMatchObject({ commitSha: "a".repeat(40) });
    expect(() =>
      CodingRunResultSchema.parse({ ...result, pullRequestUrl: "https://github.com/other/repo/pull/42" }),
    ).toThrow();
    expect(() => CodingRunResultSchema.parse({ ...result, outcome: "no_changes" })).toThrow();
    expect(
      CodingRunResultSchema.parse({
        ...result,
        outcome: "no_changes",
        headRef: undefined,
        commitSha: undefined,
        pullRequestUrl: undefined,
        pullRequestNumber: undefined,
      }),
    ).toMatchObject({ outcome: "no_changes" });
  });

  it("rejects unknown and credential-bearing result fields", () => {
    expect(() => CodingRunResultSchema.parse({ ...result, rawLog: "unsafe" })).toThrow();
    expect(() =>
      CodingRunResultSchema.parse({
        ...result,
        pullRequestUrl: "https://token@github.com/openai/example/pull/42",
      }),
    ).toThrow();
  });
});

describe("bounded duplicate-safe JSON parsing", () => {
  it("rejects malformed JSON and duplicate keys at any depth", () => {
    expect(() => parseCodingTaskInputJson("{")).toThrow(/invalid_json/);
    expect(() => parseCodingTaskInputJson('{"schemaVersion":1,"schemaVersion":1}')).toThrow(/duplicate_key/);
    expect(() => parseCodingAgentOutputJson('{"x":{"runId":"a","runId":"b"}}')).toThrow(/duplicate_key/);
    expect(() => parseCodingRunResultJson('{"usage":{"costUsd":1,"costUsd":2}}')).toThrow(/duplicate_key/);
  });

  it("rejects an oversized artifact before parsing", () => {
    expect(() => parseCodingTaskInputJson(`{"padding":"${"x".repeat(MAX_CODING_ARTIFACT_BYTES)}"}`)).toThrow(
      /size_limit/,
    );
  });

  it("rejects excessive JSON nesting before schema validation", () => {
    expect(() => parseCodingAgentOutputJson(`${"[".repeat(65)}null${"]".repeat(65)}`)).toThrow(/nesting_limit/);
  });
});
