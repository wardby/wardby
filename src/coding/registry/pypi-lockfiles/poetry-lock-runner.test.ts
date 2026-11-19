import { describe, expect, it } from "vitest";
import { runPoetryLock, spawnPoetry, type PoetrySpawn, type PoetrySpawnResult } from "./poetry-lock-runner.js";

function fake(result: Partial<PoetrySpawnResult>): { spawn: PoetrySpawn; calls: Parameters<PoetrySpawn>[] } {
  const calls: Parameters<PoetrySpawn>[] = [];
  const spawn: PoetrySpawn = async (...args) => {
    calls.push(args);
    return { code: 0, stderr: "", timedOut: false, notFound: false, ...result };
  };
  return { spawn, calls };
}

const base = {
  projectDir: "/work/app",
  env: { PATH: "/usr/bin", POETRY_HTTP_BASIC_CORP_USERNAME: "wardby" },
  timeoutMs: 1000,
};

describe("runPoetryLock", () => {
  it("runs `poetry --no-plugins lock` in the project with a safe Python environment", async () => {
    const { spawn, calls } = fake({});
    await expect(runPoetryLock({ ...base, spawn })).resolves.toEqual({ ok: true, stderrTail: "" });
    const [command, args, options] = calls[0];
    expect(command).toBe("poetry");
    expect(args).toEqual(["--no-plugins", "lock"]);
    expect(options.cwd).toBe("/work/app");
    expect(options.timeoutMs).toBe(1000);
    expect(options.env).toEqual({
      PATH: "/usr/bin",
      POETRY_HTTP_BASIC_CORP_USERNAME: "wardby",
      POETRY_NO_INTERACTION: "1",
      PYTHONSAFEPATH: "1",
      PYTHONNOUSERSITE: "1",
    });
  });

  it("reports a non-zero exit with the end of stderr", async () => {
    const { spawn } = fake({ code: 1, stderr: `${"x".repeat(5000)}boom` });
    const result = await runPoetryLock({ ...base, spawn });
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    expect(result.stderrTail.length).toBe(4096);
    expect(result.stderrTail.endsWith("boom")).toBe(true);
  });

  it("reports a timeout", async () => {
    const { spawn } = fake({ code: null, timedOut: true });
    expect(await runPoetryLock({ ...base, spawn })).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("reports poetry missing from PATH", async () => {
    const { spawn } = fake({ code: null, notFound: true, stderr: "spawn poetry ENOENT" });
    expect(await runPoetryLock({ ...base, spawn })).toEqual({
      ok: false,
      reason: "poetry_not_installed",
      stderrTail: "",
    });
  });

  it("kills a process that outlives the timeout and reports a missing command", async () => {
    const env = { PATH: process.env.PATH ?? "" };
    const slow = await spawnPoetry(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      cwd: process.cwd(),
      env,
      timeoutMs: 100,
    });
    expect(slow).toMatchObject({ timedOut: true, notFound: false });
    const missing = await spawnPoetry("wardby-no-such-command", [], { cwd: process.cwd(), env, timeoutMs: 1000 });
    expect(missing).toMatchObject({ notFound: true });
  });
});
