/**
 * Remote MCP servers: the owner-side domain. Validates a server's URL and name, loads the owner's
 * brokered secrets for it, builds the McpFetch that sends them (brokeredFetch over safeFetch), takes
 * the redacted tool snapshot, and diffs snapshots. Secret values never leave this file in any output:
 * snapshots are redacted by exact value (every encoded form) plus token shapes before they are returned.
 */
import type { PrismaClient } from "#prisma";
import { redactTokenShapedValues } from "../coding/protocol.js";
import {
  McpClientError,
  McpHttpClient,
  type McpFetch,
  type McpServerInfo,
  type McpToolEntry,
} from "./mcp-client/client.js";
import { parseSecretBrokerConfig } from "./secret-broker-config.js";
import { redactExactSecretValues, withEscapedForms } from "./secret-spans.js";
import type { SecretEntry, SecretsAccessor } from "./secrets.js";
import type { SecretCipher } from "../providers/secrets/types.js";
import { brokeredFetch } from "../sandbox/brokered-fetch.js";
import { safeFetch } from "../sandbox/safe-fetch.js";
import { consoleRedactionValues, encodedForms } from "../sandbox/secret-broker.js";

export class McpServerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpServerInputError";
  }
}

export interface McpServerRow {
  id: string;
  ownerId: string;
  name: string;
  url: string;
  secretNames: string[];
}

const SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const EXPOSED_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Validates a server URL: https, no userinfo, no fragment, default port; returns the normalised string. */
export function normaliseServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpServerInputError("The MCP server URL is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new McpServerInputError("The MCP server URL must use https.");
  if (url.username !== "" || url.password !== "")
    throw new McpServerInputError("The MCP server URL must not contain a username or password; use a brokered secret.");
  if (url.hash !== "") throw new McpServerInputError("The MCP server URL must not contain a fragment (#).");
  if (url.port !== "") throw new McpServerInputError("The MCP server URL must use the default https port (443).");
  return url.href;
}

export function assertServerName(name: string): void {
  if (!SERVER_NAME.test(name)) {
    throw new McpServerInputError(
      "The MCP server name must be 1-32 characters: lower-case letters, digits, _ or -, starting with a letter or digit.",
    );
  }
}

/** The tool name the model sees: `<server>__<tool>` with any other character mapped to `_`. */
export function exposedToolName(serverName: string, toolName: string): string {
  const name = `${serverName}__${toolName}`.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!EXPOSED_NAME.test(name)) {
    throw new McpServerInputError(
      `The tool name "${name.slice(0, 40)}..." is longer than 64 characters once prefixed.`,
    );
  }
  return name;
}

/** A server's saved tool list (toolSnapshot); anything but an array reads as empty. */
export function snapshotOf(server: { toolSnapshot: unknown }): McpToolEntry[] {
  return Array.isArray(server.toolSnapshot) ? (server.toolSnapshot as McpToolEntry[]) : [];
}

/** Exposed names of allowed tools; a name too long to expose is left out (refused at attach anyway). */
export function exposedNames(serverName: string, allowedTools: readonly string[]): string[] {
  return allowedTools.flatMap((tool) => {
    try {
      return [exposedToolName(serverName, tool)];
    } catch {
      return [];
    }
  });
}

/** Added, removed and changed (description or schema) tool names between two snapshots; order-independent. */
export function diffSnapshots(
  before: McpToolEntry[],
  after: McpToolEntry[],
): { added: string[]; removed: string[]; changed: string[] } {
  const old = new Map(before.map((t) => [t.name, t]));
  const next = new Map(after.map((t) => [t.name, t]));
  const added = [...next.keys()].filter((n) => !old.has(n)).sort();
  const removed = [...old.keys()].filter((n) => !next.has(n)).sort();
  const changed = [...next.keys()].filter((n) => old.has(n) && canonical(old.get(n)) !== canonical(next.get(n))).sort();
  return { added, removed, changed };
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** Redacts every secret value of this server (exact, every encoded and escaped form) plus token shapes. */
export function redactForServer(text: string, values: string[]): string {
  const forms = withEscapedForms(values.flatMap(encodedForms)).sort((a, b) => b.length - a.length);
  return redactTokenShapedValues(redactExactSecretValues(text, [...values, ...forms]));
}

/** The same error with its message redacted; an McpClientError keeps its code, any other keeps its name. */
export function redactError(error: unknown, values: string[]): Error {
  const message = redactForServer(error instanceof Error ? error.message : "The MCP server call failed.", values);
  if (error instanceof McpClientError) return new McpClientError(error.code, message);
  if (error instanceof McpServerInputError) return new McpServerInputError(message);
  const out = new Error(message);
  if (error instanceof Error) out.name = error.name;
  return out;
}

type SecretDb = Pick<PrismaClient, "secret">;

/** Loads the owner's secrets for the server; each must exist, be owned by ownerId, be brokered, and list the URL's host. */
export async function loadServerSecrets(
  db: SecretDb,
  cipher: Pick<SecretCipher, "decrypt">,
  server: McpServerRow,
): Promise<{ accessor: SecretsAccessor; values: string[] }> {
  const host = new URL(server.url).hostname.toLowerCase();
  const entries = new Map<string, SecretEntry>();
  const values = new Set<string>();
  for (const name of server.secretNames) {
    const stored = await db.secret.findUnique({
      where: { ownerId_name: { ownerId: server.ownerId, name } },
      select: { ciphertext: true, broker: true },
    });
    if (!stored) throw new McpServerInputError(`Secret "${name}" was not found among your secrets.`);
    if (stored.broker === null || stored.broker === undefined)
      throw new McpServerInputError(
        `Secret "${name}" is not brokered; set its broker config first (set_secret_broker).`,
      );
    let broker;
    try {
      broker = parseSecretBrokerConfig(stored.broker);
    } catch {
      throw new McpServerInputError(`Secret "${name}" has a broker config that cannot be read; set it again.`);
    }
    if (!broker.hosts.includes(host))
      throw new McpServerInputError(`Secret "${name}" is not brokered to host ${host}; add it to the secret's hosts.`);
    const entry: SecretEntry = { value: await cipher.decrypt(stored.ciphertext), broker };
    entries.set(name, entry);
    for (const v of withEscapedForms(consoleRedactionValues(entry))) values.add(v);
  }
  const accessor: SecretsAccessor = {
    get: async () => {
      throw new Error("secret_brokered: this secret is brokered; it is never readable");
    },
    resolve: async (name) => entries.get(name),
  };
  return { accessor, values: [...values] };
}

/** The McpFetch for one server: brokeredFetch over safeFetch with the timeout and signal; text body, lower-case headers. */
export function serverFetch(
  server: McpServerRow,
  accessor: SecretsAccessor,
  options: { timeoutMs: number; fetchImpl?: typeof safeFetch },
): McpFetch {
  return async (request, signal) => {
    const response = (await brokeredFetch({
      url: server.url,
      init: { method: request.method, headers: request.headers, body: request.body },
      secretNames: server.secretNames,
      secrets: accessor,
      fetchImpl: options.fetchImpl ?? safeFetch,
      policy: { timeoutMs: options.timeoutMs, signal },
      redactFromConsole: () => {},
    })) as { status: number; headers: Record<string, string>; bodyBase64: string };
    return {
      status: response.status,
      headers: Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v])),
      body: Buffer.from(response.bodyBase64, "base64").toString("utf8"),
    };
  };
}

/** initialize + listTools + close; the result is redacted (as JSON text) before it is returned. */
export async function fetchSnapshot(
  server: McpServerRow,
  deps: {
    db: SecretDb;
    cipher: Pick<SecretCipher, "decrypt">;
    fetchImpl?: typeof safeFetch;
    timeoutMs?: number;
  },
): Promise<{ serverInfo: McpServerInfo; tools: McpToolEntry[] }> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { accessor, values } = await loadServerSecrets(deps.db, deps.cipher, server);
  const client = new McpHttpClient({
    fetch: serverFetch(server, accessor, { timeoutMs, fetchImpl: deps.fetchImpl }),
    signal: AbortSignal.timeout(timeoutMs * 3),
  });
  let raw: { serverInfo: McpServerInfo; tools: McpToolEntry[] };
  try {
    const serverInfo = await client.initialize();
    raw = { serverInfo, tools: await client.listTools() };
  } catch (error) {
    throw redactError(error, values);
  } finally {
    await client.close().catch(() => {});
  }
  const redacted = redactForServer(JSON.stringify(raw), values);
  try {
    return JSON.parse(redacted) as { serverInfo: McpServerInfo; tools: McpToolEntry[] };
  } catch {
    throw new McpServerInputError("The MCP server's tool list could not be saved safely.");
  }
}

/** For the secret delete guard: names of the owner's MCP servers whose secretNames include the secret. */
export async function mcpServersUsingSecret(
  db: Pick<PrismaClient, "mcpServer">,
  ownerId: string,
  secretName: string,
): Promise<string[]> {
  const rows = await db.mcpServer.findMany({
    where: { ownerId, secretNames: { has: secretName } },
    select: { name: true },
  });
  return rows.map((r) => r.name).sort();
}
