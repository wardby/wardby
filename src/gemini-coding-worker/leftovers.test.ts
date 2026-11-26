import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killLeftoverProcesses } from "./leftovers.js";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/** A fake /proc: each entry is [pid, ppid, state, comm]. */
async function fakeProc(entries: [number, number, string, string][]): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "wardby-fake-proc-"));
  for (const [pid, ppid, state, comm] of entries) {
    await mkdir(join(root, String(pid)));
    await writeFile(join(root, String(pid), "stat"), `${pid} (${comm}) ${state} ${ppid} 1 1 0 -1 4194560 100 0`);
  }
  // Not processes.
  await mkdir(join(root, "self"));
  await writeFile(join(root, "uptime"), "1.0 1.0");
  return root;
}

describe("killLeftoverProcesses", () => {
  it("stops every process but the driver and its ancestors: SIGTERM, then SIGKILL for what is left", async () => {
    const proc = await fakeProc([
      [1, 0, "S", "tini"],
      [7, 1, "S", "node"], // the driver
      [30, 1, "S", "sleep"], // a shell's background job, reparented
      [31, 30, "S", "a) R 7 (odd name"], // a comm that tries to fake its parent
      [40, 1, "Z", "defunct"], // a zombie: nothing to signal
    ]);
    const signals: [number, NodeJS.Signals][] = [];
    const alive = new Set([30, 31]);
    await killLeftoverProcesses({
      procRoot: proc,
      self: 7,
      graceMs: 1,
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        // 30 exits on SIGTERM; 31 ignores it.
        if (signal === "SIGTERM" && pid === 30) alive.delete(30);
        if (signal === "SIGKILL") alive.delete(pid);
        if (!alive.has(pid)) rmSync(join(proc, String(pid)), { recursive: true, force: true });
      },
    });
    expect(signals.filter(([, s]) => s === "SIGTERM").map(([pid]) => pid)).toEqual([30, 31]);
    expect(signals.some(([pid, s]) => pid === 31 && s === "SIGKILL")).toBe(true);
    for (const pid of [1, 7, 40]) expect(signals.some(([p]) => p === pid)).toBe(false);
  });

  it("ignores processes it may not signal or that are already gone", async () => {
    const proc = await fakeProc([
      [1, 0, "S", "node"],
      [5, 1, "S", "other-user"],
    ]);
    await expect(
      killLeftoverProcesses({
        procRoot: proc,
        self: 1,
        graceMs: 1,
        kill: () => {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("does nothing where there is no /proc", async () => {
    const calls: number[] = [];
    await killLeftoverProcesses({
      procRoot: join(tmpdir(), "wardby-no-such-proc"),
      self: 1,
      graceMs: 1,
      kill: (pid) => calls.push(pid),
    });
    expect(calls).toEqual([]);
  });
});
