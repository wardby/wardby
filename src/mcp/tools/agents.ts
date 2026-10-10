/**
 * Agent CRUD with scope checks in server.ts and access checks here
 * (auth/access.ts: owner, or a grant of read < execute < write). Owner-only
 * whatever the grants: delete_agent and repository changes; make_owner is
 * the agents:admin escape hatch. See
 * docs/private/2026-09-26-resource-sharing-grants-spec-and-plan.md.
 */
import { Prisma, type CodingAgentProfile, type NativeExecutionMode } from "#prisma";
import { z } from "zod";
import { CodingProfilePatchSchema, CodingProfileSchema, type CodingProfile } from "../../coding/profile.js";
import { DEFAULT_CLAUDE_MAX_TURNS, MAX_CODING_TURNS, isLocalRepository } from "../../coding/protocol.js";
import { codingProviderSupportsModel } from "../../coding/provider.js";
import { assertAgentModelAvailable } from "../../core/run-pricing.js";
import { ModelUnavailableError } from "../../providers/llm/catalog-types.js";
import { currentModelCatalog } from "../../providers/llm/catalog-store.js";
import { validateCronExpression } from "../../core/cron.js";
import { modelSupportedEfforts } from "../../providers/llm/routing.js";
import { PROJECT_KEY } from "../../providers/issue-tracker/types.js";
import { LLM_EFFORT_LEVELS, isLlmEffort } from "../../providers/llm/types.js";
import { requireReadableBudgetGroup } from "../auth/ownership.js";
import {
  agentAccessResolver,
  agentNotFound,
  assertAgentAccess,
  readableAgentsWhere,
  requireAgentAccess,
} from "../auth/access.js";
import { EVERYONE_KEY, atLeast, canDelegate, deleteGrantsFor, effectiveAccess } from "../../core/grants.js";
import { projectTool } from "./tools.js";
import { requireAnyScope, requireScope } from "../auth/resource-server.js";
import { logger } from "../../core/logger.js";
import {
  authorizeRepositoryForSet,
  canonicalLocalRepository,
  type RepositoryAuthorization,
} from "../auth/repo-authorization.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

// workerImageRef is the BYO-arbitrary-image escape hatch (see
// resolveCodingWorkerImage in container.ts) — setting or changing it
// requires a step-up beyond agents:write, the same pattern make_owner below
// uses for its own sensitive, ownership-bypassing mutation.
function requireWorkerImageRefScope(ctx: McpRequestContext): void {
  requireScope(ctx, ctx.canonicalUri, "agents:admin");
}

// A debug trace makes the worker log prompts and repository content to its
// pod log, so turning it on (or off) is an admin action, gated like
// workerImageRef and audited.
function requireDebugTraceScope(ctx: McpRequestContext): void {
  requireScope(ctx, ctx.canonicalUri, "agents:admin");
}

const agentsLog = logger.child({ module: "mcp-agents" });

const MAX_DEBUG_TRACE_MINUTES = 24 * 60;

/** Package allowlists widen what a run may download, so they need their own approval. */
function requirePackageApproval(ctx: McpRequestContext): void {
  requireAnyScope(ctx, ctx.canonicalUri, "packages:approve", "agents:admin");
}

const MAX_AGENT_NAME_CHARS = 200;
const MAX_SYSTEM_PROMPT_CHARS = 64 * 1024;
const MAX_MODEL_CHARS = 128;
const MAX_BUDGET_USD = 1_000_000;
/** Upper bound on Agent.maxDelegationsPerRun: a lead fanning out to one builder per repository. */
const MAX_DELEGATIONS_PER_RUN = 20;

const PARALLEL_DELEGATIONS_DESCRIPTION =
  "Native agents with sub-agents: when true, the delegate_to_* calls the agent makes in one model turn run at the same time " +
  "instead of one after another (other tool calls still run in order). The run tree still shares one budget, so later " +
  "sub-agents get what earlier ones leave. Coding sub-agents still queue for CODING_MAX_CONCURRENT slots. Default false.";

/** Operator-facing spellings of Agent.nativeExecutionMode (the Prisma enum is `control_plane` | `sandbox`). */
const NATIVE_EXECUTION_MODES = ["control-plane", "sandbox"] as const;
type OperatorExecutionMode = (typeof NATIVE_EXECUTION_MODES)[number];

const toStoredMode = (mode: OperatorExecutionMode): NativeExecutionMode =>
  mode === "sandbox" ? "sandbox" : "control_plane";

/** An agent row as returned to operators: the mode in its hyphenated spelling, null for coding agents. */
function withOperatorMode<T extends { kind: string; nativeExecutionMode?: NativeExecutionMode | null }>(
  agent: T,
): Omit<T, "nativeExecutionMode"> & { nativeExecutionMode: OperatorExecutionMode | null } {
  return {
    ...agent,
    nativeExecutionMode:
      agent.kind !== "native" ? null : agent.nativeExecutionMode === "sandbox" ? "sandbox" : "control-plane",
  };
}

const agentFields = {
  name: z.string().trim().min(1).max(MAX_AGENT_NAME_CHARS),
  systemPrompt: z.string().min(1).max(MAX_SYSTEM_PROMPT_CHARS),
  model: z.string().trim().min(1).max(MAX_MODEL_CHARS),
  budgetUsd: z.number().finite().positive().max(MAX_BUDGET_USD),
  maxTurns: z.number().int().min(1).max(100),
  maxDelegationsPerRun: z.number().int().min(1).max(MAX_DELEGATIONS_PER_RUN),
  parallelDelegations: z.boolean(),
  schedule: z.string().trim().min(1).max(256),
  timezone: z.string().trim().min(1).max(128),
  scheduleEnabled: z.boolean(),
  kind: z.enum(["native", "coding"]),
  budgetGroupId: z.string().min(1).max(128),
  memoryEnabled: z.boolean(),
  effort: z.enum(LLM_EFFORT_LEVELS),
  nativeExecutionMode: z.enum(NATIVE_EXECUTION_MODES),
  defectProjectKey: z.string().regex(PROJECT_KEY, "must be an upper-case Jira project key"),
  defectIssueType: z.string().trim().min(1).max(100),
};

/** Self-defect config is both-or-neither; on update, both null clears it. */
function refineDefectPair(
  value: { defectProjectKey?: string | null; defectIssueType?: string | null },
  ctx: z.RefinementCtx,
): void {
  const key = value.defectProjectKey;
  const type = value.defectIssueType;
  if ((key === undefined) !== (type === undefined) || (key === null) !== (type === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defectProjectKey"],
      message: "defectProjectKey and defectIssueType must be set together (or both null to clear on update)",
    });
  }
}

const DEFECT_DESCRIPTION =
  "Self-defects (optional, both or neither with defectIssueType): the Jira project key wardby files this agent's own failures into. " +
  "Filing needs a write link (link_issue_project) to that project whose creatableIssueTypes includes defectIssueType; it is checked at filing time and fails closed.";

const CreateAgentSchema = z
  .object({
    name: agentFields.name,
    systemPrompt: agentFields.systemPrompt,
    model: agentFields.model,
    budgetUsd: agentFields.budgetUsd,
    maxTurns: agentFields.maxTurns.optional(),
    maxDelegationsPerRun: agentFields.maxDelegationsPerRun.optional(),
    parallelDelegations: agentFields.parallelDelegations.optional(),
    schedule: agentFields.schedule.optional(),
    timezone: agentFields.timezone.optional(),
    scheduleEnabled: agentFields.scheduleEnabled.optional(),
    kind: agentFields.kind.default("native"),
    budgetGroupId: agentFields.budgetGroupId.optional(),
    memoryEnabled: agentFields.memoryEnabled.default(false),
    effort: agentFields.effort.optional(),
    nativeExecutionMode: agentFields.nativeExecutionMode.optional(),
    defectProjectKey: agentFields.defectProjectKey.optional(),
    defectIssueType: agentFields.defectIssueType.optional(),
    codingProfile: CodingProfileSchema.optional(),
    repositoryAdminOverride: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    refineDefectPair(value, ctx);
    if (value.kind === "coding" && !value.codingProfile) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["codingProfile"], message: "is required for coding agents" });
    }
    if (value.kind === "native" && value.codingProfile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["codingProfile"],
        message: "is only valid for coding agents",
      });
    }
    // A model the catalog doesn't offer is left to the handler, which reports
    // model_unavailable with its reason instead of a provider mismatch.
    if (
      value.kind === "coding" &&
      value.codingProfile &&
      currentModelCatalog().get(value.model) !== undefined &&
      !codingProviderSupportsModel(value.codingProfile.provider, value.model)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model"],
        message: `is not supported by coding provider "${value.codingProfile.provider}"`,
      });
    }
    const enabledSchedule = value.schedule && value.scheduleEnabled !== false;
    if (value.kind === "coding" && enabledSchedule && !value.codingProfile?.defaultTask) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["codingProfile", "defaultTask"],
        message: "is required for an enabled schedule",
      });
    }
  });

const UpdateAgentSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: agentFields.name.optional(),
    systemPrompt: agentFields.systemPrompt.optional(),
    model: agentFields.model.optional(),
    budgetUsd: agentFields.budgetUsd.optional(),
    maxTurns: agentFields.maxTurns.optional(),
    maxDelegationsPerRun: agentFields.maxDelegationsPerRun.optional(),
    parallelDelegations: agentFields.parallelDelegations.optional(),
    schedule: agentFields.schedule.nullable().optional(),
    timezone: agentFields.timezone.optional(),
    scheduleEnabled: agentFields.scheduleEnabled.optional(),
    kind: agentFields.kind.optional(),
    budgetGroupId: agentFields.budgetGroupId.nullable().optional(),
    memoryEnabled: agentFields.memoryEnabled.optional(),
    effort: agentFields.effort.nullable().optional(),
    nativeExecutionMode: agentFields.nativeExecutionMode.optional(),
    defectProjectKey: agentFields.defectProjectKey.nullable().optional(),
    defectIssueType: agentFields.defectIssueType.nullable().optional(),
    codingProfile: CodingProfilePatchSchema.extend({
      /** Not a stored profile field: sets CodingAgentProfile.debugTraceUntil = now + minutes (null clears). */
      debugTraceMinutes: z.number().int().min(1).max(MAX_DEBUG_TRACE_MINUTES).nullable().optional(),
    }).optional(),
    repositoryAdminOverride: z.boolean().optional(),
  })
  .strict()
  .superRefine(refineDefectPair);

type CreateAgentArgs = z.infer<typeof CreateAgentSchema>;
type UpdateAgentArgs = z.infer<typeof UpdateAgentSchema>;

const REPOSITORY_ADMIN_OVERRIDE = {
  type: "boolean",
  description:
    "Admins only (agents:admin with the admin role): approve codingProfile.repository without checking GitHub access, recorded as an admin approval. On an agent the admin doesn't own, only codingProfile.repository may change.",
};

/** A `local:` repository is stored as its canonical (realpath) name, and refused outside the trusted roots. */
async function withCanonicalRepository<T extends { codingProfile?: { repository?: string } | undefined }>(
  args: T,
): Promise<T> {
  const repository = args.codingProfile?.repository;
  if (repository === undefined || !isLocalRepository(repository)) return args;
  return { ...args, codingProfile: { ...args.codingProfile, repository: await canonicalLocalRepository(repository) } };
}

/** The profile columns a repository authorization is stamped into. */
function profileStamp(authorization: RepositoryAuthorization) {
  return {
    repositoryAuthorizedVia: authorization.authorizedVia,
    repositoryAuthorizedById: authorization.authorizedById,
    repositoryAuthorizedAt: authorization.authorizedAt,
  };
}

const profileJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    provider: { type: "string", enum: ["codex", "claude-code"] },
    repository: {
      type: "string",
      description:
        "owner/name on GitHub, or local:/absolute/path for a git folder inside the server's LOCAL_REPO_ROOTS (stored by its real path; no GitHub access needed). For GitHub, your linked GitHub account (link_host_account) must have write access to it, unless a wardby admin approves it (repositoryAdminOverride). Re-checked on every run.",
    },
    baseRef: { type: "string" },
    defaultTask: { type: ["string", "null"] },
    allowWebhookTaskOverride: { type: "boolean" },
    timeoutSec: { type: "integer", minimum: 60, maximum: 7200 },
    protectedPaths: {
      type: "array",
      minItems: 1,
      maxItems: 128,
      items: { type: "string" },
      description:
        'Glob patterns (*, **, ?) a run may not change. A leading ! makes an exception, a literal file path without wildcards: ["docs/**", "!docs/changelog.md"] protects docs/ except the changelog. Every run also protects .wardby/** except .wardby/services.yaml, whatever this list says; exceptions cannot unprotect .wardby/.',
    },
    collectExclude: { type: "array", maxItems: 64, items: { type: "string" } },
    toolchain: { type: "string", enum: ["node", "node-python"] },
    toolchainVersion: { type: ["string", "null"] },
    workerImageRef: { type: ["string", "null"] },
    workspaceDiskMb: {
      type: ["integer", "null"],
      minimum: 64,
      maximum: 32768,
      description:
        "Workspace disk size in MiB. Null uses the deployment default (CODING_DISK_MB), capped by the operator's CODING_MAX_DISK_MB.",
    },
    maxTurns: {
      type: ["integer", "null"],
      minimum: 1,
      maximum: MAX_CODING_TURNS,
      description: `Claude Code runs only: the most agent turns (model calls) a run may take before it stops with coding_turn_limit. Null uses the worker default (${DEFAULT_CLAUDE_MAX_TURNS}). The run's budget and timeout still apply. Codex runs have no turn limit.`,
    },
    repoSkills: {
      type: "boolean",
      description:
        "Load the repository's agent skills into runs (Codex: .agents/skills and .codex/skills; Claude Code: .claude/skills). Default true. Repository instructions (AGENTS.md for Codex, CLAUDE.md for Claude Code) load either way.",
    },
    claudeBareMode: {
      type: "boolean",
      description:
        "Claude Code runs only. Default true: Claude Code runs in bare mode and wardby adds the repository's CLAUDE.md and its skill list to the system prompt; the model reads a skill's SKILL.md with run_command. False: bare mode is off and Claude Code loads CLAUDE.md and skills itself (native Skill tool). Repository settings, hooks, and MCP config are never loaded either way.",
    },
    packageAllowlist: {
      type: "object",
      description:
        "Approved top-level packages per ecosystem (npm, pypi). A PyPI entry may name extras, e.g. psycopg[binary]. Needs packages:approve or agents:admin.",
      additionalProperties: { type: "array", maxItems: 256, items: { type: "string" } },
    },
    packagePolicy: {
      type: "object",
      properties: { minReleaseAgeDays: { type: "integer", minimum: 0, maximum: 30 } },
      additionalProperties: false,
    },
    services: {
      type: "array",
      maxItems: 16,
      items: { type: "string" },
      description:
        'Coding-run services this agent\'s runs may start: catalog names such as "postgres" (any version the catalog has). A repository asks for them in .wardby/services.yaml on its base branch; a run asking for one not listed here is refused. Empty = none.',
    },
  },
};

function invalidArguments(label: string, error: z.ZodError): McpError {
  const details = error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
  return new McpError(400, `Invalid ${label}: ${details}`);
}

function parseCreateAgent(args: unknown): CreateAgentArgs {
  const result = CreateAgentSchema.safeParse(args);
  if (!result.success) throw invalidArguments("create_agent arguments", result.error);
  return result.data;
}

function parseUpdateAgent(args: unknown): UpdateAgentArgs {
  const result = UpdateAgentSchema.safeParse(args);
  if (!result.success) throw invalidArguments("update_agent arguments", result.error);
  return result.data;
}

function validateSchedule(schedule: string | null | undefined, timezone: string): void {
  if (!schedule) return;
  try {
    validateCronExpression(schedule, timezone);
  } catch (error) {
    throw new McpError(400, `Invalid schedule/timezone: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Effort only drives the native engine, and only on a model that accepts the
 * level; reject rather than store a setting that would silently do nothing.
 */
function validateEffort(kind: "native" | "coding", model: string, effort: string | null | undefined): void {
  if (effort == null) return;
  if (kind !== "native") {
    throw new McpError(400, "effort is only valid for native agents; coding agents do not use it.");
  }
  const accepted = modelSupportedEfforts(model);
  if (!isLlmEffort(effort) || !accepted.includes(effort)) {
    throw new McpError(
      400,
      `Model "${model}" does not accept effort "${effort}". ` +
        (accepted.length > 0
          ? `Accepted levels: ${accepted.join(", ")}.`
          : "It accepts no effort setting; leave effort unset (or null)."),
    );
  }
}

const NATIVE_SANDBOX_MODE_DESCRIPTION =
  "Where a native agent's runs execute: control-plane (default, in the server process) or sandbox (an isolated container; needs the server's native sandbox configured).";

/**
 * The mode only applies to native agents, and `sandbox` only works where the
 * server composed a native sandbox executor; refuse it otherwise rather than
 * store a mode whose every run would fail closed.
 */
function validateNativeExecutionMode(
  ctx: McpRequestContext,
  kind: "native" | "coding",
  mode: OperatorExecutionMode | null | undefined,
): void {
  if (mode == null) return;
  if (kind !== "native") {
    throw new McpError(400, "nativeExecutionMode is only valid for native agents; coding agents do not use it.");
  }
  if (mode === "sandbox" && ctx.providers.executor.supportsNativeSandbox?.() !== true) {
    throw new McpError(
      400,
      "native_sandbox_unavailable: this server has no native sandbox configured (set NATIVE_SANDBOX_LAUNCHER), " +
        'so an agent cannot use nativeExecutionMode "sandbox".',
    );
  }
}

/**
 * A model being set (create, or update with `model`) must be runnable here:
 * in the catalog and enabled; for a native agent, its provider must also be
 * configured on the native router. A coding agent is checked against the
 * catalog only: its runs go through the coding proxy, whose credentials
 * (CODING_*_CREDENTIAL_REF) are not the native router's. An existing agent's
 * unchanged model is not re-checked: if an admin later disabled it, the agent
 * fails at its next run, not at an unrelated edit.
 */
function requireModelAvailable(ctx: McpRequestContext, model: string, kind: "native" | "coding"): void {
  try {
    assertAgentModelAvailable(model, kind === "native" ? ctx.providers.llm : undefined);
  } catch (err) {
    if (err instanceof ModelUnavailableError) throw new McpError(400, err.message);
    throw err;
  }
}

function storedProfile(profile: CodingAgentProfile): CodingProfile {
  return CodingProfileSchema.parse({
    provider: profile.provider,
    repository: profile.repository,
    baseRef: profile.baseRef,
    defaultTask: profile.defaultTask,
    allowWebhookTaskOverride: profile.allowWebhookTaskOverride,
    timeoutSec: profile.timeoutSec,
    protectedPaths: profile.protectedPaths,
    collectExclude: profile.collectExclude,
    toolchain: profile.toolchain,
    toolchainVersion: profile.toolchainVersion,
    workerImageRef: profile.workerImageRef,
    workspaceDiskMb: profile.workspaceDiskMb,
    maxTurns: profile.maxTurns,
    packageAllowlist: profile.packageAllowlist,
    packagePolicy: profile.packagePolicy,
    services: profile.services,
    repoSkills: profile.repoSkills,
    claudeBareMode: profile.claudeBareMode,
  });
}

/** A service name an agent is allowed must exist in the catalog (any version); typos fail here, not at a run. */
async function requireCatalogServiceNames(
  db: Pick<Prisma.TransactionClient, "codingService">,
  names: readonly string[],
): Promise<void> {
  if (names.length === 0) return;
  const known = new Set(
    (await db.codingService.findMany({ where: { name: { in: [...names] } }, select: { name: true } })).map(
      (row) => row.name,
    ),
  );
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new McpError(
      400,
      `wardby's service catalog has no service named ${unknown.map((name) => `"${name}"`).join(", ")}; list_services shows the catalog.`,
    );
  }
}

export function registerAgentTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "create_agent",
    scope: "agents:write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        systemPrompt: { type: "string" },
        model: { type: "string" },
        budgetUsd: { type: "number" },
        maxTurns: { type: "integer" },
        maxDelegationsPerRun: {
          type: "integer",
          minimum: 1,
          maximum: MAX_DELEGATIONS_PER_RUN,
          description:
            "Native agents with sub-agents: how many delegate_to_* calls one run may make, each to a different sub-agent " +
            "(one after another, or together with parallelDelegations). Default 1: route to exactly one.",
        },
        parallelDelegations: { type: "boolean", description: PARALLEL_DELEGATIONS_DESCRIPTION },
        schedule: { type: "string" },
        timezone: { type: "string" },
        scheduleEnabled: { type: "boolean" },
        kind: { type: "string", enum: ["native", "coding"] },
        budgetGroupId: { type: "string" },
        memoryEnabled: { type: "boolean" },
        effort: {
          type: "string",
          enum: [...LLM_EFFORT_LEVELS],
          description: "Reasoning effort for native agents. Unset uses the provider default.",
        },
        nativeExecutionMode: {
          type: "string",
          enum: [...NATIVE_EXECUTION_MODES],
          description: NATIVE_SANDBOX_MODE_DESCRIPTION,
        },
        defectProjectKey: { type: "string", pattern: PROJECT_KEY.source, description: DEFECT_DESCRIPTION },
        defectIssueType: { type: "string", minLength: 1, maxLength: 100, description: DEFECT_DESCRIPTION },
        codingProfile: { ...profileJsonSchema, required: ["repository"] },
        repositoryAdminOverride: REPOSITORY_ADMIN_OVERRIDE,
      },
      required: ["name", "systemPrompt", "model", "budgetUsd"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = await withCanonicalRepository(parseCreateAgent(rawArgs));
      if (args.codingProfile?.workerImageRef != null) requireWorkerImageRefScope(ctx);
      const packages = args.codingProfile;
      if (
        packages &&
        (Object.keys(packages.packageAllowlist ?? {}).length > 0 ||
          Object.keys(packages.packagePolicy ?? {}).length > 0)
      )
        requirePackageApproval(ctx);
      validateSchedule(args.schedule, args.timezone ?? "UTC");
      requireModelAvailable(ctx, args.model, args.kind);
      validateEffort(args.kind, args.model, args.effort);
      validateNativeExecutionMode(ctx, args.kind, args.nativeExecutionMode);
      if (args.codingProfile) await requireCatalogServiceNames(ctx.db, args.codingProfile.services);
      if (args.budgetGroupId) {
        await requireReadableBudgetGroup(ctx.db, args.budgetGroupId, ctx.principal.id);
      }
      const { codingProfile, repositoryAdminOverride, nativeExecutionMode, ...agentFieldsData } = args;
      const agentData = {
        ...agentFieldsData,
        ...(nativeExecutionMode ? { nativeExecutionMode: toStoredMode(nativeExecutionMode) } : {}),
      };
      if (repositoryAdminOverride === true && !codingProfile) {
        throw new McpError(400, "repositoryAdminOverride only applies with a codingProfile repository.");
      }
      // The creator is the owner, so it's the creator's GitHub access that counts.
      const authorization = codingProfile
        ? await authorizeRepositoryForSet(ctx, {
            ownerId: ctx.principal.id,
            provider: "github",
            repository: codingProfile.repository,
            kind: "coding",
            adminOverride: repositoryAdminOverride === true,
          })
        : null;
      const agent = await ctx.db.agent.create({
        data: {
          ...agentData,
          ownerId: ctx.principal.id,
          ...(codingProfile && authorization
            ? { codingProfile: { create: { ...codingProfile, ...profileStamp(authorization) } } }
            : {}),
        },
        include: { codingProfile: true },
      });
      return textResult(withOperatorMode(agent));
    },
  });

  mcp.registerTool({
    name: "update_agent",
    scope: "agents:write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        systemPrompt: { type: "string" },
        model: { type: "string" },
        budgetUsd: { type: "number" },
        maxTurns: { type: "integer" },
        maxDelegationsPerRun: {
          type: "integer",
          minimum: 1,
          maximum: MAX_DELEGATIONS_PER_RUN,
          description:
            "Native agents with sub-agents: how many delegate_to_* calls one run may make, each to a different sub-agent " +
            "(one after another, or together with parallelDelegations). Default 1: route to exactly one.",
        },
        parallelDelegations: { type: "boolean", description: PARALLEL_DELEGATIONS_DESCRIPTION },
        schedule: { type: ["string", "null"] },
        timezone: { type: "string" },
        scheduleEnabled: { type: "boolean" },
        kind: { type: "string", enum: ["native", "coding"] },
        budgetGroupId: { type: ["string", "null"] },
        memoryEnabled: { type: "boolean" },
        effort: {
          type: ["string", "null"],
          enum: [...LLM_EFFORT_LEVELS, null],
          description: "Reasoning effort for native agents. Null clears it back to the provider default.",
        },
        nativeExecutionMode: {
          type: "string",
          enum: [...NATIVE_EXECUTION_MODES],
          description: NATIVE_SANDBOX_MODE_DESCRIPTION,
        },
        defectProjectKey: {
          type: ["string", "null"],
          pattern: PROJECT_KEY.source,
          description: `${DEFECT_DESCRIPTION} Null (together with defectIssueType) clears it.`,
        },
        defectIssueType: {
          type: ["string", "null"],
          minLength: 1,
          maxLength: 100,
          description: `${DEFECT_DESCRIPTION} Null (together with defectProjectKey) clears it.`,
        },
        codingProfile: {
          ...profileJsonSchema,
          properties: {
            ...profileJsonSchema.properties,
            debugTraceMinutes: {
              type: ["integer", "null"],
              minimum: 1,
              maximum: MAX_DEBUG_TRACE_MINUTES,
              description:
                "Admins only (agents:admin): trace every coding run of this agent for this many minutes from now; the worker writes its full stream trace, which can include prompts and repository content, to the run pod's log. Null turns it off.",
            },
          },
        },
        repositoryAdminOverride: REPOSITORY_ADMIN_OVERRIDE,
      },
      required: ["id"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = await withCanonicalRepository(parseUpdateAgent(rawArgs));
      if (args.codingProfile?.workerImageRef !== undefined) requireWorkerImageRefScope(ctx);
      const debugTraceMinutes = args.codingProfile?.debugTraceMinutes;
      if (debugTraceMinutes !== undefined) requireDebugTraceScope(ctx);
      if (args.codingProfile?.packageAllowlist !== undefined || args.codingProfile?.packagePolicy !== undefined)
        requirePackageApproval(ctx);

      // Repository authorization calls GitHub, so it runs before (outside) the
      // serializable transaction, on a pre-read; the transaction then verifies
      // the pre-read still holds. Only a changed repository (or becoming a
      // coding agent) is re-authorized; other edits keep the existing stamp.
      const before = await ctx.db.agent.findUnique({ where: { id: args.id }, include: { codingProfile: true } });
      if (!before) throw agentNotFound(args.id);
      // Strict: a repository is a binding, so only the agent's owner sets
      // one (or an admin's explicit approval, below). Not a write-grantee,
      // not the stdio operator.
      const isOwner = before.ownerId !== null && before.ownerId === ctx.principal.id;
      // An admin may approve a repository (repositoryAdminOverride) on an agent
      // they don't own, but change nothing else on it.
      const adminEdit = args.repositoryAdminOverride === true && !isOwner;
      if (adminEdit) {
        requireScope(ctx, ctx.canonicalUri, "agents:admin");
        const { id: _id, repositoryAdminOverride: _flag, codingProfile, ...others } = args;
        const profileKeys = Object.keys(codingProfile ?? {});
        if (
          Object.values(others).some((v) => v !== undefined) ||
          profileKeys.length !== 1 ||
          profileKeys[0] !== "repository"
        ) {
          throw new McpError(
            403,
            "On an agent you don't own, an admin may change only codingProfile.repository (with repositoryAdminOverride).",
          );
        }
      } else {
        await assertAgentAccess(ctx, before, args.id, "write");
      }
      const repositoryAfter = (kind: string, profile: { repository: string } | null | undefined) =>
        kind === "coding" ? (args.codingProfile?.repository ?? profile?.repository ?? null) : null;
      const plannedRepository = repositoryAfter(args.kind ?? before.kind, before.codingProfile);
      const repositoryChanges = (existing: { kind: string; codingProfile: { repository: string } | null }) => {
        const next = repositoryAfter(args.kind ?? existing.kind, existing.codingProfile);
        return next !== null && (existing.kind !== "coding" || existing.codingProfile?.repository !== next);
      };
      const refuseRepositoryBinding = () => {
        throw new McpError(
          403,
          `Agent "${args.id}": only its owner can give it a repository (codingProfile.repository, or becoming a coding agent); a repository is a binding, not shared config.`,
        );
      };
      if (!adminEdit && !isOwner && repositoryChanges(before)) refuseRepositoryBinding();
      // The coding profile as a whole (task, base ref, protected paths,
      // task-override opt-in, image, packages, limits...), leaving coding,
      // and budget-group membership direct what runs do with the owner's
      // repository access and money: owner-only, like the repository itself
      // (review I1/M1/M6). Write keeps name, prompt, model, budget amount,
      // turns, effort, memory and schedule.
      const ownerOnlyChange = (existingKind: string) =>
        args.codingProfile !== undefined ||
        (args.kind !== undefined && args.kind !== existingKind) ||
        args.budgetGroupId !== undefined;
      const refuseOwnerOnly = () => {
        throw new McpError(
          403,
          `Agent "${args.id}": only its owner can change its coding profile, kind or budget group.`,
        );
      };
      if (!adminEdit && !isOwner && ownerOnlyChange(before.kind)) refuseOwnerOnly();
      const authorization =
        plannedRepository !== null && repositoryChanges(before)
          ? await authorizeRepositoryForSet(ctx, {
              ownerId: before.ownerId,
              provider: "github",
              repository: plannedRepository,
              kind: "coding",
              adminOverride: args.repositoryAdminOverride === true,
            })
          : null;
      if (args.repositoryAdminOverride === true && !authorization) {
        throw new McpError(400, "repositoryAdminOverride only applies when the coding repository changes.");
      }

      const debugTraceUntil =
        debugTraceMinutes === undefined
          ? undefined
          : debugTraceMinutes === null
            ? null
            : new Date(Date.now() + debugTraceMinutes * 60_000);

      const agent = await ctx.db.$transaction(
        async (tx) => {
          const existing = await tx.agent.findUnique({ where: { id: args.id }, include: { codingProfile: true } });
          if (!existing) throw agentNotFound(args.id);
          if (!adminEdit) {
            await assertAgentAccess(ctx, existing, args.id, "write", tx);
            if (!isOwner && repositoryChanges(existing)) refuseRepositoryBinding();
            if (!isOwner && ownerOnlyChange(existing.kind)) refuseOwnerOnly();
          }
          if (
            existing.ownerId !== before.ownerId ||
            (repositoryChanges(existing) &&
              (!authorization ||
                repositoryAfter(args.kind ?? existing.kind, existing.codingProfile) !== plannedRepository))
          ) {
            throw new McpError(409, `Agent "${args.id}" changed while it was being updated; try again.`);
          }
          if (args.budgetGroupId) {
            await requireReadableBudgetGroup(tx, args.budgetGroupId, ctx.principal.id);
          }

          const nextKind = args.kind ?? existing.kind;
          if (nextKind === "native" && args.codingProfile) {
            throw new McpError(400, "A coding profile is only valid for coding agents.");
          }
          if (args.model !== undefined) requireModelAvailable(ctx, args.model, nextKind);
          // Only re-checked when the model, effort or kind changes: an agent whose
          // model was since disabled can still take unrelated edits.
          if (args.model !== undefined || args.effort !== undefined || nextKind !== existing.kind) {
            validateEffort(
              nextKind,
              args.model ?? existing.model,
              args.effort !== undefined ? args.effort : existing.effort,
            );
          }

          if (args.nativeExecutionMode !== undefined) {
            validateNativeExecutionMode(ctx, nextKind, args.nativeExecutionMode);
          } else if (nextKind === "coding" && existing.nativeExecutionMode === "sandbox") {
            throw new McpError(
              400,
              'nativeExecutionMode is only valid for native agents; set nativeExecutionMode to "control-plane" before changing this agent to coding.',
            );
          }

          let nextProfile: CodingProfile | null = null;
          if (nextKind === "coding") {
            const attachedTools = await tx.agentTool.count({ where: { agentId: args.id } });
            if (attachedTools > 0) {
              throw new McpError(400, "Detach all native sandbox tools before changing an agent to coding.");
            }
            const currentProfile = existing.codingProfile ? storedProfile(existing.codingProfile) : undefined;
            const { debugTraceMinutes: _minutes, ...profilePatch } = args.codingProfile ?? {};
            const profileResult = CodingProfileSchema.safeParse({ ...currentProfile, ...profilePatch });
            if (!profileResult.success) throw invalidArguments("coding profile", profileResult.error);
            nextProfile = profileResult.data;
            if (args.codingProfile?.services !== undefined) await requireCatalogServiceNames(tx, nextProfile.services);
            const nextModel = args.model ?? existing.model;
            const pairingChanges =
              args.model !== undefined ||
              existing.kind !== "coding" ||
              existing.codingProfile?.provider !== nextProfile.provider;
            if (pairingChanges && !codingProviderSupportsModel(nextProfile.provider, nextModel)) {
              throw new McpError(
                400,
                `Model "${nextModel}" is not supported by coding provider "${nextProfile.provider}".`,
              );
            }
          }

          const nextSchedule = args.schedule !== undefined ? args.schedule : existing.schedule;
          const nextTimezone = args.timezone ?? existing.timezone;
          const nextScheduleEnabled = args.scheduleEnabled ?? existing.scheduleEnabled;
          validateSchedule(nextSchedule, nextTimezone);
          if (nextKind === "coding" && nextSchedule && nextScheduleEnabled && !nextProfile?.defaultTask) {
            throw new McpError(400, "A default task is required for an enabled coding-agent schedule.");
          }

          const {
            id,
            codingProfile: _profilePatch,
            repositoryAdminOverride: _override,
            nativeExecutionMode: modeArg,
            ...fieldUpdates
          } = args;
          const updates = {
            ...fieldUpdates,
            ...(modeArg ? { nativeExecutionMode: toStoredMode(modeArg) } : {}),
          };
          const stamp = authorization ? profileStamp(authorization) : {};
          const trace = debugTraceUntil === undefined ? {} : { debugTraceUntil };
          const profileMutation =
            nextKind === "native"
              ? existing.codingProfile
                ? { delete: true as const }
                : undefined
              : existing.codingProfile
                ? { update: { ...nextProfile!, ...stamp, ...trace } }
                : { create: { ...nextProfile!, ...stamp, ...trace } };
          return tx.agent.update({
            where: { id },
            data: {
              ...updates,
              ...(profileMutation ? { codingProfile: profileMutation } : {}),
            },
            include: { codingProfile: true },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (debugTraceUntil !== undefined) {
        agentsLog.info(
          {
            event: "coding.debug_trace.set",
            agentId: agent.id,
            until: debugTraceUntil?.toISOString() ?? null,
            by: ctx.principal.id,
          },
          "coding debug trace set",
        );
      }
      return textResult(withOperatorMode(agent));
    },
  });

  mcp.registerTool({
    name: "list_agents",
    scope: "agents:read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args: Record<string, never>, ctx) => {
      const [where, accessOf] = await Promise.all([readableAgentsWhere(ctx), agentAccessResolver(ctx)]);
      const agents = await ctx.db.agent.findMany({ where, include: { codingProfile: true } });
      return textResult(agents.map((agent) => ({ ...withOperatorMode(agent), access: accessOf(agent) })));
    },
  });

  mcp.registerTool({
    name: "get_agent",
    scope: "agents:read",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async (args: { id: string }, ctx) => {
      const { agent, access } = await assertAgentAccess(
        ctx,
        await ctx.db.agent.findUnique({
          where: { id: args.id },
          include: { tools: { include: { tool: true } }, codingProfile: true, repositories: true },
        }),
        args.id,
        "read",
      );
      // A7: a tool's code and schema are its owner's, whoever can read the
      // agent (the agent's owner included). Capabilities stay visible: config.
      return textResult({
        ...withOperatorMode(agent),
        access,
        tools: agent.tools.map((attachment) => ({
          ...attachment,
          tool: projectTool(attachment.tool, ctx.principal.id),
        })),
      });
    },
  });

  mcp.registerTool({
    name: "delete_agent",
    scope: "agents:write",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async (args: { id: string }, ctx) => {
      await requireAgentAccess(ctx, args.id, "owner");
      try {
        // Grants have no FK to the resource: removed in the same transaction.
        await ctx.db.$transaction(async (tx) => {
          await deleteGrantsFor(tx, "agent", args.id);
          await tx.agent.delete({ where: { id: args.id } });
        });
      } catch (err) {
        // Run.agentId has no onDelete rule, so Postgres refuses to delete an
        // agent that has ever run. That is deliberate - runs are the cost and
        // budget history - so say so instead of surfacing the FK violation.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
          throw new McpError(
            409,
            "Agent has run history, which is kept for cost and budget accounting, so it cannot be deleted. " +
              "Use disable_schedule to stop it running.",
          );
        }
        throw err;
      }
      return textResult({ deleted: args.id });
    },
  });

  // Deliberately bypasses access checks entirely: that's the point of this
  // tool, the audited agents:admin escape hatch. Gated on agents:admin, a
  // step up from agents:write, so an ordinary caller can never reach it
  // regardless of what they own. The new owner must exist; releasing an
  // agent to owner-less is gone (sharing is done with grants). Everything
  // bound to the agent belongs to its owner, so a transfer drops what the
  // new owner doesn't own (resource-sharing grants spec §3.6, R2-1).
  mcp.registerTool({
    name: "make_owner",
    scope: "agents:admin",
    description:
      "Admins: gives an agent a new owner (an existing principal id). Secret and datastore bindings the new owner doesn't own are removed; tool capabilities the new owner never granted are suspended until they re-run attach_tool; sub-agent edges the new owner can't delegate are removed; between two owners every grant on the agent is reset (adopting an owner-less agent keeps them). Returns what changed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentId: { type: "string" },
        ownerId: { type: ["string", "null"] },
        keepEveryoneExecute: {
          type: "boolean",
          description:
            "When adopting an owner-less agent: keep an everyone grant at execute instead of lowering it to read. Anyone could then run it with the new owner's secrets and capabilities.",
        },
      },
      required: ["agentId", "ownerId"],
    },
    handler: async (args: { agentId: string; ownerId: string | null; keepEveryoneExecute?: boolean }, ctx) => {
      if (args.ownerId === null) {
        throw new McpError(
          400,
          "make_owner no longer releases an agent to owner-less; share it with grant_access instead (everyone at execute, or named principals).",
        );
      }
      const newOwner = args.ownerId;
      const principal = await ctx.db.principal.findUnique({ where: { id: newOwner } });
      if (!principal) throw new McpError(400, `Principal "${newOwner}" not found.`);
      const result = await ctx.db.$transaction(
        async (tx) => {
          const agent = await tx.agent.findUnique({ where: { id: args.agentId }, include: { codingProfile: true } });
          if (!agent) throw agentNotFound(args.agentId);
          // Admin and grandfathered repository approvals were granted to the
          // agent under its current owner. Moving it away from that owner
          // turns them into ordinary checks of the next owner's own GitHub
          // access, so an approval never travels with the agent. An
          // owner-less agent getting its first owner keeps them: that is the
          // pre-upgrade step for owner-less agents with repositories.
          const revoked: string[] = [];
          const transfer = agent.ownerId !== null && agent.ownerId !== newOwner;
          if (transfer) {
            const approved = { in: ["admin", "grandfathered"] };
            const reset = { authorizedVia: "host_permission", authorizedById: null, authorizedAt: new Date() };
            const links = await tx.agentRepository.findMany({
              where: { agentId: agent.id, authorizedVia: approved },
              orderBy: { repository: "asc" },
            });
            await tx.agentRepository.updateMany({ where: { agentId: agent.id, authorizedVia: approved }, data: reset });
            revoked.push(...links.map((l) => l.repository));
            const profile = await tx.codingAgentProfile.updateMany({
              where: { agentId: agent.id, repositoryAuthorizedVia: approved },
              data: {
                repositoryAuthorizedVia: reset.authorizedVia,
                repositoryAuthorizedById: null,
                repositoryAuthorizedAt: reset.authorizedAt,
              },
            });
            if (profile.count > 0 && agent.codingProfile) revoked.push(agent.codingProfile.repository);
          }

          // Grants: between two owners every grant is reset (the new owner
          // decides who shares it); adopting an owner-less agent keeps them,
          // but lowers an everyone grant to read unless keepEveryoneExecute:
          // the agent may regain the new owner's secrets and capabilities
          // (review I3).
          const grantsReset = transfer ? await deleteGrantsFor(tx, "agent", agent.id) : 0;
          let everyoneGrant: { before: string; after: string } | null = null;
          if (agent.ownerId === null) {
            const everyone = await tx.resourceGrant.findFirst({
              where: { resourceType: "agent", resourceId: agent.id, granteeKey: EVERYONE_KEY },
            });
            if (everyone) {
              everyoneGrant = { before: everyone.level, after: everyone.level };
              if (everyone.level !== "read" && args.keepEveryoneExecute !== true) {
                await tx.resourceGrant.update({
                  where: { id: everyone.id },
                  data: { level: "read", source: "operator", grantedById: ctx.principal.id },
                });
                everyoneGrant.after = "read";
              }
            }
          }

          const updated = await tx.agent.update({ where: { id: args.agentId }, data: { ownerId: newOwner } });

          // Secret/datastore bindings the new owner doesn't own: removed.
          const secrets = await tx.agentSecret.findMany({
            where: { agentId: agent.id },
            include: { secret: { select: { ownerId: true } } },
          });
          const foreignSecrets = secrets.filter((b) => b.secret.ownerId !== newOwner);
          if (foreignSecrets.length > 0) {
            await tx.agentSecret.deleteMany({
              where: { agentId: agent.id, secretId: { in: foreignSecrets.map((b) => b.secretId) } },
            });
          }
          const datastores = await tx.agentDatastore.findMany({
            where: { agentId: agent.id },
            include: { datastore: { select: { ownerId: true } } },
          });
          const foreignDatastores = datastores.filter((b) => b.datastore.ownerId !== newOwner);
          if (foreignDatastores.length > 0) {
            await tx.agentDatastore.deleteMany({
              where: { agentId: agent.id, datastoreId: { in: foreignDatastores.map((b) => b.datastoreId) } },
            });
          }
          const bindingsRemoved = [
            ...foreignSecrets.map((b) => ({ kind: "secret", boundName: b.boundName, resourceId: b.secretId })),
            ...foreignDatastores.map((b) => ({ kind: "datastore", boundName: b.boundName, resourceId: b.datastoreId })),
          ];

          // Tool capabilities: rows aren't rewritten; the runner ignores any
          // the new owner never stamped (capabilitiesGrantedById).
          const attachments = await tx.agentTool.findMany({
            where: { agentId: agent.id },
            include: { tool: { select: { id: true, name: true } } },
          });
          const toolCapabilitiesSuspended = attachments
            .filter((at) => at.capabilitiesGrantedById !== newOwner)
            .map((at) => ({ toolId: at.tool.id, toolName: at.tool.name }));

          // Sub-agent edges (both directions) the new owner can't delegate.
          const edges = await tx.agentSubAgent.findMany({
            where: { OR: [{ parentAgentId: agent.id }, { childAgentId: agent.id }] },
            include: {
              parent: { select: { id: true, ownerId: true } },
              child: { select: { id: true, ownerId: true } },
            },
          });
          const subAgentEdgesRemoved: { parentAgentId: string; childAgentId: string; boundName: string }[] = [];
          for (const edge of edges) {
            const parent = edge.parentAgentId === agent.id ? { ownerId: newOwner } : edge.parent;
            const child = edge.childAgentId === agent.id ? { id: agent.id, ownerId: newOwner } : edge.child;
            if (!(await canDelegate(tx, parent, child))) {
              subAgentEdgesRemoved.push({
                parentAgentId: edge.parentAgentId,
                childAgentId: edge.childAgentId,
                boundName: edge.boundName,
              });
            }
          }
          for (const edge of subAgentEdgesRemoved) {
            await tx.agentSubAgent.deleteMany({
              where: { parentAgentId: edge.parentAgentId, childAgentId: edge.childAgentId },
            });
          }

          // Webhooks others created stay, but fire only while their creator
          // may still trigger the agent (core/webhooks.ts).
          const webhooks = await tx.webhook.findMany({ where: { agentId: agent.id } });
          const webhooksInactive: { id: string; createdBy: string | null }[] = [];
          for (const webhook of webhooks) {
            if (webhook.ownerId === newOwner) continue;
            const creatorAccess = await effectiveAccess(tx, "agent", updated, webhook.ownerId);
            if (!atLeast("agent", creatorAccess, "execute")) {
              webhooksInactive.push({ id: webhook.id, createdBy: webhook.ownerId });
            }
          }

          return {
            ...withOperatorMode(updated),
            repositoryApprovalsRevoked: revoked,
            bindingsRemoved,
            toolCapabilitiesSuspended,
            subAgentEdgesRemoved,
            grantsReset,
            everyoneGrant,
            webhooksInactive,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return textResult(result);
    },
  });
}
