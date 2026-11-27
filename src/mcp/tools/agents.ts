/**
 * Agent CRUD with scope checks in server.ts and access checks here
 * (auth/access.ts: owner, or a grant of read < execute < write). Owner-only
 * whatever the grants: delete_agent and repository changes; make_owner is
 * the agents:admin escape hatch. See
 * docs/private/2026-09-26-resource-sharing-grants-spec-and-plan.md.
 */
import { Prisma, type CodingAgentProfile, type NativeExecutionMode } from "#prisma";
import { codingProfileColumns } from "../../coding/profile-columns.js";
import { GOOGLE_WEB_TOOLS, WEB_TOOLS_SETTING_INVALID, isWebTools } from "../../coding/google-web-tools.js";
import { z } from "zod";
import {
  RUN_STEPS_LEVELS,
  loadRunStepsLevel,
  runStepsAboveCeilingWarning,
  type RunStepsLevel,
} from "../../core/run-steps/config.js";
import { codeProviderOf } from "../../coding/code-host.js";
import {
  CodingProfilePatchSchema,
  CodingProfileSchema,
  GEMINI_MAX_OUTPUT_TOKENS,
  MAX_GIT_HISTORY_DEPTH,
  type CodingProfile,
  type PlanDocument,
} from "../../coding/profile.js";
import {
  DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS,
  DEFAULT_CLAUDE_MAX_TURNS,
  MAX_CLAUDE_MAX_OUTPUT_TOKENS,
  MIN_CLAUDE_MAX_OUTPUT_TOKENS,
  DEFAULT_DEBUG_TRACE_MAX_MB,
  MAX_CODING_TURNS,
  MAX_DEBUG_TRACE_MAX_MB,
  isLocalRepository,
} from "../../coding/protocol.js";
import { loadBlobStoreConfig, loadContainerExecutorConfig, loadProviderConfig } from "../../config/providers.js";
import { CODING_PROVIDERS, codingProviderSupportsModel } from "../../coding/provider.js";
import { ACCEPTED_ADVISORY_ID, MAX_ACCEPTED_ADVISORIES } from "../../coding/registry/allowlist.js";
import {
  DEFAULT_PACKAGE_AUDIT_MINUTES,
  isPackageAuditActive,
  isPackageAuditMode,
  MAX_PACKAGE_AUDIT_MINUTES,
  PACKAGE_AUDIT_MODES,
  PackageAuditPatchError,
  packageAuditActiveWarning,
  resolvePackageAuditPatch,
} from "../../coding/registry/audit-mode.js";
import { assertAgentModelAvailable } from "../../core/run-pricing.js";
import { ModelUnavailableError } from "../../providers/llm/catalog-types.js";
import { currentModelCatalog } from "../../providers/llm/catalog-store.js";
import { validateCronExpression } from "../../core/cron.js";
import { scheduleStartFields } from "../../core/schedule-start.js";
import { preferIndexScans, withSerializableRetry } from "../../core/serializable-retry.js";
import { modelSupportedEfforts } from "../../providers/llm/routing.js";
import { agentMcpServerViews, inContainerUnavailableMcpTools, inContainerWriteToolsWarning } from "./mcp-servers.js";
import {
  claudeCodeUnofferedToolsWarning,
  inContainerNativeToolsWarning,
  inContainerUnavailableNativeTools,
} from "./tools.js";
import { claudeCodeUnofferedTools } from "../../core/tool-names.js";
import { runsCommandsInAgentContainer } from "../../core/mcp-tools.js";
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
import {
  EVERYONE_KEY,
  atLeast,
  canDelegate,
  deleteGrantsFor,
  effectiveAccess,
  isPublicWritable,
  filterUnusableMcpServers,
} from "../../core/grants.js";
import { projectTool, TOOL_GRANTS_INCLUDE } from "./tools.js";
import { withZod3ToolWarnings } from "../../core/zod3-window.js";
import { isOwnerAll, requireAnyScope, requireScope } from "../auth/resource-server.js";
import { logger } from "../../core/logger.js";
import { recordPromptVersion } from "../../core/agent-prompt-versions.js";
import { removeRetainedRounds } from "./retained-rounds.js";
import {
  authorizeRepositoryForSet,
  canonicalLocalRepository,
  type RepositoryAuthorization,
} from "../auth/repo-authorization.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import {
  MAX_TUNNEL_HOSTS,
  TUNNEL_HOSTS_INVALID,
  ceilingAllows,
  currentTunnelAgentHostLevel,
  tunnelHostKind,
  tunnelHostsWithinCeiling,
  type TunnelAgentHostLevel,
} from "../../coding/tunnel-hosts.js";
import { checkPlanDocumentSetting } from "../../core/plans/settings.js";
import { checkDocumentToolsSetting, DocumentToolsSchema } from "../../core/documents/tools-setting.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

function validateWorkspaceDiskMb(workspaceDiskMb: number | null | undefined): void {
  if (workspaceDiskMb == null) return;
  const { maxDiskMb } = loadContainerExecutorConfig();
  if (workspaceDiskMb > maxDiskMb) {
    throw new McpError(
      400,
      `workspaceDiskMb (${workspaceDiskMb} MiB) exceeds the deployment cap (${maxDiskMb} MiB). Raise CODING_MAX_DISK_MB to allow this size.`,
    );
  }
}

// workerImageRef is the BYO-arbitrary-image escape hatch (see
// resolveCodingWorkerImage/resolveCodingToolImage in container.ts). For a Codex or Gemini CLI
// agent it replaces the one container that runs the whole agent; for a Claude Code agent it
// replaces only the tool-runner container that runs the agent's commands, never the agent
// container (which always stays the deployment's standard Claude Code image). Either way, setting or
// changing it requires a step-up beyond agents:write, the same pattern make_owner below uses
// for its own sensitive, ownership-bypassing mutation.
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

/** What a coding agent's warm-round fingerprint covers (warm-fingerprint.ts), as an agent row has it. */
interface WarmFingerprintSource {
  kind: string;
  model: string;
  systemPrompt: string;
  codingProfile: {
    provider: string;
    repository: string;
    toolchain: string;
    toolchainVersion: string | null;
    workerImageRef: string | null;
    workspaceDiskMb: number | null;
  } | null;
}

/** Whether an update changed anything a retained round's fingerprint covers. */
export function warmFingerprintChanged(before: WarmFingerprintSource, after: WarmFingerprintSource): boolean {
  if (before.kind !== "coding") return false;
  const a = before.codingProfile;
  const b = after.codingProfile;
  return (
    after.kind !== before.kind ||
    after.model !== before.model ||
    after.systemPrompt !== before.systemPrompt ||
    !a ||
    !b ||
    a.provider !== b.provider ||
    a.repository !== b.repository ||
    a.toolchain !== b.toolchain ||
    a.toolchainVersion !== b.toolchainVersion ||
    a.workerImageRef !== b.workerImageRef ||
    a.workspaceDiskMb !== b.workspaceDiskMb
  );
}

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

/** The warning create_agent / update_agent return (not a refusal): wardby can't tell how old a custom image is. */
export const DEPENDENCY_CACHE_IMAGE_WARNING =
  "dependencyCache is on and this agent runs its own worker image (workerImageRef): rebuild that image FROM the wardby release that includes the dependency cache before its next run, or the run fails at input (worker_input_failed). See the dependency-cache help article.";

export const SESSION_RESUME_IMAGE_WARNING =
  "sessionResume is on and this agent runs its own worker image (workerImageRef): rebuild that image FROM the wardby release that includes session resume before its next run, or the run fails at input (worker_input_failed).";
export const SESSION_RESUME_NO_STORE_WARNING =
  "sessionResume is on but this server has no blob store (BLOB_STORE), so transcripts are not kept. See the resume-runs-locally help article.";

export const SUBSTRATE_IMAGE_WARNING =
  "This deployment runs coding agents on Substrate: the image must contain this release's Substrate bridge (see the build-claude-code-image or build-worker-image help article), and end as a non-root user, or its runs fail (substrate_image_unready, substrate_bridge_incompatible or substrate_image_incomplete).";

export const TUNNEL_HOSTS_SUBSTRATE_WARNING =
  "This deployment runs coding agents on Substrate, which does not use the CONNECT tunnel yet: codingProfile.tunnelHosts has no effect on its runs.";

/** A warning when some stored tunnel hosts are above the operator's ceiling now: runs are given only the rest. */
export function tunnelHostsAboveCeilingWarning(
  patterns: readonly string[],
  level: TunnelAgentHostLevel,
  anyApproved: boolean,
): string | undefined {
  const given = tunnelHostsWithinCeiling(patterns, level).filter((pattern) => pattern !== "*" || anyApproved);
  if (given.length === patterns.length) return undefined;
  return (
    `${patterns.length - given.length} of codingProfile.tunnelHosts ${patterns.length - given.length === 1 ? "is" : "are"} above ` +
    `this server's ceiling (CODING_TUNNEL_AGENT_HOSTS=${level})${patterns.includes("*") && !anyApproved ? " or lacks the admin approval * needs" : ""}, ` +
    "so runs are not given them. See the coding-proxy-tunnel help article."
  );
}

/** The stored coding-profile fields the output warnings read. */
interface WarnedProfile {
  dependencyCache: boolean;
  sessionResume?: boolean;
  workerImageRef: string | null;
  packageAuditMode?: string | null;
  packageAuditUntil?: Date | null;
  tunnelHosts?: string[];
  tunnelAnyHostAuthorizedById?: string | null;
}

/** For a warning only: a half-set BLOB_STORE (which throws) counts as none, and never fails the tool call. */
function blobStoreConfigured(): boolean {
  try {
    return loadBlobStoreConfig(process.env) !== undefined;
  } catch {
    return false;
  }
}

/** For a warning only: whether JOB_LAUNCHER is substrate; never fails the tool call. */
function substrateLauncher(): boolean {
  try {
    return loadProviderConfig(process.env).jobs === "substrate";
  } catch {
    return false;
  }
}

/** Non-blocking warnings about an agent's coding profile as stored. */
function profileWarnings(profile: WarnedProfile | null, now: Date): string[] {
  const warnings = profile?.dependencyCache && profile.workerImageRef ? [DEPENDENCY_CACHE_IMAGE_WARNING] : [];
  if (profile?.sessionResume && profile.workerImageRef) warnings.push(SESSION_RESUME_IMAGE_WARNING);
  if (profile?.sessionResume && !blobStoreConfigured()) warnings.push(SESSION_RESUME_NO_STORE_WARNING);
  if (profile?.workerImageRef && substrateLauncher()) warnings.push(SUBSTRATE_IMAGE_WARNING);
  if (profile && isPackageAuditActive(profile.packageAuditMode, profile.packageAuditUntil, now))
    warnings.push(packageAuditActiveWarning(profile.packageAuditMode, profile.packageAuditUntil!));
  if (profile?.tunnelHosts?.length) {
    if (substrateLauncher()) warnings.push(TUNNEL_HOSTS_SUBSTRATE_WARNING);
    const ceiling = tunnelHostsAboveCeilingWarning(
      profile.tunnelHosts,
      currentTunnelAgentHostLevel(process.env),
      Boolean(profile.tunnelAnyHostAuthorizedById),
    );
    if (ceiling) warnings.push(ceiling);
  }
  return warnings;
}

/** An agent as returned to operators: profile warnings, and whether package audit mode is in force now. */
function withProfileWarnings<T extends { codingProfile: WarnedProfile | null }>(agent: T): T & { warnings?: string[] } {
  const now = new Date();
  const profile = agent.codingProfile;
  const shown = profile
    ? {
        ...agent,
        codingProfile: {
          ...profile,
          packageAuditActive: isPackageAuditActive(profile.packageAuditMode, profile.packageAuditUntil, now),
        },
      }
    : agent;
  const warnings = profileWarnings(profile, now);
  return warnings.length ? { ...shown, warnings } : shown;
}

// No JSON-schema enum on purpose: the zod check then refuses a bad value naming off, summary and detail.
const RUN_STEPS_DESCRIPTION =
  "Run steps level for this agent's runs (owner only): off records nothing, summary one line per tool call or message " +
  "(the default), detail also the tool input, the end of each tool's output and the model's text, readable only by the " +
  "agent's owner and the run's starter. A run records the lower of this and the instance's WARDBY_RUN_STEPS, fixed " +
  "when it starts. detail stores tool output: secrets the run was given are removed, but a secret that exists only in " +
  "a file the run read can remain. Null clears it (summary).";

/** For a warning only: an invalid WARDBY_RUN_STEPS stopped start-up already; never fails the tool call. */
function runStepsCeiling(): RunStepsLevel | undefined {
  try {
    return loadRunStepsLevel(process.env);
  } catch {
    return undefined;
  }
}

/** An agent as returned to operators: a warning when its runSteps is above the instance's ceiling. */
function withRunStepsWarning<T extends { runSteps?: RunStepsLevel | null; warnings?: string[] }>(agent: T): T {
  const ceiling = runStepsCeiling();
  const warning = ceiling ? runStepsAboveCeilingWarning(agent.runSteps, ceiling) : undefined;
  return warning ? { ...agent, warnings: [...(agent.warnings ?? []), warning] } : agent;
}

const agentFields = {
  name: z.string().trim().min(1).max(MAX_AGENT_NAME_CHARS),
  systemPrompt: z.string().min(1).max(MAX_SYSTEM_PROMPT_CHARS),
  model: z.string().trim().min(1).max(MAX_MODEL_CHARS),
  budgetUsd: z.number().finite().positive().max(MAX_BUDGET_USD),
  maxTurns: z.number().int().min(1).max(100),
  allowedOverrunPercent: z.number().int().min(0).max(100),
  maxDelegationsPerRun: z.number().int().min(1).max(MAX_DELEGATIONS_PER_RUN),
  parallelDelegations: z.boolean(),
  schedule: z.string().trim().min(1).max(256),
  timezone: z.string().trim().min(1).max(128),
  scheduleEnabled: z.boolean(),
  kind: z.enum(["native", "coding"]),
  budgetGroupId: z.string().min(1).max(128),
  memoryEnabled: z.boolean(),
  documentTools: DocumentToolsSchema,
  effort: z.enum(LLM_EFFORT_LEVELS),
  runSteps: z.enum(RUN_STEPS_LEVELS as [RunStepsLevel, ...RunStepsLevel[]]),
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
    allowedOverrunPercent: agentFields.allowedOverrunPercent.optional(),
    maxDelegationsPerRun: agentFields.maxDelegationsPerRun.optional(),
    parallelDelegations: agentFields.parallelDelegations.optional(),
    schedule: agentFields.schedule.optional(),
    timezone: agentFields.timezone.optional(),
    scheduleEnabled: agentFields.scheduleEnabled.optional(),
    kind: agentFields.kind.default("native"),
    budgetGroupId: agentFields.budgetGroupId.optional(),
    memoryEnabled: agentFields.memoryEnabled.default(false),
    documentTools: agentFields.documentTools.nullable().optional(),
    effort: agentFields.effort.optional(),
    runSteps: agentFields.runSteps.optional(),
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
    /** Not stored on the agent: labels the prompt version this update records (when systemPrompt changes). */
    promptSummary: z.string().min(1).max(200).optional(),
    model: agentFields.model.optional(),
    budgetUsd: agentFields.budgetUsd.optional(),
    maxTurns: agentFields.maxTurns.optional(),
    allowedOverrunPercent: agentFields.allowedOverrunPercent.optional(),
    maxDelegationsPerRun: agentFields.maxDelegationsPerRun.optional(),
    parallelDelegations: agentFields.parallelDelegations.optional(),
    schedule: agentFields.schedule.nullable().optional(),
    timezone: agentFields.timezone.optional(),
    scheduleEnabled: agentFields.scheduleEnabled.optional(),
    kind: agentFields.kind.optional(),
    budgetGroupId: agentFields.budgetGroupId.nullable().optional(),
    memoryEnabled: agentFields.memoryEnabled.optional(),
    documentTools: agentFields.documentTools.nullable().optional(),
    effort: agentFields.effort.nullable().optional(),
    runSteps: agentFields.runSteps.nullable().optional(),
    nativeExecutionMode: agentFields.nativeExecutionMode.optional(),
    defectProjectKey: agentFields.defectProjectKey.nullable().optional(),
    defectIssueType: agentFields.defectIssueType.nullable().optional(),
    codingProfile: CodingProfilePatchSchema.extend({
      /** Not a stored profile field: sets CodingAgentProfile.debugTraceUntil = now + minutes (null clears). */
      debugTraceMinutes: z.number().int().min(1).max(MAX_DEBUG_TRACE_MINUTES).nullable().optional(),
      /** Admin-only like debugTraceMinutes: CodingAgentProfile.debugTraceMaxMb (null = the default). */
      debugTraceMaxMb: z.number().int().min(1).max(MAX_DEBUG_TRACE_MAX_MB).nullable().optional(),
      /** Not stored as given: sets CodingAgentProfile.packageAuditMode and packageAuditUntil (null clears both). */
      packageAuditMode: z.enum(PACKAGE_AUDIT_MODES).nullable().optional(),
      /** Not a stored field: the audit window, in minutes from now (default 24 hours). */
      packageAuditMinutes: z.number().int().min(1).max(MAX_PACKAGE_AUDIT_MINUTES).optional(),
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

/**
 * Checks codingProfile.tunnelHosts as saved, and returns the columns that record who approved `*`.
 * An unchanged list is not re-checked, so an agent whose hosts are above a since-lowered ceiling can still
 * take unrelated edits (its runs are given only what the ceiling allows). A changed list must fit the
 * operator's ceiling (CODING_TUNNEL_AGENT_HOSTS); `*` needs an admin (agents:admin with the admin role,
 * role-gated like repositoryAdminOverride), recorded by id and time, kept while `*` stays on the list.
 */
function tunnelHostsStamp(
  ctx: McpRequestContext,
  next: readonly string[],
  previous: { tunnelHosts: string[]; tunnelAnyHostAuthorizedById: string | null } | null | undefined,
): { tunnelAnyHostAuthorizedById: string | null; tunnelAnyHostAuthorizedAt: Date | null } | undefined {
  const before = previous?.tunnelHosts ?? [];
  if (next.length === before.length && next.every((pattern, i) => pattern === before[i])) return undefined;
  if (next.length > 0) checkTunnelHostsCeiling(next);
  if (!next.includes("*")) return { tunnelAnyHostAuthorizedById: null, tunnelAnyHostAuthorizedAt: null };
  if (before.includes("*") && previous?.tunnelAnyHostAuthorizedById) return undefined;
  // Role-gated: the scope alone never suffices (resource-server.ts), as for repositoryAdminOverride.
  if (!isOwnerAll(ctx)) requireScope(ctx, ctx.canonicalUri, "agents:admin");
  return { tunnelAnyHostAuthorizedById: ctx.principal.id, tunnelAnyHostAuthorizedAt: new Date() };
}

/** Refuses a list the operator's ceiling does not allow, naming the entry and the level it needs. */
function checkTunnelHostsCeiling(patterns: readonly string[]): void {
  const level = currentTunnelAgentHostLevel(process.env);
  if (level === "off") {
    throw new McpError(
      400,
      `${TUNNEL_HOSTS_INVALID}: per-agent tunnel hosts are off on this server (CODING_TUNNEL_AGENT_HOSTS is off or the tunnel is not enabled); only the server list (CODING_TUNNEL_ALLOWED_HOSTS) applies. Set codingProfile.tunnelHosts to [] or ask the operator.`,
    );
  }
  patterns.forEach((pattern, index) => {
    const kind = tunnelHostKind(pattern);
    if (ceilingAllows(level, kind)) return;
    const needed = kind === "any" ? "any" : "pattern";
    throw new McpError(
      400,
      `${TUNNEL_HOSTS_INVALID}: entry ${index} (${kind === "any" ? "*" : "a *.domain pattern"}) needs CODING_TUNNEL_AGENT_HOSTS=${needed}; this server allows ${level === "exact" ? "exact hosts only" : "exact hosts and *.domain patterns"}.`,
    );
  });
}

/** The profile columns a repository authorization is stamped into. */
function profileStamp(authorization: RepositoryAuthorization) {
  return {
    repositoryAuthorizedVia: authorization.authorizedVia,
    repositoryAuthorizedById: authorization.authorizedById,
    repositoryAuthorizedAt: authorization.authorizedAt,
  };
}

export const profileJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    provider: { type: "string", enum: [...CODING_PROVIDERS] },
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
    workerImageRef: {
      type: ["string", "null"],
      description:
        "A digest-pinned custom image that this agent's commands run in, for your own languages and tools. Codex: build it FROM the coding-worker driver image; it runs the whole agent. Gemini CLI: build it FROM this release's wardby-gemini-coding-worker image and keep its /etc/gemini-cli files and Gemini CLI version unchanged (the worker refuses the run otherwise, worker_agent_cli_incompatible); it runs the whole agent. Claude Code: build it FROM this release's wardby-claude-tool-runner image; it runs the agent's commands, while Claude Code itself stays on the standard image. Needs agents:admin. Null uses the toolchain's standard image.",
    },
    workspaceDiskMb: {
      type: ["integer", "null"],
      minimum: 64,
      maximum: 32768,
      description:
        "Workspace disk size in MiB. Null uses the deployment default (CODING_DISK_MB), capped by the operator's CODING_MAX_DISK_MB.",
    },
    gitHistory: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        depth: {
          oneOf: [
            { type: "integer", minimum: 1, maximum: MAX_GIT_HISTORY_DEPTH },
            { type: "string", enum: ["full"] },
          ],
        },
      },
      required: ["depth"],
      description:
        'Give runs real git history in /workspace instead of a single snapshot commit: { depth: <1..100000> } commits, or { depth: "full" }. ' +
        'Applies to every writable repository of a run. Null (default) turns it off. Remote repository links (link_repository as: "remote") need it on.',
    },
    maxTurns: {
      type: ["integer", "null"],
      minimum: 1,
      maximum: MAX_CODING_TURNS,
      description: `Claude Code and Gemini CLI runs: the most agent turns (model calls) a run may take before it stops with coding_turn_limit. Null uses the worker default (${DEFAULT_CLAUDE_MAX_TURNS}). The run's budget and timeout still apply. Codex runs have no turn limit.`,
    },
    maxOutputTokens: {
      type: ["integer", "null"],
      minimum: MIN_CLAUDE_MAX_OUTPUT_TOKENS,
      maximum: MAX_CLAUDE_MAX_OUTPUT_TOKENS,
      description: `Claude Code and Gemini CLI runs: the most output tokens per model reply (default ${DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS}; up to ${MAX_CLAUDE_MAX_OUTPUT_TOKENS} on Claude Code, ${GEMINI_MAX_OUTPUT_TOKENS} on Gemini CLI). The coding proxy reserves this × the model's output price per request against the run budget, so higher values need a larger budgetUsd. Refused on a Codex agent. Null uses the default.`,
    },
    repoSkills: {
      type: "boolean",
      description:
        "Load the repository's agent skills into runs (Codex: .agents/skills and .codex/skills; Claude Code: .claude/skills; Gemini CLI: .gemini/skills and .agents/skills). Default true. Repository instructions (AGENTS.md for Codex, CLAUDE.md for Claude Code, GEMINI.md, AGENTS.md and CLAUDE.md for Gemini CLI) load either way.",
    },
    claudeBareMode: {
      type: "boolean",
      description:
        "Claude Code runs only; accepted and ignored on Codex and Gemini CLI agents. Default true: Claude Code runs in bare mode and wardby adds the repository's CLAUDE.md and its skill list to the system prompt; the model reads a skill's SKILL.md with run_command. False: bare mode is off and Claude Code loads CLAUDE.md and skills itself (native Skill tool). Repository settings, hooks, and MCP config are never loaded either way.",
    },
    webTools: {
      type: "string",
      enum: [...GOOGLE_WEB_TOOLS],
      description:
        "Server-side web tools for this agent's runs. Takes effect on Gemini CLI runs today; Codex and Claude Code accept it with no effect yet. off (default): none. search: Google Search grounding (google_web_search). search-and-fetch: search plus URL fetch (web_fetch; the run's pod must resolve public DNS names). Google runs the search or fetch itself, outside the run's tunnel hosts, and grounded queries are billed by Google separately from tokens: wardby's budget does not see that charge.",
    },
    subAgents: {
      type: "boolean",
      description:
        "Let the agent start sub-agents. Applies to Claude Code and Gemini CLI runs; Codex accepts it with no effect. Default true. Sub-agents use the run's model, and their model calls go through the coding proxy and count against the run's budget. False turns sub-agents off.",
    },
    dependencyCache: {
      type: "boolean",
      description:
        "Restore npm node_modules from a snapshot the proxy re-approves; needs package approval (packages:approve or agents:admin). Default false. The worker images must be a release that includes the cache; with a workerImageRef the result carries a warning to rebuild that image from it.",
    },
    sessionResume: {
      type: "boolean",
      description:
        "Claude Code runs only. Keep each run's session transcript (redacted) on the server so the session can later be continued in a local Claude Code CLI. Once transcripts are served, anyone who can read a run can read everything its agent saw. Needs a blob store (BLOB_STORE) on the server. Default false.",
    },
    planDocument: {
      type: ["object", "null"],
      description:
        "Publish this coding agent's plan as Wardby documents for review (see help article plan-documents). store wardby (default) keeps the plan out of the repository; store repository writes it to path, a folder with one {n}. reviewers: 1-50 principal ids with access to this agent (default: the owner). finalApproverId, onApproved (notify or build; build needs builderAgentId, a coding agent with buildFromPlan). null turns it off.",
    },
    buildFromPlan: {
      type: "boolean",
      description:
        "Refuse to build from a plan set that is not fully approved (plan_not_approved); give runs the approved versions. Default false.",
    },
    workflow: {
      type: ["object", "null"],
      description:
        "Claude Code only: run this repository workflow script, .claude/workflows/<name>.js, with Claude Code's own Workflow tool (see help article coding-workflows). { name, repository?, replyField? }: repository is a link name (omitted = the default repository); replyField names a string field of the script's returned object to use, word for word, as the run's reply (prTitle/prBody from the result are used for a pull request). Needs gitHistory (for example { \"depth\": 1 }). trigger_agent workflowArgs becomes the script's args. null turns it off.",
      properties: {
        name: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
        repository: { type: "string", minLength: 1, maxLength: 300 },
        replyField: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    packageAllowlist: {
      type: "object",
      description:
        "Approved top-level packages per ecosystem (npm, pypi). A PyPI entry may name extras, e.g. psycopg[binary]. Needs packages:approve or agents:admin.",
      additionalProperties: { type: "array", maxItems: 256, items: { type: "string" } },
    },
    packagePolicy: {
      type: "object",
      description:
        "minReleaseAgeDays: days a release must have been public before it can be installed (0-30, default 3). acceptedAdvisories: advisory ids (GHSA-…, CVE-…) this agent's runs may install despite; malware never; every waiver is reported in the PR. Needs packages:approve or agents:admin.",
      properties: {
        minReleaseAgeDays: { type: "integer", minimum: 0, maximum: 30 },
        acceptedAdvisories: {
          type: "array",
          maxItems: MAX_ACCEPTED_ADVISORIES,
          uniqueItems: true,
          items: { type: "string", pattern: ACCEPTED_ADVISORY_ID.source },
        },
      },
      additionalProperties: false,
    },
    services: {
      type: "array",
      maxItems: 16,
      items: { type: "string" },
      description:
        'Coding-run services this agent\'s runs may start: catalog names such as "postgres" (any version the catalog has). A repository asks for them in .wardby/services.yaml on its base branch; a run asking for one not listed here is refused. Empty = none.',
    },
    // No maxItems here: the zod check refuses more than MAX_TUNNEL_HOSTS with tunnel_hosts_invalid.
    tunnelHosts: {
      type: "array",
      items: { type: "string" },
      description:
        `Up to ${MAX_TUNNEL_HOSTS} hosts this agent's coding runs may reach over HTTPS (port 443) through the coding proxy's CONNECT tunnel, on top of the server's own list: ` +
        '"api.example.com" (that host), "*.example.com" (any subdomain at any depth, not example.com itself) or "*" (any public host). ' +
        'Up to the operator\'s ceiling (CODING_TUNNEL_AGENT_HOSTS: off by default, then exact, pattern or any); "*" also needs an admin (agents:admin with the admin role), recorded on the profile. ' +
        "Refused (tunnel_hosts_invalid): IP addresses, ports, schemes, paths, * inside a label, public suffixes such as *.com or *.co.uk. " +
        "Private and metadata addresses stay blocked whatever the pattern. Fixed per run at dispatch. Empty = none (see the coding-proxy-tunnel help article).",
    },
  },
};

function invalidArguments(label: string, error: z.ZodError): McpError {
  const details = error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
  return new McpError(400, `Invalid ${label}: ${details}`);
}

/** checkDocumentToolsSetting with its error mapped to a fixed-text 400. */
async function checkDocumentTools(
  db: Parameters<typeof checkDocumentToolsSetting>[0],
  agent: Parameters<typeof checkDocumentToolsSetting>[1],
  savedBy: string,
  input: Parameters<typeof checkDocumentToolsSetting>[3],
) {
  try {
    return (await checkDocumentToolsSetting(db, agent, savedBy, input)) as unknown as Prisma.InputJsonObject;
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "document_tools_invalid") throw err;
    const text: Record<string, string> = {
      kind: "only native agents take documentTools",
      reviewers: "every reviewer and the final approver must exist and be able to read this agent",
      plans: "every plan must name a planner agent you can run",
    };
    throw new McpError(400, `document_tools_invalid: ${text[String(err.cause)] ?? "check the setting"}.`);
  }
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

/**
 * update_agent's merge base for a stored profile. An unreadable stored webTools (only a direct database
 * write can make one: the column has no CHECK) is left out so a patch that sets webTools repairs it; a
 * patch that does not set it is refused with a fixed message (never the stored value, never a silent "off").
 */
export function profileMergeBase(profile: CodingAgentProfile, patch: { webTools?: unknown }): CodingProfile {
  if (!isWebTools(profile.webTools) && patch.webTools === undefined) {
    throw new McpError(400, `Invalid coding profile: ${WEB_TOOLS_SETTING_INVALID}.`);
  }
  return storedProfile(profile);
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
    gitHistory: profile.gitHistoryFull
      ? { depth: "full" }
      : profile.gitHistoryDepth != null
        ? { depth: profile.gitHistoryDepth }
        : null,
    maxTurns: profile.maxTurns,
    maxOutputTokens: profile.maxOutputTokens,
    packageAllowlist: profile.packageAllowlist,
    packagePolicy: profile.packagePolicy,
    services: profile.services,
    repoSkills: profile.repoSkills,
    claudeBareMode: profile.claudeBareMode,
    dependencyCache: profile.dependencyCache,
    sessionResume: profile.sessionResume,
    planDocument: profile.planDocument ?? null,
    buildFromPlan: profile.buildFromPlan,
    workflow:
      profile.workflowName == null
        ? null
        : {
            name: profile.workflowName,
            ...(profile.workflowRepository ? { repository: profile.workflowRepository } : {}),
            ...(profile.workflowReplyField ? { replyField: profile.workflowReplyField } : {}),
          },
    tunnelHosts: profile.tunnelHosts,
    webTools: isWebTools(profile.webTools) ? profile.webTools : undefined,
    subAgents: profile.subAgents,
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
        allowedOverrunPercent: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          description:
            "Percent above budgetUsd a run may spend before it is stopped. On a coding agent it raises each of its runs' limit; on a lead agent that delegates, it raises its run tree's ceiling for coding sub-agents. Native runs' own model calls are not affected. Budget group caps still apply. 0 = stop at budgetUsd.",
        },
        maxDelegationsPerRun: {
          type: "integer",
          minimum: 1,
          maximum: MAX_DELEGATIONS_PER_RUN,
          description:
            "Native agents with sub-agents: how many delegate_to_* calls one run may make, to each sub-agent and repository at most once " +
            "(one after another, or together with parallelDelegations). Default 1: route to exactly one.",
        },
        parallelDelegations: { type: "boolean", description: PARALLEL_DELEGATIONS_DESCRIPTION },
        schedule: { type: "string" },
        timezone: { type: "string" },
        scheduleEnabled: { type: "boolean" },
        kind: { type: "string", enum: ["native", "coding"] },
        budgetGroupId: { type: "string" },
        memoryEnabled: { type: "boolean" },
        documentTools: {
          type: "object",
          description:
            "Native agents only: built-in doc_* tools to create, read and revise Wardby documents and designs in a run (see help article native-agent-documents). access read|write; reviewers: 1-50 principal ids who can read this agent (default: the owner; on create_agent only the owner can be a reviewer: share the agent, then add other reviewers with update_agent); finalApproverId; maxNewPerRun 1-20 (default 5); plans: planner agent ids whose plan documents this agent may read and comment on. null turns it off.",
        },
        effort: {
          type: "string",
          enum: [...LLM_EFFORT_LEVELS],
          description: "Reasoning effort for native agents. Unset uses the provider default.",
        },
        runSteps: { type: "string", description: RUN_STEPS_DESCRIPTION },
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
          Object.keys(packages.packagePolicy ?? {}).length > 0 ||
          packages.dependencyCache === true)
      )
        requirePackageApproval(ctx);
      validateSchedule(args.schedule, args.timezone ?? "UTC");
      requireModelAvailable(ctx, args.model, args.kind);
      validateEffort(args.kind, args.model, args.effort);
      validateNativeExecutionMode(ctx, args.kind, args.nativeExecutionMode);
      validateWorkspaceDiskMb(args.codingProfile?.workspaceDiskMb);
      if (args.codingProfile) await requireCatalogServiceNames(ctx.db, args.codingProfile.services);
      if (args.budgetGroupId) {
        await requireReadableBudgetGroup(ctx.db, args.budgetGroupId, ctx.principal.id, isOwnerAll(ctx));
      }
      const { codingProfile, repositoryAdminOverride, nativeExecutionMode, documentTools, ...agentFieldsData } = args;
      const documentToolsChecked = documentTools
        ? await checkDocumentTools(
            ctx.db,
            { id: "", ownerId: ctx.principal.id, kind: args.kind },
            ctx.principal.id,
            documentTools,
          )
        : undefined;
      const agentData = {
        ...agentFieldsData,
        ...(documentToolsChecked ? { documentTools: documentToolsChecked } : {}),
        ...(nativeExecutionMode ? { nativeExecutionMode: toStoredMode(nativeExecutionMode) } : {}),
      };
      if (repositoryAdminOverride === true && !codingProfile) {
        throw new McpError(400, "repositoryAdminOverride only applies with a codingProfile repository.");
      }
      // The creator is the owner, so it's the creator's GitHub access that counts.
      const authorization = codingProfile
        ? await authorizeRepositoryForSet(ctx, {
            ownerId: ctx.principal.id,
            provider: codeProviderOf(codingProfile.repository),
            repository: codingProfile.repository,
            kind: "coding",
            adminOverride: repositoryAdminOverride === true,
          })
        : null;
      let planChecked: PlanDocument | null = null;
      if (codingProfile?.planDocument) {
        try {
          planChecked = await checkPlanDocumentSetting(
            ctx.db,
            { id: "", ownerId: ctx.principal.id },
            codingProfile.planDocument,
          );
        } catch (err) {
          throw new McpError(400, err instanceof Error ? err.message : "plan_settings_invalid");
        }
      }
      // Per-agent tunnel hosts: within the operator's ceiling, and * only with an admin's approval.
      const tunnelStamp = codingProfile ? tunnelHostsStamp(ctx, codingProfile.tunnelHosts, null) : undefined;
      const agent = await ctx.db.$transaction(async (tx) => {
        const created = await tx.agent.create({
          data: {
            ...agentData,
            ...(await scheduleStartFields(ctx.db, null, {
              schedule: agentData.schedule ?? null,
              timezone: agentData.timezone ?? "UTC",
              scheduleEnabled: agentData.scheduleEnabled ?? true,
            })),
            ownerId: ctx.principal.id,
            ...(codingProfile && authorization
              ? {
                  codingProfile: {
                    create: {
                      ...codingProfileColumns(
                        planChecked ? { ...codingProfile, planDocument: planChecked } : codingProfile,
                      ),
                      ...profileStamp(authorization),
                      ...tunnelStamp,
                    },
                  },
                }
              : {}),
          },
          include: { codingProfile: true },
        });
        await recordPromptVersion(tx, {
          agentId: created.id,
          systemPrompt: created.systemPrompt,
          via: "create",
          createdById: ctx.principal.id,
        });
        return created;
      });
      return textResult(withRunStepsWarning(withProfileWarnings(withOperatorMode(agent))));
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
        promptSummary: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Optional label for the prompt version this update records when systemPrompt changes (see list_agent_prompt_versions).",
        },
        model: { type: "string" },
        budgetUsd: { type: "number" },
        maxTurns: { type: "integer" },
        allowedOverrunPercent: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          description:
            "Percent above budgetUsd a run may spend before it is stopped. On a coding agent it raises each of its runs' limit; on a lead agent that delegates, it raises its run tree's ceiling for coding sub-agents. Native runs' own model calls are not affected. Budget group caps still apply. 0 = stop at budgetUsd.",
        },
        maxDelegationsPerRun: {
          type: "integer",
          minimum: 1,
          maximum: MAX_DELEGATIONS_PER_RUN,
          description:
            "Native agents with sub-agents: how many delegate_to_* calls one run may make, to each sub-agent and repository at most once " +
            "(one after another, or together with parallelDelegations). Default 1: route to exactly one.",
        },
        parallelDelegations: { type: "boolean", description: PARALLEL_DELEGATIONS_DESCRIPTION },
        schedule: { type: ["string", "null"] },
        timezone: { type: "string" },
        scheduleEnabled: { type: "boolean" },
        kind: { type: "string", enum: ["native", "coding"] },
        budgetGroupId: { type: ["string", "null"] },
        memoryEnabled: { type: "boolean" },
        documentTools: {
          type: ["object", "null"],
          description:
            "Native agents only: built-in doc_* tools to create, read and revise Wardby documents and designs in a run (see help article native-agent-documents). access read|write; reviewers: 1-50 principal ids who can read this agent (default: the owner); finalApproverId; maxNewPerRun 1-20 (default 5); plans: planner agent ids whose plan documents this agent may read and comment on. null turns it off.",
        },
        effort: {
          type: ["string", "null"],
          enum: [...LLM_EFFORT_LEVELS, null],
          description: "Reasoning effort for native agents. Null clears it back to the provider default.",
        },
        runSteps: { type: ["string", "null"], description: RUN_STEPS_DESCRIPTION },
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
            debugTraceMaxMb: {
              type: ["integer", "null"],
              minimum: 1,
              maximum: MAX_DEBUG_TRACE_MAX_MB,
              description: `Admins only (agents:admin): cap on one traced run's trace output, in MiB (default ${DEFAULT_DEBUG_TRACE_MAX_MB}); the trace stops with a limit_reached line once it is reached. Null restores the default.`,
            },
            packageAuditMode: {
              type: ["string", "null"],
              enum: [...PACKAGE_AUDIT_MODES, null],
              description:
                "Package audit mode, for a limited time (packageAuditMinutes). Needs packages:approve or agents:admin, and only the agent's owner may set it. " +
                '"audit": the registry installs packages outside this agent\'s allowlist instead of refusing them, and records each one; ' +
                '"full": also installs versions withheld only by high or critical advisories. Malware is refused and the release-age limit enforced in every mode. ' +
                "This weakens the supply-chain guard while it is on: use it to find out which packages a task needs, then add them to packageAllowlist. " +
                "Fixed per run when the run is dispatched. Null turns it off.",
            },
            packageAuditMinutes: {
              type: "integer",
              minimum: 1,
              maximum: MAX_PACKAGE_AUDIT_MINUTES,
              description: `How long package audit mode stays on, in minutes from now (default ${DEFAULT_PACKAGE_AUDIT_MINUTES}, at most ${MAX_PACKAGE_AUDIT_MINUTES}: 7 days). Given alone, it re-arms the stored mode. Needs packages:approve or agents:admin.`,
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
      const debugTraceMaxMb = args.codingProfile?.debugTraceMaxMb;
      if (debugTraceMinutes !== undefined || debugTraceMaxMb !== undefined) requireDebugTraceScope(ctx);
      const auditPatch = {
        packageAuditMode: args.codingProfile?.packageAuditMode,
        packageAuditMinutes: args.codingProfile?.packageAuditMinutes,
      };
      if (
        args.codingProfile?.packageAllowlist !== undefined ||
        args.codingProfile?.packagePolicy !== undefined ||
        args.codingProfile?.dependencyCache !== undefined ||
        auditPatch.packageAuditMode !== undefined ||
        auditPatch.packageAuditMinutes !== undefined
      )
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
      // An owner-all caller (owner:all + wardby_owner) acts as the owner of every agent, so no
      // owner-only field or binding is refused to it; its repository is approved as an admin's.
      const ownerAll = isOwnerAll(ctx);
      const isOwner = ownerAll || (before.ownerId !== null && before.ownerId === ctx.principal.id);
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
      // turns, effort, memory and schedule. The run steps level is the owner's too:
      // detail records tool output that only the owner and the run's starter may read.
      const ownerOnlyChange = (existingKind: string) =>
        args.codingProfile !== undefined ||
        (args.kind !== undefined && args.kind !== existingKind) ||
        args.budgetGroupId !== undefined ||
        args.runSteps !== undefined ||
        args.documentTools !== undefined;
      const refuseOwnerOnly = () => {
        throw new McpError(
          403,
          `Agent "${args.id}": only its owner can change its coding profile, kind, budget group, run steps level or document tools.`,
        );
      };
      if (!adminEdit && !isOwner && ownerOnlyChange(before.kind)) refuseOwnerOnly();
      const authorization =
        plannedRepository !== null && repositoryChanges(before)
          ? await authorizeRepositoryForSet(ctx, {
              ownerId: before.ownerId,
              provider: codeProviderOf(plannedRepository),
              repository: plannedRepository,
              kind: "coding",
              adminOverride:
                args.repositoryAdminOverride === true ||
                (ownerAll && !(before.ownerId !== null && before.ownerId === ctx.principal.id)),
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

      let auditSet: { mode: string | null; until: Date | null } | undefined;
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
            await requireReadableBudgetGroup(tx, args.budgetGroupId, ctx.principal.id, isOwnerAll(ctx));
          }

          const nextKind = args.kind ?? existing.kind;
          if (nextKind !== existing.kind) {
            // A write link without triggers is a coding agent's extra repository
            // and a native agent's plain write access; changing kind would
            // silently reinterpret it.
            const reinterpreted = await tx.agentRepository.count({
              where: { agentId: args.id, access: "write", triggers: { isEmpty: true } },
            });
            if (reinterpreted > 0) {
              throw new McpError(
                400,
                `Agent "${args.id}" has write repository links without triggers, which mean different things on native and coding agents; unlink them before changing its kind.`,
              );
            }
          }
          // A coding repository is an owner binding (agentOwnerBindings): an
          // agent everyone can write never gets one, as attach_* refuse theirs.
          if (
            ((nextKind === "coding" && existing.kind !== "coding") || repositoryChanges(existing)) &&
            (await isPublicWritable(tx, existing.id))
          ) {
            throw new McpError(
              409,
              `Agent "${args.id}" is writable by everyone, so it can't become a coding agent or get a repository; revoke or lower the everyone grant first.`,
            );
          }
          // The document tools setting is an owner binding too (agentOwnerBindings).
          if (args.documentTools && (await isPublicWritable(tx, existing.id))) {
            throw new McpError(
              409,
              `Agent "${args.id}" is writable by everyone, so it can't get document tools; revoke or lower the everyone grant first.`,
            );
          }
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
          let tunnelStamp: ReturnType<typeof tunnelHostsStamp>;
          if (nextKind === "coding") {
            // Attached native tools stay: a Claude Code run serves them through its MCP token (#622); a
            // Codex run leaves them out, and the answer warns below.
            const {
              debugTraceMinutes: _minutes,
              debugTraceMaxMb: _maxMb,
              packageAuditMode: _auditMode,
              packageAuditMinutes: _auditMinutes,
              ...profilePatch
            } = args.codingProfile ?? {};
            const currentProfile = existing.codingProfile
              ? profileMergeBase(existing.codingProfile, profilePatch)
              : undefined;
            const profileResult = CodingProfileSchema.safeParse({ ...currentProfile, ...profilePatch });
            if (!profileResult.success) throw invalidArguments("coding profile", profileResult.error);
            nextProfile = profileResult.data;
            if (args.codingProfile?.planDocument) {
              try {
                nextProfile.planDocument = await checkPlanDocumentSetting(
                  tx,
                  { id: existing.id, ownerId: existing.ownerId },
                  args.codingProfile.planDocument,
                );
              } catch (err) {
                throw new McpError(400, err instanceof Error ? err.message : "plan_settings_invalid");
              }
            }
            if (typeof args.codingProfile?.workspaceDiskMb === "number" || nextKind !== existing.kind) {
              validateWorkspaceDiskMb(nextProfile.workspaceDiskMb);
            }
            if (args.codingProfile?.services !== undefined) await requireCatalogServiceNames(tx, nextProfile.services);
            tunnelStamp = tunnelHostsStamp(ctx, nextProfile.tunnelHosts, existing.codingProfile);
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

          // Package audit mode: resolved against the stored mode inside the
          // transaction, so minutes alone re-arm what is stored now.
          let audit: { mode: (typeof PACKAGE_AUDIT_MODES)[number] | null; until: Date | null } | undefined;
          try {
            const storedMode = existing.codingProfile?.packageAuditMode;
            audit = resolvePackageAuditPatch(
              { mode: isPackageAuditMode(storedMode) ? storedMode : null },
              auditPatch,
              new Date(),
            );
          } catch (error) {
            if (error instanceof PackageAuditPatchError) throw new McpError(400, error.message);
            throw error;
          }
          auditSet = audit;

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
            promptSummary,
            documentTools: documentToolsArg,
            ...fieldUpdates
          } = args;
          // The setting is judged against the kind the agent has after this update; a coding agent
          // keeps no setting, so becoming coding clears it.
          const nextDocumentTools =
            nextKind === "coding" && documentToolsArg === undefined
              ? existing.documentTools === null
                ? undefined
                : null
              : documentToolsArg;
          const documentToolsData =
            nextDocumentTools === undefined
              ? {}
              : {
                  documentTools:
                    nextDocumentTools === null
                      ? Prisma.DbNull
                      : await checkDocumentTools(
                          tx,
                          { id: existing.id, ownerId: existing.ownerId, kind: nextKind },
                          ctx.principal.id,
                          nextDocumentTools,
                        ),
                };
          const updates = {
            ...fieldUpdates,
            ...documentToolsData,
            ...(modeArg ? { nativeExecutionMode: toStoredMode(modeArg) } : {}),
          };
          const stamp = authorization ? profileStamp(authorization) : {};
          const trace = {
            ...(debugTraceUntil === undefined ? {} : { debugTraceUntil }),
            ...(debugTraceMaxMb === undefined ? {} : { debugTraceMaxMb }),
            ...(audit === undefined ? {} : { packageAuditMode: audit.mode, packageAuditUntil: audit.until }),
          };
          const profileMutation =
            nextKind === "native"
              ? existing.codingProfile
                ? { delete: true as const }
                : undefined
              : existing.codingProfile
                ? { update: { ...codingProfileColumns(nextProfile!), ...stamp, ...trace, ...tunnelStamp } }
                : { create: { ...codingProfileColumns(nextProfile!), ...stamp, ...trace, ...tunnelStamp } };
          const scheduleStart = await scheduleStartFields(tx, existing, {
            schedule: nextSchedule,
            timezone: nextTimezone,
            scheduleEnabled: nextScheduleEnabled,
          });
          const updated = await tx.agent.update({
            where: { id },
            data: {
              ...updates,
              ...scheduleStart,
              ...(profileMutation ? { codingProfile: profileMutation } : {}),
            },
            include: { codingProfile: true },
          });
          if (updates.systemPrompt !== undefined) {
            await recordPromptVersion(tx, {
              agentId: id,
              systemPrompt: updated.systemPrompt,
              via: "update",
              createdById: ctx.principal.id,
              summary: promptSummary,
            });
          }
          return updated;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      // Warm rounds: a change to what a retained round's fingerprint covers ends its retained sandboxes
      // now (a later round would start fresh anyway).
      if (warmFingerprintChanged(before, agent)) await removeRetainedRounds(ctx, agent.id);
      if (debugTraceUntil !== undefined || debugTraceMaxMb !== undefined) {
        agentsLog.info(
          {
            event: "coding.debug_trace.set",
            agentId: agent.id,
            ...(debugTraceUntil !== undefined ? { until: debugTraceUntil?.toISOString() ?? null } : {}),
            ...(debugTraceMaxMb !== undefined ? { maxMb: debugTraceMaxMb } : {}),
            by: ctx.principal.id,
          },
          "coding debug trace set",
        );
      }
      if (auditSet !== undefined) {
        agentsLog.info(
          {
            event: "coding.package_audit.set",
            agentId: agent.id,
            mode: auditSet.mode,
            until: auditSet.until?.toISOString() ?? null,
            by: ctx.principal.id,
          },
          "coding package audit mode set",
        );
      }
      const shown = withRunStepsWarning(withProfileWarnings(withOperatorMode(agent)));
      // Becoming a coding agent that runs commands next to the agent (Codex, Gemini CLI: a provider
      // switch, or a native agent becoming coding) leaves out every attached MCP tool the server doesn't
      // mark read-only: say which, so the owner isn't surprised by a run. Its attached native tools are
      // left out of those runs altogether (#622): say which, too.
      const wasInContainer = before.kind === "coding" && runsCommandsInAgentContainer(before.codingProfile?.provider);
      const added: string[] = [];
      if (agent.kind === "coding" && runsCommandsInAgentContainer(agent.codingProfile?.provider) && !wasInContainer) {
        const writers = await inContainerUnavailableMcpTools(ctx.db, agent.id);
        const nativeTools = await inContainerUnavailableNativeTools(ctx.db, agent.id);
        if (writers.length > 0) added.push(inContainerWriteToolsWarning(writers));
        if (nativeTools.length > 0) added.push(inContainerNativeToolsWarning(nativeTools));
      }
      // Becoming Claude Code (a provider switch, or a native agent becoming coding): its runs leave out
      // an attached tool whose name or description Claude Code can't be offered; say which.
      const wasClaudeCode = before.kind === "coding" && !wasInContainer;
      if (agent.kind === "coding" && !runsCommandsInAgentContainer(agent.codingProfile?.provider) && !wasClaudeCode) {
        const unoffered = await claudeCodeUnofferedTools(ctx.db, agent.id);
        if (unoffered.length > 0) added.push(claudeCodeUnofferedToolsWarning(unoffered));
      }
      if (added.length > 0) return textResult({ ...shown, warnings: [...(shown.warnings ?? []), ...added] });
      return textResult(shown);
    },
  });

  mcp.registerTool({
    name: "list_agents",
    scope: "agents:read",
    description:
      "Lists the agents you can see. Each row has an `access` field, your level on that agent: owner > write > execute > read. When showing the agents as a table, include `access` as a column. " +
      "summary: true returns only id, name, kind, model, codingProvider, budgetUsd, ownerId, runSteps and access per agent, for listings that don't need the full configuration. " +
      "all: true lists every agent in the deployment (admins only, admin:view); an agent you have no grant on shows access `none`.",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "boolean" }, all: { type: "boolean" } },
      additionalProperties: false,
    },
    handler: async (args: { summary?: boolean; all?: boolean }, ctx) => {
      if (args.all === true && !ctx.operator && !isOwnerAll(ctx)) requireScope(ctx, ctx.canonicalUri, "admin:view");
      const [where, accessOf] = await Promise.all([
        args.all === true ? Promise.resolve({}) : readableAgentsWhere(ctx),
        agentAccessResolver(ctx),
      ]);
      if (args.summary === true) {
        const agents = await ctx.db.agent.findMany({
          where,
          select: {
            id: true,
            name: true,
            kind: true,
            model: true,
            budgetUsd: true,
            ownerId: true,
            runSteps: true,
            codingProfile: { select: { provider: true } },
          },
          orderBy: { name: "asc" },
        });
        return textResult(
          agents.map(({ codingProfile, budgetUsd, ...agent }) => ({
            ...agent,
            codingProvider: codingProfile?.provider ?? null,
            budgetUsd: Number(budgetUsd),
            access: accessOf(agent),
          })),
        );
      }
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
          include: {
            tools: { include: { tool: { include: TOOL_GRANTS_INCLUDE } } },
            codingProfile: true,
            repositories: true,
          },
        }),
        args.id,
        "read",
      );
      // A7: a tool's code and schema are its owner's, whoever can read the
      // agent (the agent's owner included). Capabilities stay visible: config.
      return textResult({
        ...withRunStepsWarning(withProfileWarnings(withOperatorMode(agent))),
        access,
        mcpServers: await agentMcpServerViews(ctx.db, agent.id),
        // Zod 3 window: the caller's own tools carry their warnings (see core/zod3-window.ts).
        tools: await Promise.all(
          agent.tools.map(async (attachment) => ({
            ...attachment,
            tool: await withZod3ToolWarnings(projectTool(attachment.tool, ctx.principal.id, isOwnerAll(ctx))),
          })),
        ),
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
      // Warm rounds: a deleted agent's retained coding sandboxes go too (best effort; they expire anyway).
      await removeRetainedRounds(ctx, args.id);
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
      "Admins: gives an agent a new owner (an existing principal id). Secret, datastore and MCP server bindings the new owner doesn't own are removed; tool capabilities the new owner never granted are suspended until they re-run attach_tool; sub-agent edges the new owner can't delegate are removed; between two owners every grant on the agent is reset, its document tools (documentTools) are turned off, and document grants shared with the agent are removed except on the new owner's own documents (documentGrantsRemoved; adopting an owner-less agent keeps all of these). Returns what changed.",
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
      // Bounded retry: a concurrent grant or attach on the same rows aborts one side (Serializable).
      const result = await withSerializableRetry(() =>
        ctx.db.$transaction(
          async (tx) => {
            await preferIndexScans(tx);
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
              await tx.agentRepository.updateMany({
                where: { agentId: agent.id, authorizedVia: approved },
                data: reset,
              });
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

            // Document tools name the old owner's reviewers and planners: between two owners they are turned off,
            // like the other owner bindings, for the new owner to set again.
            const documentToolsCleared = transfer && agent.documentTools !== null;
            // Documents other people shared with this agent were shared with the old owner's agent: between two
            // owners those grants go too (except on the new owner's own documents), so re-enabling document tools
            // can't reach them. Adopting an owner-less agent keeps them, as it keeps documentTools.
            let documentGrantsRemoved = 0;
            if (transfer) {
              const docGrants = await tx.resourceGrant.findMany({
                where: { resourceType: "document", granteeKind: "agent", granteeAgentId: agent.id },
                select: { id: true, resourceId: true },
              });
              if (docGrants.length > 0) {
                const ownDocs = await tx.document.findMany({
                  where: { id: { in: docGrants.map((g) => g.resourceId) }, ownerId: newOwner },
                  select: { id: true },
                });
                const keep = new Set(ownDocs.map((d) => d.id));
                const drop = docGrants.filter((g) => !keep.has(g.resourceId)).map((g) => g.id);
                if (drop.length > 0) {
                  documentGrantsRemoved = (await tx.resourceGrant.deleteMany({ where: { id: { in: drop } } })).count;
                }
              }
            }
            const updated = await tx.agent.update({
              where: { id: args.agentId },
              data: { ownerId: newOwner, ...(documentToolsCleared ? { documentTools: Prisma.DbNull } : {}) },
            });

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
            // MCP server attachments: the server's brokered secrets act for its
            // owner, so a server the new owner neither owns nor holds use on is detached.
            const mcpServers = await tx.agentMcpServer.findMany({
              where: { agentId: agent.id },
              include: { server: { select: { id: true, name: true, ownerId: true } } },
              orderBy: { serverId: "asc" },
            });
            const foreignMcpServers = await filterUnusableMcpServers(tx, () => newOwner, mcpServers);
            if (foreignMcpServers.length > 0) {
              await tx.agentMcpServer.deleteMany({
                where: { agentId: agent.id, serverId: { in: foreignMcpServers.map((b) => b.serverId) } },
              });
            }
            const bindingsRemoved = [
              ...foreignSecrets.map((b) => ({ kind: "secret", boundName: b.boundName, resourceId: b.secretId })),
              ...foreignDatastores.map((b) => ({
                kind: "datastore",
                boundName: b.boundName,
                resourceId: b.datastoreId,
              })),
              ...foreignMcpServers.map((b) => ({
                kind: "mcp_server",
                boundName: b.server.name,
                resourceId: b.serverId,
              })),
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
              documentToolsCleared,
              documentGrantsRemoved,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
      return textResult(result);
    },
  });
}
