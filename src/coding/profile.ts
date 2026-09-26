import { z } from "zod";
import { isImmutableDockerImage } from "../providers/jobs/docker-isolation.js";
import { MAX_CODING_TASK_BYTES, normalizeGitHubRepository, normalizeGitRef } from "./protocol.js";
import { MAX_COLLECT_EXCLUDE_PATHS, validateCollectExcludePath } from "./collect-exclude.js";
import { CODING_PROVIDERS } from "./provider.js";
import { parseAllowlist, resolvePolicy } from "./registry/allowlist.js";
import { REGISTRY_ADAPTERS } from "./registry/adapters.js";

export const MIN_CODING_TIMEOUT_SEC = 60;
export const MAX_CODING_TIMEOUT_SEC = 7200;
export const MAX_PROTECTED_PATHS = 128;
export const DEFAULT_PROTECTED_PATHS = [
  ".github/workflows/**",
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
] as const;

const MAX_PROTECTED_PATH_BYTES = 512;
const INVALID_MULTILINE_CONTROL = /[\u0000\u000B\u000C\u000E-\u001F\u007F]/;
const INVALID_SINGLE_LINE_CONTROL = /[\u0000-\u001F\u007F]/;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

const repositorySchema = z
  .string()
  .refine((value) => {
    try {
      normalizeGitHubRepository(value);
      return true;
    } catch {
      return false;
    }
  }, "must be a canonical name or uncredentialed github.com repository")
  .transform(normalizeGitHubRepository);

const baseRefSchema = z
  .string()
  .refine((value) => {
    try {
      normalizeGitRef(value);
      return true;
    } catch {
      return false;
    }
  }, "must be a safe branch ref")
  .transform(normalizeGitRef);

const defaultTaskSchema = z
  .string()
  .refine((value) => byteLength(value) <= MAX_CODING_TASK_BYTES, `must be at most ${MAX_CODING_TASK_BYTES} UTF-8 bytes`)
  .refine((value) => !INVALID_MULTILINE_CONTROL.test(value), "must not contain control characters")
  .refine((value) => value.trim().length > 0, "must not be blank")
  .nullable();

const protectedPathSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0 && byteLength(value) <= MAX_PROTECTED_PATH_BYTES, "must be a bounded path")
  .refine((value) => !INVALID_SINGLE_LINE_CONTROL.test(value), "must not contain control characters")
  .refine(
    (value) => !value.startsWith("/") && !value.startsWith("./") && !value.includes("\\"),
    "must be a repository-relative POSIX path",
  )
  .refine(
    (value) => !value.split("/").some((part) => part === "" || part === "." || part === ".."),
    "must not contain empty or traversal components",
  );

const collectExcludePathSchema = z.string().transform((value, ctx) => {
  try {
    return validateCollectExcludePath(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a repository-relative path without wildcards" });
    return z.NEVER;
  }
});

const KNOWN_TOOLCHAINS = ["node", "node-python"] as const;

const toolchainSchema = z.enum(KNOWN_TOOLCHAINS);
const toolchainVersionSchema = z.string().trim().min(1).max(32).nullable();
const workerImageRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(isImmutableDockerImage, "must be an immutable repository digest")
  .nullable();
const workspaceDiskMbSchema = z.number().int().min(64).max(32_768).nullable();

const packageAllowlistSchema = z
  .record(z.string(), z.array(z.string().min(1).max(256)).max(256))
  .superRefine((value, ctx) => {
    try {
      parseAllowlist(value, REGISTRY_ADAPTERS);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "invalid allowlist",
      });
    }
  });
const packagePolicySchema = z
  .object({ minReleaseAgeDays: z.number().int().min(0).max(30).optional() })
  .strict()
  .superRefine((value, ctx) => {
    try {
      resolvePolicy(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid package policy" });
    }
  });

const codingProfileFields = {
  provider: z.enum(CODING_PROVIDERS),
  repository: repositorySchema,
  baseRef: baseRefSchema,
  defaultTask: defaultTaskSchema,
  allowWebhookTaskOverride: z.boolean(),
  timeoutSec: z.number().int().min(MIN_CODING_TIMEOUT_SEC).max(MAX_CODING_TIMEOUT_SEC),
  toolchain: toolchainSchema,
  toolchainVersion: toolchainVersionSchema,
  workerImageRef: workerImageRefSchema,
  workspaceDiskMb: workspaceDiskMbSchema,
  protectedPaths: z
    .array(protectedPathSchema)
    .min(1)
    .max(MAX_PROTECTED_PATHS)
    .transform((paths) => [...new Set(paths)]),
  collectExclude: z
    .array(collectExcludePathSchema)
    .max(MAX_COLLECT_EXCLUDE_PATHS)
    .transform((paths) => [...new Set(paths)]),
  packageAllowlist: packageAllowlistSchema,
  packagePolicy: packagePolicySchema,
};

export const CodingProfileSchema = z
  .object({
    provider: codingProfileFields.provider.default("codex"),
    repository: codingProfileFields.repository,
    baseRef: codingProfileFields.baseRef.default("main"),
    defaultTask: codingProfileFields.defaultTask.default(null),
    allowWebhookTaskOverride: codingProfileFields.allowWebhookTaskOverride.default(false),
    timeoutSec: codingProfileFields.timeoutSec.default(1800),
    protectedPaths: codingProfileFields.protectedPaths.default([...DEFAULT_PROTECTED_PATHS]),
    collectExclude: codingProfileFields.collectExclude.default([]),
    toolchain: codingProfileFields.toolchain.default("node"),
    toolchainVersion: codingProfileFields.toolchainVersion.default(null),
    workerImageRef: codingProfileFields.workerImageRef.default(null),
    workspaceDiskMb: codingProfileFields.workspaceDiskMb.default(null),
    packageAllowlist: codingProfileFields.packageAllowlist.default({}),
    packagePolicy: codingProfileFields.packagePolicy.default({}),
  })
  .strict();

export const CodingProfilePatchSchema = z
  .object({
    provider: codingProfileFields.provider.optional(),
    repository: codingProfileFields.repository.optional(),
    baseRef: codingProfileFields.baseRef.optional(),
    defaultTask: codingProfileFields.defaultTask.optional(),
    allowWebhookTaskOverride: codingProfileFields.allowWebhookTaskOverride.optional(),
    timeoutSec: codingProfileFields.timeoutSec.optional(),
    protectedPaths: codingProfileFields.protectedPaths.optional(),
    collectExclude: codingProfileFields.collectExclude.optional(),
    toolchain: codingProfileFields.toolchain.optional(),
    toolchainVersion: codingProfileFields.toolchainVersion.optional(),
    workerImageRef: codingProfileFields.workerImageRef.optional(),
    workspaceDiskMb: codingProfileFields.workspaceDiskMb.optional(),
    packageAllowlist: codingProfileFields.packageAllowlist.optional(),
    packagePolicy: codingProfileFields.packagePolicy.optional(),
  })
  .strict();

export type CodingProfile = z.infer<typeof CodingProfileSchema>;
export type CodingProfilePatch = z.infer<typeof CodingProfilePatchSchema>;
