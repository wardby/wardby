/**
 * Run hook management: create_run_hook, update_run_hook, delete_run_hook,
 * list_run_hooks and test_run_hook. A run hook ties a sandbox tool to one of
 * an agent's workflow events; wardby, never the model, calls the tool.
 *
 * Trust model, the same as attach_tool's: write on the agent manages its
 * hooks; a new hook needs a tool the caller may attach; the hook's secrets
 * and hosts are the agent owner's to grant (and honoured only while that
 * owner still owns the agent); includeFinalText — the run's own output
 * leaving wardby — needs agents:admin with the admin role.
 */
import { randomUUID } from "node:crypto";
import { Prisma, type RunHook } from "#prisma";
import { callRunHook } from "../../core/run-hooks/dispatcher.js";
import { buildHookEvent } from "../../core/run-hooks/params.js";
import { SAMPLE_PAYLOADS, TEST_FINAL_TEXT } from "../../core/run-hooks/samples.js";
import { loadAgentSecretValues } from "../../core/secret-guard.js";
import { isPublicWritable } from "../../core/grants.js";
import { HOOK_EVENT_KINDS, RUN_END_STATUSES, type HookEventKind } from "../../core/workflow-events.js";
import { validateParams } from "../../sandbox/zod-params.js";
import { ToolCapabilitiesPatchSchema } from "../../sandbox/tool-capabilities.js";
import { assertAgentAccess } from "../auth/access.js";
import { requireOwnedTool } from "../auth/ownership.js";
import { requireScope } from "../auth/resource-server.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

/** The largest config a hook may carry, as JSON. */
export const MAX_HOOK_CONFIG_BYTES = 8 * 1024;
const RUNS = ["top_level", "all"] as const;

interface HookArgs {
  events?: string[];
  statuses?: string[];
  runs?: string;
  includeFinalText?: boolean;
  config?: unknown;
  allowedSecrets?: string[];
  allowedHosts?: string[];
  enabled?: boolean;
}

interface ParsedHook {
  events: HookEventKind[];
  statuses: string[];
  runs: (typeof RUNS)[number];
  includeFinalText: boolean;
  config: Record<string, unknown>;
  allowedSecrets: string[] | undefined;
  allowedHosts: string[] | undefined;
  enabled: boolean;
}

const unique = (values: string[]) => new Set(values).size === values.length;

function parseHookArgs(args: HookArgs): ParsedHook {
  const events = args.events ?? [];
  const unknownKinds = events.filter((e) => !(HOOK_EVENT_KINDS as readonly string[]).includes(e));
  if (unknownKinds.length > 0 || !unique(events)) {
    throw new McpError(400, `events must be distinct values from: ${HOOK_EVENT_KINDS.join(", ")}.`);
  }
  const statuses = args.statuses ?? [];
  if (statuses.some((s) => !(RUN_END_STATUSES as readonly string[]).includes(s)) || !unique(statuses)) {
    throw new McpError(400, `statuses must be distinct values from: ${RUN_END_STATUSES.join(", ")}.`);
  }
  const runs = args.runs ?? "top_level";
  if (!(RUNS as readonly string[]).includes(runs)) throw new McpError(400, 'runs must be "top_level" or "all".');
  const config = args.config ?? {};
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new McpError(400, "config must be a JSON object.");
  }
  if (Buffer.byteLength(JSON.stringify(config)) > MAX_HOOK_CONFIG_BYTES) {
    throw new McpError(400, `config must be at most ${MAX_HOOK_CONFIG_BYTES} bytes as JSON.`);
  }
  const caps = ToolCapabilitiesPatchSchema.safeParse({
    allowedSecrets: args.allowedSecrets,
    allowedHosts: args.allowedHosts,
  });
  if (!caps.success) {
    throw new McpError(400, `Invalid hook capabilities: ${caps.error.issues.map((i) => i.message).join("; ")}`);
  }
  return {
    events: events as HookEventKind[],
    statuses,
    runs: runs as ParsedHook["runs"],
    includeFinalText: args.includeFinalText === true,
    config: config as Record<string, unknown>,
    allowedSecrets: caps.data.allowedSecrets,
    allowedHosts: caps.data.allowedHosts,
    enabled: args.enabled ?? true,
  };
}

/** Refuses a config that holds one of the agent's secret values: config is plain settings, never secrets. */
async function assertNoSecretInConfig(ctx: McpRequestContext, agentId: string, config: unknown): Promise<void> {
  const json = JSON.stringify(config);
  if (json === "{}") return;
  let values: string[];
  try {
    values = (await loadAgentSecretValues(ctx.db, ctx.providers.secrets, agentId)).flatMap((e) => e.values);
  } catch {
    throw new McpError(503, "secret_values_unavailable: the agent's secret values could not be read; try again.");
  }
  if (values.some((v) => v.length >= 6 && json.includes(v))) {
    throw new McpError(
      400,
      "hook_config_has_secret: config holds one of the agent's secret values. Put secrets in allowedSecrets and read them in the tool with secrets.get(name).",
    );
  }
}

/** Runs the tool's params schema against a sample event of every kind the hook takes. */
async function assertToolAcceptsConfig(
  tool: { paramsZod: string },
  agent: { id: string; name: string },
  hook: ParsedHook,
): Promise<void> {
  const kinds = hook.events.length > 0 ? hook.events : [...HOOK_EVENT_KINDS];
  for (const kind of kinds) {
    const event = buildHookEvent(
      { id: "sample-event", kind, runId: "sample-run", createdAt: new Date(0), payload: SAMPLE_PAYLOADS[kind] },
      agent,
      hook.includeFinalText ? { finalText: TEST_FINAL_TEXT, finalTextTruncated: false } : undefined,
    );
    const result = await validateParams(tool.paramsZod, { event, config: hook.config });
    if (!result.ok) {
      throw new McpError(
        400,
        `hook_config_rejected: the tool's params schema rejects { event, config } for a ${kind} event: ${result.errorMessage.slice(0, 500)}`,
      );
    }
  }
}

function requireFinalTextAdmin(ctx: McpRequestContext): void {
  try {
    requireScope(ctx, ctx.canonicalUri, "agents:admin");
  } catch {
    throw new McpError(
      403,
      "final_text_needs_admin: includeFinalText sends the run's own output out of wardby, so it needs agents:admin with the admin role.",
    );
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

function hookView(
  hook: RunHook & { tool?: { name: string } | null },
  agentOwnerId: string | null,
  counts?: { pending: number; failed: number },
) {
  return {
    id: hook.id,
    agentId: hook.agentId,
    toolId: hook.toolId,
    ...(hook.tool ? { toolName: hook.tool.name } : {}),
    events: hook.events,
    statuses: hook.statuses,
    runs: hook.runs,
    includeFinalText: hook.includeFinalText,
    config: hook.config,
    allowedSecrets: strings(hook.allowedSecrets),
    allowedHosts: strings(hook.allowedHosts),
    // Secrets and hosts only apply while the agent's current owner granted them.
    capabilitiesGranted: agentOwnerId !== null && hook.capabilitiesGrantedById === agentOwnerId,
    enabled: hook.enabled,
    lastError: hook.lastError,
    lastErrorAt: hook.lastErrorAt,
    createdAt: hook.createdAt,
    ...(counts ?? {}),
  };
}

const HOOK_PROPERTIES = {
  events: { type: "array", items: { type: "string", enum: [...HOOK_EVENT_KINDS] }, uniqueItems: true },
  statuses: { type: "array", items: { type: "string", enum: [...RUN_END_STATUSES] }, uniqueItems: true },
  runs: { type: "string", enum: [...RUNS] },
  includeFinalText: { type: "boolean" },
  config: { type: "object" },
  allowedSecrets: { type: "array", items: { type: "string" } },
  allowedHosts: { type: "array", items: { type: "string" } },
  enabled: { type: "boolean" },
} as const;

const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable };

export function registerRunHookTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "create_run_hook",
    scope: "agents:write",
    description:
      "Ties a sandbox tool to an agent's workflow events: wardby (not the model) calls the tool with { event, config } when one happens. Needs write on the agent and a tool you may attach. events: any of " +
      `${HOOK_EVENT_KINDS.join(", ")} (empty = all); run_completed fires for every finished run, filtered by statuses (empty = all) and runs ("top_level", the default, or "all" to include child runs). ` +
      "config is plain settings passed to the tool (a channel, an address), never secrets; it must pass the tool's params schema. allowedSecrets and allowedHosts are what the tool may read and fetch, the agent owner's to grant, as in attach_tool. " +
      "includeFinalText adds the run's final text (masked by exact value against the agent's secrets, cut to 65,536 characters) and needs agents:admin with the admin role. One agent can have many hooks, the same tool more than once.",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" }, toolId: { type: "string" }, ...HOOK_PROPERTIES },
      required: ["agentId", "toolId"],
    },
    handler: async (args: HookArgs & { agentId: string; toolId: string }, ctx) => {
      const parsed = parseHookArgs(args);
      if (parsed.includeFinalText) requireFinalTextAdmin(ctx);
      const capabilitiesPassed = parsed.allowedSecrets !== undefined || parsed.allowedHosts !== undefined;
      await assertNoSecretInConfig(ctx, args.agentId, parsed.config);
      const created = await ctx.db.$transaction(async (tx) => {
        const { agent } = await assertAgentAccess(
          ctx,
          await tx.agent.findUnique({ where: { id: args.agentId } }),
          args.agentId,
          "write",
          tx,
        );
        const isOwner = agent.ownerId !== null && agent.ownerId === ctx.principal.id;
        if (capabilitiesPassed && !isOwner) {
          throw new McpError(
            403,
            "Only the agent's owner can grant a hook secrets or hosts; ask them to re-run update_run_hook with them.",
          );
        }
        if (capabilitiesPassed && (await isPublicWritable(tx, agent.id))) {
          throw new McpError(
            409,
            `Agent "${agent.id}" is writable by everyone, so hook capabilities cannot be granted on it; revoke or lower the everyone grant first.`,
          );
        }
        const tool = await requireOwnedTool(tx, args.toolId, ctx.principal.id);
        await assertToolAcceptsConfig(tool, agent, parsed);
        const hook = await tx.runHook.create({
          data: {
            agentId: agent.id,
            toolId: tool.id,
            events: parsed.events,
            statuses: parsed.statuses,
            runs: parsed.runs,
            includeFinalText: parsed.includeFinalText,
            config: parsed.config as Prisma.InputJsonObject,
            allowedSecrets: (isOwner && parsed.allowedSecrets) || [],
            allowedHosts: (isOwner && parsed.allowedHosts) || [],
            enabled: parsed.enabled,
            createdById: ctx.principal.id,
            capabilitiesGrantedById: isOwner ? agent.ownerId : null,
            finalTextApprovedById: parsed.includeFinalText ? ctx.principal.id : null,
          },
          include: { tool: { select: { name: true } } },
        });
        return { hook, ownerId: agent.ownerId };
      }, SERIALIZABLE);
      return textResult({ hook: hookView(created.hook, created.ownerId) });
    },
  });

  mcp.registerTool({
    name: "update_run_hook",
    scope: "agents:write",
    description:
      "Replaces a run hook's settings with the full desired state (fields left out take their defaults, as in create_run_hook) and clears its lastError. Needs write on the hook's agent. " +
      "Only the agent's owner can set allowedSecrets/allowedHosts; when anyone else updates, the hook's capabilities are left as they are. Turning includeFinalText on needs agents:admin with the admin role.",
    inputSchema: {
      type: "object",
      properties: { hookId: { type: "string" }, ...HOOK_PROPERTIES },
      required: ["hookId"],
    },
    handler: async (args: HookArgs & { hookId: string }, ctx) => {
      const parsed = parseHookArgs(args);
      const capabilitiesPassed = parsed.allowedSecrets !== undefined || parsed.allowedHosts !== undefined;
      const current = await ctx.db.runHook.findUnique({ where: { id: args.hookId } });
      if (!current) throw new McpError(404, `Run hook "${args.hookId}" not found.`);
      if (parsed.includeFinalText && !current.includeFinalText) requireFinalTextAdmin(ctx);
      await assertNoSecretInConfig(ctx, current.agentId, parsed.config);
      const updated = await ctx.db.$transaction(async (tx) => {
        const { agent } = await assertAgentAccess(
          ctx,
          await tx.agent.findUnique({ where: { id: current.agentId } }),
          current.agentId,
          "write",
          tx,
        );
        const isOwner = agent.ownerId !== null && agent.ownerId === ctx.principal.id;
        if (capabilitiesPassed && !isOwner) {
          throw new McpError(403, "Only the agent's owner can grant a hook secrets or hosts.");
        }
        if (capabilitiesPassed && (await isPublicWritable(tx, agent.id))) {
          throw new McpError(
            409,
            `Agent "${agent.id}" is writable by everyone, so hook capabilities cannot be granted on it; revoke or lower the everyone grant first.`,
          );
        }
        const tool = await tx.tool.findUniqueOrThrow({ where: { id: current.toolId } });
        await assertToolAcceptsConfig(tool, agent, parsed);
        const ownerGrant = isOwner
          ? {
              allowedSecrets: parsed.allowedSecrets ?? [],
              allowedHosts: parsed.allowedHosts ?? [],
              capabilitiesGrantedById: agent.ownerId,
            }
          : {};
        const hook = await tx.runHook.update({
          where: { id: current.id },
          data: {
            events: parsed.events,
            statuses: parsed.statuses,
            runs: parsed.runs,
            includeFinalText: parsed.includeFinalText,
            config: parsed.config as Prisma.InputJsonObject,
            enabled: parsed.enabled,
            lastError: null,
            lastErrorAt: null,
            ...ownerGrant,
            ...(parsed.includeFinalText && !current.includeFinalText
              ? { finalTextApprovedById: ctx.principal.id }
              : !parsed.includeFinalText
                ? { finalTextApprovedById: null }
                : {}),
          },
          include: { tool: { select: { name: true } } },
        });
        return { hook, ownerId: agent.ownerId };
      }, SERIALIZABLE);
      return textResult({ hook: hookView(updated.hook, updated.ownerId) });
    },
  });

  mcp.registerTool({
    name: "delete_run_hook",
    scope: "agents:write",
    description: "Deletes a run hook and its pending deliveries. Needs write on the hook's agent.",
    inputSchema: { type: "object", properties: { hookId: { type: "string" } }, required: ["hookId"] },
    handler: async (args: { hookId: string }, ctx) => {
      const hook = await ctx.db.runHook.findUnique({ where: { id: args.hookId } });
      if (!hook) throw new McpError(404, `Run hook "${args.hookId}" not found.`);
      await assertAgentAccess(
        ctx,
        await ctx.db.agent.findUnique({ where: { id: hook.agentId } }),
        hook.agentId,
        "write",
      );
      await ctx.db.runHook.delete({ where: { id: hook.id } });
      return textResult({ deleted: true, hookId: hook.id });
    },
  });

  mcp.registerTool({
    name: "list_run_hooks",
    scope: "agents:read",
    description:
      "Lists an agent's run hooks (needs read on the agent), each with its settings, whether its secrets and hosts are granted by the agent's current owner (capabilitiesGranted), lastError, and its pending and failed delivery counts.",
    inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
    handler: async (args: { agentId: string }, ctx) => {
      const { agent } = await assertAgentAccess(
        ctx,
        await ctx.db.agent.findUnique({ where: { id: args.agentId } }),
        args.agentId,
        "read",
      );
      const hooks = await ctx.db.runHook.findMany({
        where: { agentId: agent.id },
        orderBy: { createdAt: "asc" },
        include: { tool: { select: { name: true } } },
      });
      const grouped = hooks.length
        ? await ctx.db.runHookDelivery.groupBy({
            by: ["hookId", "state"],
            where: { hookId: { in: hooks.map((h) => h.id) }, state: { in: ["pending", "failed"] } },
            _count: { _all: true },
          })
        : [];
      const count = (hookId: string, state: string) =>
        grouped.find((g) => g.hookId === hookId && g.state === state)?._count._all ?? 0;
      return textResult({
        hooks: hooks.map((h) =>
          hookView(h, agent.ownerId, { pending: count(h.id, "pending"), failed: count(h.id, "failed") }),
        ),
      });
    },
  });

  mcp.registerTool({
    name: "test_run_hook",
    scope: "agents:write",
    description:
      "Calls a run hook's tool now with a synthetic run_completed event (event.test is true; with includeFinalText, a placeholder final text, never a real run's output) and its config, the same way a real delivery does, and returns { ok } or the masked error. Records nothing. Needs write on the hook's agent.",
    inputSchema: { type: "object", properties: { hookId: { type: "string" } }, required: ["hookId"] },
    handler: async (args: { hookId: string }, ctx) => {
      const hook = await ctx.db.runHook.findUnique({
        where: { id: args.hookId },
        include: { tool: { select: { name: true, code: true, paramsZod: true, timeoutMs: true } } },
      });
      if (!hook) throw new McpError(404, `Run hook "${args.hookId}" not found.`);
      const { agent } = await assertAgentAccess(
        ctx,
        await ctx.db.agent.findUnique({ where: { id: hook.agentId } }),
        hook.agentId,
        "write",
      );
      const result = await callRunHook(
        { db: ctx.db, secrets: ctx.providers.secrets, datastore: ctx.providers.datastore },
        {
          hook,
          tool: hook.tool,
          agent: { id: agent.id, name: agent.name, ownerId: agent.ownerId },
          event: {
            id: `test-${randomUUID()}`,
            kind: "run_completed",
            runId: null,
            createdAt: new Date(),
            payload: { ...SAMPLE_PAYLOADS.run_completed, agentName: agent.name },
          },
          testFinalText: TEST_FINAL_TEXT,
        },
      );
      return textResult(result.ok ? { ok: true } : { ok: false, error: result.error });
    },
  });
}
