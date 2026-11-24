/**
 * What one attached user tool may do, and the privileged host it runs with: shared by a native run
 * (runner.ts createNativeRunTools) and a Claude Code run's native tool calls on the gateway
 * (coding-native-tools.ts), so a tool gets exactly the same grants either way.
 */
import type { Datastore } from "../providers/datastore/types.js";
import { scopeDatastore } from "../providers/datastore/scoped.js";
import { loadToolMaxTimeoutMs } from "../config/tool-timeout.js";
import { createPrivilegedHost, type PrivilegedHost } from "../sandbox/host-functions.js";
import type { safeFetch } from "../sandbox/safe-fetch.js";
import { asPrefixMap, asStringArray } from "../sandbox/tool-capabilities.js";
import { effectiveToolTimeoutMs, fetchTimeoutFor } from "../sandbox/tool-timeout.js";
import { scopeSharedDatastoreAccessor, type SharedDatastoreAccessor } from "./datastores.js";
import type { Logger } from "./logger.js";
import { scopeSecretsAccessor, type SecretsAccessor } from "./secrets.js";

/** An attachment's four capability fields, as the runtime honours them. */
export interface UserToolGrants {
  allowedSecrets: string[];
  allowedDatastorePrefixes: string[];
  allowedHosts: string[];
  allowedSharedDatastorePrefixes: Record<string, string[]>;
}

/** The stored attachment fields consentedToolGrants reads. */
export interface ToolAttachmentGrants {
  capabilitiesGrantedById: string | null;
  allowedSecrets: unknown;
  allowedDatastorePrefixes: unknown;
  allowedHosts: unknown;
  allowedSharedDatastorePrefixes: unknown;
}

/**
 * An attachment's four capability fields are honoured only when the agent's CURRENT owner granted
 * them (resource-sharing grants spec §3.4.2): a write-grantee's attachment, a make_owner transfer and
 * a pre-grants row nobody vouched for all run with no secrets, no datastore and no fetch until the
 * owner re-grants with attach_tool.
 */
export function consentedToolGrants(agentOwnerId: string | null, attachment: ToolAttachmentGrants): UserToolGrants {
  const consented = agentOwnerId !== null && attachment.capabilitiesGrantedById === agentOwnerId;
  return {
    allowedSecrets: consented ? asStringArray(attachment.allowedSecrets) : [],
    allowedDatastorePrefixes: consented ? asStringArray(attachment.allowedDatastorePrefixes) : [],
    allowedHosts: consented ? asStringArray(attachment.allowedHosts) : [],
    allowedSharedDatastorePrefixes: consented ? asPrefixMap(attachment.allowedSharedDatastorePrefixes) : {},
  };
}

/** A tool's time limit under the current ceiling (WARDBY_TOOL_MAX_TIMEOUT_MS, read each call). */
export function userToolLimitMs(tool: { timeoutMs?: number }): number {
  return effectiveToolTimeoutMs(tool.timeoutMs, loadToolMaxTimeoutMs());
}

export interface UserToolHostOptions {
  agentId: string;
  /** The tool's name, prefixed onto its console lines. */
  name: string;
  tool: UserToolGrants & { timeoutMs?: number };
  /**
   * The limit this call actually runs under, when the caller caps it below the tool's own (a coding
   * run's call never runs past its session deadline): each fetch times out just after it. Absent = the
   * tool's limit under the current ceiling.
   */
  limitMs?: number;
  signal: AbortSignal;
  /** Secret values to redact from console lines even if this host never fetched them. */
  redactSecretValues?: readonly string[];
  /** The agent's private datastore provider (scoped here to the tool's prefixes). */
  datastore: Datastore;
  /** The agent's shared datastores (scoped here to the tool's prefixes). */
  sharedDatastore: SharedDatastoreAccessor;
  /** The agent's secrets (scoped here to the tool's allowedSecrets). */
  secrets: SecretsAccessor;
  /** Overrides the sandbox's outbound network call — tests only. */
  fetchImpl?: typeof safeFetch;
  /** Where console lines go; the shared sandbox logger when absent — tests only. */
  logger?: Logger;
}

/** The privileged host for one call of a user tool, scoped to that attachment's grants. */
export function userToolHost(options: UserToolHostOptions): PrivilegedHost {
  const { tool } = options;
  return createPrivilegedHost({
    redactSecretValues: options.redactSecretValues,
    fetchTimeoutMs: fetchTimeoutFor(options.limitMs ?? userToolLimitMs(tool)),
    agentId: options.agentId,
    datastore: scopeDatastore(options.datastore, tool.allowedDatastorePrefixes),
    sharedDatastore: scopeSharedDatastoreAccessor(options.sharedDatastore, tool.allowedSharedDatastorePrefixes),
    secrets: scopeSecretsAccessor(options.secrets, tool.allowedSecrets),
    allowedFetchHosts: tool.allowedHosts,
    fetchImpl: options.fetchImpl,
    ...(options.logger ? { logger: options.logger } : {}),
    logTag: options.name,
    signal: options.signal,
  });
}
