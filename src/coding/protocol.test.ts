import { describe, expect, it } from "vitest";
import {
  CODING_PROTOCOL_VERSION,
  CodingAgentOutputSchema,
  CodingRunResultSchema,
  normalizeCodingTag,
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
  MAX_REDACTED_SPAN,
  TRAILING_ANCHORED_PATTERNS,
  redactAndTruncate,
  redactTokenShapedValues,
} from "./protocol.js";

const input = {
  schemaVersion: CODING_PROTOCOL_VERSION,
  runId: "run_123",
  repository: "OpenAI/Example.git",
  baseRef: "refs/heads/main",
  headRef: "wardby/run-run_123",
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
  headRef: "wardby/run-run_123",
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

  it("accepts an omitted tag and a short safe one", () => {
    expect(CodingAgentOutputSchema.parse(output).tag).toBeUndefined();
    expect(CodingAgentOutputSchema.parse({ ...output, tag: "JIRA-123" }).tag).toBe("JIRA-123");
  });

  it.each([
    ["JIRA 123", "jira-123"],
    ["tag]evil", "tag-evil"],
    ["tag[evil", "tag-evil"],
    ["Add 20 new jokes", "add-20-new-jokes"],
    ["feat: jokes!", "feat-jokes"],
    ["-leading punctuation-", "leading-punctuation"],
    ["x".repeat(33), "x".repeat(32)],
    ["add twenty new knock-knock jokes for issue 37", "add-twenty-new-knock-knock-jokes"],
  ])("normalizes a model-written tag %j to %j instead of failing the run", (tag, expected) => {
    expect(CodingAgentOutputSchema.parse({ ...output, tag }).tag).toBe(expected);
  });

  it.each(["!!!", "   ", "", 42, {}])("drops a tag %j with nothing usable left", (tag) => {
    expect(CodingAgentOutputSchema.parse({ ...output, tag }).tag).toBeUndefined();
  });

  it("keeps an already valid tag exactly", () => {
    expect(normalizeCodingTag("JIRA-123")).toBe("JIRA-123");
    expect(normalizeCodingTag("deps/bump_v1.2")).toBe("deps/bump_v1.2");
    expect(normalizeCodingTag(null)).toBeNull();
    expect(normalizeCodingTag(undefined)).toBeUndefined();
  });

  it("redacts a token-shaped tag", () => {
    expect(CodingAgentOutputSchema.parse({ ...output, tag: `ghp_${"a".repeat(20)}` }).tag).toBe("[REDACTED]");
  });

  it("treats an explicit null tag the same as an absent one", () => {
    // OpenAI's strict Structured Outputs mode requires every property in required, so the worker
    // always emits a "tag" key — null, not omitted, means "no tag" (see coding-worker/driver.ts).
    expect(CodingAgentOutputSchema.parse({ ...output, tag: null }).tag).toBeUndefined();
  });
});

describe("CodingRunResultSchema", () => {
  it("still rejects an unsafe tag in a persisted result, which only trusted code writes", () => {
    expect(() => CodingRunResultSchema.parse({ ...result, tag: "Add 20 jokes" })).toThrow();
  });

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

  it("accepts an omitted tag, a null tag, and a short safe one, rejecting unsafe ones", () => {
    expect(CodingRunResultSchema.parse(result).tag).toBeUndefined();
    expect(CodingRunResultSchema.parse({ ...result, tag: null }).tag).toBeUndefined();
    expect(CodingRunResultSchema.parse({ ...result, tag: "GH-42" }).tag).toBe("GH-42");
    expect(() => CodingRunResultSchema.parse({ ...result, tag: "tag]evil" })).toThrow();
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

describe("redactTokenShapedValues", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

  it("redacts the credential shapes an operator log can pick up from a cause chain", () => {
    // A JWT (delegating auth), a Google access token, an AWS secret in
    // key=value form, and a PEM block — none of which the token patterns
    // covered before.
    expect(redactTokenShapedValues(`bearer token ${jwt} rejected`)).toBe("bearer token [REDACTED] rejected");
    expect(redactTokenShapedValues(`ya29.${"a".repeat(40)}`)).toBe("[REDACTED]");
    expect(redactTokenShapedValues('aws_secret_access_key="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEX"')).toBe(
      'aws_secret_access_key="[REDACTED]"',
    );
    const fakePrivateKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK\n-----END RSA PRIVATE KEY-----"; // gitleaks:allow -- malformed test fixture
    expect(redactTokenShapedValues(fakePrivateKey)).toBe("[REDACTED]");
  });

  it("redacts a URL's userinfo even when the password is not token-shaped", () => {
    expect(redactTokenShapedValues("clone https://git:hunter2@github.com/o/r failed")).toBe(
      "clone https://[REDACTED]@github.com/o/r failed",
    );
    expect(redactTokenShapedValues(`fatal: https://x-access-token:ghs_${"a".repeat(36)}@github.com/o/r`)).toBe(
      "fatal: https://[REDACTED]@github.com/o/r",
    );
  });

  it("scales linearly on adversarial input — redaction runs over untrusted git output", () => {
    // Doubling the input must not much more than double the cost. This is the
    // assertion that discriminates: a reintroduced quadratic is 100-300x, while
    // a machine being slow shifts both halves equally and changes nothing. The
    // shapes use SEPARATOR runs, not spaces — a space caps every in-class run
    // at a few characters, which is why an earlier space-separated JWT case
    // passed at 9.7 ms while that pattern was still quadratic (13.7 s on
    // `"eyJ-".repeat(50_000)`).
    const shapes = {
      "lowercase run": (n: number) => "a".repeat(n),
      whitespace: (n: number) => " ".repeat(n),
      "base64 run": (n: number) => "aB9+/=".repeat(n / 6),
      "jwt hyphen run": (n: number) => "eyJ-".repeat(n / 4),
      "jwt token run": (n: number) => `eyJ${"a".repeat(20)}-`.repeat(n / 24),
      "ya29 hyphen run": (n: number) => `ya29.${"a".repeat(20)}-`.repeat(n / 26),
      "unterminated PEM blocks": (n: number) => "-----BEGIN PRIVATE KEY-----".repeat(n / 27),
      "aws key body": (n: number) => `aws_secret_access_key="${"A".repeat(n)}`,
    };
    // Best-of-5 after one warm-up call: the cost is deterministic, so the
    // minimum strips scheduler noise without making the ratio meaningless, and
    // the warm-up keeps JIT compilation out of the first measurement.
    const cost = (input: string): number => {
      redactTokenShapedValues(input);
      let best = Infinity;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const startedAt = performance.now();
        redactTokenShapedValues(input);
        best = Math.min(best, performance.now() - startedAt);
      }
      return best;
    };

    // A 4x step, not 2x. At 2x, linear scaling gives a ratio of 2 and quadratic
    // gives 4, so any threshold between them has at most 1.5x headroom -- and the
    // previous threshold of 3 flaked on GitHub's 2-vCPU runners at 3.26 and
    // 3.79, failing `verify` on main while passing locally even under full CPU
    // load. At 4x, linear gives 4 and quadratic 16, so a threshold of 8 has 2x
    // margin on both sides.
    //
    // The floor is 5 ms rather than 0.5 ms for the same reason. The flaking
    // shape runs in well under a millisecond, where a ratio measures scheduler
    // noise, not the regex. A reintroduced quadratic is nowhere near the floor:
    // at 100k characters it costs seconds (see above), so the floor only ever
    // silences noise, never a regression.
    const SCALE = 4;
    const RATIO_LIMIT = 8;
    const FLOOR_MS = 5;
    for (const [shape, build] of Object.entries(shapes)) {
      const half = cost(build(100_000));
      const full = cost(build(100_000 * SCALE));
      expect(full / Math.max(half, FLOOR_MS), `${shape} must scale linearly, not quadratically`).toBeLessThan(
        RATIO_LIMIT,
      );
      // Absolute backstop, for the case where both measurements are slow. The
      // binding shape costs ~136 ms at 400k locally, but 500 ms flaked on
      // GitHub's 2-vCPU runners (557 ms for the jwt hyphen run) while the ratio
      // check above passed. A reintroduced quadratic costs seconds at 400k and
      // already fails the ratio, so this bound only has to catch a stall, not
      // a slow runner.
      expect(full, `${shape} must not stall the event loop`).toBeLessThan(2000);
    }
  }, 60_000);

  it("keeps every trailing-anchored pattern inside MAX_REDACTED_SPAN", () => {
    // redactAndTruncate's window is only safe while a pattern that needs its
    // trailing anchor (`@`, `-----END …`) cannot match a span longer than the
    // margin. That coupling was documented and unenforced: raising a bound in
    // protocol.ts must fail HERE rather than silently breaking the window.
    const longest = (pattern: RegExp, build: (n: number) => string): number => {
      // Grow each variable region until the pattern stops matching, then
      // measure the real maximal match rather than trusting the literals.
      let low = 1;
      let high = 4 * MAX_REDACTED_SPAN;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (new RegExp(pattern.source, pattern.flags).test(build(middle))) low = middle;
        else high = middle - 1;
      }
      const match = new RegExp(pattern.source, pattern.flags).exec(build(low));
      expect(match, "the constructed maximal candidate must still match").not.toBeNull();
      return match?.[0].length ?? 0;
    };

    const { urlCredentials, pemPrivateKey } = TRAILING_ANCHORED_PATTERNS;
    const urlSpan = longest(urlCredentials, (n) => `h${"t".repeat(n)}://${"u".repeat(n)}:${"p".repeat(n)}@host`);
    const pemSpan = longest(
      pemPrivateKey,
      (n) =>
        `-----BEGIN ${"A".repeat(Math.min(n, 32))} PRIVATE KEY-----${"x".repeat(n)}-----END ${"A".repeat(Math.min(n, 32))} PRIVATE KEY-----`,
    );

    expect(urlSpan).toBeLessThanOrEqual(MAX_REDACTED_SPAN);
    expect(pemSpan).toBeLessThanOrEqual(MAX_REDACTED_SPAN);
    // Pin the measured spans too: a change here is a deliberate decision, and
    // it has to be re-checked against the window either way.
    expect({ urlSpan, pemSpan }).toEqual({ urlSpan: 1061, pemSpan: 6262 });
  });

  it("redactAndTruncate keeps a credential that straddles the truncation point out of the output", () => {
    const secret = `https://x-access-token:ghs_${"a".repeat(36)}@github.com/o/r`;
    const noisy = `${"x".repeat(90)}${secret}${"y".repeat(200_000)}`;
    const shown = redactAndTruncate(noisy, 100);
    // Truncating first would have printed the front of the token; redacting
    // first leaves only the (possibly clipped) replacement at the cut.
    expect(shown).toHaveLength(100);
    expect(shown.slice(90)).toBe("https://[R");
    expect(shown).not.toContain("ghs_");
    expect(shown).not.toContain("x-access-token");
    // And with room to spare, the whole replacement survives.
    expect(redactAndTruncate(`${"x".repeat(10)}${secret}`, 100)).toContain("https://[REDACTED]@github.com/o/r");
  });

  it("leaves ordinary text alone — a commit sha is not a secret", () => {
    const sha = "a".repeat(40);
    expect(redactTokenShapedValues(`checked out ${sha} from https://github.com/o/r`)).toBe(
      `checked out ${sha} from https://github.com/o/r`,
    );
    expect(redactTokenShapedValues("npm test failed: 3 of 12 assertions")).toBe("npm test failed: 3 of 12 assertions");
  });
});
