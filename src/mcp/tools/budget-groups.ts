/** BudgetGroup CRUD with scope checks in server.ts and ownership checks here. */
import { z } from "zod";
import { computeGroupSpend } from "../../core/budget-groups.js";
import { canRead, requireOwnedBudgetGroup, visibleToPrincipal } from "../auth/ownership.js";
import { McpError } from "../errors.js";
import type { ReevoMcpServer } from "../server.js";
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

export function registerBudgetGroupTools(mcp: ReevoMcpServer): void {
  mcp.registerTool({
    name: "create_budget_group",
    scope: "budget_groups:write",
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
    scope: "budget_groups:write",
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
      await requireOwnedBudgetGroup(ctx.db, id, ctx.principal.id);
      const group = await ctx.db.budgetGroup.update({ where: { id }, data: updates });
      return textResult(group);
    },
  });

  mcp.registerTool({
    name: "list_budget_groups",
    scope: "agents:read",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args: Record<string, never>, ctx) => {
      const groups = await ctx.db.budgetGroup.findMany({ where: visibleToPrincipal(ctx.principal.id) });
      return textResult(groups);
    },
  });

  mcp.registerTool({
    name: "get_budget_group",
    scope: "agents:read",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async (args: { id: string }, ctx) => {
      const group = await ctx.db.budgetGroup.findUnique({
        where: { id: args.id },
        include: { agents: { select: { id: true, name: true } } },
      });
      if (!group || !canRead(group.ownerId, ctx.principal.id)) {
        throw new McpError(404, `Budget group "${args.id}" not found.`);
      }
      const spend = await computeGroupSpend(
        ctx.db,
        group,
        group.agents.map((a) => a.id),
        new Date(),
      );
      return textResult({ ...group, spend });
    },
  });

  mcp.registerTool({
    name: "delete_budget_group",
    scope: "budget_groups:write",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async (args: { id: string }, ctx) => {
      await requireOwnedBudgetGroup(ctx.db, args.id, ctx.principal.id);
      // Agent.budgetGroupId -> BudgetGroup is ON DELETE SET NULL: member
      // agents are ungrouped automatically, never blocked or cascaded.
      await ctx.db.budgetGroup.delete({ where: { id: args.id } });
      return textResult({ deleted: args.id });
    },
  });
}
