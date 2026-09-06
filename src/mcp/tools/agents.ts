/** Agent CRUD with scope checks in server.ts and ownership checks here. */
import { Prisma, type CodingAgentProfile } from "@prisma/client";
import { z } from "zod";
import {
  CodingProfilePatchSchema,
  CodingProfileSchema,
  type CodingProfile,
} from "../../coding/profile.js";
import { validateCronExpression } from "../../core/cron.js";
import { assertCanMutate, canRead, requireOwnedAgent, visibleToPrincipal } from "../auth/ownership.js";
import { McpError } from "../errors.js";
import type { ReevoMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

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
};

const CreateAgentSchema = z.object({
  name: agentFields.name,
  systemPrompt: agentFields.systemPrompt,
  model: agentFields.model,
  budgetUsd: agentFields.budgetUsd,
  maxTurns: agentFields.maxTurns.optional(),
  schedule: agentFields.schedule.optional(),
  timezone: agentFields.timezone.optional(),
  scheduleEnabled: agentFields.scheduleEnabled.optional(),
  kind: agentFields.kind.default("native"),
  codingProfile: CodingProfileSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === "coding" && !value.codingProfile) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["codingProfile"], message: "is required for coding agents" });
  }
  if (value.kind === "native" && value.codingProfile) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["codingProfile"], message: "is only valid for coding agents" });
  }
  const enabledSchedule = value.schedule && value.scheduleEnabled !== false;
  if (value.kind === "coding" && enabledSchedule && !value.codingProfile?.defaultTask) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["codingProfile", "defaultTask"], message: "is required for an enabled schedule" });
  }
});

const UpdateAgentSchema = z.object({
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
  codingProfile: CodingProfilePatchSchema.optional(),
}).strict();

type CreateAgentArgs = z.infer<typeof CreateAgentSchema>;
type UpdateAgentArgs = z.infer<typeof UpdateAgentSchema>;

const profileJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    provider: { type: "string", enum: ["codex"] },
    repository: { type: "string" },
    baseRef: { type: "string" },
    defaultTask: { type: ["string", "null"] },
    timeoutSec: { type: "integer", minimum: 60, maximum: 7200 },
    allowedEgress: { type: "array", maxItems: 64, items: { type: "string" } },
    protectedPaths: { type: "array", minItems: 1, maxItems: 128, items: { type: "string" } },
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

function storedProfile(profile: CodingAgentProfile): CodingProfile {
  return CodingProfileSchema.parse({
    provider: profile.provider,
    repository: profile.repository,
    baseRef: profile.baseRef,
    defaultTask: profile.defaultTask,
    timeoutSec: profile.timeoutSec,
    allowedEgress: profile.allowedEgress,
    protectedPaths: profile.protectedPaths,
  });
}

export function registerAgentTools(mcp: ReevoMcpServer): void {
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
        codingProfile: { ...profileJsonSchema, required: ["repository"] },
      },
      required: ["name", "systemPrompt", "model", "budgetUsd"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = parseCreateAgent(rawArgs);
      validateSchedule(args.schedule, args.timezone ?? "UTC");
      const { codingProfile, ...agentData } = args;
      const agent = await ctx.db.agent.create({
        data: {
          ...agentData,
          ownerId: ctx.principal.id,
          ...(codingProfile ? { codingProfile: { create: codingProfile } } : {}),
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
        codingProfile: profileJsonSchema,
      },
      required: ["id"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = parseUpdateAgent(rawArgs);
      const agent = await ctx.db.$transaction(async (tx) => {
        const existing = await tx.agent.findUnique({ where: { id: args.id }, include: { codingProfile: true } });
        if (!existing) throw new McpError(404, `Agent "${args.id}" not found.`);
        assertCanMutate(existing.ownerId, ctx.principal.id, `Agent "${args.id}" is not owned by the caller.`);

        const nextKind = args.kind ?? existing.kind;
        if (nextKind === "native" && args.codingProfile) {
          throw new McpError(400, "A coding profile is only valid for coding agents.");
        }

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
        }

        const nextSchedule = args.schedule !== undefined ? args.schedule : existing.schedule;
        const nextTimezone = args.timezone ?? existing.timezone;
        const nextScheduleEnabled = args.scheduleEnabled ?? existing.scheduleEnabled;
        validateSchedule(nextSchedule, nextTimezone);
        if (nextKind === "coding" && nextSchedule && nextScheduleEnabled && !nextProfile?.defaultTask) {
          throw new McpError(400, "A default task is required for an enabled coding-agent schedule.");
        }

        const { id, codingProfile: _profilePatch, ...updates } = args;
        const profileMutation = nextKind === "native"
          ? (existing.codingProfile ? { delete: true as const } : undefined)
          : (existing.codingProfile ? { update: nextProfile! } : { create: nextProfile! });
        return tx.agent.update({
          where: { id },
          data: {
            ...updates,
            ...(profileMutation ? { codingProfile: profileMutation } : {}),
          },
          include: { codingProfile: true },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
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
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    handler: async (args: { id: string }, ctx) => {
      const agent = await ctx.db.agent.findUnique({
        where: { id: args.id },
        include: { tools: { include: { tool: true } }, codingProfile: true },
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
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    handler: async (args: { id: string }, ctx) => {
      await requireOwnedAgent(ctx.db, args.id, ctx.principal.id);
      await ctx.db.agent.delete({ where: { id: args.id } });
      return textResult({ deleted: args.id });
    },
  });
}
