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

  describe("extra repositories (#537)", () => {
    let linkCounter = 0;
    /** A deferred run with dispatch's unresolved rows: `base` from a ref file, `upstream` at main. */
    async function runWithRepositories() {
      const run = await unresolvedRun();
      const n = ++linkCounter;
      const link = (name: string, extra: Record<string, unknown>) =>
        db.agentRepository.create({
          data: {
            agentId,
            name: `${name}-${n}`,
            provider: "github",
            repository: `acme/${name}-${suffix}-${n}`,
            access: "read",
            authorizedVia: "admin",
            ...extra,
          },
        });
      const base = await link("base", { refFromFile: "upstream-sync" });
      const upstream = await link("upstream", { ref: "main" });
      const row = (position: number, l: typeof base, requestedRef: string | null) => ({
        runId: run.id,
        position,
        name: l.name,
        access: "read",
        provider: "github",
        repository: l.repository,
        requestedRef,
        refFromFile: l.refFromFile,
        resolvedSha: null,
        linkId: l.id,
      });
      await db.codingRunRepository.createMany({ data: [row(0, base, null), row(1, upstream, "main")] });
      return run;
    }
    function repositoryExecutor(refFile: string | null) {
      const { executor, spies } = fakeExecutor();
      const authorizeCodingRepository = vi.fn(async () => ({ ok: true as const }));
      const resolveCodingRepositoryRef = vi.fn(async ({ ref }: { ref: string }) =>
        ref === "main" ? "d".repeat(40) : /^[0-9a-f]{40}$/.test(ref) ? ref : null,
      );
      executor.authorizeCodingRepository = authorizeCodingRepository;
      executor.resolveCodingRepositoryRef = resolveCodingRepositoryRef;
      spies.readCodingRepositoryFile.mockImplementation((async ({ path }: { path: string }) =>
        path === "upstream-sync" ? refFile : INDEX) as never);
      return { executor, spies, authorizeCodingRepository, resolveCodingRepositoryRef };
    }
    const rowsOf = (runId: string) =>
      db.codingRunRepository.findMany({ where: { runId }, orderBy: { position: "asc" } });

    it("fills each row's requested ref and commit when the run starts", async () => {
      const run = await runWithRepositories();
      const { executor, spies } = repositoryExecutor(`${"c".repeat(40)}\n`);

      await expect(resolveDeferredCodingRun({ db, executor, runId: run.id })).resolves.toBe(true);

      expect(spies.readCodingRepositoryFile).toHaveBeenCalledWith(
        expect.objectContaining({ repository: "openai/example", baseRef: "main", path: "upstream-sync" }),
      );
      expect(await rowsOf(run.id)).toEqual([
        expect.objectContaining({ requestedRef: "c".repeat(40), resolvedSha: "c".repeat(40) }),
        expect.objectContaining({ requestedRef: "main", resolvedSha: "d".repeat(40) }),
      ]);
      expect((await codingRunOf(run.id)).workerImage).toBe(WORKER);
    });

    it("refuses the run when a ref file is unreadable, naming its path only", async () => {
      const run = await runWithRepositories();
      const { executor } = repositoryExecutor("not a ref\n");

      await expect(resolveDeferredCodingRun({ db, executor, runId: run.id })).resolves.toBe(false);

      const refused = await runOf(run.id);
      expect(refused.status).toBe("refused");
      expect(refused.error).toMatch(
        /^repository_ref_unreadable: the ref file upstream-sync for link "base-\d+" is not/,
      );
      expect(refused.error).not.toContain("not a ref");
      expect((await codingRunOf(run.id)).workerImage).toBeNull();
    });

    it("refuses the run when a row is not authorized, before resolving any ref", async () => {
      const run = await runWithRepositories();
      const { executor, spies, authorizeCodingRepository, resolveCodingRepositoryRef } = repositoryExecutor(
        "c".repeat(40),
      );
      authorizeCodingRepository.mockResolvedValue({ ok: false, reason: "github_account_not_allowed" } as never);

      await expect(resolveDeferredCodingRun({ db, executor, runId: run.id })).resolves.toBe(false);

      expect((await runOf(run.id)).error).toMatch(/^repo_access_github_account_not_allowed: /);
      expect(resolveCodingRepositoryRef).not.toHaveBeenCalled();
      expect(spies.readCodingRepositoryFile).not.toHaveBeenCalledWith(
        expect.objectContaining({ path: "upstream-sync" }),
      );
    });

    it.each([
      ["cannot authorize extra repositories", "authorizeCodingRepository"],
      ["cannot resolve their refs", "resolveCodingRepositoryRef"],
    ] as const)("refuses the run, not fails it, when the executor %s", async (_label, missing) => {
      const run = await runWithRepositories();
      const { executor } = repositoryExecutor(`${"c".repeat(40)}\n`);
      delete executor[missing];

      await expect(resolveDeferredCodingRun({ db, executor, runId: run.id })).resolves.toBe(false);

      expect(await runOf(run.id)).toMatchObject({
        status: "refused",
        error: "coding_repositories_unsupported: this deployment cannot resolve extra repositories.",
      });
      expect((await codingRunOf(run.id)).workerImage).toBeNull();
    });
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
