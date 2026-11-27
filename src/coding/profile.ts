import { z } from "zod";
import { isImmutableDockerImage } from "../providers/jobs/docker-isolation.js";
import {
  MAX_CODING_TASK_BYTES,
  MAX_CLAUDE_MAX_OUTPUT_TOKENS,
  MAX_CODING_TURNS,
  MIN_CLAUDE_MAX_OUTPUT_TOKENS,
  isLocalRepository,
  normalizeGitHubRepository,
  normalizeGitRef,
  normalizeLocalRepository,
} from "./protocol.js";
import { MAX_COLLECT_EXCLUDE_PATHS, validateCollectExcludePath } from "./collect-exclude.js";
import { CODING_PROVIDERS } from "./provider.js";
import { GOOGLE_WEB_TOOLS } from "./google-web-tools.js";
import { WARDBY_PROTECTED_PATHS, isWellFormedProtectedPath, protectsSomePath } from "./protected-paths.js";
import { acceptedAdvisoriesSchema, parseAllowlist, resolvePolicy } from "./registry/allowlist.js";
import { REGISTRY_ADAPTERS } from "./registry/adapters.js";
import { AllowedServiceNamesSchema } from "./services/catalog.js";
import {
  MAX_TUNNEL_HOSTS,
  TUNNEL_HOSTS_INVALID,
  parseTunnelHostPattern,
  tunnelHostRefusalText,
} from "./tunnel-hosts.js";

/** Gemini 4's published output limit (thinking counts toward it); the proxy holds an unset request at this. */
export const GEMINI_MAX_OUTPUT_TOKENS = 65_536;

export const MIN_CODING_TIMEOUT_SEC = 60;
export const MAX_CODING_TIMEOUT_SEC = 7200;
export const MAX_PROTECTED_PATHS = 128;
export const DEFAULT_PROTECTED_PATHS = [
  ".github/workflows/**",
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
  // Enforced for every run anyway (providers/vcs/git.ts protectedPathMatcher); listed so new agents show it.
  ...WARDBY_PROTECTED_PATHS,
] as const;

const MAX_PROTECTED_PATH_BYTES = 512;
const INVALID_MULTILINE_CONTROL = /[\u0000\u000B\u000C\u000E-\u001F\u007F]/;
const INVALID_SINGLE_LINE_CONTROL = /[\u0000-\u001F\u007F]/;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** GitHub names, or `local:/abs/path` (syntactic only; trusted roots are enforced where it is authorized and used). */
function normalizeProfileRepository(value: string): string {
  return isLocalRepository(value) ? normalizeLocalRepository(value) : normalizeGitHubRepository(value);
}

const repositorySchema = z
  .string()
  .refine((value) => {
    try {
      normalizeProfileRepository(value);
      return true;
    } catch {
      return false;
    }
  }, "must be a canonical name, an uncredentialed github.com repository, or local:/absolute/path")
  .transform(normalizeProfileRepository);

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
    isWellFormedProtectedPath,
    "must be a repository-relative POSIX path without empty or traversal components, or ! and a literal file path (no wildcards) for an exception",
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
/**
 * Git history in runs (#536): the clone depth (1..100000) or "full"; null = off, today's behaviour.
 * Strict: any other key is rejected.
 */
export const MAX_GIT_HISTORY_DEPTH = 100_000;
const gitHistorySchema = z
  .object({ depth: z.union([z.number().int().min(1).max(MAX_GIT_HISTORY_DEPTH), z.literal("full")]) })
  .strict()
  .nullable();
/** A workflow script's name: the file `.claude/workflows/<name>.js` (docs: coding workflows, #582). */
export const WORKFLOW_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** A field of a workflow script's returned object (workflow.replyField). */
export const WORKFLOW_REPLY_FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/**
 * Claude Code runs only: run this workflow script (`.claude/workflows/<name>.js`) with Claude Code's
 * own Workflow tool. `repository` is a link name (omitted = the default repository), read at the
 * commit resolved for the run. Null = no workflow.
 */
export const WorkflowSchema = z
  .object({
    name: z
      .string()
      .regex(WORKFLOW_NAME, "must be 1-64 letters, digits, _ or - (the file .claude/workflows/<name>.js)"),
    repository: z
      .string()
      .min(1)
      .max(300)
      .refine((value) => !INVALID_SINGLE_LINE_CONTROL.test(value), "must not contain control characters")
      .optional(),
    /**
     * The field of the script's returned object that is the run's reply, posted word for word (the
     * pull request body comes from prBody). Omitted = the session's own summary of the result.
     */
    replyField: z
      .string()
      .regex(WORKFLOW_REPLY_FIELD, "must be 1-64 letters, digits or _, starting with a letter or _")
      .optional(),
  })
  .strict()
  .nullable();
export type CodingWorkflow = NonNullable<z.infer<typeof WorkflowSchema>>;

/** Claude Code and Gemini CLI runs: the most agent turns a run may take; null = the worker default (DEFAULT_CLAUDE_MAX_TURNS). */
const maxTurnsSchema = z.number().int().min(1).max(MAX_CODING_TURNS).nullable();
/**
 * Claude Code and Gemini CLI runs: the most output tokens per model reply; null = the
 * worker default (DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS; on Gemini CLI, GEMINI_MAX_OUTPUT_TOKENS,
 * which is also its upper bound). The proxy reserves this x the output price per request
 * against the run budget.
 */
const maxOutputTokensSchema = z
  .number()
  .int()
  .min(MIN_CLAUDE_MAX_OUTPUT_TOKENS)
  .max(MAX_CLAUDE_MAX_OUTPUT_TOKENS)
  .nullable();

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
  .object({
    minReleaseAgeDays: z.number().int().min(0).max(30).optional(),
    acceptedAdvisories: acceptedAdvisoriesSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      resolvePolicy(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid package policy" });
    }
  });

/**
 * Per-agent CONNECT tunnel hosts (src/coding/tunnel-hosts.ts): up to 50 exact hosts, `*.domain` patterns or
 * `*`, normalised and de-duplicated. Syntax only: the operator's ceiling and the admin approval `*` needs are
 * checked where the agent is saved, and the ceiling again at dispatch. Empty = none.
 */
const tunnelHostsSchema = z
  .array(z.string().max(300, `${TUNNEL_HOSTS_INVALID}: each entry is a hostname of at most 253 characters`))
  .max(MAX_TUNNEL_HOSTS, `${TUNNEL_HOSTS_INVALID}: at most ${MAX_TUNNEL_HOSTS} entries`)
  .transform((values, ctx) => {
    const patterns: string[] = [];
    values.forEach((value, index) => {
      const parsed = parseTunnelHostPattern(value);
      if (parsed.ok) patterns.push(parsed.pattern);
      else
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `${TUNNEL_HOSTS_INVALID}: entry ${index} ${tunnelHostRefusalText(parsed.reason)}`,
        });
    });
    return [...new Set(patterns)];
  });

const PLAN_PATH = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._{}/-]{1,200}\/$/;
export const PlanDocumentSchema = z
  .object({
    store: z.enum(["wardby", "repository"]).default("wardby"),
    path: z
      .string()
      .regex(PLAN_PATH, "must be a repository folder ending in /")
      .refine((p) => p.split("{n}").length === 2, "must hold {n} once")
      .optional(),
    reviewers: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
    finalApproverId: z.string().min(1).max(200).optional(),
    onApproved: z.enum(["notify", "build"]).default("notify"),
    builderAgentId: z.string().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.store === "repository" && !value.path) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["path"], message: "required for store repository" });
    }
    if (value.store === "wardby" && value.path) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["path"], message: "only for store repository" });
    }
    if (value.onApproved === "build" && !value.builderAgentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["builderAgentId"], message: "required for onApproved build" });
    }
  });
export type PlanDocumentInput = z.infer<typeof PlanDocumentSchema>;
export type PlanDocument = PlanDocumentInput & { reviewers: string[] };

/** A stored planDocument for a reader (dispatch, publish, approval): reviewers default to the owner (R20). */
export function readPlanDocument(stored: unknown, ownerId: string | null): PlanDocument | null {
  if (stored === null || stored === undefined) return null;
  const parsed = PlanDocumentSchema.parse(stored);
  return { ...parsed, reviewers: parsed.reviewers ?? (ownerId ? [ownerId] : []) };
}

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
  gitHistory: gitHistorySchema,
  maxTurns: maxTurnsSchema,
  maxOutputTokens: maxOutputTokensSchema,
  protectedPaths: z
    .array(protectedPathSchema)
    .min(1)
    .max(MAX_PROTECTED_PATHS)
    .refine(protectsSomePath, "must protect at least one path; entries starting with ! are only exceptions")
    .transform((paths) => [...new Set(paths)]),
  collectExclude: z
    .array(collectExcludePathSchema)
    .max(MAX_COLLECT_EXCLUDE_PATHS)
    .transform((paths) => [...new Set(paths)]),
  packageAllowlist: packageAllowlistSchema,
  packagePolicy: packagePolicySchema,
  /** Coding-run services this agent's runs may start: catalog names, any version (docs/coding-services.md). */
  services: AllowedServiceNamesSchema,
  repoSkills: z.boolean(),
  claudeBareMode: z.boolean(),
  /** Restore npm node_modules from a snapshot the proxy re-approves (docs: dependency cache). */
  dependencyCache: z.boolean(),
  /** Keep each run's redacted Claude Code session transcript so it can be resumed locally. */
  sessionResume: z.boolean(),
  /** Publish this agent's plan as reviewable documents (docs: plan documents). */
  planDocument: PlanDocumentSchema.nullable(),
  /** Refuse to build from a plan set that is not fully approved. */
  buildFromPlan: z.boolean(),
  /** Run a repository workflow script instead of a free-form task (Claude Code only, #582). */
  workflow: WorkflowSchema,
  /** Hosts this agent's runs may reach through the CONNECT tunnel, on top of the server list (#627). */
  tunnelHosts: tunnelHostsSchema,
  /** Gemini's server-side web tools (googleSearch / urlContext); provider-neutral, used by Gemini CLI runs today. */
  webTools: z.enum(GOOGLE_WEB_TOOLS),
  /** Claude Code and Gemini CLI sub-agents (spec §3a); Codex accepts it with no effect. */
  subAgents: z.boolean(),
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
    gitHistory: codingProfileFields.gitHistory.default(null),
    maxTurns: codingProfileFields.maxTurns.default(null),
    maxOutputTokens: codingProfileFields.maxOutputTokens.default(null),
    packageAllowlist: codingProfileFields.packageAllowlist.default({}),
    packagePolicy: codingProfileFields.packagePolicy.default({}),
    services: codingProfileFields.services.default([]),
    repoSkills: codingProfileFields.repoSkills.default(true),
    claudeBareMode: codingProfileFields.claudeBareMode.default(true),
    dependencyCache: codingProfileFields.dependencyCache.default(false),
    sessionResume: codingProfileFields.sessionResume.default(false),
    planDocument: codingProfileFields.planDocument.default(null),
    buildFromPlan: codingProfileFields.buildFromPlan.default(false),
    workflow: codingProfileFields.workflow.default(null),
    tunnelHosts: codingProfileFields.tunnelHosts.default([]),
    webTools: codingProfileFields.webTools.default("off"),
    subAgents: codingProfileFields.subAgents.default(true),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (profile.workflow !== null && profile.provider !== "claude-code") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workflow"],
        message: "workflow applies to Claude Code agents only (provider claude-code); set it to null",
      });
    }
    if (profile.workflow !== null && profile.gitHistory === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workflow"],
        message:
          'a workflow run needs git history: set gitHistory (for example { "depth": 1 }) so the script\'s git commands and commits work',
      });
    }
    if (profile.sessionResume && profile.provider !== "claude-code") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sessionResume"],
        message: "sessionResume applies to Claude Code agents only (provider claude-code); set it to false",
      });
    }
    if (profile.maxOutputTokens !== null && profile.provider !== "claude-code" && profile.provider !== "gemini-cli") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxOutputTokens"],
        message:
          "maxOutputTokens applies to Claude Code and Gemini CLI agents only (provider claude-code or gemini-cli); set it to null",
      });
    }
    if (
      profile.maxOutputTokens !== null &&
      profile.provider === "gemini-cli" &&
      profile.maxOutputTokens > GEMINI_MAX_OUTPUT_TOKENS
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxOutputTokens"],
        message: `a Gemini CLI agent's maxOutputTokens is at most ${GEMINI_MAX_OUTPUT_TOKENS} (Gemini 4's output limit)`,
      });
    }
  });

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
    gitHistory: codingProfileFields.gitHistory.optional(),
    maxTurns: codingProfileFields.maxTurns.optional(),
    maxOutputTokens: codingProfileFields.maxOutputTokens.optional(),
    packageAllowlist: codingProfileFields.packageAllowlist.optional(),
    packagePolicy: codingProfileFields.packagePolicy.optional(),
    services: codingProfileFields.services.optional(),
    repoSkills: codingProfileFields.repoSkills.optional(),
    claudeBareMode: codingProfileFields.claudeBareMode.optional(),
    dependencyCache: codingProfileFields.dependencyCache.optional(),
    sessionResume: codingProfileFields.sessionResume.optional(),
    planDocument: codingProfileFields.planDocument.optional(),
    buildFromPlan: codingProfileFields.buildFromPlan.optional(),
    workflow: codingProfileFields.workflow.optional(),
    tunnelHosts: codingProfileFields.tunnelHosts.optional(),
    webTools: codingProfileFields.webTools.optional(),
    subAgents: codingProfileFields.subAgents.optional(),
  })
  .strict();

export type CodingProfile = z.infer<typeof CodingProfileSchema>;
export type CodingProfilePatch = z.infer<typeof CodingProfilePatchSchema>;
