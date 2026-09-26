/** Agent CRUD with scope checks in server.ts and ownership checks here. */
import { Prisma, type CodingAgentProfile } from "#prisma";
import { z } from "zod";
import { CodingProfilePatchSchema, CodingProfileSchema, type CodingProfile } from "../../coding/profile.js";
import { codingProviderSupportsModel } from "../../coding/provider.js";
import { validateCronExpression } from "../../core/cron.js";
import { modelSupportedEfforts } from "../../providers/llm/routing.js";
import { LLM_EFFORT_LEVELS, isLlmEffort } from "../../providers/llm/types.js";
import {
  assertCanMutate,
  canMutate,
  canRead,
  requireOwnedAgent,
  requireReadableBudgetGroup,
  visibleToPrincipal,
} from "../auth/ownership.js";
import { requireAnyScope, requireScope } from "../auth/resource-server.js";
import { authorizeRepositoryForSet, type RepositoryAuthorization } from "../auth/repo-authorization.js";
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

/** Package allowlists widen what a run may download, so they need their own approval. */
function requirePackageApproval(ctx: McpRequestContext): void {
  requireAnyScope(ctx, ctx.canonicalUri, "packages:approve", "agents:admin");
}

const MAX_AGENT_NAME_CHARS = 200;
const MAX_SYSTEM_PROMPT_CHARS = 64 * 1024;
const MAX_MODEL_CHARS = 128;
const MAX_BUDGET_USD = 1_000_000;

const agentFields = {
  name: z.string().trim().min(1).max(MAX_AGENT_NAME_CHARS),
  systemPrompt: z.string().min(1).max(MAX_SYSTEM_PROMPT_CHARS),
  model: z.string().trim().min(1).max(MAX_MODEL_CHARS),
  budgetUsd: z.number().finite().positive().max(MAX_BUDGET_USD),
  maxTurns: z.number().int().min(1).max(100),
  schedule: z.string().trim().min(1).max(256),
  timezone: z.string().trim().min(1).max(128),
  scheduleEnabled: z.boolean(),
  kind: z.enum(["native", "coding"]),
  budgetGroupId: z.string().min(1).max(128),
  memoryEnabled: z.boolean(),
  effort: z.enum(LLM_EFFORT_LEVELS),
};

const CreateAgentSchema = z
  .object({
    name: agentFields.name,
    systemPrompt: agentFields.systemPrompt,
    model: agentFields.model,
    budgetUsd: agentFields.budgetUsd,
    maxTurns: agentFields.maxTurns.optional(),
    schedule: agentFields.schedule.optional(),
    timezone: agentFields.timezone.optional(),
    scheduleEnabled: agentFields.scheduleEnabled.optional(),
    kind: agentFields.kind.default("native"),
    budgetGroupId: agentFields.budgetGroupId.optional(),
    memoryEnabled: agentFields.memoryEnabled.default(false),
    effort: agentFields.effort.optional(),
    codingProfile: CodingProfileSchema.optional(),
    repositoryAdminOverride: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
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
    if (
      value.kind === "coding" &&
      value.codingProfile &&
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
    schedule: agentFields.schedule.nullable().optional(),
    timezone: agentFields.timezone.optional(),
    scheduleEnabled: agentFields.scheduleEnabled.optional(),
    kind: agentFields.kind.optional(),
    budgetGroupId: agentFields.budgetGroupId.nullable().optional(),
    memoryEnabled: agentFields.memoryEnabled.optional(),
    effort: agentFields.effort.nullable().optional(),
    codingProfile: CodingProfilePatchSchema.optional(),
    repositoryAdminOverride: z.boolean().optional(),
  })
  .strict();

type CreateAgentArgs = z.infer<typeof CreateAgentSchema>;
type UpdateAgentArgs = z.infer<typeof UpdateAgentSchema>;

const REPOSITORY_ADMIN_OVERRIDE = {
  type: "boolean",
  description:
    "Admins only (agents:admin with the admin role): approve codingProfile.repository without checking GitHub access, recorded as an admin approval. On an agent the admin doesn't own, only codingProfile.repository may change.",
};

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
        "owner/name on GitHub. Your linked GitHub account (link_host_account) must have write access to it, unless a wardby admin approves it (repositoryAdminOverride). Re-checked on every run.",
    },
    baseRef: { type: "string" },
    defaultTask: { type: ["string", "null"] },
    allowWebhookTaskOverride: { type: "boolean" },
    timeoutSec: { type: "integer", minimum: 60, maximum: 7200 },
    protectedPaths: { type: "array", minItems: 1, maxItems: 128, items: { type: "string" } },
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
    packageAllowlist: {
      type: "object",
      description: "Approved top-level packages per ecosystem (npm, pypi). Needs packages:approve or agents:admin.",
      additionalProperties: { type: "array", maxItems: 256, items: { type: "string" } },
    },
    packagePolicy: {
      type: "object",
      properties: { minReleaseAgeDays: { type: "integer", minimum: 0, maximum: 30 } },
      additionalProperties: false,
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
    packageAllowlist: profile.packageAllowlist,
    packagePolicy: profile.packagePolicy,
  });
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
        codingProfile: { ...profileJsonSchema, required: ["repository"] },
        repositoryAdminOverride: REPOSITORY_ADMIN_OVERRIDE,
      },
      required: ["name", "systemPrompt", "model", "budgetUsd"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = parseCreateAgent(rawArgs);
      if (args.codingProfile?.workerImageRef != null) requireWorkerImageRefScope(ctx);
      const packages = args.codingProfile;
      if (
        packages &&
        (Object.keys(packages.packageAllowlist ?? {}).length > 0 ||
          Object.keys(packages.packagePolicy ?? {}).length > 0)
      )
        requirePackageApproval(ctx);
      validateSchedule(args.schedule, args.timezone ?? "UTC");
      validateEffort(args.kind, args.model, args.effort);
      if (args.budgetGroupId) {
        await requireReadableBudgetGroup(ctx.db, args.budgetGroupId, ctx.principal.id);
      }
      const { codingProfile, repositoryAdminOverride, ...agentData } = args;
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
      return textResult(agent);
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
        codingProfile: profileJsonSchema,
        repositoryAdminOverride: REPOSITORY_ADMIN_OVERRIDE,
      },
      required: ["id"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = parseUpdateAgent(rawArgs);
      if (args.codingProfile?.workerImageRef !== undefined) requireWorkerImageRefScope(ctx);
      if (args.codingProfile?.packageAllowlist !== undefined || args.codingProfile?.packagePolicy !== undefined)
        requirePackageApproval(ctx);

      // Repository authorization calls GitHub, so it runs before (outside) the
      // serializable transaction, on a pre-read; the transaction then verifies
      // the pre-read still holds. Only a changed repository (or becoming a
      // coding agent) is re-authorized; other edits keep the existing stamp.
      const before = await ctx.db.agent.findUnique({ where: { id: args.id }, include: { codingProfile: true } });
      if (!before) throw new McpError(404, `Agent "${args.id}" not found.`);
      // An admin may approve a repository (repositoryAdminOverride) on an agent
      // they don't own, but change nothing else on it.
      const adminEdit = args.repositoryAdminOverride === true && !canMutate(before.ownerId, ctx.principal.id);
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
        assertCanMutate(before.ownerId, ctx.principal.id, `Agent "${args.id}" is not owned by the caller.`);
      }
      const repositoryAfter = (kind: string, profile: { repository: string } | null | undefined) =>
        kind === "coding" ? (args.codingProfile?.repository ?? profile?.repository ?? null) : null;
      const plannedRepository = repositoryAfter(args.kind ?? before.kind, before.codingProfile);
      const repositoryChanges = (existing: { kind: string; codingProfile: { repository: string } | null }) => {
        const next = repositoryAfter(args.kind ?? existing.kind, existing.codingProfile);
        return next !== null && (existing.kind !== "coding" || existing.codingProfile?.repository !== next);
      };
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

      const agent = await ctx.db.$transaction(
        async (tx) => {
          const existing = await tx.agent.findUnique({ where: { id: args.id }, include: { codingProfile: true } });
          if (!existing) throw new McpError(404, `Agent "${args.id}" not found.`);
          if (!adminEdit) {
            assertCanMutate(existing.ownerId, ctx.principal.id, `Agent "${args.id}" is not owned by the caller.`);
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
            await requireReadableBudgetGroup(ctx.db, args.budgetGroupId, ctx.principal.id);
          }

          const nextKind = args.kind ?? existing.kind;
          if (nextKind === "native" && args.codingProfile) {
            throw new McpError(400, "A coding profile is only valid for coding agents.");
          }
          validateEffort(
            nextKind,
            args.model ?? existing.model,
            args.effort !== undefined ? args.effort : existing.effort,
          );

          let nextProfile: CodingProfile | null = null;
          if (nextKind === "coding") {
            const attachedTools = await tx.agentTool.count({ where: { agentId: args.id } });
            if (attachedTools > 0) {
              throw new McpError(400, "Detach all native sandbox tools before changing an agent to coding.");
            }
            const currentProfile = existing.codingProfile ? storedProfile(existing.codingProfile) : undefined;
            const profileResult = CodingProfileSchema.safeParse({ ...currentProfile, ...args.codingProfile });
            if (!profileResult.success) throw invalidArguments("coding profile", profileResult.error);
            nextProfile = profileResult.data;
            const nextModel = args.model ?? existing.model;
            if (!codingProviderSupportsModel(nextProfile.provider, nextModel)) {
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

          const { id, codingProfile: _profilePatch, repositoryAdminOverride: _override, ...updates } = args;
          const stamp = authorization ? profileStamp(authorization) : {};
          const profileMutation =
            nextKind === "native"
              ? existing.codingProfile
                ? { delete: true as const }
                : undefined
              : existing.codingProfile
                ? { update: { ...nextProfile!, ...stamp } }
                : { create: { ...nextProfile!, ...stamp } };
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
      return textResult(agent);
    },
  });

  mcp.registerTool({
    name: "list_agents",
    scope: "agents:read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args: Record<string, never>, ctx) => {
      const agents = await ctx.db.agent.findMany({
        where: visibleToPrincipal(ctx.principal.id),
        include: { codingProfile: true },
      });
      return textResult(agents);
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
      const agent = await ctx.db.agent.findUnique({
        where: { id: args.id },
        include: { tools: { include: { tool: true } }, codingProfile: true, repositories: true },
      });
      if (!agent || !canRead(agent.ownerId, ctx.principal.id)) {
        throw new McpError(404, `Agent "${args.id}" not found.`);
      }
      return textResult(agent);
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
      await requireOwnedAgent(ctx.db, args.id, ctx.principal.id);
      try {
        await ctx.db.agent.delete({ where: { id: args.id } });
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

  // Deliberately bypasses ownership entirely (no assertCanMutate/
  // requireOwnedAgent call) — that's the point of this tool vs. the
  // self-service null-owner-is-public-mutable rule everything else here
  // follows. Gated on agents:admin, a step up from agents:write, so an
  // ordinary caller can never reach it regardless of what they own.
  // ownerId: null releases the agent back to public, same as any agent
  // that was never assigned an owner.
  mcp.registerTool({
    name: "make_owner",
    scope: "agents:admin",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { agentId: { type: "string" }, ownerId: { type: ["string", "null"] } },
      required: ["agentId", "ownerId"],
    },
    handler: async (args: { agentId: string; ownerId: string | null }, ctx) => {
      if (args.ownerId !== null) {
        const principal = await ctx.db.principal.findUnique({ where: { id: args.ownerId } });
        if (!principal) throw new McpError(400, `Principal "${args.ownerId}" not found.`);
      }
      const result = await ctx.db.$transaction(
        async (tx) => {
          const agent = await tx.agent.findUnique({ where: { id: args.agentId }, include: { codingProfile: true } });
          if (!agent) throw new McpError(404, `Agent "${args.agentId}" not found.`);
          // Admin and grandfathered repository approvals were granted to the
          // agent under its current owner. Moving it away from that owner (to
          // someone else, or to public) turns them into ordinary checks of the
          // next owner's own GitHub access, so an approval never travels with
          // the agent. A public agent getting its first owner keeps them: that
          // is the pre-upgrade step for public agents with repositories.
          const revoked: string[] = [];
          if (agent.ownerId !== null && agent.ownerId !== args.ownerId) {
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
          const updated = await tx.agent.update({ where: { id: args.agentId }, data: { ownerId: args.ownerId } });
          return { ...updated, repositoryApprovalsRevoked: revoked };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return textResult(result);
    },
  });
}
