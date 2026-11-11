/**
 * The run hook dispatcher against real PostgreSQL and the real sandbox:
 * delivery with the hook's own secret and host, the final text masked by
 * exact value, capabilities withheld without the owner's consent, permanent
 * failures (params rejected, hook disabled), retries up to MAX_ATTEMPTS, and
 * error text masked before it is stored. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Datastore } from "../../providers/datastore/types.js";
import type { safeFetch } from "../../sandbox/safe-fetch.js";
import { createPrismaClient } from "../db.js";
import { MAX_ATTEMPTS } from "../notification-dispatcher.js";
import { attachSecret, createSecret } from "../secrets.js";
import { dispatchHooksOnce, RUN_HOOK_LEASE_SCOPE } from "./dispatcher.js";

const SECRET = "fake-hook-secret-value-9876";

describe.skipIf(!process.env.DATABASE_URL)("run hook dispatcher (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID();
  const id = (name: string) => `rhdisp-${name}-${s}`;
  const owner = id("owner");
  const agent = id("agent");
  const run = id("run");
  const toolOk = id("tool-ok");
  const toolThrows = id("tool-throws");
  // Hooks get no datastore (scoped to no prefixes): this one only has to exist.
  const datastore = {
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined,
    list: async () => [],
  } as unknown as Datastore;
  const calls: { url: string; body: unknown; policy: { allowedHosts?: string[]; restrictToAllowedHosts?: boolean } }[] =
    [];
  // A stand-in for safeFetch: it records the policy safeFetch would enforce.
  const fetchImpl = (async (url: string, init?: { body?: string }, policy?: never) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, policy: policy ?? {} });
    return { ok: true, status: 200, statusText: "OK", url, headers: {}, bodyBase64: "" };
  }) as unknown as typeof safeFetch;
  const rt = { db, secrets: cipher, datastore, fetchImpl, holder: id("holder") };

  const CONFIG_ZOD =
    "z.object({ event: z.object({ kind: z.string() }).passthrough(), config: z.object({ to: z.string() }) })";

  // Only this suite uses the run hook lease: a holder from an earlier run would keep it for its TTL.
  const clearLease = () => db.schedulerLease.deleteMany({ where: { scope: RUN_HOOK_LEASE_SCOPE } });

  beforeAll(async () => {
    await clearLease();
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.agent.create({
      data: { id: agent, name: agent, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner },
    });
    await createSecret(`HOOK_KEY_${s.slice(0, 8)}`, SECRET, owner, cipher, db);
    await attachSecret(agent, `HOOK_KEY_${s.slice(0, 8)}`, owner, db);
    await db.run.create({
      data: { id: run, agentId: agent, status: "succeeded", finalText: `Report. Leaked ${SECRET} in a quote.` },
    });
    await db.tool.create({
      data: {
        id: toolOk,
        name: toolOk,
        description: "t",
        paramsZod: CONFIG_ZOD,
        jsonSchema: {},
        ownerId: owner,
        code: `const key = await secrets.get('HOOK_KEY_${s.slice(0, 8)}');
const r = await fetch('https://hooks.example.test/in', { method: 'POST', body: JSON.stringify({ params, sawKey: key === ${JSON.stringify(SECRET)} }) });
return r.status;`,
      },
    });
    await db.tool.create({
      data: {
        id: toolThrows,
        name: toolThrows,
        description: "t",
        paramsZod: CONFIG_ZOD,
        jsonSchema: {},
        ownerId: owner,
        code: `throw new Error('upstream said ' + ${JSON.stringify(SECRET)});`,
      },
    });
  });

  afterAll(async () => {
    await clearLease();
    await db.workflowEvent.deleteMany({ where: { dedupeKey: { endsWith: `-${s}` } } });
    await db.runHook.deleteMany({ where: { agentId: agent } });
    await db.tool.deleteMany({ where: { id: { in: [toolOk, toolThrows] } } });
    await db.run.deleteMany({ where: { id: run } });
    await db.agentSecret.deleteMany({ where: { agentId: agent } });
    await db.secret.deleteMany({ where: { ownerId: owner } });
    await db.agent.deleteMany({ where: { id: agent } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  beforeEach(() => {
    calls.length = 0;
  });

  let n = 0;
  async function hookWithDelivery(over: Record<string, unknown> = {}) {
    n++;
    const hook = await db.runHook.create({
      data: {
        agentId: agent,
        toolId: toolOk,
        createdById: owner,
        config: { to: "ops@example.test" },
        allowedSecrets: [`HOOK_KEY_${s.slice(0, 8)}`],
        allowedHosts: ["hooks.example.test"],
        capabilitiesGrantedById: owner,
        ...over,
      },
    });
    const event = await db.workflowEvent.create({
      data: {
        kind: "run_completed",
        dedupeKey: `run_completed:${n}-${s}`,
        runId: run,
        agentId: agent,
        payload: { kind: "run_completed", status: "succeeded", agentName: "auditor" },
      },
    });
    const delivery = await db.runHookDelivery.create({ data: { eventId: event.id, hookId: hook.id } });
    return { hook, delivery };
  }
  const pass = (hookId: string) => dispatchHooksOnce({ ...rt, only: { hookIds: [hookId] } });
  const reload = (deliveryId: string) => db.runHookDelivery.findUniqueOrThrow({ where: { id: deliveryId } });

  it("delivers the event and config with the hook's secret and host, and the final text masked", async () => {
    const { hook, delivery } = await hookWithDelivery({ includeFinalText: true });
    expect(await pass(hook.id)).toBe(1);
    expect((await reload(delivery.id)).state).toBe("delivered");
    expect(calls).toHaveLength(1);
    const body = calls[0].body as { params: { event: Record<string, unknown>; config: unknown }; sawKey: boolean };
    expect(body.sawKey).toBe(true);
    expect(body.params.config).toEqual({ to: "ops@example.test" });
    expect(body.params.event).toMatchObject({
      schemaVersion: 1,
      kind: "run_completed",
      runId: run,
      agent: { id: agent, name: agent },
      data: { status: "succeeded" },
      finalTextTruncated: false,
    });
    expect(body.params.event.finalText).toBe("Report. Leaked [REDACTED] in a quote.");
  });

  it("sends no final text when the hook does not include it", async () => {
    const { hook } = await hookWithDelivery();
    await pass(hook.id);
    const body = calls[0].body as { params: { event: Record<string, unknown> } };
    expect(body.params.event).not.toHaveProperty("finalText");
  });

  it("withholds the hook's secrets and hosts without the agent owner's consent", async () => {
    const { hook } = await hookWithDelivery({ capabilitiesGrantedById: null });
    await pass(hook.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].policy).toMatchObject({ allowedHosts: [], restrictToAllowedHosts: true });
    expect((calls[0].body as { sawKey: boolean }).sawKey).toBe(false);
  });

  it("gives the hook only its own hosts with consent", async () => {
    const { hook } = await hookWithDelivery();
    await pass(hook.id);
    expect(calls[0].policy).toMatchObject({ allowedHosts: ["hooks.example.test"], restrictToAllowedHosts: true });
  });

  it("retries a failed call later with backoff", async () => {
    const { hook, delivery } = await hookWithDelivery({ toolId: toolThrows });
    await pass(hook.id);
    const row = await reload(delivery.id);
    expect(row.state).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("fails permanently when the tool's params schema rejects the event and config", async () => {
    const { hook, delivery } = await hookWithDelivery({ config: { wrong: true } });
    await pass(hook.id);
    const row = await reload(delivery.id);
    expect(row.state).toBe("failed");
    expect(row.lastError).toMatch(/^hook_params_rejected/);
    expect((await db.runHook.findUniqueOrThrow({ where: { id: hook.id } })).lastError).toMatch(/^hook_params_rejected/);
  });

  it("fails a delivery whose hook was turned off", async () => {
    const { hook, delivery } = await hookWithDelivery({ enabled: false });
    await pass(hook.id);
    expect(await reload(delivery.id)).toMatchObject({
      state: "failed",
      lastError: expect.stringMatching(/^hook_disabled/),
    });
  });

  it("masks a secret value in the tool's error before storing it, and fails after the last attempt", async () => {
    const { hook, delivery } = await hookWithDelivery({ toolId: toolThrows });
    await db.runHookDelivery.update({ where: { id: delivery.id }, data: { attempts: MAX_ATTEMPTS - 1 } });
    await pass(hook.id);
    const row = await reload(delivery.id);
    expect(row.state).toBe("failed");
    expect(row.lastError).toContain("[REDACTED]");
    expect(row.lastError).not.toContain(SECRET);
    const stored = await db.runHook.findUniqueOrThrow({ where: { id: hook.id } });
    expect(stored.lastError).not.toContain(SECRET);
  });
});
