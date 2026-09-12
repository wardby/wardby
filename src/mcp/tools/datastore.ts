import { Prisma, type PrismaClient } from "@prisma/client";
import type { ReevoMcpServer } from "../server.js";
import type { DatastoreValue } from "../../providers/index.js";
import {
  requireOwnedAgent,
  requireReadableAgent,
  requireOwnedDatastore,
  canRead,
  assertCanMutate,
} from "../auth/ownership.js";
import {
  createDatastore,
  listDatastores,
  deleteDatastore,
  attachDatastore,
  detachDatastore,
  buildSharedDatastoreAccessor,
} from "../../core/datastores.js";
import { McpError } from "../errors.js";
import { textResult } from "./text-result.js";

/**
 * A `boundName` names an *attachment* (agentId, boundName) -> Datastore.
 * requireOwnedAgent/requireReadableAgent only check the agent's own
 * ownership — for a public (null-owner) agent that's readable/mutable by
 * anyone, so gating solely on the agent would let a principal who attaches
 * their own private Datastore to a public agent inadvertently expose that
 * Datastore's full read/write access to every other principal, with no
 * sandbox mediation. So every boundName branch additionally checks the
 * underlying Datastore's own ownership. When no attachment exists under
 * that boundName, this resolves to `undefined` and callers fall through to
 * today's unchanged behavior (miss for reads, throw for writes) — this
 * check only ever narrows access when an attachment IS found, it never
 * grants access an attachment didn't already imply.
 */
async function findAttachedDatastore(
  db: Pick<PrismaClient, "agentDatastore">,
  agentId: string,
  boundName: string,
): Promise<{ ownerId: string | null } | undefined> {
  const attachment = await db.agentDatastore.findFirst({ where: { agentId, boundName }, include: { datastore: true } });
  return attachment?.datastore;
}

async function requireReadableSharedDatastore(
  db: Pick<PrismaClient, "agentDatastore">,
  agentId: string,
  boundName: string,
  principalId: string,
): Promise<void> {
  const datastore = await findAttachedDatastore(db, agentId, boundName);
  if (!datastore) return;
  if (!canRead(datastore.ownerId, principalId)) {
    throw new McpError(404, `Datastore bound as "${boundName}" not found.`);
  }
}

async function requireMutableSharedDatastore(
  db: Pick<PrismaClient, "agentDatastore">,
  agentId: string,
  boundName: string,
  principalId: string,
): Promise<void> {
  const datastore = await findAttachedDatastore(db, agentId, boundName);
  if (!datastore) return;
  assertCanMutate(datastore.ownerId, principalId, `Datastore bound as "${boundName}" is not owned by the caller.`);
}

export function registerDatastoreTools(mcp: ReevoMcpServer): void {
  mcp.registerTool({
    name: "create_datastore",
    scope: "datastore:write",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    handler: async (args: { name: string }, ctx) => {
      try {
        const datastore = await createDatastore(args.name, ctx.principal.id, ctx.db);
        return textResult({ id: datastore.id, name: datastore.name, createdAt: datastore.createdAt });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new McpError(409, `A datastore named "${args.name}" already exists.`);
        }
        throw err;
      }
    },
  });

  mcp.registerTool({
    name: "list_datastores",
    scope: "datastore:write",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args: Record<string, never>, ctx) => {
      const datastores = await listDatastores(ctx.principal.id, ctx.db);
      return textResult(datastores);
    },
  });

  mcp.registerTool({
    name: "delete_datastore",
    scope: "datastore:write",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (args: { id: string }, ctx) => {
      await requireOwnedDatastore(ctx.db, args.id, ctx.principal.id);
      try {
        await deleteDatastore(args.id, ctx.db);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2003" || err.code === "P2014")) {
          throw new McpError(409, "Datastore still has attached agents or entries — detach/clear it first.");
        }
        throw err;
      }
      return textResult({ deleted: args.id });
    },
  });

  mcp.registerTool({
    name: "attach_datastore",
    scope: "datastore:write",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        datastoreId: { type: "string" },
        boundName: { type: "string", minLength: 1 },
      },
      required: ["agentId", "datastoreId"],
    },
    handler: async (args: { agentId: string; datastoreId: string; boundName?: string }, ctx) => {
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      const datastore = await requireOwnedDatastore(ctx.db, args.datastoreId, ctx.principal.id);
      const boundName = args.boundName ?? datastore.name;
      try {
        await attachDatastore(args.agentId, args.datastoreId, ctx.db, boundName);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new McpError(409, `Agent already binds a datastore under name "${boundName}".`);
        }
        throw err;
      }
      return textResult({ attached: true });
    },
  });

  mcp.registerTool({
    name: "detach_datastore",
    scope: "datastore:write",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" }, boundName: { type: "string" } },
      required: ["agentId", "boundName"],
    },
    handler: async (args: { agentId: string; boundName: string }, ctx) => {
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      await requireMutableSharedDatastore(ctx.db, args.agentId, args.boundName, ctx.principal.id);
      await detachDatastore(args.agentId, args.boundName, ctx.db);
      return textResult({ detached: true });
    },
  });

  mcp.registerTool({
    name: "datastore_get",
    scope: "agents:read",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" }, key: { type: "string" }, boundName: { type: "string" } },
      required: ["agentId", "key"],
    },
    handler: async (args: { agentId: string; key: string; boundName?: string }, ctx) => {
      await requireReadableAgent(ctx.db, args.agentId, ctx.principal.id);
      if (args.boundName) {
        await requireReadableSharedDatastore(ctx.db, args.agentId, args.boundName, ctx.principal.id);
        const accessor = buildSharedDatastoreAccessor(args.agentId, ctx.providers.datastore, ctx.db);
        const value = await accessor.get(args.boundName, args.key);
        return textResult({ value: value ?? null });
      }
      const value = await ctx.providers.datastore.get(args.agentId, args.key);
      return textResult({ value: value ?? null });
    },
  });

  mcp.registerTool({
    name: "datastore_list",
    scope: "agents:read",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" }, prefix: { type: "string" }, boundName: { type: "string" } },
      required: ["agentId"],
    },
    handler: async (args: { agentId: string; prefix?: string; boundName?: string }, ctx) => {
      await requireReadableAgent(ctx.db, args.agentId, ctx.principal.id);
      if (args.boundName) {
        await requireReadableSharedDatastore(ctx.db, args.agentId, args.boundName, ctx.principal.id);
        const accessor = buildSharedDatastoreAccessor(args.agentId, ctx.providers.datastore, ctx.db);
        const keys = await accessor.list(args.boundName, args.prefix);
        return textResult(keys);
      }
      const keys = await ctx.providers.datastore.list(args.agentId, args.prefix);
      return textResult(keys);
    },
  });

  mcp.registerTool({
    name: "datastore_set",
    scope: "datastore:write",
    description:
      'Sets a datastore value. Pass "boundName" to write to a shared datastore attached under that name instead of the agent\'s private one. Pass "pii": true to encrypt the value at rest (AES-256-GCM) — opt in only for values that actually carry PII, never inferred automatically.',
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        key: { type: "string" },
        value: {},
        pii: { type: "boolean" },
        boundName: { type: "string" },
      },
      required: ["agentId", "key", "value"],
    },
    handler: async (
      args: { agentId: string; key: string; value: DatastoreValue; pii?: boolean; boundName?: string },
      ctx,
    ) => {
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      if (args.boundName) {
        await requireMutableSharedDatastore(ctx.db, args.agentId, args.boundName, ctx.principal.id);
        const accessor = buildSharedDatastoreAccessor(args.agentId, ctx.providers.datastore, ctx.db);
        await accessor.set(args.boundName, args.key, args.value, { pii: args.pii });
        return textResult({ ok: true });
      }
      await ctx.providers.datastore.set(args.agentId, args.key, args.value, { pii: args.pii });
      return textResult({ ok: true });
    },
  });

  mcp.registerTool({
    name: "datastore_delete",
    scope: "datastore:write",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" }, key: { type: "string" }, boundName: { type: "string" } },
      required: ["agentId", "key"],
    },
    handler: async (args: { agentId: string; key: string; boundName?: string }, ctx) => {
      await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      if (args.boundName) {
        await requireMutableSharedDatastore(ctx.db, args.agentId, args.boundName, ctx.principal.id);
        const accessor = buildSharedDatastoreAccessor(args.agentId, ctx.providers.datastore, ctx.db);
        await accessor.delete(args.boundName, args.key);
        return textResult({ ok: true });
      }
      await ctx.providers.datastore.delete(args.agentId, args.key);
      return textResult({ ok: true });
    },
  });
}
