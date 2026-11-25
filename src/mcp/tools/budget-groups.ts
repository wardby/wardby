/** BudgetGroup CRUD with scope checks in server.ts and ownership checks here. */
import { z } from "zod";
import { computeGroupSpend } from "../../core/budget-groups.js";
import { Prisma } from "#prisma";
import { atLeast, deleteGrantsFor } from "../../core/grants.js";
import { withSerializableRetry } from "../../core/serializable-retry.js";
import { agentAccessResolver } from "../auth/access.js";
import { readableBudgetGroupsWhere, requireBudgetGroupAccess } from "../auth/ownership.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

const MAX_GROUP_NAME_CHARS = 200;
const MAX_BUDGET_USD = 1_000_000;

const capField = z.number().finite().positive().max(MAX_BUDGET_USD);

const CreateBudgetGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_GROUP_NAME_CHARS),
    dailyBudgetUsd: capField.optional(),
    weeklyBudgetUsd: capField.optional(),
    monthlyBudgetUsd: capField.optional(),
    warnThresholdRatio: z.number().finite().gt(0).lte(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.dailyBudgetUsd === undefined &&
      value.weeklyBudgetUsd === undefined &&
      value.monthlyBudgetUsd === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dailyBudgetUsd"],
        message: "at least one of dailyBudgetUsd/weeklyBudgetUsd/monthlyBudgetUsd is required",
      });
    }
  });

const UpdateBudgetGroupSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().trim().min(1).max(MAX_GROUP_NAME_CHARS).optional(),
    dailyBudgetUsd: capField.nullable().optional(),
    weeklyBudgetUsd: capField.nullable().optional(),
    monthlyBudgetUsd: capField.nullable().optional(),
    warnThresholdRatio: z.number().finite().gt(0).lte(1).optional(),
  })
  .strict();

function invalidArguments(label: string, error: z.ZodError): McpError {
  const details = error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
  return new McpError(400, `Invalid ${label}: ${details}`);
}

const capSchemaProps = {
  dailyBudgetUsd: { type: ["number", "null"] },
  weeklyBudgetUsd: { type: ["number", "null"] },
  monthlyBudgetUsd: { type: ["number", "null"] },
  warnThresholdRatio: { type: "number" },
};

export function registerBudgetGroupTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "create_budget_group",
    permission: "budget_groups:write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string" }, ...capSchemaProps },
      required: ["name"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const result = CreateBudgetGroupSchema.safeParse(rawArgs);
      if (!result.success) throw invalidArguments("create_budget_group arguments", result.error);
      const group = await ctx.db.budgetGroup.create({
        data: { ...result.data, ownerId: ctx.principal.id },
      });
      return textResult(group);
    },
  });

  mcp.registerTool({
    name: "update_budget_group",
    permission: "budget_groups:write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" }, name: { type: "string" }, ...capSchemaProps },
      required: ["id"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const result = UpdateBudgetGroupSchema.safeParse(rawArgs);
      if (!result.success) throw invalidArguments("update_budget_group arguments", result.error);
      const { id, ...updates } = result.data;
      await requireBudgetGroupAccess(ctx, id, "write");
      const group = await ctx.db.budgetGroup.update({ where: { id }, data: updates });
      return textResult(group);
    },
  });

  mcp.registerTool({
    name: "list_budget_groups",
    permission: "agents:read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args: Record<string, never>, ctx) => {
      const groups = await ctx.db.budgetGroup.findMany({ where: await readableBudgetGroupsWhere(ctx) });
      return textResult(groups);
    },
  });

  mcp.registerTool({
    name: "get_budget_group",
    permission: "agents:read",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async (args: { id: string }, ctx) => {
      await requireBudgetGroupAccess(ctx, args.id, "read");
      const group = await ctx.db.budgetGroup.findUniqueOrThrow({
        where: { id: args.id },
        include: { agents: { select: { id: true, name: true, budgetUsd: true, ownerId: true } } },
      });
      const spend = await computeGroupSpend(ctx.db, group, group.agents, new Date());
      // The group's spend is the group's; the agents in it are listed only when the caller may read them.
      const canReadAgent = await agentAccessResolver(ctx);
      const visible = group.agents.filter((agent) => atLeast("agent", canReadAgent(agent), "read"));
      return textResult({ ...group, agents: visible.map(({ id, name }) => ({ id, name })), spend });
    },
  });

  mcp.registerTool({
    name: "delete_budget_group",
    permission: "budget_groups:write",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async (args: { id: string }, ctx) => {
      await requireBudgetGroupAccess(ctx, args.id, "owner");
      // Agent.budgetGroupId -> BudgetGroup is ON DELETE SET NULL: member
      // agents are ungrouped automatically, never blocked or cascaded.
      // Serializable, so a concurrent grant_access cannot leave a grant row behind a deleted group.
      await withSerializableRetry(() =>
        ctx.db.$transaction(
          async (tx) => {
            await deleteGrantsFor(tx, "budget_group", args.id);
            await tx.budgetGroup.delete({ where: { id: args.id } });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
      return textResult({ deleted: args.id });
    },
  });
}
