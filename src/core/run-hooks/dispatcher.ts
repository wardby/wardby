/**
 * Delivers run hooks: a lease-gated loop (one sender across replicas) picks
 * due RunHookDelivery rows, builds the tool's `{ event, config }`, and runs
 * the hook's tool in the sandbox with the hook's own secrets and hosts —
 * only while the agent's current owner granted them, as for an attached
 * tool. The tool's return value is discarded: a hook is outbound only.
 *
 * Secrets: the final text (only for a hook with includeFinalText) and every
 * error text are masked by exact value against all of the agent's secret
 * values before they reach the tool, a row, a log, or an MCP reply. If those
 * values can't be read, the delivery waits and retries rather than sending
 * unmasked text.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "#prisma";
import { loadToolMaxTimeoutMs } from "../../config/tool-timeout.js";
import { scopeDatastore } from "../../providers/datastore/scoped.js";
import type { Datastore } from "../../providers/datastore/types.js";
import type { SecretCipher } from "../../providers/secrets/types.js";
import { runInSandbox } from "../../sandbox/run-in-sandbox.js";
import type { safeFetch } from "../../sandbox/safe-fetch.js";
import { effectiveToolTimeoutMs } from "../../sandbox/tool-timeout.js";
import { validateParams } from "../../sandbox/zod-params.js";
import { buildSharedDatastoreAccessor, scopeSharedDatastoreAccessor } from "../datastores.js";
import { tryAcquireLease } from "../lease.js";
import { logger } from "../logger.js";
import { backoffMs, MAX_ATTEMPTS } from "../notification-dispatcher.js";
import { loadAgentSecretValues } from "../secret-guard.js";
import { redactExactSecretValues } from "../secret-spans.js";
import { buildSecretsAccessor, scopeSecretsAccessor } from "../secrets.js";
import { buildHookEvent, hookFinalText, type HookEventRow } from "./params.js";

const log = logger.child({ module: "run-hooks" });

export const RUN_HOOK_LEASE_SCOPE = "run-hook-dispatch";
const LEASE_TTL_MS = 30_000;
const PASS_BUDGET_MS = 20_000;
const BATCH = 50;
/** The most characters of an error kept on a row or returned. */
export const MAX_HOOK_ERROR_CHARS = 500;

export interface RunHookRuntime {
  db: PrismaClient;
  secrets: SecretCipher;
  datastore: Datastore;
  /** Overrides the sandbox's outbound network call — tests only. */
  fetchImpl?: typeof safeFetch;
}

export interface HookRow {
  id: string;
  enabled: boolean;
  includeFinalText: boolean;
  config: unknown;
  allowedSecrets: unknown;
  allowedHosts: unknown;
  capabilitiesGrantedById: string | null;
}
export interface HookToolRow {
  name: string;
  code: string;
  paramsZod: string;
  timeoutMs: number | null;
}
export interface HookAgentRow {
  id: string;
  name: string;
  ownerId: string | null;
}

export type HookCallResult = { ok: true } | { ok: false; permanent: boolean; error: string };

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Runs one hook's tool for one event. Never throws; every error it returns is masked and bounded. */
export async function callRunHook(
  rt: RunHookRuntime,
  input: {
    hook: HookRow;
    tool: HookToolRow;
    agent: HookAgentRow;
    event: HookEventRow;
    /** test_run_hook: the synthetic event's placeholder final text. */
    testFinalText?: string;
  },
): Promise<HookCallResult> {
  const { hook, tool, agent, event } = input;
  let values: string[];
  try {
    values = (await loadAgentSecretValues(rt.db, rt.secrets, agent.id)).flatMap((e) => e.values);
  } catch {
    return {
      ok: false,
      permanent: false,
      error: "secret_values_unavailable: the agent's secret values could not be read",
    };
  }
  const mask = (text: string) => redactExactSecretValues(text, values).slice(0, MAX_HOOK_ERROR_CHARS);
  try {
    let finalText: { finalText: string | null; finalTextTruncated: boolean } | undefined;
    if (hook.includeFinalText) {
      const text =
        input.testFinalText ??
        (event.runId
          ? ((await rt.db.run.findUnique({ where: { id: event.runId }, select: { finalText: true } }))?.finalText ??
            null)
          : null);
      finalText = hookFinalText(text, values);
    }
    const params = {
      event: buildHookEvent(event, { id: agent.id, name: agent.name }, finalText, input.testFinalText !== undefined),
      config: hook.config && typeof hook.config === "object" ? hook.config : {},
    };
    const validated = await validateParams(tool.paramsZod, params);
    if (!validated.ok) {
      return { ok: false, permanent: true, error: mask(`hook_params_rejected: ${validated.errorMessage}`) };
    }
    const consented = agent.ownerId !== null && hook.capabilitiesGrantedById === agent.ownerId;
    const result = await runInSandbox({
      code: tool.code,
      params: validated.value,
      agentId: agent.id,
      // Hooks get no datastore: they deliver an event, they don't keep state.
      datastore: scopeDatastore(rt.datastore, []),
      sharedDatastore: scopeSharedDatastoreAccessor(buildSharedDatastoreAccessor(agent.id, rt.datastore, rt.db), {}),
      toolName: tool.name,
      allowedFetchHosts: consented ? strings(hook.allowedHosts) : [],
      secrets: scopeSecretsAccessor(
        buildSecretsAccessor(agent.id, rt.secrets, rt.db),
        consented ? strings(hook.allowedSecrets) : [],
      ),
      timeoutMs: effectiveToolTimeoutMs(tool.timeoutMs ?? undefined, loadToolMaxTimeoutMs()),
      ...(rt.fetchImpl ? { fetchImpl: rt.fetchImpl } : {}),
    });
    if (result.ok) return { ok: true };
    return { ok: false, permanent: false, error: mask(`${result.errorKind}: ${result.errorMessage}`) };
  } catch (err) {
    return {
      ok: false,
      permanent: false,
      error: mask(`hook_failed: ${err instanceof Error ? err.message : String(err)}`),
    };
  }
}

/** One delivery pass. Returns how many deliveries it attempted. */
export async function dispatchHooksOnce(
  deps: RunHookRuntime & { holder: string; now?: () => Date; only?: { hookIds?: string[] } },
): Promise<number> {
  const clock = deps.now ?? (() => new Date());
  const start = clock();
  const { db } = deps;
  if (!(await tryAcquireLease(db, RUN_HOOK_LEASE_SCOPE, deps.holder, LEASE_TTL_MS))) return 0;
  const due = await db.runHookDelivery.findMany({
    where: {
      state: "pending",
      nextAttemptAt: { lte: start },
      ...(deps.only?.hookIds ? { hookId: { in: deps.only.hookIds } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: BATCH,
    include: {
      event: true,
      hook: {
        include: {
          tool: { select: { name: true, code: true, paramsZod: true, timeoutMs: true } },
          agent: { select: { id: true, name: true, ownerId: true } },
        },
      },
    },
  });
  let attempted = 0;
  for (const d of due) {
    if (attempted > 0 && clock().getTime() - start.getTime() >= PASS_BUDGET_MS) break;
    if (!(await tryAcquireLease(db, RUN_HOOK_LEASE_SCOPE, deps.holder, LEASE_TTL_MS))) {
      log.warn({ holder: deps.holder }, "lost the run hook lease mid-pass; stopping");
      break;
    }
    attempted++;
    const now = clock();
    const outcome: HookCallResult = d.hook.enabled
      ? await callRunHook(deps, { hook: d.hook, tool: d.hook.tool, agent: d.hook.agent, event: d.event })
      : { ok: false, permanent: true, error: "hook_disabled: the hook was turned off before this event was delivered" };
    const attempts = d.attempts + 1;
    if (outcome.ok) {
      await db.runHookDelivery.update({
        where: { id: d.id },
        data: { state: "delivered", attempts, deliveredAt: now, lastError: null },
      });
      continue;
    }
    const failed = outcome.permanent || attempts >= MAX_ATTEMPTS;
    await db.runHookDelivery.update({
      where: { id: d.id },
      data: {
        attempts,
        lastError: outcome.error,
        ...(failed ? { state: "failed" } : { nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)) }),
      },
    });
    if (failed) {
      await db.runHook.update({ where: { id: d.hookId }, data: { lastError: outcome.error, lastErrorAt: now } });
    }
    // The error is already masked and bounded; ids only otherwise.
    log.warn(
      { hookId: d.hookId, deliveryId: d.id, attempts, failed, error: outcome.error },
      "run hook delivery failed",
    );
  }
  return attempted;
}

export interface RunHookDispatcherHandle {
  stop(): void;
}

/** Starts the delivery loop (every replica; the lease elects one sender). */
export function startRunHookDispatcher(
  deps: RunHookRuntime & { holder?: string; intervalMs?: number },
): RunHookDispatcherHandle {
  const holder = deps.holder ?? `run-hooks-${randomUUID()}`;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void dispatchHooksOnce({ ...deps, holder })
      .catch((err: unknown) => log.warn({ err }, "run hook dispatch pass failed"))
      .finally(() => {
        running = false;
      });
  }, deps.intervalMs ?? 2000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
