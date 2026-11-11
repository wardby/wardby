/**
 * A native run's remote MCP tools: the load step pins the agent's attached, allowed tools
 * (loadMcpToolPins), the runner offers them as built-ins (mcpToolDefs), and every call runs on the
 * control plane through handleMcpTool. The pin decides only which tools the model sees for this
 * run; each call re-checks the live attachment, that the agent's owner may still use the server (owns
 * it or holds use on it), and uses the live server row (URL, secrets). A pin carries no URL (a query
 * string can carry a token), secret names or owner id: pins are saved in the run's step results.
 *
 * Secret values never leave: results and errors are redacted against the server's secrets (every
 * encoded form) plus token shapes, the log line carries no arguments, bodies or URL, and
 * mcpNamedSecretValues feeds the run's own redaction (secret-guard.ts loadAgentSecretValues).
 */
import type { PrismaClient } from "#prisma";
import { ownerCanUseMcpServer } from "./grants.js";
import { loadMcpServersMode, MCP_SERVERS_OFF_MESSAGE } from "../config/mcp-servers.js";
import { loadToolMaxTimeoutMs } from "../config/tool-timeout.js";
import { McpClientError, McpHttpClient } from "./mcp-client/client.js";
import { toolResultText } from "./mcp-client/results.js";
import {
  exposedToolName,
  loadServerSecrets,
  logCredentialsUnavailable,
  McpCredentialsUnavailableError,
  McpServerInputError,
  redactForServer,
  serverFetch,
  snapshotOf,
  type McpServerRow,
} from "./mcp-servers.js";
import { storedSecretRedactionValues } from "./oauth-secrets.js";
import { parseSecretBrokerConfig } from "./secret-broker-config.js";
import { withEscapedForms } from "./secret-spans.js";
import type { Logger } from "./logger.js";
import type { LoadedTool } from "../providers/engine/types.js";
import type { SecretCipher } from "../providers/secrets/types.js";
import type { safeFetch } from "../sandbox/safe-fetch.js";
import { consoleRedactionValues, encodedForms } from "../sandbox/secret-broker.js";

/** One MCP tool as the load step pins it. */
export interface McpToolPin {
  /** The name the model sees: `<server name>__<tool name>`. */
  exposedName: string;
  /** The name the server knows. */
  toolName: string;
  serverId: string;
  serverName: string;
  /** Only when the attachment sets one. */
  callTimeoutMs?: number;
  definition: { description: string; inputSchema: Record<string, unknown> };
}

export const DEFAULT_MCP_CALL_TIMEOUT_MS = 30_000;

/** What a grantee's run sees when the server owner's credentials can't be loaded. */
export const SHARED_CREDENTIALS_MESSAGE = "The MCP server's credentials can't be used; ask its owner to check it.";

/**
 * A Codex coding agent runs shell commands that can read the run's MCP token, so it may use only tools
 * the server marks read-only (annotations.readOnlyHint === true in the saved tool list).
 */
export function isMarkedReadOnly(entry: { annotations?: Record<string, unknown> } | undefined): boolean {
  return entry?.annotations?.readOnlyHint === true;
}

/**
 * Whether a coding provider gets the Codex read-only rule. Fails closed: anything but exactly
 * "claude-code" (Codex, an unknown value, or a coding agent with no profile) counts as Codex. A run
 * is judged by the provider it was dispatched with (CodingRun.provider), never the agent's current
 * profile, which can change between dispatch and launch.
 */
export function isCodexCoding(provider: string | null | undefined): boolean {
  return provider !== "claude-code";
}

type McpToolsDb = Pick<PrismaClient, "agentMcpServer" | "secret" | "resourceGrant" | "$transaction">;
/** Redaction reads attachments and secrets only: it covers every attached server, usable or not. */
type McpSecretsDb = Pick<PrismaClient, "agentMcpServer" | "secret">;

export interface McpToolPinOptions {
  /**
   * Pin only tools the server marks read-only: the caller sets it for a Codex coding run, from the
   * provider the run was dispatched with (isCodexCoding(run.provider)). Native runs leave it unset.
   */
  readOnlyOnly?: boolean;
}

/**
 * Builds pins for an agent's attachments: allowed tools present in the snapshot only, from servers the
 * agent's owner may still use (owns, or holds use on); none when the mode is off.
 */
export async function loadMcpToolPins(
  db: Pick<PrismaClient, "agentMcpServer" | "resourceGrant">,
  agentId: string,
  options: McpToolPinOptions = {},
): Promise<McpToolPin[]> {
  if (loadMcpServersMode() === "off") return [];
  const rows = await db.agentMcpServer.findMany({
    where: { agentId },
    include: { server: true, agent: { select: { ownerId: true } } },
    orderBy: [{ createdAt: "asc" }, { serverId: "asc" }],
  });
  const pins: McpToolPin[] = [];
  for (const row of rows) {
    if (!(await ownerCanUseMcpServer(db, row.agent.ownerId, row.server))) continue;
    const byName = new Map(snapshotOf(row.server).map((t) => [t.name, t]));
    for (const toolName of row.allowedTools) {
      const entry = byName.get(toolName);
      if (!entry) continue;
      // A refresh can drop readOnlyHint after attach: such a tool stays out of a Codex run.
      if (options.readOnlyOnly === true && !isMarkedReadOnly(entry)) continue;
      let exposedName: string;
      try {
        exposedName = exposedToolName(row.server.name, toolName);
      } catch {
        continue;
      }
      pins.push({
        exposedName,
        toolName,
        serverId: row.server.id,
        serverName: row.server.name,
        ...(row.callTimeoutMs !== null ? { callTimeoutMs: row.callTimeoutMs } : {}),
        definition: { description: entry.description, inputSchema: entry.inputSchema },
      });
    }
  }
  return pins;
}

/**
 * The pins whose exposed name no other tool of the run uses. Attach refuses clashes; this covers a
 * name that became a built-in (or an attached tool) later: the MCP tool is left out, with a warning.
 */
export function withoutClashingPins(
  pins: readonly McpToolPin[],
  otherNames: readonly string[],
  log: Pick<Logger, "warn">,
): McpToolPin[] {
  const taken = new Set(otherNames);
  return pins.filter((pin) => {
    if (!taken.has(pin.exposedName)) {
      taken.add(pin.exposedName);
      return true;
    }
    log.warn(
      { serverId: pin.serverId, tool: pin.toolName, exposedName: pin.exposedName },
      "MCP tool left out of the run: its name clashes with another tool",
    );
    return false;
  });
}

export function mcpToolDefs(pins: readonly McpToolPin[]): LoadedTool[] {
  return pins.map((pin) => ({
    name: pin.exposedName,
    description: `From MCP server ${pin.serverName}: ${pin.definition.description}`,
    jsonSchema: pin.definition.inputSchema,
  }));
}

export interface McpToolContext {
  db: McpToolsDb;
  /** Full cipher: an OAuth secret's refresh re-encrypts its tokens. */
  cipher: SecretCipher;
  /** The agent whose attachment is re-checked on every call. */
  agentId: string;
  /** The run, for the per-call log line. */
  runId: string;
  /** The run's stop signal: aborting it stops a call in flight. */
  signal: AbortSignal;
  /** A sandboxed run's session deadline; the call's time limit never runs past it. */
  deadlineAt?: Date;
  /**
   * Refuse any tool the live tool list doesn't mark read-only: set by the coding gateway for a Codex
   * run, from the run's dispatched provider (isCodexCoding(codingRun.provider)). Native runs leave it unset.
   */
  readOnlyOnly?: boolean;
  fetchImpl?: typeof safeFetch;
  log: Pick<Logger, "info" | "warn">;
}

function error(code: string, message: string): string {
  return JSON.stringify({ error: code, message });
}

function parseArgs(argsJson: string): Record<string, unknown> | undefined {
  if (argsJson.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(argsJson);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Never throws. Re-checks the live attachment, validates the arguments, runs initialize → tools/call →
 * close under the time limit, and returns the redacted result text or a JSON error. One log line per call.
 */
export async function handleMcpTool(pin: McpToolPin, argsJson: string, ctx: McpToolContext): Promise<string> {
  const startedAt = Date.now();
  const done = (text: string, outcome: string): string => {
    ctx.log.info(
      {
        runId: ctx.runId,
        agentId: ctx.agentId,
        serverId: pin.serverId,
        tool: pin.toolName,
        outcome,
        durationMs: Date.now() - startedAt,
        resultChars: text.length,
      },
      "mcp tool call",
    );
    return text;
  };
  const fail = (code: string, message: string) => done(error(code, message), code);

  let values: string[] = [];
  try {
    if (loadMcpServersMode() === "off") return fail("mcp_servers_off", MCP_SERVERS_OFF_MESSAGE);
    const row = await ctx.db.agentMcpServer.findUnique({
      where: { agentId_serverId: { agentId: ctx.agentId, serverId: pin.serverId } },
      include: { server: true, agent: { select: { ownerId: true } } },
    });
    if (!row || !row.allowedTools.includes(pin.toolName)) {
      return fail(
        "mcp_tool_not_allowed",
        `The tool "${pin.exposedName}" is no longer allowed for this agent: its MCP server was detached or the tool was taken off the allowed list.`,
      );
    }
    // A revoked or lowered grant stops the very next call, even before the attachment is pruned.
    if (!(await ownerCanUseMcpServer(ctx.db, row.agent.ownerId, row.server))) {
      return fail(
        "mcp_tool_not_allowed",
        `The tool "${pin.exposedName}" is no longer allowed for this agent: its owner no longer has use access to MCP server "${row.server.name}".`,
      );
    }
    const live = snapshotOf(row.server).find((t) => t.name === pin.toolName);
    if (!live) {
      return fail(
        "mcp_tool_removed",
        `The tool "${pin.exposedName}" is no longer in MCP server "${row.server.name}"'s tool list.`,
      );
    }
    if (ctx.readOnlyOnly === true && !isMarkedReadOnly(live)) {
      return fail(
        "mcp_tool_not_allowed",
        `The tool "${pin.exposedName}" is no longer allowed for this agent: Codex agents can use only tools the server marks read-only.`,
      );
    }
    const args = parseArgs(argsJson);
    if (!args) return fail("invalid_arguments", "The tool's arguments must be a JSON object.");

    const configured = Math.min(
      row.callTimeoutMs ?? pin.callTimeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS,
      loadToolMaxTimeoutMs(),
    );
    const untilDeadline = ctx.deadlineAt ? ctx.deadlineAt.getTime() - Date.now() : Infinity;
    const limitMs = Math.max(0, Math.min(configured, untilDeadline));
    const timedOut = `The MCP server did not answer within ${limitMs} ms.`;
    if (ctx.signal.aborted) return fail("mcp_call_timeout", "The call was stopped.");
    if (limitMs <= 0) return fail("mcp_call_timeout", "The run's time limit has been reached.");

    const server: McpServerRow = {
      id: row.server.id,
      ownerId: row.server.ownerId,
      name: row.server.name,
      url: row.server.url,
      secretNames: row.server.secretNames,
    };
    let secrets: Awaited<ReturnType<typeof loadServerSecrets>>;
    try {
      secrets = await loadServerSecrets(ctx.db, ctx.cipher, server, {
        ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
      });
    } catch (err) {
      const shared = row.agent.ownerId !== server.ownerId;
      if (err instanceof McpCredentialsUnavailableError) {
        logCredentialsUnavailable(ctx.log, err);
        return fail(err.code, shared ? SHARED_CREDENTIALS_MESSAGE : err.message);
      }
      // The detail names the server owner's secrets and speaks to that owner: a grantee's run gets neither.
      if (err instanceof McpServerInputError && shared) {
        return fail("mcp_server_error", SHARED_CREDENTIALS_MESSAGE);
      }
      throw err;
    }
    values = secrets.values;

    const controller = new AbortController();
    let stopped = false;
    const onStop = () => {
      stopped = true;
      controller.abort();
    };
    ctx.signal.addEventListener("abort", onStop, { once: true });
    const timer = setTimeout(() => controller.abort(), limitMs);
    // The race ends the call even if a transport ignores the signal.
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new McpClientError("mcp_call_timeout", "aborted")), {
        once: true,
      });
    });
    aborted.catch(() => {});
    // A stop that fired while the secrets were loading came before the listener; act on it now.
    if (ctx.signal.aborted) onStop();
    const client = new McpHttpClient({
      fetch: serverFetch(server, secrets.accessor, { timeoutMs: limitMs, fetchImpl: ctx.fetchImpl }),
      signal: controller.signal,
    });
    try {
      const result = await Promise.race([
        (async () => {
          await client.initialize();
          return client.callTool(pin.toolName, args);
        })(),
        aborted,
      ]);
      const { text, isError } = toolResultText(result, (raw) => redactForServer(raw, values));
      return done(text, isError ? "mcp_server_error" : "ok");
    } catch (err) {
      if (controller.signal.aborted) {
        return fail("mcp_call_timeout", stopped ? "The call was stopped." : timedOut);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onStop);
      // Best effort; never waits on a server that already ran out of time.
      if (controller.signal.aborted) void client.close().catch(() => {});
      else await client.close().catch(() => {});
    }
  } catch (err) {
    const message = redactForServer(err instanceof Error ? err.message : "The MCP server call failed.", values);
    if (err instanceof McpClientError) return fail(err.code, message);
    if (err instanceof McpServerInputError) return fail("mcp_server_error", message);
    return fail("mcp_server_unreachable", "The MCP server could not be reached.");
  }
}

export interface NamedMcpSecretValues {
  /** `mcp:<server name>/<secret name>`. */
  name: string;
  values: string[];
}

/**
 * Every secret value of every server attached to the agent, named `mcp:<server>/<secret>`, in
 * every form the server's own redaction looks for. A secret that no longer exists has no value to
 * leak and is skipped; a read that fails rejects (callers fail closed).
 */
export async function mcpNamedSecretValues(
  db: McpSecretsDb,
  cipher: Pick<SecretCipher, "decrypt">,
  agentId: string,
): Promise<NamedMcpSecretValues[]> {
  const rows = await db.agentMcpServer.findMany({
    where: { agentId },
    select: { server: { select: { name: true, ownerId: true, secretNames: true } } },
  });
  const named: NamedMcpSecretValues[] = [];
  for (const { server } of rows) {
    for (const secretName of server.secretNames) {
      const stored = await db.secret.findUnique({
        where: { ownerId_name: { ownerId: server.ownerId, name: secretName } },
        select: { ciphertext: true, broker: true, oauth: true },
      });
      if (!stored) continue;
      const plaintext = await cipher.decrypt(stored.ciphertext);
      // Read as stored, never refreshed: an OAuth secret contributes its tokens, not its payload JSON.
      const [value, ...rest] = storedSecretRedactionValues(plaintext, stored.oauth);
      const base = consoleRedactionValues({
        value,
        broker: readableBroker(stored.broker),
        ...(rest.length ? { oauth: { redact: rest } } : {}),
      });
      named.push({
        name: `mcp:${server.name}/${secretName}`,
        values: withEscapedForms([...new Set([...base, ...base.flatMap(encodedForms)])]),
      });
    }
  }
  return named;
}

/** A stored broker config, or null when there is none or it cannot be read (the value alone is then redacted). */
function readableBroker(stored: unknown): ReturnType<typeof parseSecretBrokerConfig> | null {
  if (stored === null || stored === undefined) return null;
  try {
    return parseSecretBrokerConfig(stored);
  } catch {
    return null;
  }
}

/** Secret values for every attached server of this agent (for run-text masking and gateway cause checks). */
export async function mcpSecretValuesForAgent(
  db: McpSecretsDb,
  cipher: Pick<SecretCipher, "decrypt">,
  agentId: string,
): Promise<string[]> {
  return (await mcpNamedSecretValues(db, cipher, agentId)).flatMap((n) => n.values);
}
