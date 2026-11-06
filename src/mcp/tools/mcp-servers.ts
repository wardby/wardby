/**
 * Remote MCP servers over Wardby's own MCP (docs/mcp-servers.md): register a server (HTTPS URL plus the
 * owner's brokered secrets), keep its saved tool list fresh, and attach an allowlisted subset of its tools
 * to an agent. Gated by WARDBY_MCP_SERVERS (off | admins | owners). Results carry secret names, never
 * values: snapshots and errors arrive from fetchSnapshot already redacted. Audit lines carry the URL's host
 * only, never the full URL (a query string can carry a token).
 */
import { z } from "zod";
import { Prisma, type PrismaClient } from "#prisma";
import { loadMcpServersMode, MCP_SERVERS_OFF_MESSAGE } from "../../config/mcp-servers.js";
import { loadToolMaxTimeoutMs } from "../../config/tool-timeout.js";
import { atLeast, deleteGrantsFor, effectiveAccess, grantedIds } from "../../core/grants.js";
import { logger } from "../../core/logger.js";
import { McpClientError, type McpServerInfo, type McpToolEntry } from "../../core/mcp-client/client.js";
import {
  assertServerName,
  diffSnapshots,
  exposedNames,
  exposedToolName,
  fetchSnapshot,
  McpServerInputError,
  normaliseServerUrl,
  snapshotOf,
  type McpServerRow,
} from "../../core/mcp-servers.js";
import { isMarkedReadOnly } from "../../core/mcp-tools.js";
import { REVIEW_HOST_TOOL_NAMES } from "../../core/review-host-tools.js";
import { preferIndexScans, withSerializableRetry } from "../../core/serializable-retry.js";
import { reservedToolNameReason } from "../../core/tool-names.js";
import { agentAccessResolver, assertAgentAccess, requireAgentAccess, requireBindable } from "../auth/access.js";
import { requireScope } from "../auth/resource-server.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

const serversLog = logger.child({ module: "mcp-servers" });

export { MCP_SERVERS_OFF_MESSAGE };
const DESCRIPTION_PREVIEW_CHARS = 300;
const MIN_CALL_TIMEOUT_MS = 1000;

type ServerRecord = McpServerRow & { toolSnapshot: unknown; serverInfo: unknown; snapshotAt: Date | null };

/**
 * Refuses when the mode is off, except for cleanup (delete and detach stay possible so an operator who
 * turns the feature off can still remove servers and attachments); in admins mode, register/update/refresh
 * also need hosts:admin.
 */
function gate(ctx: McpRequestContext, kind: "configure" | "other" | "cleanup"): void {
  const mode = loadMcpServersMode();
  if (mode === "off" && kind !== "cleanup") throw new McpError(403, MCP_SERVERS_OFF_MESSAGE);
  if (kind === "configure" && mode === "admins") requireScope(ctx, ctx.canonicalUri, "hosts:admin");
}

function audit(ctx: McpRequestContext, action: string, server: { id: string; name: string; url: string }): void {
  serversLog.info(
    {
      event: `mcp.server.${action}`,
      serverId: server.id,
      name: server.name,
      host: new URL(server.url).hostname,
      by: ctx.principal.id,
    },
    "MCP server changed",
  );
}

function parse<Output>(schema: z.ZodType<Output, unknown>, label: string, value: unknown): Output {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const details = result.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  throw new McpError(400, `Invalid ${label}: ${details}`);
}

/** Input errors → 400; MCP client errors (already redacted) → 502 with their code. */
async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof McpServerInputError) throw new McpError(400, err.message);
    if (err instanceof McpClientError) throw new McpError(502, `${err.code}: ${err.message}`);
    throw err;
  }
}

function serverNotFound(id: string): McpError {
  return new McpError(404, `MCP server "${id}" not found.`);
}

/** The caller's own server, or 404 (whether it is missing or someone else's). */
async function requireOwnedServer(
  ctx: McpRequestContext,
  id: string,
  db: Pick<PrismaClient, "mcpServer"> = ctx.db,
): Promise<ServerRecord> {
  const server = await db.mcpServer.findUnique({ where: { id } });
  if (!server || server.ownerId !== ctx.principal.id) throw serverNotFound(id);
  return server;
}

/**
 * A server the caller owns or holds at least `min` on through a grant. Missing and no-access look the same
 * (404); a grant that is too low says what it lacks (403).
 */
async function requireServerAccess(
  ctx: McpRequestContext,
  id: string,
  min: "read" | "use",
  db: Pick<PrismaClient, "mcpServer" | "resourceGrant"> = ctx.db,
): Promise<ServerRecord> {
  const server = await db.mcpServer.findUnique({ where: { id } });
  if (!server) throw serverNotFound(id);
  const access = await effectiveAccess(db, "mcp_server", server, ctx.principal.id);
  if (access === "none") throw serverNotFound(id);
  if (!atLeast("mcp_server", access, min)) {
    throw new McpError(403, `MCP server "${server.name}": attaching it needs use access (you have ${access}).`);
  }
  return server;
}

function takeSnapshot(ctx: McpRequestContext, server: McpServerRow) {
  return mapped(() =>
    fetchSnapshot(server, { db: ctx.db, cipher: ctx.providers.secrets, fetchImpl: ctx.providers.sandboxFetch }),
  );
}

function snapshotData(snapshot: { serverInfo: McpServerInfo; tools: McpToolEntry[] }) {
  return {
    toolSnapshot: snapshot.tools as unknown as Prisma.InputJsonValue,
    serverInfo: snapshot.serverInfo as unknown as Prisma.InputJsonValue,
    snapshotAt: new Date(),
  };
}

function serverView(server: ServerRecord) {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    secretNames: server.secretNames,
    serverInfo: server.serverInfo,
    snapshotAt: server.snapshotAt,
    tools: snapshotOf(server).map((t) => ({
      name: t.name,
      description: t.description.slice(0, DESCRIPTION_PREVIEW_CHARS),
      annotations: t.annotations,
    })),
  };
}

/** get_agent's mcpServers field: each attachment with its exposed names and allowed tools gone from the snapshot. */
export async function agentMcpServerViews(db: Pick<PrismaClient, "agentMcpServer">, agentId: string) {
  const rows = await db.agentMcpServer.findMany({
    where: { agentId },
    include: { server: { select: { id: true, name: true, toolSnapshot: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => {
    const present = new Set(snapshotOf(row.server).map((t) => t.name));
    return {
      serverId: row.server.id,
      serverName: row.server.name,
      allowedTools: row.allowedTools,
      exposedNames: exposedNames(row.server.name, row.allowedTools),
      callTimeoutMs: row.callTimeoutMs,
      missingTools: row.allowedTools.filter((name) => !present.has(name)),
    };
  });
}

const SecretNames = z.array(z.string().min(1).max(1024)).max(8);
const RegisterSchema = z
  .object({ name: z.string().max(64), url: z.string().max(2048), secretNames: SecretNames.default([]) })
  .strict();
const UpdateSchema = z
  .object({ id: z.string().min(1).max(64), url: z.string().max(2048).optional(), secretNames: SecretNames.optional() })
  .strict();
const IdSchema = z.object({ id: z.string().min(1).max(64) }).strict();
const AttachSchema = z
  .object({
    agentId: z.string().min(1).max(64),
    serverId: z.string().min(1).max(64),
    allowedTools: z.array(z.string().min(1).max(200)).min(1).max(500),
    callTimeoutMs: z.number().int().optional(),
  })
  .strict();
const DetachSchema = z.object({ agentId: z.string().min(1).max(64), serverId: z.string().min(1).max(64) }).strict();

const ID_ONLY = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string" } },
};

export function registerMcpServerTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "register_mcp_server",
    scope: "tools:write",
    description:
      "Register a remote MCP server (Streamable HTTP, https only) so its tools can be attached to your agents. secretNames are your brokered secrets, each brokered to the URL's host; they are sent on every request and never readable. Wardby calls the server's tools/list and saves the result. With WARDBY_MCP_SERVERS=admins this needs hosts:admin.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "url"],
      properties: {
        name: {
          type: "string",
          description: "Lower-case letters, digits, _ or -; prefixes the tool names agents see.",
        },
        url: { type: "string", description: "The server's https endpoint, e.g. https://mcp.example.com/mcp." },
        secretNames: { type: "array", items: { type: "string" } },
      },
    },
    handler: async (rawArgs: unknown, ctx) => {
      gate(ctx, "configure");
      const input = parse(RegisterSchema, "register_mcp_server arguments", rawArgs);
      const url = await mapped(async () => {
        assertServerName(input.name);
        return normaliseServerUrl(input.url);
      });
      const ownerId = ctx.principal.id;
      const taken = () => new McpError(409, `You already have an MCP server named "${input.name}".`);
      if (await ctx.db.mcpServer.findUnique({ where: { ownerId_name: { ownerId, name: input.name } } })) throw taken();
      const draft = { id: "", ownerId, name: input.name, url, secretNames: input.secretNames };
      const snapshot = await takeSnapshot(ctx, draft);
      let server: ServerRecord;
      try {
        server = await ctx.db.mcpServer.create({
          data: { ownerId, name: input.name, url, secretNames: input.secretNames, ...snapshotData(snapshot) },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw taken();
        throw err;
      }
      audit(ctx, "register", server);
      return textResult(serverView(server));
    },
  });

  mcp.registerTool({
    name: "update_mcp_server",
    scope: "tools:write",
    description:
      "Owner only: change a server's URL or secretNames. Wardby re-checks the secrets, saves a fresh tool list straight away and returns what changed (diff). With WARDBY_MCP_SERVERS=admins this needs hosts:admin.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
        url: { type: "string" },
        secretNames: { type: "array", items: { type: "string" } },
      },
    },
    handler: async (rawArgs: unknown, ctx) => {
      gate(ctx, "configure");
      const input = parse(UpdateSchema, "update_mcp_server arguments", rawArgs);
      const current = await requireOwnedServer(ctx, input.id);
      const url = input.url === undefined ? current.url : await mapped(async () => normaliseServerUrl(input.url!));
      const secretNames = input.secretNames ?? current.secretNames;
      const snapshot = await takeSnapshot(ctx, { ...current, url, secretNames });
      const server = await ctx.db.mcpServer.update({
        where: { id: current.id },
        data: { url, secretNames, ...snapshotData(snapshot) },
      });
      audit(ctx, "update", server);
      return textResult({ ...serverView(server), diff: diffSnapshots(snapshotOf(current), snapshot.tools) });
    },
  });

  mcp.registerTool({
    name: "refresh_mcp_server",
    scope: "tools:write",
    description:
      "Owner only: fetch the server's tools/list again and save it. Changes apply straight away: an allowed tool the server no longer lists is left out of runs and shown under missingTools by get_agent. Returns the diff (added, removed, changed) and the agents left with missing tools. With WARDBY_MCP_SERVERS=admins this needs hosts:admin.",
    inputSchema: ID_ONLY,
    handler: async (rawArgs: unknown, ctx) => {
      gate(ctx, "configure");
      const { id } = parse(IdSchema, "refresh_mcp_server arguments", rawArgs);
      const current = await requireOwnedServer(ctx, id);
      const snapshot = await takeSnapshot(ctx, current);
      const server = await ctx.db.mcpServer.update({ where: { id }, data: snapshotData(snapshot) });
      audit(ctx, "refresh", server);
      const present = new Set(snapshot.tools.map((t) => t.name));
      const attachments = await ctx.db.agentMcpServer.findMany({
        where: { serverId: id },
        include: { agent: { select: { id: true, ownerId: true } } },
        orderBy: { createdAt: "asc" },
      });
      // Name only agents the caller can read; count the rest, so a refresh never reveals others' agent ids.
      const accessOf = await agentAccessResolver(ctx);
      const affected = attachments
        .map((a) => ({ agent: a.agent, missingTools: a.allowedTools.filter((t) => !present.has(t)) }))
        .filter((a) => a.missingTools.length > 0);
      const readable = affected.filter((a) => accessOf(a.agent) !== "none");
      const hidden = affected.length - readable.length;
      return textResult({
        diff: diffSnapshots(snapshotOf(current), snapshot.tools),
        affectedAgents: readable.map((a) => ({ agentId: a.agent.id, missingTools: a.missingTools })),
        ...(hidden > 0 ? { otherAffectedAgents: hidden } : {}),
      });
    },
  });

  mcp.registerTool({
    name: "list_mcp_servers",
    scope: "agents:read",
    description:
      "Your registered MCP servers and the ones shared with you: id, name, host, tool count, when the tool list was saved and yours (false for shared ones, which show no secret names).",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    handler: async (_rawArgs: unknown, ctx) => {
      gate(ctx, "other");
      const sharedIds = await grantedIds(ctx.db, "mcp_server", ctx.principal.id, "read");
      const rows = await ctx.db.mcpServer.findMany({
        where: { OR: [{ ownerId: ctx.principal.id }, { id: { in: sharedIds } }] },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      return textResult({
        servers: rows.map((s) => ({
          id: s.id,
          name: s.name,
          host: new URL(s.url).hostname,
          ownerId: s.ownerId,
          toolCount: snapshotOf(s).length,
          snapshotAt: s.snapshotAt,
          yours: s.ownerId === ctx.principal.id,
          // Secret names stay with the owner.
          ...(s.ownerId === ctx.principal.id ? { secretNames: s.secretNames } : {}),
        })),
      });
    },
  });

  mcp.registerTool({
    name: "get_mcp_server",
    scope: "agents:read",
    description:
      "One of your MCP servers, or one shared with you (read or higher), with its full saved tool list (name, description, inputSchema, annotations). Secret names show for the owner only.",
    inputSchema: ID_ONLY,
    handler: async (rawArgs: unknown, ctx) => {
      gate(ctx, "other");
      const { id } = parse(IdSchema, "get_mcp_server arguments", rawArgs);
      const server = await requireServerAccess(ctx, id, "read");
      const view = serverView(server);
      const yours = server.ownerId === ctx.principal.id;
      // Secret names and the full URL (a query string can carry a token) stay with the owner.
      const { secretNames: _secretNames, url: _url, ...shared } = view;
      void _secretNames;
      void _url;
      return textResult({
        ...(yours ? view : { ...shared, host: new URL(server.url).hostname }),
        yours,
        ownerId: server.ownerId,
        tools: snapshotOf(server),
      });
    },
  });

  mcp.registerTool({
    name: "delete_mcp_server",
    scope: "tools:write",
    description:
      "Owner only: delete an MCP server. It is detached from every agent, including agents others attached it to through a grant. Allowed even when WARDBY_MCP_SERVERS=off, so cleanup stays possible.",
    inputSchema: ID_ONLY,
    handler: async (rawArgs: unknown, ctx) => {
      gate(ctx, "cleanup");
      const { id } = parse(IdSchema, "delete_mcp_server arguments", rawArgs);
      const server = await requireOwnedServer(ctx, id);
      await ctx.db.$transaction(async (tx) => {
        await tx.mcpServer.delete({ where: { id } });
        // Grants have no foreign key to the server.
        await deleteGrantsFor(tx, "mcp_server", id);
      });
      audit(ctx, "delete", server);
      return textResult({ deleted: id });
    },
  });

  mcp.registerTool({
    name: "attach_mcp_server",
    scope: "tools:write",
    description:
      "Agent owner only: let an agent (native or coding) call the named tools of one of your MCP servers, or of one shared with you at use or higher (its tools then run with the owner's credentials). allowedTools are exact names from the saved tool list (no wildcards); the agent sees each as <server name>__<tool name>. callTimeoutMs (per call, default 30000) is capped by WARDBY_TOOL_MAX_TIMEOUT_MS. Re-attaching replaces the allowlist and time limit. Coding agents get the tools as mcp__wardby_mcp__<name>; Codex agents can use only tools the server marks read-only (readOnlyHint) in the saved tool list.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["agentId", "serverId", "allowedTools"],
      properties: {
        agentId: { type: "string" },
        serverId: { type: "string" },
        allowedTools: { type: "array", items: { type: "string" } },
        callTimeoutMs: { type: "integer" },
      },
    },
    handler: async (rawArgs: unknown, ctx) => {
      gate(ctx, "other");
      const input = parse(AttachSchema, "attach_mcp_server arguments", rawArgs);
      const ceiling = loadToolMaxTimeoutMs();
      if (
        input.callTimeoutMs !== undefined &&
        (input.callTimeoutMs < MIN_CALL_TIMEOUT_MS || input.callTimeoutMs > ceiling)
      ) {
        throw new McpError(
          400,
          `callTimeoutMs must be at least ${MIN_CALL_TIMEOUT_MS} and at most ${ceiling} (WARDBY_TOOL_MAX_TIMEOUT_MS).`,
        );
      }
      const duplicates = input.allowedTools.filter((t, i) => input.allowedTools.indexOf(t) !== i);
      if (duplicates.length > 0) throw new McpError(400, `allowedTools lists "${duplicates[0]}" more than once.`);
      // Bounded retry: a concurrent grant change or make_owner on the same rows aborts one side.
      await withSerializableRetry(() =>
        ctx.db.$transaction(
          async (tx) => {
            await preferIndexScans(tx);
            const { agent } = await assertAgentAccess(
              ctx,
              await tx.agent.findUnique({ where: { id: input.agentId } }),
              input.agentId,
              "read",
              tx,
            );
            // An attachment grants capabilities (the server's secrets act for the agent): strict owner only.
            await requireBindable(ctx, agent, tx);
            const server = await requireServerAccess(ctx, input.serverId, "use", tx);
            const known = new Set(snapshotOf(server).map((t) => t.name));
            const unknown = input.allowedTools.filter((t) => !known.has(t));
            if (unknown.length > 0) {
              throw new McpError(
                400,
                `Not in MCP server "${server.name}"'s saved tool list: ${unknown.join(", ")}. Run refresh_mcp_server if the server added them.`,
              );
            }
            if (agent.kind === "coding") {
              const profile = await tx.codingAgentProfile.findUnique({
                where: { agentId: agent.id },
                select: { provider: true },
              });
              if (profile?.provider === "codex") {
                const byName = new Map(snapshotOf(server).map((t) => [t.name, t]));
                const writer = input.allowedTools.find((t) => !isMarkedReadOnly(byName.get(t)));
                if (writer !== undefined) {
                  throw new McpError(
                    400,
                    `Codex agents can use only tools the server marks read-only (${writer} isn't).`,
                  );
                }
              }
            }
            const exposed = await mapped(async () => input.allowedTools.map((t) => exposedToolName(server.name, t)));
            await assertNoClash(tx, agent.id, server.id, exposed);
            const fields = { allowedTools: input.allowedTools, callTimeoutMs: input.callTimeoutMs ?? null };
            await tx.agentMcpServer.upsert({
              where: { agentId_serverId: { agentId: agent.id, serverId: server.id } },
              create: { agentId: agent.id, serverId: server.id, attachedById: ctx.principal.id, ...fields },
              update: { attachedById: ctx.principal.id, ...fields },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
      return textResult({ attached: true });
    },
  });

  mcp.registerTool({
    name: "detach_mcp_server",
    scope: "tools:write",
    description:
      "Agent owner only: remove an MCP server's tools from an agent. Allowed even when WARDBY_MCP_SERVERS=off, so cleanup stays possible.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["agentId", "serverId"],
      properties: { agentId: { type: "string" }, serverId: { type: "string" } },
    },
    handler: async (rawArgs: unknown, ctx) => {
      gate(ctx, "cleanup");
      const input = parse(DetachSchema, "detach_mcp_server arguments", rawArgs);
      await requireAgentAccess(ctx, input.agentId, "owner");
      const { count } = await ctx.db.agentMcpServer.deleteMany({
        where: { agentId: input.agentId, serverId: input.serverId },
      });
      return textResult({ detached: count > 0 });
    },
  });
}

/**
 * 409 naming the first exposed name that clashes with a built-in, an attached tool or another MCP attachment.
 * Exported for tests: no valid server and tool name maps to a built-in repository tool name.
 */
export async function assertNoClash(
  tx: Prisma.TransactionClient,
  agentId: string,
  serverId: string,
  exposed: string[],
): Promise<void> {
  const clash = (name: string, why: string) =>
    new McpError(409, `The tool name "${name}" clashes with ${why} on agent "${agentId}".`);
  const seen = new Set<string>();
  for (const name of exposed) {
    if (seen.has(name)) throw clash(name, "another of the allowed tools (both map to this name)");
    seen.add(name);
    const reserved = reservedToolNameReason(name);
    if (reserved) throw new McpError(409, `The tool name "${name}" clashes with a built-in: ${reserved}`);
    if (REVIEW_HOST_TOOL_NAMES.has(name)) throw clash(name, "a built-in repository tool");
  }
  const attached = await tx.agentTool.findMany({ where: { agentId }, select: { tool: { select: { name: true } } } });
  for (const { tool } of attached) if (seen.has(tool.name)) throw clash(tool.name, "an attached tool");
  const others = await tx.agentMcpServer.findMany({
    where: { agentId, serverId: { not: serverId } },
    include: { server: { select: { name: true } } },
  });
  for (const other of others) {
    for (const name of exposedNames(other.server.name, other.allowedTools)) {
      if (seen.has(name)) throw clash(name, `a tool of MCP server "${other.server.name}"`);
    }
  }
}
