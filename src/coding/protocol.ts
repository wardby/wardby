import { z } from "zod";

export const CODING_PROTOCOL_VERSION = 1 as const;
export const MAX_CODING_ARTIFACT_BYTES = 64 * 1024;
export const MAX_CODING_TASK_BYTES = 16 * 1024;
export const MAX_CODING_SUMMARY_BYTES = 8 * 1024;
export const MAX_CODING_TESTS = 64;
export const MAX_CODING_TEST_COMMAND_BYTES = 2 * 1024;

const MAX_REPOSITORY_INPUT_BYTES = 512;
const MAX_REF_BYTES = 255;
const MAX_MODEL_BYTES = 128;
const MAX_RUN_ID_BYTES = 128;
const MAX_COST_USD = 1_000_000;
const MAX_JSON_NESTING_DEPTH = 64;
const INVALID_MULTILINE_CONTROL = /[\u0000\u000B\u000C\u000E-\u001F\u007F]/;
const INVALID_SINGLE_LINE_CONTROL = /[\u0000-\u001F\u007F]/;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedText(maxBytes: number, singleLine = false) {
  const invalidControl = singleLine ? INVALID_SINGLE_LINE_CONTROL : INVALID_MULTILINE_CONTROL;
  return z
    .string()
    .refine((value) => byteLength(value) <= maxBytes, `must be at most ${maxBytes} UTF-8 bytes`)
    .refine((value) => !invalidControl.test(value), "must not contain control characters")
    .refine((value) => value.trim().length > 0, "must not be blank");
}

function repositoryParts(value: string): [owner: string, repository: string] {
  if (byteLength(value) > MAX_REPOSITORY_INPUT_BYTES || INVALID_SINGLE_LINE_CONTROL.test(value)) {
    throw new Error("invalid GitHub repository");
  }

  let candidate = value.trim();
  if (candidate.startsWith("https://")) {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("repository must be an uncredentialed github.com URL");
    }
    candidate = url.pathname.replace(/^\/+|\/+$/g, "");
  } else if (candidate.includes("://") || candidate.includes("@") || candidate.includes(":")) {
    throw new Error("repository URLs and credentials are not allowed");
  }

  if (candidate.endsWith(".git")) candidate = candidate.slice(0, -4);
  const parts = candidate.split("/");
  if (parts.length !== 2) throw new Error("repository must be owner/name");
  const [owner, repository] = parts;
  const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
  const repositoryPattern = /^[A-Za-z0-9._-]{1,100}$/;
  if (!ownerPattern.test(owner) || !repositoryPattern.test(repository) || repository === "." || repository === "..") {
    throw new Error("invalid GitHub owner or repository name");
  }
  return [owner.toLowerCase(), repository.toLowerCase()];
}

export function normalizeGitHubRepository(value: string): string {
  return repositoryParts(value).join("/");
}

function isGitHubRepository(value: string): boolean {
  try {
    normalizeGitHubRepository(value);
    return true;
  } catch {
    return false;
  }
}

export function normalizeGitRef(value: string): string {
  let ref = value.trim();
  if (ref.startsWith("refs/heads/")) ref = ref.slice("refs/heads/".length);
  if (!ref || byteLength(ref) > MAX_REF_BYTES || ref === "@" || ref.startsWith("-")) {
    throw new Error("invalid Git ref");
  }
  if (
    /[\u0000-\u0020\u007F~^:?*\\[]/.test(ref) ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.includes("//") ||
    ref.includes("..") ||
    ref.includes("@{")
  ) {
    throw new Error("invalid Git ref");
  }
  const components = ref.split("/");
  if (components.some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) {
    throw new Error("invalid Git ref");
  }
  return ref;
}

function isGitRef(value: string): boolean {
  try {
    normalizeGitRef(value);
    return true;
  } catch {
    return false;
  }
}

const repositorySchema = z
  .string()
  .refine(isGitHubRepository, "must be a canonical name or uncredentialed github.com repository")
  .transform(normalizeGitHubRepository);

export const CodingBaseRefSchema = z.string().refine(isGitRef, "must be a safe branch ref").transform(normalizeGitRef);

export const CodingTaskOverrideSchema = boundedText(MAX_CODING_TASK_BYTES);

const runIdSchema = boundedText(MAX_RUN_ID_BYTES, true).refine(
  (value) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value),
  "must be an opaque identifier",
);

const modelSchema = boundedText(MAX_MODEL_BYTES, true).refine(
  (value) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value),
  "must be a model identifier",
);

const usageSchema = z
  .object({
    tokensIn: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    tokensOut: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    costUsd: z.number().finite().nonnegative().max(MAX_COST_USD),
  })
  .strict();

const testResultSchema = z
  .object({
    command: boundedText(MAX_CODING_TEST_COMMAND_BYTES, true),
    outcome: z.enum(["passed", "failed", "skipped"]),
  })
  .strict();

export const CodingTaskInputSchema = z
  .object({
    schemaVersion: z.literal(CODING_PROTOCOL_VERSION),
    runId: runIdSchema,
    repository: repositorySchema,
    baseRef: CodingBaseRefSchema,
    headRef: CodingBaseRefSchema,
    task: CodingTaskOverrideSchema,
    model: modelSchema,
    budgetUsd: z.number().finite().positive().max(MAX_COST_USD),
    deadlineAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.headRef !== `reevo/run-${value.runId}`) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["headRef"], message: "must match reevo/run-<runId>" });
    }
  });

export const CodingAgentOutputSchema = z
  .object({
    schemaVersion: z.literal(CODING_PROTOCOL_VERSION),
    runId: runIdSchema,
    outcome: z.enum(["changes_ready", "no_changes", "budget_exhausted"]),
    summary: boundedText(MAX_CODING_SUMMARY_BYTES),
    tests: z.array(testResultSchema).max(MAX_CODING_TESTS),
  })
  .strict()
  .transform((value) => ({
    ...value,
    summary: redactTokenShapedValues(value.summary),
    tests: value.tests.map((test) => ({ ...test, command: redactTokenShapedValues(test.command) })),
  }));

const pullRequestUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname.toLowerCase() === "github.com" &&
        !url.port &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "must be an uncredentialed github.com URL");

export const CodingRunResultSchema = z
  .object({
    schemaVersion: z.literal(CODING_PROTOCOL_VERSION),
    outcome: z.enum(["pull_request_opened", "no_changes", "budget_exhausted"]),
    repository: repositorySchema,
    baseRef: CodingBaseRefSchema,
    headRef: CodingBaseRefSchema.optional(),
    commitSha: z
      .string()
      .regex(/^[0-9a-fA-F]{40}$/)
      .transform((value) => value.toLowerCase())
      .optional(),
    pullRequestUrl: pullRequestUrlSchema.optional(),
    pullRequestNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    summary: boundedText(MAX_CODING_SUMMARY_BYTES),
    tests: z.array(testResultSchema).max(MAX_CODING_TESTS),
    usage: usageSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const prFields = [value.headRef, value.commitSha, value.pullRequestUrl, value.pullRequestNumber];
    if (value.outcome === "pull_request_opened" && prFields.some((field) => field === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pull_request_opened requires all PR fields" });
    }
    if (value.outcome !== "pull_request_opened" && prFields.some((field) => field !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "non-PR outcomes must not include PR fields" });
    }
    if (value.pullRequestUrl && value.pullRequestNumber) {
      const expected = `https://github.com/${value.repository}/pull/${value.pullRequestNumber}`;
      if (value.pullRequestUrl !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pullRequestUrl"],
          message: "must match repository and PR number",
        });
      }
    }
  })
  .transform((value) => ({
    ...value,
    summary: redactTokenShapedValues(value.summary),
    tests: value.tests.map((test) => ({ ...test, command: redactTokenShapedValues(test.command) })),
  }));

export type CodingTaskInput = z.infer<typeof CodingTaskInputSchema>;
export type CodingAgentOutput = z.infer<typeof CodingAgentOutputSchema>;
export type CodingRunResult = z.infer<typeof CodingRunResultSchema>;

/** Parses stored worker output into the only coding result shape callers may receive. */
export function publicCodingRunResult(value: unknown): CodingRunResult | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = CodingRunResultSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const TOKEN_PATTERNS = [
  /sk-(?:ant-)?[A-Za-z0-9_-]{16,}/gi,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /rrp_[A-Za-z0-9_-]{32,}/g,
  /rv[a-z]_[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}/gi,
];

export function redactTokenShapedValues(value: string): string {
  return TOKEN_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, "[REDACTED]"), value);
}

function parseJsonWithoutDuplicateKeys(text: string): unknown {
  if (byteLength(text) > MAX_CODING_ARTIFACT_BYTES) throw new Error("coding_artifact_size_limit");
  let offset = 0;

  const whitespace = () => {
    while (/\s/.test(text[offset] ?? "")) offset += 1;
  };
  const string = (): string => {
    const start = offset;
    if (text[offset++] !== '"') throw new Error("coding_artifact_invalid_json");
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '"') {
        try {
          return JSON.parse(text.slice(start, offset)) as string;
        } catch {
          throw new Error("coding_artifact_invalid_json");
        }
      }
      if (character === "\\") offset += 1;
      else if (character.charCodeAt(0) < 0x20) throw new Error("coding_artifact_invalid_json");
    }
    throw new Error("coding_artifact_invalid_json");
  };
  const value = (depth = 0): void => {
    if (depth > MAX_JSON_NESTING_DEPTH) throw new Error("coding_artifact_nesting_limit");
    whitespace();
    if (text[offset] === "{") {
      offset += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      for (;;) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error(`coding_artifact_duplicate_key:${key}`);
        keys.add(key);
        whitespace();
        if (text[offset++] !== ":") throw new Error("coding_artifact_invalid_json");
        value(depth + 1);
        whitespace();
        const separator = text[offset++];
        if (separator === "}") return;
        if (separator !== ",") throw new Error("coding_artifact_invalid_json");
      }
    }
    if (text[offset] === "[") {
      offset += 1;
      whitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      for (;;) {
        value(depth + 1);
        whitespace();
        const separator = text[offset++];
        if (separator === "]") return;
        if (separator !== ",") throw new Error("coding_artifact_invalid_json");
      }
    }
    if (text[offset] === '"') {
      string();
      return;
    }
    const token = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(offset));
    if (!token) throw new Error("coding_artifact_invalid_json");
    offset += token[0].length;
  };

  value();
  whitespace();
  if (offset !== text.length) throw new Error("coding_artifact_invalid_json");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("coding_artifact_invalid_json");
  }
}

export function parseCodingTaskInputJson(text: string): CodingTaskInput {
  return CodingTaskInputSchema.parse(parseJsonWithoutDuplicateKeys(text));
}

export function parseCodingAgentOutputJson(text: string): CodingAgentOutput {
  return CodingAgentOutputSchema.parse(parseJsonWithoutDuplicateKeys(text));
}

export function parseCodingRunResultJson(text: string): CodingRunResult {
  return CodingRunResultSchema.parse(parseJsonWithoutDuplicateKeys(text));
}
