import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killLeftoverProcesses, WORKER_PID_NAMESPACE_ENV } from "./leftovers.js";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const ENV = { [WORKER_PID_NAMESPACE_ENV]: "1" };

async function addProcess(proc: string, pid: number, ppid: number, state = "S", comm = "sh"): Promise<void> {
  await mkdir(join(proc, String(pid)));
  await writeFile(join(proc, String(pid), "stat"), `${pid} (${comm}) ${state} ${ppid} 1 1 0 -1 4194560 100 0`);
}

/** A fake /proc: each entry is [pid, ppid, state, comm]. */
async function fakeProc(entries: [number, number, string, string][]): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "wardby-fake-proc-"));
  for (const [pid, ppid, state, comm] of entries) await addProcess(root, pid, ppid, state, comm);
  // Not processes.
  await mkdir(join(root, "self"));
  await writeFile(join(root, "uptime"), "1.0 1.0");
  return root;
}

const gone = (proc: string, pid: number) => rmSync(join(proc, String(pid)), { recursive: true, force: true });

describe("killLeftoverProcesses", () => {
  it("stops then kills every process but the driver and its ancestors", async () => {
    const proc = await fakeProc([
      [1, 0, "S", "docker-init"],
      [7, 1, "S", "node"], // the driver
      [30, 1, "S", "sleep"], // a shell's background job, reparented
      [31, 30, "S", "a) R 7 (odd name"], // a comm that tries to fake its parent; ignores SIGTERM
      [40, 1, "Z", "defunct"], // a zombie: nothing to signal
    ]);
    const signals: [number, NodeJS.Signals][] = [];
    const result = await killLeftoverProcesses({
      procRoot: proc,
      self: 7,
      env: ENV,
      pauseMs: 1,
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === "SIGKILL") gone(proc, pid);
      },
    });
    expect(result).toBe("swept");
    expect(signals).toEqual([
      [30, "SIGSTOP"],
      [31, "SIGSTOP"],
      [30, "SIGKILL"],
      [31, "SIGKILL"],
    ]);
  });

  it("catches what a process forks before it is stopped, and stopped processes cannot fork", async () => {
    const proc = await fakeProc([
      [1, 0, "S", "init"],
      [7, 1, "S", "node"],
      [30, 1, "S", "forker"],
    ]);
    const stopped = new Set<number>();
    let next = 100;
    let forked = 0;
    const result = await killLeftoverProcesses({
      procRoot: proc,
      self: 7,
      env: ENV,
      pauseMs: 1,
      kill: (pid, signal) => {
        // A running forker makes a new child on every signal it sees; a stopped one cannot.
        if (!stopped.has(pid) && forked < 3) {
          forked += 1;
          rmSync(join(proc, String(next)), { recursive: true, force: true });
          void addProcess(proc, next++, pid);
        }
        if (signal === "SIGSTOP") stopped.add(pid);
        if (signal === "SIGKILL") gone(proc, pid);
      },
    });
    expect(result).toBe("swept");
    expect(forked).toBeGreaterThan(0);
  });

  it("throws a fixed code when processes keep appearing (never returns with survivors)", async () => {
    const proc = await fakeProc([
      [1, 0, "S", "init"],
      [7, 1, "S", "node"],
      [30, 1, "S", "hydra"],
    ]);
    let next = 100;
    const pending: Promise<void>[] = [];
    await expect(
      killLeftoverProcesses({
        procRoot: proc,
        self: 7,
        env: ENV,
        pauseMs: 5,
        kill: (pid, signal) => {
          if (signal !== "SIGKILL") return;
          gone(proc, pid);
          // Something outside the sweep's reach replaces every process it kills.
          pending.push(addProcess(proc, next++, 1));
        },
      }),
    ).rejects.toThrow("coding_stream_failed");
    await Promise.all(pending);
  });

  it("leaves processes it may not signal (another uid) alone", async () => {
    const proc = await fakeProc([
      [1, 0, "S", "node"],
      [5, 1, "S", "other-user"],
    ]);
    const signals: NodeJS.Signals[] = [];
    await expect(
      killLeftoverProcesses({
        procRoot: proc,
        self: 1,
        env: ENV,
        pauseMs: 1,
        kill: (_pid, signal) => {
          signals.push(signal);
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        },
      }),
    ).resolves.toBe("swept");
    expect(signals).toEqual(["SIGSTOP"]);
  });

  it("skips (signals nothing) outside the worker image's pid namespace", async () => {
    const proc = await fakeProc([
      [1, 0, "S", "launchd"],
      [7, 3, "S", "node"], // PID 1 is not the driver's ancestor: a shared namespace
      [3, 0, "S", "runtime"],
      [30, 1, "S", "someone-else"],
    ]);
    const calls: number[] = [];
    const kill = (pid: number) => void calls.push(pid);
    expect(await killLeftoverProcesses({ procRoot: proc, self: 7, env: ENV, pauseMs: 1, kill })).toBe("skipped");
    // Without the image's marker, even a namespace that looks right is left alone.
    expect(await killLeftoverProcesses({ procRoot: proc, self: 30, env: {}, pauseMs: 1, kill })).toBe("skipped");
    expect(
      await killLeftoverProcesses({ procRoot: join(tmpdir(), "wardby-no-such-proc"), self: 1, env: ENV, kill }),
    ).toBe("skipped");
    expect(calls).toEqual([]);
  });
});
