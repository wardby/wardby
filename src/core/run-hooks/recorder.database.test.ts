/**
 * Run hook fan-out against real PostgreSQL: the recorder writes one
 * RunHookDelivery per matching enabled hook, records an event that only a
 * hook takes (no Slack provider or channel), never gives Slack channels
 * run_completed, and pruning keeps an event with a pending hook delivery.
 * Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { pruneWorkflowEvents } from "../notification-dispatcher.js";
import { createWorkflowEventRecorder } from "../workflow-event-recorder.js";
import type { RunCompletedPayload } from "../workflow-events.js";

describe.skipIf(!process.env.DATABASE_URL)("run hook recorder (database)", () => {
  const db = createPrismaClient();
  const s = randomUUID();
  const id = (name: string) => `rhrec-${name}-${s}`;
  const owner = id("owner");
  const agent = id("agent");
  const tool = id("tool");
  const tag = s.replace(/-/g, "").slice(0, 12).toUpperCase();
  const channel = `CRH${tag}`;
  const hooks = { all: id("hook-all"), failedOnly: id("hook-failed"), prOnly: id("hook-pr"), off: id("hook-off") };

  const completed = (over: Partial<RunCompletedPayload> = {}): RunCompletedPayload => ({
    kind: "run_completed",
    agentName: "a",
    status: "succeeded",
    trigger: "scheduled",
    parentRunId: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    costUsd: "0.1",
    reason: null,
    pullRequests: [],
    ...over,
  });

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.agent.create({
      data: { id: agent, name: agent, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner },
    });
    await db.tool.create({
      data: { id: tool, name: tool, description: "t", paramsZod: "z.any()", jsonSchema: {}, code: "1", ownerId: owner },
    });
    const base = { agentId: agent, toolId: tool, createdById: owner };
    await db.runHook.createMany({
      data: [
        { ...base, id: hooks.all },
        { ...base, id: hooks.failedOnly, events: ["run_completed"], statuses: ["failed"] },
        { ...base, id: hooks.prOnly, events: ["pr_opened"] },
        { ...base, id: hooks.off, enabled: false },
      ],
    });
    await db.notificationChannel.create({
      data: { provider: "slack", channelId: channel, agentId: agent, authorizedById: owner },
    });
  });

  afterAll(async () => {
    await db.workflowEvent.deleteMany({ where: { dedupeKey: { endsWith: `-${s}` } } });
    await db.runHook.deleteMany({ where: { agentId: agent } });
    await db.notificationChannel.deleteMany({ where: { agentId: agent } });
    await db.tool.deleteMany({ where: { id: tool } });
    await db.agent.deleteMany({ where: { id: agent } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  const deliveriesOf = async (dedupeKey: string) => {
    const event = await db.workflowEvent.findUnique({
      where: { dedupeKey },
      include: { deliveries: true, hookDeliveries: true },
    });
    return {
      event,
      hooks: (event?.hookDeliveries ?? []).map((d) => d.hookId).sort(),
      channels: (event?.deliveries ?? []).map((d) => d.channelId),
    };
  };

  it("gives run_completed to the matching enabled hooks and never to a Slack channel", async () => {
    const key = `run_completed:ok-${s}`;
    await createWorkflowEventRecorder(db, ["slack"])({ dedupeKey: key, agentId: agent, payload: completed() });
    const got = await deliveriesOf(key);
    expect(got.hooks).toEqual([hooks.all]);
    expect(got.channels).toEqual([]);
  });

  it("filters run_completed by status", async () => {
    const key = `run_completed:failed-${s}`;
    await createWorkflowEventRecorder(db, ["slack"])({
      dedupeKey: key,
      agentId: agent,
      payload: completed({ status: "failed" }),
    });
    expect((await deliveriesOf(key)).hooks).toEqual([hooks.all, hooks.failedOnly].sort());
  });

  it("records an event only a hook takes when no chat provider is configured", async () => {
    const key = `pr_opened:hook-only-${s}`;
    await createWorkflowEventRecorder(
      db,
      [],
    )({
      dedupeKey: key,
      agentId: agent,
      payload: { kind: "pr_opened", prLabel: "o/r#1", prUrl: "https://github.com/o/r/pull/1", movedTo: null },
    });
    const got = await deliveriesOf(key);
    expect(got.hooks).toEqual([hooks.all, hooks.prOnly].sort());
    expect(got.channels).toEqual([]);
  });

  it("still gives Slack its delivery alongside the hooks", async () => {
    const key = `pr_opened:both-${s}`;
    await createWorkflowEventRecorder(db, ["slack"])({
      dedupeKey: key,
      agentId: agent,
      pullRequest: { codeProvider: "github", repository: `o-${s}/r`, number: 2 },
      payload: { kind: "pr_opened", prLabel: "o/r#2", prUrl: "https://github.com/o/r/pull/2", movedTo: null },
    });
    const got = await deliveriesOf(key);
    expect(got.channels).toEqual([channel]);
    expect(got.hooks).toEqual([hooks.all, hooks.prOnly].sort());
  });

  it("records a fact once", async () => {
    const key = `run_completed:dedupe-${s}`;
    const recorder = createWorkflowEventRecorder(db, []);
    await recorder({ dedupeKey: key, agentId: agent, payload: completed() });
    await recorder({ dedupeKey: key, agentId: agent, payload: completed() });
    expect((await deliveriesOf(key)).hooks).toEqual([hooks.all]);
  });

  it("pruning keeps an old event while a hook delivery is pending", async () => {
    const key = `run_completed:prune-${s}`;
    await createWorkflowEventRecorder(db, [])({ dedupeKey: key, agentId: agent, payload: completed() });
    const { event } = await deliveriesOf(key);
    await db.workflowEvent.update({ where: { id: event!.id }, data: { createdAt: new Date("2020-01-01") } });
    const only = { id: event!.id };
    await pruneWorkflowEvents(db, new Date(), 30, only);
    expect(await db.workflowEvent.findUnique({ where: { id: event!.id } })).not.toBeNull();
    await db.runHookDelivery.updateMany({ where: { eventId: event!.id }, data: { state: "delivered" } });
    await pruneWorkflowEvents(db, new Date(), 30, only);
    expect(await db.workflowEvent.findUnique({ where: { id: event!.id } })).toBeNull();
  });
});
