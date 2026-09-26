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
import { Prisma, type Tool } from "#prisma";
import { deriveJsonSchema, validateParams } from "../../sandbox/zod-params.js";
import { runInSandbox } from "../../sandbox/run-in-sandbox.js";
import { ToolCapabilitiesPatchSchema } from "../../sandbox/tool-capabilities.js";
import { buildSharedDatastoreAccessor } from "../../core/datastores.js";
import { findSameNamedAttachedTool, reservedToolNameReason } from "../../core/tool-names.js";
import type { WardbyMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import {
  assertCanMutate,
  requireOwnedAgent,
  requireOwnedTool,
  requireReadableAgent,
  requireStrictlyOwnedTool,
  visibleToPrincipal,
  canRead,
} from "../auth/ownership.js";
import { textResult } from "./text-result.js";

type AttachedAgent = { id: string; name: string; ownerId: string | null };

/** The agents `toolId` is attached to, read inside the caller's transaction. */
async function attachedAgents(tx: Pick<Prisma.TransactionClient, "agentTool">, toolId: string) {
  const rows = await tx.agentTool.findMany({
    where: { toolId },
    select: { agent: { select: { id: true, name: true, ownerId: true } } },
  });
  return rows.map((row): AttachedAgent => row.agent);
}

/**
 * Names the agents the caller can read (its own and public ones) and only
 * counts the rest, so a refusal never reveals another principal's agent
 * names or ids.
 */
function describeAgents(agents: AttachedAgent[], principalId: string): string {
  const readable = agents.filter((agent) => canRead(agent.ownerId, principalId));
  const hidden = agents.length - readable.length;
  const parts = readable.map((agent) => `"${agent.name}" (${agent.id})`);
  if (hidden > 0) parts.push(`${hidden} agent(s) owned by other principals`);
  return parts.join(", ");
}

/** Refuses a name one of the runner's built-ins would shadow (see core/tool-names.ts). */
function assertToolNameAllowed(name: string): void {
  const reason = reservedToolNameReason(name);
  if (reason) throw new McpError(400, reason);
}

export function registerToolAuthoringTools(mcp: WardbyMcpServer): void {
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
      assertToolNameAllowed(args.name);
      const schemaResult = await deriveJsonSchema(args.paramsZod);
      if (!schemaResult.ok) {
        return textResult({ ok: false, errorKind: schemaResult.errorKind, errorMessage: schemaResult.errorMessage });
      }
      try {
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
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new McpError(409, `A tool named "${args.name}" already exists for your principal.`);
        }
        throw err;
      }
    },
  });

  mcp.registerTool({
    name: "update_tool",
    scope: "tools:write",
    description:
      "Replaces a tool's description, paramsZod and/or code in place (its name can't change: agents' prompts call it by name). Owner-only: public tools can't be changed over MCP. Refused while the tool is attached to any agent you don't own, including public agents, since the change would reach another owner's agent; detach it there first or create a new tool. Runs already started keep the version they loaded for their whole lifetime; the next run picks up the new one.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        toolId: { type: "string" },
        description: { type: "string" },
        paramsZod: { type: "string" },
        code: { type: "string" },
      },
      required: ["toolId"],
    },
    handler: async (args: { toolId: string; description?: string; paramsZod?: string; code?: string }, ctx) => {
      if (args.description === undefined && args.paramsZod === undefined && args.code === undefined) {
        throw new McpError(400, "update_tool needs at least one of description, paramsZod or code.");
      }
      // Checked once up front so a non-owner never gets as far as a sandbox
      // compile, and again (with the attachments) inside the transaction.
      await requireStrictlyOwnedTool(ctx.db, args.toolId, ctx.principal.id);
      // Same derivation as create_tool: the cached jsonSchema must never go
      // stale against paramsZod (see Tool.jsonSchema). Done before the
      // transaction so a QuickJS compile never holds it open.
      let jsonSchema: object | undefined;
      if (args.paramsZod !== undefined) {
        const schemaResult = await deriveJsonSchema(args.paramsZod);
        if (!schemaResult.ok) {
          return textResult({ ok: false, errorKind: schemaResult.errorKind, errorMessage: schemaResult.errorMessage });
        }
        jsonSchema = schemaResult.value as object;
      }
      const tool = await ctx.db.$transaction(
        async (tx) => {
          await requireStrictlyOwnedTool(tx, args.toolId, ctx.principal.id);
          // An attachment's grants (secrets, hosts, datastore prefixes) hand
          // whatever code this row holds to that agent's owner's resources,
          // and the description reaches that owner's model context -- so any
          // cross-owner attachment (a public agent included) blocks every
          // field. Serializable, like attach_tool's own transaction, so a
          // concurrent cross-owner attach can't land between this check and
          // the write.
          const crossOwner = (await attachedAgents(tx, args.toolId)).filter(
            (agent) => agent.ownerId !== ctx.principal.id,
          );
          if (crossOwner.length > 0) {
            throw new McpError(
              409,
              `Tool "${args.toolId}" is attached to agents you don't own: ${describeAgents(crossOwner, ctx.principal.id)}. Detach it from those agents first (or ask their owners to), or create a new tool instead.`,
            );
          }
          return tx.tool.update({
            where: { id: args.toolId },
            data: {
              ...(args.description !== undefined ? { description: args.description } : {}),
              ...(args.code !== undefined ? { code: args.code } : {}),
              ...(args.paramsZod !== undefined ? { paramsZod: args.paramsZod, jsonSchema } : {}),
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return textResult(tool);
    },
  });

  mcp.registerTool({
    name: "delete_tool",
    scope: "tools:write",
    description:
      "Deletes a tool you own. Refused while it is attached to any agent; pass detach: true to detach it from your own agents first. It is never detached from another owner's or a public agent -- use detach_tool for a public agent, or ask the other owner. Past runs are unaffected, and a run already under way keeps the version it loaded.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { toolId: { type: "string" }, detach: { type: "boolean" } },
      required: ["toolId"],
    },
    handler: async (args: { toolId: string; detach?: boolean }, ctx) => {
      const stillAttached = (agents: AttachedAgent[], hint: string) =>
        new McpError(
          409,
          `Tool "${args.toolId}" is still attached to ${describeAgents(agents, ctx.principal.id)}.${hint}`,
        );
      try {
        const detachedFrom = await ctx.db.$transaction(
          async (tx) => {
            await requireStrictlyOwnedTool(tx, args.toolId, ctx.principal.id);
            const agents = await attachedAgents(tx, args.toolId);
            const own = agents.filter((agent) => agent.ownerId === ctx.principal.id);
            const others = agents.filter((agent) => agent.ownerId !== ctx.principal.id);
            // Checked before any detach, so a refusal leaves every
            // attachment in place. Public agents are included: pulling a
            // tool from a shared agent should be an explicit detach_tool.
            if (others.length > 0) {
              throw stillAttached(
                others,
                " Only your own agents can be detached here; detach it from public agents with detach_tool, or ask the other owners to.",
              );
            }
            if (own.length > 0 && args.detach !== true) {
              throw stillAttached(own, " Pass detach: true to detach it from these agents and delete it.");
            }
            if (own.length > 0) {
              await tx.agentTool.deleteMany({
                where: { toolId: args.toolId, agentId: { in: own.map((agent) => agent.id) } },
              });
            }
            await tx.tool.delete({ where: { id: args.toolId } });
            return own.map((agent) => agent.id);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        return textResult({ deleted: args.toolId, detachedFrom });
      } catch (err) {
        // AgentTool.toolId is ON DELETE RESTRICT: an attachment that raced in
        // past the check above still stops the delete, as P2003.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
          throw new McpError(409, `Tool "${args.toolId}" is still attached to an agent; nothing was deleted.`);
        }
        throw err;
      }
    },
  });

  mcp.registerTool({
    name: "dry_run_tool",
    scope: "tools:write",
    description:
      "Test-runs tool code against sample args without persisting it. Fetch is denied by default, same as a freshly attached tool — pass allowedHosts to test code that calls fetch().",
    inputSchema: {
      type: "object",
      properties: {
        paramsZod: { type: "string" },
        code: { type: "string" },
        sampleArgs: { type: "object" },
        allowedHosts: { type: "array", items: { type: "string" } },
      },
      required: ["paramsZod", "code", "sampleArgs"],
    },
    handler: async (args: { paramsZod: string; code: string; sampleArgs: unknown; allowedHosts?: string[] }, ctx) => {
      const hosts = ToolCapabilitiesPatchSchema.pick({ allowedHosts: true }).safeParse({
        allowedHosts: args.allowedHosts,
      });
      if (!hosts.success) {
        throw new McpError(400, `Invalid allowedHosts: ${hosts.error.issues.map((i) => i.message).join("; ")}`);
      }

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
      // isolated per-caller rather than colliding across authors. Fetch is
      // deny-by-default here too — same posture as a freshly attached tool
      // (OWASP LLM08) — rather than the unconditional wildcard this used to
      // pass; a caller testing fetch-dependent code must declare the hosts
      // it needs, same as at attach_tool time. sharedDatastore is likewise
      // unscoped here: there's no tool attachment to carry
      // allowedSharedDatastorePrefixes for a dry run, so it resolves exactly
      // like a real agent with no shared-datastore attachments at all
      // (empty reads, throwing writes) — never a capability-scoping bypass.
      const sandboxResult = await runInSandbox({
        code: args.code,
        params: validated.value,
        agentId: ctx.principal.id,
        datastore: ctx.providers.datastore,
        sharedDatastore: buildSharedDatastoreAccessor(ctx.principal.id, ctx.providers.datastore, ctx.db),
        toolName: "dry_run_tool",
        allowedFetchHosts: hosts.data.allowedHosts ?? [],
      });
      return textResult({ jsonSchema, result: sandboxResult });
    },
  });

  mcp.registerTool({
    name: "attach_tool",
    scope: "tools:write",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        toolId: { type: "string" },
        allowedSecrets: { type: "array", items: { type: "string" } },
        allowedDatastorePrefixes: { type: "array", items: { type: "string" } },
        allowedHosts: { type: "array", items: { type: "string" } },
        // { [boundName]: allowedKeyPrefixes[] } — per shared-datastore
        // attachment, the same default-deny grant as allowedDatastorePrefixes
        // is for the agent's private store. A boundName absent from this map
        // denies that shared store entirely.
        allowedSharedDatastorePrefixes: {
          type: "object",
          additionalProperties: { type: "array", items: { type: "string" } },
        },
      },
      required: ["agentId", "toolId"],
    },
    handler: async (
      args: {
        agentId: string;
        toolId: string;
        allowedSecrets?: string[];
        allowedDatastorePrefixes?: string[];
        allowedHosts?: string[];
        allowedSharedDatastorePrefixes?: Record<string, string[]>;
      },
      ctx,
    ) => {
      const patch = ToolCapabilitiesPatchSchema.safeParse({
        allowedSecrets: args.allowedSecrets,
        allowedDatastorePrefixes: args.allowedDatastorePrefixes,
        allowedHosts: args.allowedHosts,
        allowedSharedDatastorePrefixes: args.allowedSharedDatastorePrefixes,
      });
      if (!patch.success) {
        throw new McpError(400, `Invalid tool capabilities: ${patch.error.issues.map((i) => i.message).join("; ")}`);
      }
      await ctx.db.$transaction(
        async (tx) => {
          const agent = await tx.agent.findUnique({ where: { id: args.agentId } });
          if (!agent) throw new McpError(404, `Agent "${args.agentId}" not found.`);
          assertCanMutate(agent.ownerId, ctx.principal.id, `Agent "${args.agentId}" is not owned by the caller.`);
          if (agent.kind === "coding") {
            throw new McpError(400, "Native sandbox tools cannot be attached to coding agents.");
          }
          const tool = await requireOwnedTool(tx, args.toolId, ctx.principal.id);
          // The runtime dispatches by name, and names are only unique per
          // owner: a second same-named tool on one agent would be a
          // duplicate tool name to the model and silently shadow one of them.
          const clash = await findSameNamedAttachedTool(tx, args.agentId, tool);
          if (clash) {
            throw new McpError(
              409,
              `Agent "${args.agentId}" already has a different tool named "${tool.name}" attached (${clash.id}); detach it first.`,
            );
          }
          await tx.agentTool.upsert({
            where: { agentId_toolId: { agentId: args.agentId, toolId: args.toolId } },
            create: {
              agentId: args.agentId,
              toolId: args.toolId,
              allowedSecrets: patch.data.allowedSecrets ?? [],
              allowedDatastorePrefixes: patch.data.allowedDatastorePrefixes ?? [],
              allowedHosts: patch.data.allowedHosts ?? [],
              allowedSharedDatastorePrefixes: patch.data.allowedSharedDatastorePrefixes ?? {},
            },
            update: {
              ...(patch.data.allowedSecrets !== undefined ? { allowedSecrets: patch.data.allowedSecrets } : {}),
              ...(patch.data.allowedDatastorePrefixes !== undefined
                ? { allowedDatastorePrefixes: patch.data.allowedDatastorePrefixes }
                : {}),
              ...(patch.data.allowedHosts !== undefined ? { allowedHosts: patch.data.allowedHosts } : {}),
              ...(patch.data.allowedSharedDatastorePrefixes !== undefined
                ? { allowedSharedDatastorePrefixes: patch.data.allowedSharedDatastorePrefixes }
                : {}),
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return textResult({ attached: true });
    },
  });

  mcp.registerTool({
    name: "detach_tool",
    scope: "tools:write",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" }, toolId: { type: "string" } },
      required: ["agentId", "toolId"],
    },
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
      const project = (tool: Tool) =>
        tool.ownerId === ctx.principal.id
          ? tool
          : // `public` tells a public tool apart from the caller's own
            // same-named one: names are unique per owner, not globally.
            { id: tool.id, name: tool.name, description: tool.description, public: true };
      if (args.agentId) {
        await requireReadableAgent(ctx.db, args.agentId, ctx.principal.id);
        const rows = await ctx.db.agentTool.findMany({ where: { agentId: args.agentId }, include: { tool: true } });
        return textResult(
          rows
            .map((r) => r.tool)
            .filter((tool) => canRead(tool.ownerId, ctx.principal.id))
            .map(project),
        );
      }
      const tools = await ctx.db.tool.findMany({ where: visibleToPrincipal(ctx.principal.id) });
      return textResult(tools.filter((tool) => canRead(tool.ownerId, ctx.principal.id)).map(project));
    },
  });
}
