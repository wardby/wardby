/**
 * Tool authoring — raw path only (Amendment A: the guided Elicitation/Tasks
 * flow is deferred; this ships create_tool + dry_run_tool as the
 * test-before-commit loop instead). A compile/validation failure is a
 * NORMAL tool result carrying `{ok:false, errorKind, errorMessage}` — not
 * an isError — since the call itself succeeded (compilation was attempted
 * and correctly reported a problem the caller can fix and retry), matching
 * runInSandbox's own SandboxResult convention. Ownership/scope failures
 * (attach/detach on an agent or tool you don't own) DO throw, same
 * convention as every other tool in this codebase.
 */
import type { Datastore } from "../../providers/index.js";
import { Prisma, type PrismaClient } from "@prisma/client";
import { deriveJsonSchema, validateParams } from "../../sandbox/zod-params.js";
import { runInSandbox } from "../../sandbox/run-in-sandbox.js";
import type { ReevoMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import { assertCanMutate, requireOwnedAgent, requireReadableAgent, visibleToPrincipal, canRead } from "../auth/ownership.js";

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function requireOwnedTool(db: Pick<PrismaClient, "tool">, id: string, principalId: string) {
  const tool = await db.tool.findUnique({ where: { id } });
  if (!tool) throw new McpError(404, `Tool "${id}" not found.`);
  if (tool.ownerId !== principalId) throw new McpError(403, `Tool "${id}" is not owned by the caller.`);
  return tool;
}

export function registerToolAuthoringTools(mcp: ReevoMcpServer): void {
  mcp.registerTool({
    name: "create_tool",
    scope: "tools:write",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        paramsZod: { type: "string" },
        code: { type: "string" },
      },
      required: ["name", "description", "paramsZod", "code"],
    },
    handler: async (args: { name: string; description: string; paramsZod: string; code: string }, ctx) => {
      const schemaResult = await deriveJsonSchema(args.paramsZod);
      if (!schemaResult.ok) {
        return textResult({ ok: false, errorKind: schemaResult.errorKind, errorMessage: schemaResult.errorMessage });
      }
      const tool = await ctx.db.tool.create({
        data: {
          name: args.name,
          description: args.description,
          paramsZod: args.paramsZod,
          code: args.code,
          jsonSchema: schemaResult.value as object,
          ownerId: ctx.principal.id,
        },
      });
      return textResult(tool);
    },
  });

  mcp.registerTool({
    name: "dry_run_tool",
    scope: "tools:write",
    inputSchema: {
      type: "object",
      properties: { paramsZod: { type: "string" }, code: { type: "string" }, sampleArgs: { type: "object" } },
      required: ["paramsZod", "code", "sampleArgs"],
    },
    handler: async (args: { paramsZod: string; code: string; sampleArgs: unknown }, ctx) => {
      const schemaResult = await deriveJsonSchema(args.paramsZod);
      if (!schemaResult.ok) {
        return textResult({ ok: false, errorKind: schemaResult.errorKind, errorMessage: schemaResult.errorMessage });
      }
      const jsonSchema = schemaResult.value;

      const validated = await validateParams(args.paramsZod, args.sampleArgs);
      if (!validated.ok) {
        return textResult({
          jsonSchema,
          result: { ok: false, errorKind: validated.errorKind, errorMessage: validated.errorMessage },
        });
      }

      // No real agent exists for a dry run — the caller's own principal
      // scopes the sandbox's datastore access, keeping dry-run reads/writes
      // isolated per-caller rather than colliding across authors.
      const sandboxResult = await runInSandbox({
        code: args.code,
        params: validated.value,
        agentId: ctx.principal.id,
        datastore: ctx.providers.datastore as Datastore,
        toolName: "dry_run_tool",
      });
      return textResult({ jsonSchema, result: sandboxResult });
    },
  });

  mcp.registerTool({
    name: "attach_tool",
    scope: "tools:write",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, toolId: { type: "string" } }, required: ["agentId", "toolId"] },
    handler: async (args: { agentId: string; toolId: string }, ctx) => {
      await ctx.db.$transaction(async (tx) => {
        const agent = await tx.agent.findUnique({ where: { id: args.agentId } });
        if (!agent) throw new McpError(404, `Agent "${args.agentId}" not found.`);
        assertCanMutate(agent.ownerId, ctx.principal.id, `Agent "${args.agentId}" is not owned by the caller.`);
        if (agent.kind === "coding") {
          throw new McpError(400, "Native sandbox tools cannot be attached to coding agents.");
        }
        await requireOwnedTool(tx, args.toolId, ctx.principal.id);
        await tx.agentTool.create({ data: { agentId: args.agentId, toolId: args.toolId } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return textResult({ attached: true });
    },
  });

  mcp.registerTool({
    name: "detach_tool",
    scope: "tools:write",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, toolId: { type: "string" } }, required: ["agentId", "toolId"] },
    handler: async (args: { agentId: string; toolId: string }, ctx) => {
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      await requireOwnedTool(ctx.db, args.toolId, ctx.principal.id);
      await ctx.db.agentTool.deleteMany({ where: { agentId: args.agentId, toolId: args.toolId } });
      return textResult({ detached: true });
    },
  });

  mcp.registerTool({
    name: "list_tools",
    scope: "tools:write",
    inputSchema: { type: "object", properties: { agentId: { type: "string" } } },
    handler: async (args: { agentId?: string }, ctx) => {
      const project = (tool: import("@prisma/client").Tool) => tool.ownerId === ctx.principal.id ? tool : { id: tool.id, name: tool.name, description: tool.description };
      if (args.agentId) {
        await requireReadableAgent(ctx.db, args.agentId, ctx.principal.id);
        const rows = await ctx.db.agentTool.findMany({ where: { agentId: args.agentId }, include: { tool: true } });
        return textResult(rows.map((r) => r.tool).filter((tool) => canRead(tool.ownerId, ctx.principal.id)).map(project));
      }
      const tools = await ctx.db.tool.findMany({ where: visibleToPrincipal(ctx.principal.id) });
      return textResult(tools.filter((tool) => canRead(tool.ownerId, ctx.principal.id)).map(project));
    },
  });
}
