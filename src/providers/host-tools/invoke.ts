/**
 * Runs one approved snapshot of a bound tool with a restricted privileged host: fetch
 * reaches the provider's API hosts inside this call's repository, using the operation's
 * methods, with no redirects followed and only plain content headers, and the only secret alias is `host`. Datastores and readable secrets are
 * absent, and console output is dropped. Never throws: every failure is a fixed code,
 * so no tool text reaches a model, a run record or a published comment.
 */
import type { SandboxLimits } from "../../sandbox/eval-core.js";
import { createPrivilegedHost, type HostBridge, type PrivilegedHost } from "../../sandbox/host-functions.js";
import { runToolCode } from "../../sandbox/run-in-sandbox.js";
import { safeFetch } from "../../sandbox/safe-fetch.js";
import { validateParams } from "../../sandbox/zod-params.js";
import type { Datastore } from "../datastore/types.js";
import type { SharedDatastoreAccessor } from "../../core/datastores.js";
import type { SecretEntry } from "../../core/secrets.js";
import {
  HOST_OPERATIONS,
  HOST_TOOL_DECLINE_CODES,
  type HostOperation,
  type HostToolDeclineCode,
} from "./operations.js";
import {
  assertHostToolHeaders,
  assertHostToolRequest,
  HostToolRequestDenied,
  MAX_HOST_TOOL_FETCHES,
} from "./request-guard.js";

export const HOST_SECRET_ALIAS = "host";

export type HostToolErrorCode =
  | "host_tool_failed"
  | "host_tool_timeout"
  | "host_tool_invalid_result"
  | "host_tool_invalid_params"
  | "host_tool_request_denied"
  | "host_tool_no_credential"
  | `host_${HostToolDeclineCode}`;

export type HostToolResult = { ok: true; value: unknown } | { ok: false; code: HostToolErrorCode };

export interface HostToolInvocation {
  provider: string;
  operation: HostOperation;
  snapshot: { code: string; paramsZod: string };
  params: Record<string, unknown>;
  apiHosts: readonly string[];
  pathPrefix: string;
  credential: () => Promise<SecretEntry | undefined>;
  fetchImpl?: typeof safeFetch;
  limits?: Partial<SandboxLimits>;
}

const absent: HostBridge = async () => {
  throw new Error("host_tool_capability_absent");
};

export async function invokeHostTool(input: HostToolInvocation): Promise<HostToolResult> {
  const definition = HOST_OPERATIONS[input.operation];
  const failures = { denied: false, noCredential: false };

  const validated = await validateParams(input.snapshot.paramsZod, input.params);
  if (!validated.ok) return { ok: false, code: "host_tool_invalid_params" };

  const privileged = (signal: AbortSignal): PrivilegedHost => {
    const inner = createPrivilegedHost({
      agentId: `host-provider:${input.provider}`,
      // Never reached: every bridge that would use them is `absent` below.
      datastore: {} as Datastore,
      sharedDatastore: {} as SharedDatastoreAccessor,
      logTag: `host-tool:${input.operation}`,
      allowedFetchHosts: [...input.apiHosts],
      // Redirects are never followed here: a later hop would skip the guard, so the tool re-fetches through it.
      fetchImpl: (u, i, o) => (input.fetchImpl ?? safeFetch)(u, i, { ...o, followRedirects: false }),
      signal,
      secrets: {
        get: async () => undefined,
        resolve: async (name) => {
          if (name !== HOST_SECRET_ALIAS) return undefined;
          let entry: SecretEntry | undefined;
          try {
            entry = await input.credential();
          } catch {
            entry = undefined;
          }
          // A thrown or partial credential must not carry its text into tool code.
          if (!entry || !entry.broker) {
            failures.noCredential = true;
            throw new Error("host_tool_no_credential");
          }
          return entry;
        },
      },
    });
    let fetches = 0;
    return {
      __bridge_console: async () => null,
      __bridge_fetch: async (argsJson) => {
        try {
          const [url, init, secretNames] = JSON.parse(argsJson) as [
            string,
            { method?: string; headers?: unknown }?,
            unknown?,
          ];
          if (++fetches > MAX_HOST_TOOL_FETCHES) throw new HostToolRequestDenied();
          if (
            secretNames !== undefined &&
            !(Array.isArray(secretNames) && secretNames.every((n) => n === HOST_SECRET_ALIAS))
          ) {
            throw new HostToolRequestDenied();
          }
          assertHostToolHeaders(init?.headers);
          assertHostToolRequest(url, init?.method ?? "GET", {
            apiHosts: input.apiHosts,
            pathPrefix: input.pathPrefix,
            methods: definition.methods,
          });
        } catch (err) {
          failures.denied = true;
          throw err;
        }
        return inner.__bridge_fetch(argsJson);
      },
      __bridge_datastoreGet: absent,
      __bridge_datastoreSet: absent,
      __bridge_datastoreDelete: absent,
      __bridge_datastoreList: absent,
      __bridge_sharedDatastoreGet: absent,
      __bridge_sharedDatastoreSet: absent,
      __bridge_sharedDatastoreDelete: absent,
      __bridge_sharedDatastoreList: absent,
      __bridge_secretsGet: absent,
    };
  };

  const result = await runToolCode({
    code: input.snapshot.code,
    params: validated.value,
    limits: input.limits,
    privileged,
  });

  // Checked first: a tool that catches a refusal must not turn it into a success.
  if (failures.denied) return { ok: false, code: "host_tool_request_denied" };
  if (failures.noCredential) return { ok: false, code: "host_tool_no_credential" };
  if (!result.ok) {
    return {
      ok: false,
      code: result.errorKind === "timeout" || result.errorKind === "cpu" ? "host_tool_timeout" : "host_tool_failed",
    };
  }
  const decline = declineOf(result.value);
  if (decline) return { ok: false, code: `host_${decline}` };
  const parsed = definition.result.safeParse(result.value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, code: "host_tool_invalid_result" };
}

function declineOf(value: unknown): HostToolDeclineCode | null {
  if (typeof value !== "object" || value === null || !("error" in value)) return null;
  const { error } = value;
  return (HOST_TOOL_DECLINE_CODES as readonly unknown[]).includes(error) ? (error as HostToolDeclineCode) : null;
}
