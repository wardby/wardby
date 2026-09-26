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
import {
  ToolAttachedError,
  deleteToolGuarded,
  hasToolChanges,
  prepareToolUpdate,
  updateToolGuarded,
  type AttachedAgent,
} from "../../core/tool-admin.js";
import type { WardbyMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import {
  requireOwnedTool,
  requireStrictlyOwnedTool,
  assertStrictlyOwnedTool,
  visibleToPrincipal,
  canRead,
} from "../auth/ownership.js";
import { agentAccessResolver, assertAgentAccess, requireAgentAccess } from "../auth/access.js";
import { atLeast } from "../../core/grants.js";
import type { McpRequestContext } from "../context.js";
import { textResult } from "./text-result.js";

/**
 * Names the agents the caller can read (its own and ones granted to it)
 * and only counts the rest, so a refusal never reveals another principal's
 * agent names or ids.
 */
async function describeAgents(agents: AttachedAgent[], ctx: McpRequestContext): Promise<string> {
  const accessOf = await agentAccessResolver(ctx);
  const readable = agents.filter((agent) => atLeast("agent", accessOf(agent), "read"));
  const hidden = agents.length - readable.length;
  const parts = readable.map((agent) => `"${agent.name}" (${agent.id})`);
  if (hidden > 0) parts.push(`${hidden} agent(s) owned by other principals`);
  return parts.join(", ");
}

/**
 * A tool row as a caller who doesn't own it may see it: name and
 * description, never code or paramsZod (A7). `public` tells an owner-less
 * tool apart from the caller's own same-named one (names are unique per
 * owner, not globally). Shared by list_tools and get_agent.
 */
export function projectTool(tool: Tool, principalId: string) {
  if (tool.ownerId !== null && tool.ownerId === principalId) return tool;
  return tool.ownerId === null
    ? { id: tool.id, name: tool.name, description: tool.description, public: true }
    : { id: tool.id, name: tool.name, description: tool.description, public: false, ownerIsCaller: false };
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
      const changes = { description: args.description, paramsZod: args.paramsZod, code: args.code };
      if (!hasToolChanges(changes)) {
        throw new McpError(400, "update_tool needs at least one of description, paramsZod or code.");
      }
      // Checked once up front so a non-owner never gets as far as a sandbox
      // compile, and again (with the attachments) inside the transaction.
      await requireStrictlyOwnedTool(ctx.db, args.toolId, ctx.principal.id);
      const prepared = await prepareToolUpdate(changes);
      if (!prepared.ok) {
        return textResult({ ok: false, errorKind: prepared.errorKind, errorMessage: prepared.errorMessage });
      }
      // Any attachment to an agent the caller doesn't own (a public agent
      // included) blocks every field; see core/tool-admin.ts for why, and
      // for the Serializable transaction that keeps a concurrent attach from
      // landing between the check and the write.
      try {
        const tool = await updateToolGuarded(ctx.db, args.toolId, prepared.data, (row) =>
          assertStrictlyOwnedTool(row, args.toolId, ctx.principal.id),
        );
        return textResult(tool);
      } catch (err) {
        if (err instanceof ToolAttachedError) {
          throw new McpError(
            409,
            `Tool "${args.toolId}" is attached to agents you don't own: ${await describeAgents(err.agents, ctx)}. Detach it from those agents first (or ask their owners to), or create a new tool instead.`,
          );
        }
        throw err;
      }
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
      try {
        const detachedFrom = await deleteToolGuarded(ctx.db, args.toolId, {
          detach: args.detach === true,
          authorize: (row) => assertStrictlyOwnedTool(row, args.toolId, ctx.principal.id),
        });
        return textResult({ deleted: args.toolId, detachedFrom });
      } catch (err) {
        if (!(err instanceof ToolAttachedError)) throw err;
        const agents = await describeAgents(err.agents, ctx);
        switch (err.reason) {
          // Public agents are included: pulling a tool from a shared agent
          // should be an explicit detach_tool.
          case "other_owners":
            throw new McpError(
              409,
              `Tool "${args.toolId}" is still attached to ${agents}. Only your own agents can be detached here; detach it from public agents with detach_tool, or ask the other owners to.`,
            );
          case "needs_detach":
            throw new McpError(
              409,
              `Tool "${args.toolId}" is still attached to ${agents}. Pass detach: true to detach it from these agents and delete it.`,
            );
          case "race":
            throw new McpError(409, `Tool "${args.toolId}" is still attached to an agent; nothing was deleted.`);
        }
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
    description:
      "Attaches a tool to an agent (needs write on the agent). The four capability fields (allowedSecrets, allowedDatastorePrefixes, allowedHosts, allowedSharedDatastorePrefixes) are the agent owner's to grant: anyone else passing one gets 403, and their attachment runs with none until the owner re-runs attach_tool with the capabilities. When the owner grants an attachment it had not granted before (someone else attached it, or the agent changed owner), every capability not passed is reset to empty, so state each one you want.",
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
      const capabilitiesPassed = Object.values(patch.data).some((value) => value !== undefined);
      await ctx.db.$transaction(
        async (tx) => {
          const { agent } = await assertAgentAccess(
            ctx,
            await tx.agent.findUnique({ where: { id: args.agentId } }),
            args.agentId,
            "write",
            tx,
          );
          if (agent.kind === "coding") {
            throw new McpError(400, "Native sandbox tools cannot be attached to coding agents.");
          }
          // Capabilities carry the owner's consent (resource-sharing grants
          // spec §3.4.2). Strict ownership: neither a write-grantee nor the
          // stdio operator may hand the owner's secrets, datastores or
          // network to code on the agent.
          const isOwner = agent.ownerId !== null && agent.ownerId === ctx.principal.id;
          if (capabilitiesPassed && !isOwner) {
            throw new McpError(
              403,
              "Only the agent's owner can grant capabilities to an attachment; ask them to re-run attach_tool with the capabilities.",
            );
          }
          const existing = await tx.agentTool.findUnique({
            where: { agentId_toolId: { agentId: args.agentId, toolId: args.toolId } },
          });
          // Creating an attachment needs a tool the caller may attach (Phase
          // 1: its own or an owner-less one). Re-attaching an existing one
          // only changes its capabilities: that is how the agent's owner
          // grants them to a write-grantee's tool, or re-grants them after a
          // make_owner transfer, so the tool check does not apply.
          const tool = existing
            ? await tx.tool.findUniqueOrThrow({ where: { id: args.toolId } })
            : await requireOwnedTool(tx, args.toolId, ctx.principal.id);
          // The runtime dispatches by name, and names are only unique per
          // owner: a second same-named tool on one agent would be a
          // duplicate tool name to the model and silently shadow one of them.
          const clash = await findSameNamedAttachedTool(tx, args.agentId, tool);
          if (clash) {
            // The clashing tool may be another principal's private one (a
            // write-grantee's, or one left from before a transfer): name its
            // id only when the caller could read it anyway.
            const which = canRead(clash.ownerId, ctx.principal.id)
              ? ` (${clash.id})`
              : " (a tool owned by another principal)";
            throw new McpError(
              409,
              `Agent "${args.agentId}" already has a different tool named "${tool.name}" attached${which}; detach it first.`,
            );
          }
          // Re-granting an attachment this owner never vouched for: what is
          // not restated is reset, never silently adopted.
          const keepUnstated = existing?.capabilitiesGrantedById === agent.ownerId;
          const field = <K extends keyof typeof patch.data>(key: K, empty: NonNullable<(typeof patch.data)[K]>) =>
            patch.data[key] !== undefined ? { [key]: patch.data[key] } : keepUnstated ? {} : { [key]: empty };
          const ownerGrant = isOwner
            ? {
                ...field("allowedSecrets", []),
                ...field("allowedDatastorePrefixes", []),
                ...field("allowedHosts", []),
                ...field("allowedSharedDatastorePrefixes", {}),
                capabilitiesGrantedById: agent.ownerId,
              }
            : {};
          await tx.agentTool.upsert({
            where: { agentId_toolId: { agentId: args.agentId, toolId: args.toolId } },
            create: {
              agentId: args.agentId,
              toolId: args.toolId,
              allowedSecrets: (isOwner && patch.data.allowedSecrets) || [],
              allowedDatastorePrefixes: (isOwner && patch.data.allowedDatastorePrefixes) || [],
              allowedHosts: (isOwner && patch.data.allowedHosts) || [],
              allowedSharedDatastorePrefixes: (isOwner && patch.data.allowedSharedDatastorePrefixes) || {},
              attachedById: ctx.principal.id,
              capabilitiesGrantedById: isOwner ? agent.ownerId : null,
            },
            // A non-owner's re-attach leaves an existing attachment's
            // capabilities and consent stamp untouched.
            update: ownerGrant,
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
      // Write on the agent is enough, whoever owns the tool: an agent's
      // owner (or write-grantee) can always pull a tool off it.
      await requireAgentAccess(ctx, args.agentId, "write");
      await ctx.db.agentTool.deleteMany({ where: { agentId: args.agentId, toolId: args.toolId } });
      return textResult({ detached: true });
    },
  });

  mcp.registerTool({
    name: "list_tools",
    scope: "tools:write",
    inputSchema: { type: "object", properties: { agentId: { type: "string" } } },
    handler: async (args: { agentId?: string }, ctx) => {
      const project = (tool: Tool) => projectTool(tool, ctx.principal.id);
      if (args.agentId) {
        const { access } = await requireAgentAccess(ctx, args.agentId, "read");
        const rows = await ctx.db.agentTool.findMany({ where: { agentId: args.agentId }, include: { tool: true } });
        // The agent's owner sees every tool on it (projected: code only for
        // the tool's own owner); anyone else only tools they could see anyway.
        return textResult(
          rows
            .map((r) => r.tool)
            .filter((tool) => access === "owner" || canRead(tool.ownerId, ctx.principal.id))
            .map(project),
        );
      }
      const tools = await ctx.db.tool.findMany({ where: visibleToPrincipal(ctx.principal.id) });
      return textResult(tools.filter((tool) => canRead(tool.ownerId, ctx.principal.id)).map(project));
    },
  });
}
