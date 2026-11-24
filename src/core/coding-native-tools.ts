/**
 * A Claude Code run's native wardby tools (#622): the agent's attached sandbox tools, served to the
 * worker through the same path as its remote MCP tools (worker → coding proxy /mcp → native gateway
 * /coding-mcp). Dispatch pins each tool's name, description and schema next to the MCP pins
 * (loadNativeToolPins); Claude Code sees one as `mcp__wardby_mcp__<tool name>`. As in a native run, a
 * run keeps the tool version it started with: the pin also fixes the tool's code, parameter schema,
 * time limit and the attachment's consented grants (consentedToolGrants) at dispatch, so update_tool
 * or a grant change mid-run applies to the next run. Those fixed fields are the gateway's alone: the
 * listed form (tools/list, the coding proxy's ledger read) carries the name, description and schema
 * only. Every call still checks the attachment exists (a detached tool is refused) and reads the
 * secret values live, then runs the tool with userToolHost, private datastore and shared datastores
 * included. The tool code runs in the gateway process, in the same QuickJS sandbox and under the same
 * time limit as a native agent's control-plane run.
 *
 * Codex runs never get native pins: a Codex run's shell commands can read the run's MCP token, and a
 * native tool has no read-only mark (#623). The gateway refuses a native call from a Codex session too.
 *
 * Secret values never leave: the result (and any error) is redacted by exact value against every
 * value of the attachment's allowed secrets, in every encoded and JSON-escaped form, before it is
 * returned; when those values can't be read the tool does not run and a fixed error is returned.
 * Console lines go to the operator log through the privileged host, redacted against the same values.
 * The per-call log line carries ids, the tool's name, a fixed outcome and sizes only.
 */
import type { PrismaClient } from "#prisma";
import type { Datastore } from "../providers/datastore/types.js";
import type { LoadedTool } from "../providers/engine/types.js";
import type { SecretCipher } from "../providers/secrets/types.js";
import type { safeFetch } from "../sandbox/safe-fetch.js";
import { encodedForms } from "../sandbox/secret-broker.js";
import { runUserToolCall } from "../sandbox/user-tool.js";
import { buildSharedDatastoreAccessor } from "./datastores.js";
import type { Logger } from "./logger.js";
import type { McpToolPin } from "./mcp-tools.js";
import { readRedactionValues } from "./runner.js";
import { buildSecretsAccessor, scopeSecretsAccessor } from "./secrets.js";
import { redactExactSecretValues, withEscapedForms } from "./secret-spans.js";
import { duplicateToolNames, NATIVE_TOOL_DESCRIPTION_MAX_CHARS, NATIVE_TOOL_NAME } from "./tool-names.js";
import { consentedToolGrants, userToolHost, userToolLimitMs, type UserToolGrants } from "./user-tool-host.js";

export { NATIVE_TOOL_NAME, nativeToolNameMessage } from "./tool-names.js";

/** One attached native tool as dispatch pins it for a Claude Code run. */
export interface NativeToolPin {
  kind: "native";
  /** The tool's name; Claude Code sees `mcp__wardby_mcp__<exposedName>`. */
  exposedName: string;
  toolId: string;
  toolName: string;
  definition: { description: string; inputSchema: Record<string, unknown> };
  /**
   * The tool version and grants the run started with, fixed at dispatch. Read by the gateway only:
   * never listed, never read by the coding proxy (listedToolPin), never logged.
   */
  pinned: NativeToolVersion;
}

/** What a native pin fixes for its run: the tool's code, schema and limit, and the consented grants. */
export interface NativeToolVersion {
  code: string;
  paramsZod: string;
  /** The tool's own timeoutMs; absent = the default. The operator's ceiling is applied per call. */
  timeoutMs?: number;
  grants: UserToolGrants;
}

/** Any pin a coding session holds: an MCP server's tool (no `kind`) or a native tool. */
export type CodingToolPin = McpToolPin | NativeToolPin;

export function isNativeToolPin(value: unknown): value is NativeToolPin {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const definition = p.definition as Record<string, unknown> | null | undefined;
  return (
    p.kind === "native" &&
    typeof p.exposedName === "string" &&
    NATIVE_TOOL_NAME.test(p.exposedName) &&
    typeof p.toolId === "string" &&
    p.toolId !== "" &&
    typeof p.toolName === "string" &&
    p.toolName !== "" &&
    definition !== null &&
    typeof definition === "object" &&
    !Array.isArray(definition) &&
    typeof definition.description === "string" &&
    definition.inputSchema !== null &&
    typeof definition.inputSchema === "object" &&
    !Array.isArray(definition.inputSchema) &&
    isNativeToolVersion(p.pinned)
  );
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

function isNativeToolVersion(value: unknown): value is NativeToolVersion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const grants = v.grants as Record<string, unknown> | null | undefined;
  const shared = grants?.allowedSharedDatastorePrefixes as Record<string, unknown> | null | undefined;
  return (
    typeof v.code === "string" &&
    typeof v.paramsZod === "string" &&
    (v.timeoutMs === undefined || (typeof v.timeoutMs === "number" && Number.isSafeInteger(v.timeoutMs))) &&
    grants !== null &&
    typeof grants === "object" &&
    !Array.isArray(grants) &&
    isStringArray(grants.allowedSecrets) &&
    isStringArray(grants.allowedDatastorePrefixes) &&
    isStringArray(grants.allowedHosts) &&
    shared !== null &&
    typeof shared === "object" &&
    !Array.isArray(shared) &&
    Object.values(shared).every(isStringArray)
  );
}

/** A coding run's tools fail when two attached native tools share a name, as a native run does. */
export const NATIVE_TOOL_DUPLICATE_NAMES_ERROR = "coding_native_tool_duplicate_names";

/**
 * Pins for the agent's attached native tools, by name, each with the tool version and consented grants
 * the run keeps until it ends. A name Claude Code can't be offered, or a description over the coding
 * proxy's limit, is left out with a warning (the run still starts). Two attached tools with one name
 * fail the run (NATIVE_TOOL_DUPLICATE_NAMES_ERROR), as they fail a native run. The caller pins them
 * for a Claude Code run only.
 */
export async function loadNativeToolPins(
  db: Pick<PrismaClient, "agentTool">,
  agentId: string,
  log: Pick<Logger, "warn">,
): Promise<NativeToolPin[]> {
  const rows = await db.agentTool.findMany({
    where: { agentId },
    select: {
      capabilitiesGrantedById: true,
      allowedSecrets: true,
      allowedDatastorePrefixes: true,
      allowedHosts: true,
      allowedSharedDatastorePrefixes: true,
      agent: { select: { ownerId: true } },
      tool: {
        select: {
          id: true,
          name: true,
          description: true,
          jsonSchema: true,
          code: true,
          paramsZod: true,
          timeoutMs: true,
        },
      },
    },
    orderBy: [{ tool: { name: "asc" } }, { toolId: "asc" }],
  });
  const duplicates = duplicateToolNames(rows.map((row) => row.tool.name));
  if (duplicates.length > 0) {
    // The names are the operator's own tool names; never the code or the grants.
    throw new Error(
      `${NATIVE_TOOL_DUPLICATE_NAMES_ERROR}: the agent has more than one attached tool named ${duplicates
        .map((name) => `"${name.slice(0, 80)}"`)
        .join(", ")}`,
    );
  }
  const pins: NativeToolPin[] = [];
  for (const row of rows) {
    const { tool } = row;
    if (!NATIVE_TOOL_NAME.test(tool.name)) {
      log.warn({ agentId, toolId: tool.id }, "native tool left out of the coding run: its name can't be offered");
      continue;
    }
    if (tool.description.length > NATIVE_TOOL_DESCRIPTION_MAX_CHARS) {
      log.warn(
        { agentId, toolId: tool.id },
        "native tool left out of the coding run: its description is over the coding proxy's limit",
      );
      continue;
    }
    const schema = tool.jsonSchema;
    pins.push({
      kind: "native",
      exposedName: tool.name,
      toolId: tool.id,
      toolName: tool.name,
      definition: {
        description: tool.description,
        inputSchema:
          schema !== null && typeof schema === "object" && !Array.isArray(schema) ? schema : { type: "object" },
      },
      pinned: {
        code: tool.code,
        paramsZod: tool.paramsZod,
        ...(typeof tool.timeoutMs === "number" ? { timeoutMs: tool.timeoutMs } : {}),
        grants: consentedToolGrants(row.agent.ownerId, row),
      },
    });
  }
  return pins;
}

/**
 * The native pins whose name no other pin of the run uses (an MCP tool's exposed name, or an earlier
 * native pin). Attach refuses clashes; this covers one that got past it: the native tool is left out,
 * with a warning.
 */
export function withoutClashingNativePins(
  pins: readonly NativeToolPin[],
  otherNames: readonly string[],
  log: Pick<Logger, "warn">,
): NativeToolPin[] {
  const taken = new Set(otherNames);
  return pins.filter((pin) => {
    if (!taken.has(pin.exposedName)) {
      taken.add(pin.exposedName);
      return true;
    }
    log.warn(
      { toolId: pin.toolId, exposedName: pin.exposedName },
      "native tool left out of the coding run: its name clashes with another tool",
    );
    return false;
  });
}

/** What tools/list serves for native pins: the tool's own description. */
export function nativeToolDefs(pins: readonly NativeToolPin[]): LoadedTool[] {
  return pins.map((pin) => ({
    name: pin.exposedName,
    description: pin.definition.description,
    jsonSchema: pin.definition.inputSchema,
  }));
}

export interface NativeToolContext {
  db: PrismaClient;
  /** Reads the agent's secrets (brokered or readable). */
  secrets: SecretCipher;
  /** The datastore provider: the agent's private store and its shared datastores. */
  datastore: Datastore;
  /** The agent whose attachment is re-read on every call. */
  agentId: string;
  /** The run, for the per-call log line. */
  runId: string;
  /** The run's stop signal (and the proxy's request): aborting it stops a call in flight. */
  signal: AbortSignal;
  /** The session deadline; the call's time limit never runs past it. */
  deadlineAt?: Date;
  /** Overrides the sandbox's outbound network call — tests only. */
  sandboxFetch?: typeof safeFetch;
  /** Where the tool's console lines go; the shared sandbox logger when absent — tests only. */
  consoleLogger?: Logger;
  log: Pick<Logger, "info" | "warn">;
}

/** What a native call answers when its secrets can't be read to redact the result. */
export const NATIVE_TOOL_SECRETS_UNAVAILABLE_MESSAGE =
  "The tool did not run: its secrets could not be read to keep their values out of the result; try again.";

const error = (code: string, message: string): string => JSON.stringify({ error: code, message });

/** True for runUserToolCall's error shape (`{ error, message }`), as coding-mcp's isMcpErrorText reads it. */
function isErrorText(text: string): boolean {
  if (!text.startsWith('{"error":')) return false;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return Object.keys(value).length === 2 && typeof value.error === "string" && typeof value.message === "string";
  } catch {
    return false;
  }
}

/**
 * Never throws. Re-reads the live attachment, runs the tool with the attachment's consented grants
 * under its time limit (never past the session deadline), and returns the redacted result text or a
 * JSON error. One log line per call.
 */
export async function handleNativeTool(pin: NativeToolPin, argsJson: string, ctx: NativeToolContext): Promise<string> {
  const startedAt = Date.now();
  const done = (text: string, outcome: string): string => {
    // Ids, the tool's name, a fixed outcome and sizes only: never the arguments or the result.
    ctx.log.info(
      {
        runId: ctx.runId,
        agentId: ctx.agentId,
        toolId: pin.toolId,
        tool: pin.toolName,
        outcome,
        durationMs: Date.now() - startedAt,
        resultChars: text.length,
      },
      "native tool call",
    );
    return text;
  };
  const fail = (code: string, message: string) => done(error(code, message), code);
  try {
    // The attachment must still exist; its tool version and grants are the run's pinned ones.
    const row = await ctx.db.agentTool.findUnique({
      where: { agentId_toolId: { agentId: ctx.agentId, toolId: pin.toolId } },
      select: { toolId: true },
    });
    if (!row) {
      return fail(
        "mcp_tool_not_allowed",
        `The tool "${pin.exposedName}" is no longer allowed for this agent: it was detached.`,
      );
    }
    const { grants } = pin.pinned;
    const tool = {
      code: pin.pinned.code,
      paramsZod: pin.pinned.paramsZod,
      ...grants,
      ...(pin.pinned.timeoutMs !== undefined ? { timeoutMs: pin.pinned.timeoutMs } : {}),
    };
    const untilDeadline = ctx.deadlineAt ? ctx.deadlineAt.getTime() - Date.now() : Infinity;
    const limitMs = Math.max(0, Math.min(userToolLimitMs(tool), untilDeadline));
    if (ctx.signal.aborted) return fail("mcp_call_timeout", "The call was stopped.");
    if (limitMs <= 0) return fail("mcp_call_timeout", "The run's time limit has been reached.");

    const secrets = buildSecretsAccessor(ctx.agentId, ctx.secrets, ctx.db);
    // Every value the tool may use, read before it runs: no complete list, no call (fail closed).
    let values: string[];
    try {
      const base = await readRedactionValues(
        scopeSecretsAccessor(secrets, grants.allowedSecrets),
        grants.allowedSecrets,
      );
      values = withEscapedForms([...new Set([...base, ...base.flatMap(encodedForms)])]);
    } catch {
      return fail("secret_check_unavailable", NATIVE_TOOL_SECRETS_UNAVAILABLE_MESSAGE);
    }
    const sharedDatastore = buildSharedDatastoreAccessor(ctx.agentId, ctx.datastore, ctx.db);
    const raw = await runUserToolCall(
      { code: tool.code, paramsZod: tool.paramsZod, timeoutMs: limitMs },
      argsJson,
      (signal) =>
        userToolHost({
          agentId: ctx.agentId,
          name: pin.toolName,
          tool,
          limitMs,
          signal,
          redactSecretValues: values,
          datastore: ctx.datastore,
          sharedDatastore,
          secrets,
          fetchImpl: ctx.sandboxFetch,
          logger: ctx.consoleLogger,
        }),
      { signal: ctx.signal },
    );
    const text = redactExactSecretValues(raw, values);
    return done(text, isErrorText(text) ? "tool_error" : "ok");
  } catch {
    // Nothing of the error leaves: its message could carry anything the call touched.
    return fail("native_tool_failed", "The tool call failed.");
  }
}
