import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "../../core/db.js";
import type { SecretVersion } from "../../core/secret-versions.js";
import { PlanFilesRecorder } from "./recorder.js";
import { loadPlanFiles } from "./store.js";

/** Every line the shared logger receives (the container.test.ts `logged` pattern): proves no content is logged. */
const logged = vi.hoisted(() => [] as { level: string; payload: Record<string, unknown>; message: string }[]);
vi.mock("../../core/logger.js", () => {
  const make = (): Record<string, unknown> => {
    const at =
      (level: string) =>
      (payload: Record<string, unknown>, message?: string): void => {
        logged.push({ level, payload, message: message ?? "" });
      };
    return {
      child: () => make(),
      trace: at("trace"),
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
      fatal: at("fatal"),
    };
  };
  return { logger: make() };
});
beforeEach(() => {
  logged.length = 0;
});

const FAKE_SECRET = "wardby-fake-secret-value-7f3a9c";
const FAKE_TOKEN = "ghp_" + "Z".repeat(36);
const b64 = (s: string) => Buffer.from(s).toString("base64");
const output = (runId: string, files: { path: string; content: string }[]) =>
  JSON.stringify({
    schemaVersion: 1,
    runId,
    status: "ok",
    files: files.map((f) => ({ path: f.path, contentBase64: b64(f.content) })),
    skipped: [],
    skippedUnnamed: 0,
  });

describe.skipIf(!process.env.DATABASE_URL)("PlanFilesRecorder", () => {
  const db = createPrismaClient();
  const versions: SecretVersion[] = [{ id: "s1", name: "API_KEY", updatedAt: "2026-11-16T10:00:00.000Z" }];
  const stamp = `plan-rec-${Date.now()}`;
  let runId: string;
  let agentId: string;
  beforeAll(async () => {
    const owner = await db.principal.create({ data: { id: stamp, subject: stamp } });
    const agent = await db.agent.create({
      data: { name: stamp, systemPrompt: "p", model: "m", budgetUsd: 1, maxTurns: 3, ownerId: owner.id },
    });
    agentId = agent.id;
    const run = await db.run.create({ data: { agentId, status: "running", trigger: "manual" } });
    runId = run.id;
    await db.codingRun.create({
      data: {
        runId,
        task: "t",
        repository: "o/r",
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        provider: "codex",
        model: "m",
        timeoutSec: 60,
        protectedPaths: [],
        budgetReservedUsd: 0.1,
        collectPlanFiles: true,
      },
    });
  });
  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: stamp } });
    await db.$disconnect();
  });

  const recorder = (over: Partial<ConstructorParameters<typeof PlanFilesRecorder>[0]> = {}) =>
    new PlanFilesRecorder({
      db,
      secretValues: async () => [FAKE_SECRET],
      secretVersions: async () => versions,
      ...over,
    });

  it("redacts by exact value, withholds token-shaped files, and stores only path + redacted text", async () => {
    const status = await recorder().record({
      runId,
      agentId,
      launchSecretVersions: versions,
      read: async () =>
        output(runId, [
          { path: "plan.md", content: `# Plan\nThe key is ${FAKE_SECRET}.\n` },
          { path: "leak.md", content: `token ${FAKE_TOKEN}\n` },
        ]),
    });
    expect(status).toBe("stored");
    const stored = await loadPlanFiles(db, runId, "output");
    expect(stored).toEqual([{ path: "plan.md", content: "# Plan\nThe key is [REDACTED].\n" }]);
    const run = await db.codingRun.findUniqueOrThrow({ where: { runId } });
    expect(run.planFilesStatus).toBe("stored");
    expect(run.planFilesWithheld).toEqual(["leak.md"]);
    const everything = JSON.stringify({ stored, run, logs: logged });
    expect(everything).not.toContain(FAKE_SECRET);
    expect(everything).not.toContain(FAKE_TOKEN);
  });

  it("stores nothing when a secret changed during the run", async () => {
    await db.codingRunPlanFile.deleteMany({ where: { runId } });
    const status = await recorder({
      secretVersions: async () => [{ id: "s1", name: "API_KEY", updatedAt: "2026-11-16T11:00:00.000Z" }],
    }).record({
      runId,
      agentId,
      launchSecretVersions: versions,
      read: async () => output(runId, [{ path: "x.md", content: "x" }]),
    });
    expect(status).toBe("secrets_changed");
    expect(await loadPlanFiles(db, runId, "output")).toEqual([]);
    const run = await db.codingRun.findUniqueOrThrow({ where: { runId } });
    expect(run.planFilesStatus).toBe("secrets_changed");
  });

  it("re-checks limits and run id, and records fixed codes", async () => {
    const base = { runId, agentId, launchSecretVersions: versions };
    expect(
      await recorder().record({
        ...base,
        read: async () => {
          throw new Error("plan_files_too_large");
        },
      }),
    ).toBe("plan_too_large");
    expect(
      await recorder().record({
        ...base,
        read: async () => output("some-other-run", [{ path: "x.md", content: "x" }]),
      }),
    ).toBe("plan_files_failed");
    expect(await recorder().record(base)).toBe("plan_files_unsupported");
    expect(await recorder().record({ ...base, read: async () => undefined })).toBe("plan_files_missing");
    expect(
      await recorder().record({
        ...base,
        read: async () => JSON.stringify({ schemaVersion: 1, runId, status: "error", error: "plan_too_large" }),
      }),
    ).toBe("plan_too_large");
    const run = await db.codingRun.findUniqueOrThrow({ where: { runId } });
    expect(run.planFilesStatus).toBe("plan_too_large");
  });

  it("a file that is not valid UTF-8 after decoding is withheld", async () => {
    const bad = Buffer.from([0xff, 0xfe]).toString("base64");
    const status = await recorder().record({
      runId,
      agentId,
      launchSecretVersions: versions,
      read: async () =>
        JSON.stringify({
          schemaVersion: 1,
          runId,
          status: "ok",
          files: [{ path: "bin.md", contentBase64: bad }],
          skipped: [],
          skippedUnnamed: 0,
        }),
    });
    expect(status).toBe("stored");
    const run = await db.codingRun.findUniqueOrThrow({ where: { runId } });
    expect(run.planFilesWithheld).toEqual(["bin.md"]);
    expect(await loadPlanFiles(db, runId, "output")).toEqual([]);
  });
});
