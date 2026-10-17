/**
 * Resolving a gateway-dispatched coding run when the control plane starts it, against real
 * PostgreSQL (the built-in service catalog is seeded by migration). The executor is a fake.
 * Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_CODING_TASK_BYTES } from "../coding/protocol.js";
import { BUILTIN_CODING_SERVICES } from "../coding/services/builtins.js";
import { resolvedFromDefinition } from "../coding/services/catalog.js";
import { SERVICE_INSTRUCTIONS_TOO_LARGE_SENTENCE } from "../coding/services/wording.js";
import type { Executor } from "../providers/executor/types.js";
import { createPrismaClient } from "./db.js";
import { resolveDeferredCodingRun } from "./deferred-coding.js";

const WORKER = `img@sha256:${"a".repeat(64)}`;
const TOOL = `tool@sha256:${"b".repeat(64)}`;
const DECLARATION = 'services:\n  postgres: "16"\n';
const INDEX = "# Knowledge index\n- runs.md: how runs start\n";
const POSTGRES_16 = BUILTIN_CODING_SERVICES.find((s) => s.name === "postgres" && s.version === "16")!;

describe.skipIf(!process.env.DATABASE_URL)("resolveDeferredCodingRun (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID().slice(0, 8);
  const agentId = `defcode-agent-${suffix}`;
  const nativeAgentId = `defcode-native-${suffix}`;
  const noServicesAgentId = `defcode-noservices-${suffix}`;

  beforeAll(async () => {
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        kind: "coding",
        systemPrompt: "Run the tests first.",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        codingProfile: {
          create: { repository: "openai/example", protectedPaths: ["CODEOWNERS"], services: ["postgres"] },
        },
      },
    });
    await db.agent.create({
      data: {
        id: noServicesAgentId,
        name: noServicesAgentId,
        kind: "coding",
        systemPrompt: "No services.",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        codingProfile: { create: { repository: "openai/example", protectedPaths: ["CODEOWNERS"], services: [] } },
      },
    });
    await db.agent.create({
      data: { id: nativeAgentId, name: nativeAgentId, systemPrompt: "s", model: "m", budgetUsd: 1 },
    });
  });
  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId: { in: [agentId, nativeAgentId, noServicesAgentId] } } });
    await db.agent.deleteMany({ where: { id: { in: [agentId, nativeAgentId, noServicesAgentId] } } });
    await db.$disconnect();
  });

  /** A pending run as the gateway's dispatch records it: images null, no services, the raw request. */
  async function unresolvedRun(task = "Add 20 jokes", workerImage: string | null = null, forAgent = agentId) {
    const run = await db.run.create({
      data: { agentId: forAgent, executionManaged: true, startDeferredAt: new Date() },
    });
    await db.codingRun.create({
      data: {
        runId: run.id,
        task,
        request: task,
        repository: "openai/example",
        baseRef: "main",
        headRef: `wardby/run-${run.id}`,
        provider: "codex",
        model: "gpt-5.6-luna",
        timeoutSec: 900,
        protectedPaths: ["CODEOWNERS"],
        budgetReservedUsd: 1,
        workerImage,
        toolImage: null,
        services: [],
      },
    });
    return run;
  }

  function fakeExecutor(declaration: string | null = DECLARATION) {
    const spies = {
      resolveCodingWorkerImage: vi.fn(() => WORKER),
      resolveCodingToolImage: vi.fn(() => TOOL),
      readCodingRepositoryFile: vi.fn(async () => INDEX),
      readCodingServiceDeclaration: vi.fn(async () => declaration),
    };
    const executor: Executor = {
      start: vi.fn(async () => {}),
      async stop() {},
      supportsCodingServices: () => true,
      ...spies,
    };
    return { executor, spies };
  }

  const codingRunOf = (runId: string) => db.codingRun.findUniqueOrThrow({ where: { runId } });
  const runOf = (runId: string) => db.run.findUniqueOrThrow({ where: { id: runId } });

  it("resolves the images, services, and composed task, and lets the run start", async () => {
    const run = await unresolvedRun();
    const { executor, spies } = fakeExecutor();

    await expect(resolveDeferredCodingRun({ db, executor, runId: run.id })).resolves.toBe(true);

    expect(spies.readCodingServiceDeclaration).toHaveBeenCalledWith({ repository: "openai/example", baseRef: "main" });
    const coding = await codingRunOf(run.id);
    expect(coding).toMatchObject({ workerImage: WORKER, toolImage: TOOL });
    expect(coding.services).toEqual([resolvedFromDefinition(POSTGRES_16)]);
    expect(coding.task).toMatch(/^Standing instructions for this coding agent:\nRun the tests first\./);
    expect(coding.task).toContain("Services for this run:");
    expect(coding.task).toMatch(/\n- postgres 16: .*DATABASE_URL=postgres:\/\/test:test@127\.0\.0\.1:5432\/test/);
    expect(coding.task).toContain("Architecture knowledge for this repository");
    expect(coding.task).toContain("- runs.md: how runs start");
    expect(coding.task).toMatch(/\n\nRequest:\nAdd 20 jokes$/);
    expect(coding.request).toBe("Add 20 jokes");
    expect((await runOf(run.id)).status).toBe("pending");
  });

  it("leaves an already-resolved coding run alone", async () => {
    const run = await unresolvedRun("Already composed", WORKER);
    const { executor, spies } = fakeExecutor();

    await expect(resolveDeferredCodingRun({ db, executor, runId: run.id })).resolves.toBe(true);

    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    expect(await codingRunOf(run.id)).toMatchObject({ task: "Already composed", toolImage: null, services: [] });
  });

  it("starts a native run without reading anything", async () => {
    const run = await db.run.create({
      data: { agentId: nativeAgentId, executionManaged: true, startDeferredAt: new Date() },
    });
    const { executor, spies } = fakeExecutor();

    await expect(resolveDeferredCodingRun({ db, executor, runId: run.id })).resolves.toBe(true);

    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  it("never reads the declaration for a profile that allows no services", async () => {
    const run = await unresolvedRun("Add 20 jokes", null, noServicesAgentId);
    const { executor, spies } = fakeExecutor();

    await expect(resolveDeferredCodingRun({ db, executor, runId: run.id })).resolves.toBe(true);

    expect(spies.readCodingServiceDeclaration).not.toHaveBeenCalled();
    expect(await codingRunOf(run.id)).toMatchObject({ workerImage: WORKER, services: [] });
  });

  it("refuses over services before an image fault is raised, as dispatch orders them", async () => {
    const run = await unresolvedRun();
    const { executor } = fakeExecutor('services:\n  postgres: "99"\n');
    executor.resolveCodingWorkerImage = () => {
      throw new Error("coding_worker_image_invalid");
    };

    await expect(resolveDeferredCodingRun({ db, executor, runId: run.id })).resolves.toBe(false);

    expect(await runOf(run.id)).toMatchObject({ status: "refused" });
  });

  it("propagates an image resolution failure, leaving the run for the drain to fail", async () => {
    const run = await unresolvedRun();
    const { executor } = fakeExecutor();
    executor.resolveCodingWorkerImage = () => {
      throw new Error("coding_worker_image_invalid");
    };

    await expect(resolveDeferredCodingRun({ db, executor, runId: run.id })).rejects.toThrow(
      "coding_worker_image_invalid",
    );
    expect((await codingRunOf(run.id)).workerImage).toBeNull();
  });

  it.each([
    ["names a service the catalog lacks", 'services:\n  postgres: "99"\n', /^service_unknown: /],
    ["is not a valid declaration", "services: [", /^service_declaration_invalid: /],
  ])("refuses the run when the declaration %s", async (_label, declaration, error) => {
    const run = await unresolvedRun();
    const { executor } = fakeExecutor(declaration);

    await expect(resolveDeferredCodingRun({ db, executor, runId: run.id })).resolves.toBe(false);

    const refused = await runOf(run.id);
    expect(refused.status).toBe("refused");
    expect(refused.error).toMatch(error);
    expect(refused.finishedAt).toBeInstanceOf(Date);
    expect(await codingRunOf(run.id)).toMatchObject({ workerImage: null, toolImage: null, task: "Add 20 jokes" });
  });

  it("refuses the run, as dispatch does, when the services note no longer fits the task limit", async () => {
    // Fits at dispatch (instructions + request); the services note added at start pushes it over.
    const request = "x".repeat(MAX_CODING_TASK_BYTES - 200);
    const run = await unresolvedRun(request);
    const { executor } = fakeExecutor();

    await expect(resolveDeferredCodingRun({ db, executor, runId: run.id })).resolves.toBe(false);

    expect(await runOf(run.id)).toMatchObject({
      status: "refused",
      error: `service_declaration_invalid: ${SERVICE_INSTRUCTIONS_TOO_LARGE_SENTENCE}`,
    });
    expect((await codingRunOf(run.id)).workerImage).toBeNull();
  });

  it("does not refuse a run that is no longer pending", async () => {
    const run = await unresolvedRun();
    await db.run.update({ where: { id: run.id }, data: { status: "cancelled", error: "stopped" } });
    const { executor } = fakeExecutor('services:\n  postgres: "99"\n');

    await expect(resolveDeferredCodingRun({ db, executor, runId: run.id })).resolves.toBe(false);

    expect(await runOf(run.id)).toMatchObject({ status: "cancelled", error: "stopped" });
  });

  it("writes the coding run once when two starts race", async () => {
    const run = await unresolvedRun();
    const { executor } = fakeExecutor();
    const updateMany = vi.spyOn(db.codingRun, "updateMany");
    try {
      const results = await Promise.all([
        resolveDeferredCodingRun({ db, executor, runId: run.id }),
        resolveDeferredCodingRun({ db, executor, runId: run.id }),
      ]);
      expect(results).toEqual([true, true]);
      const counts = await Promise.all(updateMany.mock.results.map((r) => r.value as Promise<{ count: number }>));
      expect(counts.reduce((sum, { count }) => sum + count, 0)).toBe(1);
    } finally {
      updateMany.mockRestore();
    }
    const coding = await codingRunOf(run.id);
    expect(coding.workerImage).toBe(WORKER);
    expect(coding.task.match(/\n\nRequest:\n/g)).toHaveLength(1);
  });
});
