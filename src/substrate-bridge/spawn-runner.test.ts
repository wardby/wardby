import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signalRunnerGroup, spawnRunner } from "./tool.js";

describe("spawnRunner", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spawn-runner-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function script(body: string): Promise<string> {
    const path = join(dir, "runner.mjs");
    await writeFile(path, body);
    return path;
  }

  it("resolves ready on the ready line, passes other stdout through, and never echoes the setup", async () => {
    const entry = await script(`
import { writeFileSync } from "node:fs";
writeFileSync(process.env.PROOF_FILE, process.env.WARDBY_TOOL_SETUP);
console.log("runner says hi");
console.log("wardby_tool_runner_ready");
setTimeout(() => process.exit(7), 100);
`);
    const written: string[] = [];
    const errors: string[] = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk: string | Uint8Array) => (written.push(String(chunk)), true);
    process.stderr.write = (chunk: string | Uint8Array) => (errors.push(String(chunk)), true);
    let handle: ReturnType<typeof spawnRunner>;
    let code: number;
    try {
      handle = spawnRunner("SETUP-VALUE-123", { PROOF_FILE: join(dir, "proof") }, entry);
      await handle.ready;
      code = await handle.exited;
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
    expect(code).toBe(7);
    expect(await readFile(join(dir, "proof"), "utf8")).toBe("SETUP-VALUE-123");
    // Only the runner's own non-ready line is passed through; the ready line is consumed.
    expect(written.join("")).toContain("runner says hi\n");
    expect(written.join("")).not.toContain("wardby_tool_runner_ready");
    expect([...written, ...errors].join("")).not.toContain("SETUP-VALUE-123");
  });

  it("stop and kill reach the runner's whole process group, even a runner and child that ignore SIGTERM", async () => {
    const childPidFile = join(dir, "child.pid");
    const entry = await script(`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
const child = spawn(
  process.execPath,
  ["-e", 'process.on("SIGTERM", () => {}); console.log("up"); setInterval(() => {}, 1000);'],
  { stdio: ["ignore", "pipe", "ignore"] },
);
// Ready only once the child ignores SIGTERM too.
child.stdout.once("data", () => {
  writeFileSync(process.env.CHILD_PID_FILE, String(child.pid));
  console.log("wardby_tool_runner_ready");
});
setInterval(() => {}, 1000);
`);
    const handle = spawnRunner("x", { CHILD_PID_FILE: childPidFile }, entry);
    await handle.ready;
    const childPid = Number(await readFile(childPidFile, "utf8"));
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(childPid)).toBe(true);
    let exited = false;
    void handle.exited.then(() => (exited = true));
    handle.stop!();
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Both ignore SIGTERM: a stop alone leaves them running.
    expect(exited).toBe(false);
    expect(alive(childPid)).toBe(true);
    handle.kill!();
    expect(await handle.exited).toBe(1);
    for (let i = 0; i < 50 && alive(childPid); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alive(childPid)).toBe(false);
    // A group already gone is not an error.
    expect(() => handle.kill!()).not.toThrow();
  });

  it("rejects ready when the runner exits first", async () => {
    const entry = await script("process.exit(3);\n");
    const handle = spawnRunner("x", {}, entry);
    await expect(handle.ready).rejects.toMatchObject({ code: "substrate_bridge_runner_exited" });
    expect(await handle.exited).toBe(3);
  });

  describe("signalRunnerGroup", () => {
    const errno = (code: string) => Object.assign(new Error(code), { code });
    const target = (over: Partial<Parameters<typeof signalRunnerGroup>[0]> = {}) => ({
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
      ...over,
    });

    it("treats ESRCH as an empty group", () => {
      const log = vi.fn();
      const child = target();
      signalRunnerGroup(
        child,
        "SIGTERM",
        () => {
          throw errno("ESRCH");
        },
        log,
      );
      expect(log).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
    });

    it("falls back to the runner itself on EPERM", () => {
      const child = target();
      signalRunnerGroup(
        child,
        "SIGTERM",
        () => {
          throw errno("EPERM");
        },
        vi.fn(),
      );
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("logs an unexpected error as a fixed-field event", () => {
      const log = vi.fn();
      signalRunnerGroup(
        target(),
        "SIGTERM",
        () => {
          throw errno("EINVAL");
        },
        log,
      );
      expect(log).toHaveBeenCalledWith("substrate_bridge_runner_signal_failed", { signal: "SIGTERM", errno: "EINVAL" });
    });

    it("skips the final SIGKILL when the runner exited and its group is gone", () => {
      const killFn = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
        if (signal === 0) throw errno("ESRCH");
        return true;
      });
      signalRunnerGroup(target({ exitCode: 0 }), "SIGKILL", killFn, vi.fn());
      expect(killFn).toHaveBeenCalledTimes(1);
      expect(killFn).toHaveBeenCalledWith(-4242, 0);
    });

    it("still kills the group when the runner exited but processes remain", () => {
      const killFn = vi.fn(() => true);
      signalRunnerGroup(target({ exitCode: 0 }), "SIGKILL", killFn, vi.fn());
      expect(killFn).toHaveBeenCalledWith(-4242, "SIGKILL");
    });
  });
});
