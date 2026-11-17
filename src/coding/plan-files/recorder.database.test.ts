import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import type { SecretVersion } from "../../core/secret-versions.js";
import { PlanFilesRecorder } from "./recorder.js";
import { assertPlanFilesWithinLimits, loadPlanFiles } from "./store.js";
import { PLAN_FILES_LIMITS } from "../protocol.js";

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
/** The run's registry token shape (coding-worker/credentials.ts): rrg_ + 43 base64url characters. */
const FAKE_REGISTRY_TOKEN = "rrg_" + "fakeRegistryToken0123456789_-abcdefghijklmn".slice(0, 43);
/** A secret JSON escaping changes: a quote, a backslash and a newline. */
const FAKE_ESCAPING_SECRET = 'fake"quote\\back\nline-9d2e';
const FAKE_SHORT_SECRET = "q7Zx";
const b64 = (s: string) => Buffer.from(s).toString("base64");
const output = (
  runId: string,
  files: { path: string; content: string }[],
  skipped: string[] = [],
  skippedUnnamed = 0,
) =>
  JSON.stringify({
    schemaVersion: 1,
    runId,
    status: "ok",
    files: files.map((f) => ({ path: f.path, contentBase64: b64(f.content) })),
    skipped,
    skippedUnnamed,
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

  /** Every test starts from a run with no plan outcome yet: an outcome is written once (writeOnce). */
  const reset = async () => {
    await db.codingRunPlanFile.deleteMany({ where: { runId, direction: "output" } });
    await db.codingRun.update({
      where: { runId },
      data: { planFilesStatus: null, planFilesWithheld: Prisma.DbNull, planFilesSkipped: Prisma.DbNull },
    });
  };
  beforeEach(reset);

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
    expect(run.planFilesWithheld).toEqual({ paths: ["leak.md"], unnamed: 0 });
    expect(run.planFilesSkipped).toEqual({ paths: [], unnamed: 0 });
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
    await reset(); // an outcome is written once: each case starts from a run with none
    expect(
      await recorder().record({
        ...base,
        read: async () => {
          throw new Error("plan_files_too_large");
        },
      }),
    ).toBe("plan_too_large");
    await reset(); // an outcome is written once: each case starts from a run with none
    expect(
      await recorder().record({
        ...base,
        read: async () => output("some-other-run", [{ path: "x.md", content: "x" }]),
      }),
    ).toBe("plan_files_failed");
    await reset();
    expect(await recorder().record(base)).toBe("plan_files_unsupported");
    await reset();
    expect(await recorder().record({ ...base, read: async () => undefined })).toBe("plan_files_missing");
    await reset(); // an outcome is written once: each case starts from a run with none
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
    expect(run.planFilesWithheld).toEqual({ paths: ["bin.md"], unnamed: 0 });
    expect(await loadPlanFiles(db, runId, "output")).toEqual([]);
  });
  const base = () => ({ runId, agentId, launchSecretVersions: versions });
  /** Output rows left with no outcome recorded: a non-stored outcome must remove them in its transaction. */
  const storeOne = async () => {
    await db.codingRunPlanFile.create({ data: { runId, direction: "output", path: "a.md", content: "a" } });
    expect(await loadPlanFiles(db, runId, "output")).toHaveLength(1);
  };

  it("withholds a file whose content holds a NUL character, like a token-shaped one (Postgres text rejects NUL)", async () => {
    const status = await recorder().record({
      ...base(),
      read: async () =>
        output(runId, [
          { path: "ok.md", content: "fine\n" },
          { path: "nul.md", content: "before\u0000after\n" },
        ]),
    });
    expect(status).toBe("stored");
    expect(await loadPlanFiles(db, runId, "output")).toEqual([{ path: "ok.md", content: "fine\n" }]);
    const run = await db.codingRun.findUniqueOrThrow({ where: { runId } });
    expect(run.planFilesWithheld).toEqual({ paths: ["nul.md"], unnamed: 0 });
  });

  it("storeChecked withholds a NUL-holding file too; the rest of the plan is stored", async () => {
    const status = await recorder().storeChecked(
      base(),
      [
        { path: "plan.md", content: "# Plan\n" },
        { path: "bad.md", content: "\u0000" },
      ],
      { paths: [], unnamed: 0 },
    );
    expect(status).toBe("stored");
    expect(await loadPlanFiles(db, runId, "output")).toEqual([{ path: "plan.md", content: "# Plan\n" }]);
    expect((await db.codingRun.findUniqueOrThrow({ where: { runId } })).planFilesWithheld).toEqual({
      paths: ["bad.md"],
      unnamed: 0,
    });
  });

  it("withholds a file holding the run's registry token (rrg_)", async () => {
    expect(FAKE_REGISTRY_TOKEN).toHaveLength(47);
    const status = await recorder().record({
      ...base(),
      read: async () =>
        output(runId, [
          { path: "ok.md", content: "fine\n" },
          { path: "registry.md", content: `npm token ${FAKE_REGISTRY_TOKEN}\n` },
        ]),
    });
    expect(status).toBe("stored");
    const stored = await loadPlanFiles(db, runId, "output");
    expect(stored).toEqual([{ path: "ok.md", content: "fine\n" }]);
    const run = await db.codingRun.findUniqueOrThrow({ where: { runId } });
    expect(run.planFilesWithheld).toEqual({ paths: ["registry.md"], unnamed: 0 });
    expect(JSON.stringify({ stored, run, logs: logged })).not.toContain(FAKE_REGISTRY_TOKEN);
  });

  it("redacts JSON-escaped forms of a secret and secrets of any length", async () => {
    const escapedOnce = JSON.stringify(FAKE_ESCAPING_SECRET).slice(1, -1);
    const status = await recorder({
      secretValues: async () => [FAKE_ESCAPING_SECRET, FAKE_SHORT_SECRET],
    }).record({
      ...base(),
      read: async () =>
        output(runId, [
          { path: "config.md", content: `{"key": "${escapedOnce}"}\n` },
          { path: "short.md", content: `pin ${FAKE_SHORT_SECRET} here\n` },
        ]),
    });
    expect(status).toBe("stored");
    const stored = await loadPlanFiles(db, runId, "output");
    expect(stored).toEqual([
      { path: "config.md", content: '{"key": "[REDACTED]"}\n' },
      { path: "short.md", content: "pin [REDACTED] here\n" },
    ]);
    const everything = JSON.stringify({ stored, logs: logged });
    expect(everything).not.toContain(escapedOnce);
    expect(JSON.stringify(stored.map((f) => f.content))).not.toContain(FAKE_SHORT_SECRET);
  });

  it("never stores or lists a path that holds a secret or token-shaped value, only counts it", async () => {
    const tokenPath = `ghp_${"Y".repeat(36)}.md`;
    const secretPath = `${FAKE_SECRET}.md`;
    const status = await recorder().record({
      ...base(),
      read: async () =>
        output(
          runId,
          [
            { path: "plan.md", content: "plan\n" },
            { path: secretPath, content: "harmless\n" },
            { path: tokenPath, content: "harmless\n" },
          ],
          ["ok-skipped.md", `notes/${FAKE_SECRET}`],
          1,
        ),
    });
    expect(status).toBe("stored");
    const stored = await loadPlanFiles(db, runId, "output");
    expect(stored).toEqual([{ path: "plan.md", content: "plan\n" }]);
    const run = await db.codingRun.findUniqueOrThrow({ where: { runId } });
    expect(run.planFilesWithheld).toEqual({ paths: [], unnamed: 2 });
    expect(run.planFilesSkipped).toEqual({ paths: ["ok-skipped.md"], unnamed: 2 });
    const everything = JSON.stringify({ stored, run, logs: logged });
    expect(everything).not.toContain(FAKE_SECRET);
    expect(everything).not.toContain("Y".repeat(36));
  });

  it("round-trips the worker's skipped paths and unnamed count", async () => {
    const status = await recorder().record({
      ...base(),
      read: async () => output(runId, [{ path: "a.md", content: "a" }], ["link.md", "bin.md"], 3),
    });
    expect(status).toBe("stored");
    const run = await db.codingRun.findUniqueOrThrow({ where: { runId } });
    expect(run.planFilesSkipped).toEqual({ paths: ["link.md", "bin.md"], unnamed: 3 });
  });

  it("a non-stored outcome removes leftover output files and path lists", async () => {
    await storeOne();
    await db.codingRun.update({
      where: { runId },
      data: { planFilesWithheld: { paths: ["w.md"], unnamed: 0 }, planFilesSkipped: { paths: [], unnamed: 0 } },
    });
    const status = await recorder({
      secretVersions: async () => [{ id: "s1", name: "API_KEY", updatedAt: "2026-11-16T12:00:00.000Z" }],
    }).record({ ...base(), read: async () => output(runId, [{ path: "b.md", content: "b" }]) });
    expect(status).toBe("secrets_changed");
    expect(await loadPlanFiles(db, runId, "output")).toEqual([]);
    const run = await db.codingRun.findUniqueOrThrow({ where: { runId } });
    expect(run.planFilesStatus).toBe("secrets_changed");
    expect(run.planFilesWithheld).toBeNull();
    expect(run.planFilesSkipped).toBeNull();
  });

  it("records secrets_unavailable when values or versions can't be read", async () => {
    const read = async () => output(runId, [{ path: "a.md", content: "a" }]);
    await storeOne();
    expect(
      await recorder({
        secretValues: async () => {
          throw new Error("vault down");
        },
      }).record({ ...base(), read }),
    ).toBe("secrets_unavailable");
    expect(await loadPlanFiles(db, runId, "output")).toEqual([]);
    await reset();
    expect(
      await recorder({
        secretVersions: async () => {
          throw new Error("vault down");
        },
      }).record({ ...base(), read }),
    ).toBe("secrets_unavailable");
    const run = await db.codingRun.findUniqueOrThrow({ where: { runId } });
    expect(run.planFilesStatus).toBe("secrets_unavailable");
  });

  it("treats missing launch secret versions as changed", async () => {
    await storeOne();
    const status = await recorder().record({
      runId,
      agentId,
      read: async () => output(runId, [{ path: "a.md", content: "a" }]),
    });
    expect(status).toBe("secrets_changed");
    expect(await loadPlanFiles(db, runId, "output")).toEqual([]);
  });

  it("storeChecked redacts, withholds and stores files the control plane already holds", async () => {
    const status = await recorder().storeChecked(
      base(),
      [
        { path: "plan.md", content: `key ${FAKE_SECRET}\n` },
        { path: "leak.md", content: `t ${FAKE_TOKEN}\n` },
      ],
      { paths: ["skipped.md", `${FAKE_SECRET}.md`], unnamed: 2 },
    );
    expect(status).toBe("stored");
    const stored = await loadPlanFiles(db, runId, "output");
    expect(stored).toEqual([{ path: "plan.md", content: "key [REDACTED]\n" }]);
    const run = await db.codingRun.findUniqueOrThrow({ where: { runId } });
    expect(run.planFilesStatus).toBe("stored");
    expect(run.planFilesWithheld).toEqual({ paths: ["leak.md"], unnamed: 0 });
    // The caller's unnamed count is carried, plus the path that held a secret value.
    expect(run.planFilesSkipped).toEqual({ paths: ["skipped.md"], unnamed: 3 });
    const everything = JSON.stringify({ stored, run, logs: logged });
    expect(everything).not.toContain(FAKE_SECRET);
    expect(everything).not.toContain(FAKE_TOKEN);
  });

  it("re-checks limits and paths on decoded content itself", async () => {
    const big = "x".repeat(PLAN_FILES_LIMITS.maxFileBytes + 1);
    expect(() => assertPlanFilesWithinLimits([{ path: "big.md", content: big }])).toThrow("plan_too_large");
    expect(() =>
      assertPlanFilesWithinLimits([
        { path: "a.md", content: "1" },
        { path: "a.md", content: "2" },
      ]),
    ).toThrow("plan_path_invalid");
    expect(() => assertPlanFilesWithinLimits([{ path: "../escape.md", content: "1" }])).toThrow("plan_path_invalid");

    await storeOne();
    expect(await recorder().storeChecked(base(), [{ path: "big.md", content: big }], { paths: [], unnamed: 0 })).toBe(
      "plan_too_large",
    );
    expect(await loadPlanFiles(db, runId, "output")).toEqual([]);
    await reset();
    expect(
      await recorder().storeChecked(
        base(),
        [
          { path: "a.md", content: "1" },
          { path: "a.md", content: "2" },
        ],
        { paths: [], unnamed: 0 },
      ),
    ).toBe("plan_files_failed");
    const run = await db.codingRun.findUniqueOrThrow({ where: { runId } });
    expect(run.planFilesStatus).toBe("plan_files_failed");
  });

  it("markStatus settles a given fixed failure code once, through the write-once path", async () => {
    expect(await recorder().markStatus(runId, "plan_folder_refused")).toBe("plan_folder_refused");
    expect(await recorder().markStatus(runId, "plan_too_large")).toBe("plan_folder_refused");
    expect(await recorder().storeChecked(base(), [{ path: "a.md", content: "a" }], { paths: [], unnamed: 0 })).toBe(
      "plan_folder_refused",
    );
    expect(await loadPlanFiles(db, runId, "output")).toEqual([]);
    const run = await db.codingRun.findUniqueOrThrow({ where: { runId } });
    expect(run.planFilesStatus).toBe("plan_folder_refused");
  });

  it("refuses to overwrite a recorded outcome: no rows added, status unchanged", async () => {
    await recorder().markFailed(runId);
    const late = await recorder().record({
      ...base(),
      read: async () => output(runId, [{ path: "late.md", content: "late" }]),
    });
    expect(late).toBe("plan_files_failed");
    expect(await loadPlanFiles(db, runId, "output")).toEqual([]);
    expect(
      await recorder().storeChecked(base(), [{ path: "late.md", content: "late" }], { paths: [], unnamed: 0 }),
    ).toBe("plan_files_failed");
    expect(await loadPlanFiles(db, runId, "output")).toEqual([]);
    // A refused write reports the status the database holds, not the one the late writer computed.
    expect(await recorder().record({ ...base(), read: async () => undefined })).toBe("plan_files_failed");
    expect(await recorder().markFailed(runId)).toBe("plan_files_failed");
    const run = await db.codingRun.findUniqueOrThrow({ where: { runId } });
    expect(run.planFilesStatus).toBe("plan_files_failed");
  });

  it("refuses to replace stored files: a later outcome leaves the first one's rows and status", async () => {
    expect(
      await recorder().record({ ...base(), read: async () => output(runId, [{ path: "a.md", content: "a" }]) }),
    ).toBe("stored");
    expect(await recorder().markFailed(runId)).toBe("stored");
    expect(
      await recorder().record({ ...base(), read: async () => output(runId, [{ path: "b.md", content: "b" }]) }),
    ).toBe("stored");
    expect(await loadPlanFiles(db, runId, "output")).toEqual([{ path: "a.md", content: "a" }]);
    const run = await db.codingRun.findUniqueOrThrow({ where: { runId } });
    expect(run.planFilesStatus).toBe("stored");
    expect(run.planFilesSkipped).toEqual({ paths: [], unnamed: 0 });
  });
});
