/**
 * Orchestrates one sandboxed tool invocation: full host API (fetch,
 * datastore, parsers, etc.) installed, fresh runtime/context per call
 * (isolation — no state bleeds between calls; persistent state is the
 * datastore's job). Never lets a tool failure escape as anything other
 * than a structured `SandboxResult` — a throw, timeout, memory
 * exhaustion, or non-serializable return all fail *that call* cleanly
 * instead of crashing the run or the host process.
 */

import { installHostFunctions } from "./host-functions.js";
import { SANDBOX_PRELUDE } from "./prelude.js";
import { evalToJson, NON_SERIALIZABLE_MARKER, type SandboxLimits, type SandboxResult } from "./eval-core.js";
import type { Datastore } from "../providers/datastore/types.js";
import type { SecretsAccessor } from "../core/secrets.js";
import type { SharedDatastoreAccessor } from "../core/datastores.js";
import { boundedJson, boundedString } from "./bounded-json.js";
import { BRIDGE_INPUT_BYTES } from "./limits.js";
import type { Logger } from "../core/logger.js";

export type { SandboxErrorKind, SandboxLimits, SandboxResult } from "./eval-core.js";

export interface SandboxInvocation {
  /** The tool body source. Runs as an async function body receiving `params`. */
  code: string;
  params: unknown;
  agentId: string;
  datastore: Datastore;
  sharedDatastore: SharedDatastoreAccessor;
  /** Used only to tag forwarded console output and error messages. */
  toolName: string;
  /** Overrides the default limits (limits.ts) — mainly for fast, deterministic tests. */
  limits?: Partial<SandboxLimits>;
  /** Omitted for a dry run (no real agent) — secrets.get always resolves undefined. */
  secrets?: SecretsAccessor;
  /** Overrides the default shared logger — mainly for tests that need to capture forwarded console output. */
  logger?: Logger;
  /** Forwarded to installHostFunctions — which hosts this tool attachment may fetch. Omitted/empty = no outbound fetch at all; a literal "*" element lifts the restriction. */
  allowedFetchHosts?: string[];
}

export async function runInSandbox(invocation: SandboxInvocation): Promise<SandboxResult> {
  let params: string;
  try {
    boundedString(invocation.code, BRIDGE_INPUT_BYTES);
    params = boundedJson(invocation.params, BRIDGE_INPUT_BYTES);
  } catch {
    return { ok: false, errorKind: "memory", errorMessage: "Sandbox invocation input limit exceeded." };
  }
  // The final JSON.stringify is wrapped separately so a serialization
  // failure (e.g. a circular reference) is tagged distinctly from the tool
  // body itself throwing — both "fail cleanly", but the caller should be
  // able to tell "your tool has a bug" from "your tool's result can't
  // cross the boundary" apart.
  const code = `${SANDBOX_PRELUDE}
(async () => {
  const params = ${params};
  const __result = await (async (params) => {
    ${invocation.code}
  })(params);
  try {
    return JSON.stringify(__result === undefined ? null : __result);
  } catch (__serializeErr) {
    throw new Error("${NON_SERIALIZABLE_MARKER}" + (__serializeErr && __serializeErr.message));
  }
})()`;

  return evalToJson(code, invocation.limits, (context, runtime, signal) => {
    installHostFunctions(context, runtime, {
      agentId: invocation.agentId,
      datastore: invocation.datastore,
      sharedDatastore: invocation.sharedDatastore,
      logTag: invocation.toolName,
      secrets: invocation.secrets,
      logger: invocation.logger,
      allowedFetchHosts: invocation.allowedFetchHosts,
      signal,
    });
  });
}
