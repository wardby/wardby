/**
 * AgentSubAgent CRUD — agent-composition edges. Attach/detach require
 * ownership of both the parent and child agent (same convention as
 * attach_tool requiring ownership of both the agent and the tool), and
 * attach rejects any edge that would create a cycle in the parent/child
 * graph (§7 of the design doc) — cycles are not something Postgres can
 * enforce natively.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { requireOwnedAgent } from "../auth/ownership.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

type SubAgentDb = Pick<PrismaClient, "agentSubAgent">;

/**
 * True if `fromAgentId` can already reach `toAgentId` by following existing
 * parent -> child edges. Attaching a new edge parentAgentId -> childAgentId
 * is only safe when childAgentId cannot already reach parentAgentId --
 * otherwise the new edge would close a cycle. Loads the whole edge set and
 * walks it in JS rather than a recursive SQL query: the edge count is
 * expected to stay small (agent-composition graphs, not a general graph
 * store), and this keeps the check readable and easy to unit test.
 */
async function canReach(db: SubAgentDb, fromAgentId: string, toAgentId: string): Promise<boolean> {
  const edges = await db.agentSubAgent.findMany({ select: { parentAgentId: true, childAgentId: true } });
  const childrenOf = new Map<string, string[]>();
  for (const edge of edges) {
    const list = childrenOf.get(edge.parentAgentId) ?? [];
    list.push(edge.childAgentId);
    childrenOf.set(edge.parentAgentId, list);
  }
  const seen = new Set<string>([fromAgentId]);
  const stack = [fromAgentId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === toAgentId) return true;
    for (const next of childrenOf.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

export function registerSubAgentTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "attach_subagent",
    scope: "agents:write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        parentAgentId: { type: "string" },
        childAgentId: { type: "string" },
        boundName: { type: "string", minLength: 1 },
      },
      required: ["parentAgentId", "childAgentId"],
    },
    handler: async (args: { parentAgentId: string; childAgentId: string; boundName?: string }, ctx) => {
      if (args.parentAgentId === args.childAgentId) {
        throw new McpError(400, "An agent cannot be its own sub-agent.");
      }
      const parent = await requireOwnedAgent(ctx.db, args.parentAgentId, ctx.principal.id);
      const child = await requireOwnedAgent(ctx.db, args.childAgentId, ctx.principal.id);
      if (await canReach(ctx.db, args.childAgentId, args.parentAgentId)) {
        throw new McpError(400, `Attaching "${child.name}" as a sub-agent of "${parent.name}" would create a cycle.`);
      }
      const boundName = args.boundName ?? child.name;
      try {
        await ctx.db.agentSubAgent.upsert({
          where: { parentAgentId_childAgentId: { parentAgentId: args.parentAgentId, childAgentId: args.childAgentId } },
          create: { parentAgentId: args.parentAgentId, childAgentId: args.childAgentId, boundName },
          update: { boundName },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new McpError(409, `"${parent.name}" already has a different sub-agent bound to name "${boundName}".`);
        }
        throw err;
      }
      return textResult({ attached: true, boundName });
    },
  });

  mcp.registerTool({
    name: "detach_subagent",
    scope: "agents:write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        parentAgentId: { type: "string" },
        childAgentId: { type: "string" },
      },
      required: ["parentAgentId", "childAgentId"],
    },
    handler: async (args: { parentAgentId: string; childAgentId: string }, ctx) => {
      await requireOwnedAgent(ctx.db, args.parentAgentId, ctx.principal.id);
      await requireOwnedAgent(ctx.db, args.childAgentId, ctx.principal.id);
      await ctx.db.agentSubAgent.deleteMany({
        where: { parentAgentId: args.parentAgentId, childAgentId: args.childAgentId },
      });
      return textResult({ detached: true });
    },
  });

  mcp.registerTool({
    name: "list_subagents",
    scope: "agents:read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { agentId: { type: "string" } },
      required: ["agentId"],
    },
    handler: async (args: { agentId: string }, ctx) => {
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      const [asParent, asChild] = await Promise.all([
        ctx.db.agentSubAgent.findMany({
          where: { parentAgentId: args.agentId },
          include: { child: { select: { id: true, name: true } } },
        }),
        ctx.db.agentSubAgent.findMany({
          where: { childAgentId: args.agentId },
          include: { parent: { select: { id: true, name: true } } },
        }),
      ]);
      return textResult({
        children: asParent.map((e) => ({ boundName: e.boundName, agentId: e.child.id, agentName: e.child.name })),
        parents: asChild.map((e) => ({ boundName: e.boundName, agentId: e.parent.id, agentName: e.parent.name })),
      });
    },
  });
}
