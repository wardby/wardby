import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { endGroup, parseProcStat, readProcTable, type ProcEntry, type ProcessSeams } from "./workspace.js";

const GROUP = 4242;

/** A fake child that leads process group GROUP and has already exited. */
const child = { pid: GROUP, exitCode: 0, signalCode: null, kill: () => true };

/** Seams over a fake process table that each kill call may change. */
function fakeSeams(
  table: ProcEntry[],
  options: { isInit: boolean; onKill?: (pid: number, signal: NodeJS.Signals | 0, table: ProcEntry[]) => void },
): ProcessSeams & { kills: [number, NodeJS.Signals | 0][] } {
  const kills: [number, NodeJS.Signals | 0][] = [];
  return {
    kills,
    kill: (pid, signal) => {
      kills.push([pid, signal]);
      options.onKill?.(pid, signal, table);
      return true;
    },
    procs: () => [...table],
    isInit: () => options.isInit,
    selfPid: 1,
  };
}

const sent = (kills: [number, NodeJS.Signals | 0][]): [number, NodeJS.Signals | 0][] =>
  kills.filter(([, signal]) => signal !== 0);

describe("parseProcStat", () => {
  it("reads the pid, state and process group, whatever the command name holds", () => {
    expect(parseProcStat("123 (node) S 1 123 123 0 -1 4194560")).toEqual({ pid: 123, pgid: 123, state: "S" });
    expect(parseProcStat("77 (a (weird) name) Z 1 70 70 0")).toEqual({ pid: 77, pgid: 70, state: "Z" });
    expect(parseProcStat("garbage")).toBeUndefined();
    expect(parseProcStat("12 (x)")).toBeUndefined();
  });

  it("lists a /proc-shaped directory and skips what it cannot read", async () => {
    const root = await mkdtemp(join(tmpdir(), "wardby-proc-"));
    try {
      await mkdir(join(root, "10"));
      await writeFile(join(root, "10", "stat"), "10 (sh) R 1 10 10 0");
      await mkdir(join(root, "11"));
      await mkdir(join(root, "self"));
      expect(readProcTable(root)).toEqual([{ pid: 10, pgid: 10, state: "R" }]);
      expect(readProcTable(join(root, "missing"))).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("endGroup", () => {
  const logged: string[] = [];
  const log = (event: string): void => void logged.push(event);
  afterEach(() => void logged.splice(0));

  it("counts a zombie group member as gone: no SIGKILL, no still-running event", async () => {
    const table: ProcEntry[] = [
      { pid: 1, pgid: 1, state: "S" },
      { pid: GROUP + 1, pgid: GROUP, state: "Z" },
    ];
    const seams = fakeSeams(table, { isInit: false });
    const started = Date.now();
    await endGroup(child, 2_000, log, seams);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(sent(seams.kills)).toEqual([[-GROUP, "SIGTERM"]]);
    expect(logged).not.toContain("substrate_bridge_group_still_running");
  });

  it("never sweeps with kill(-1) when the bridge is not PID 1", async () => {
    const table: ProcEntry[] = [{ pid: GROUP + 1, pgid: GROUP, state: "S" }];
    const seams = fakeSeams(table, {
      isInit: false,
      onKill: (pid, signal, t) => {
        if (pid === -GROUP && signal === "SIGKILL") t.splice(0);
      },
    });
    await endGroup(child, 30, log, seams);
    expect(sent(seams.kills)).toEqual([
      [-GROUP, "SIGTERM"],
      [-GROUP, "SIGKILL"],
    ]);
    expect(seams.kills.some(([pid]) => pid === -1)).toBe(false);
  });

  it("as PID 1, sweeps once with kill(-1, SIGKILL) after the group's SIGKILL, and waits for the escapee", async () => {
    const table: ProcEntry[] = [
      { pid: 1, pgid: 1, state: "S" },
      // Ignores SIGTERM.
      { pid: GROUP + 1, pgid: GROUP, state: "S" },
      // Left the group (setsid): only the sweep reaches it.
      { pid: 900, pgid: 900, state: "S" },
    ];
    const seams = fakeSeams(table, {
      isInit: true,
      onKill: (pid, signal, t) => {
        if (pid === -GROUP && signal === "SIGKILL") t.splice(1, 1, { pid: GROUP + 1, pgid: GROUP, state: "Z" });
        if (pid === -1 && signal === "SIGKILL") t.splice(2, 1);
      },
    });
    await endGroup(child, 30, log, seams);
    expect(sent(seams.kills)).toEqual([
      [-GROUP, "SIGTERM"],
      [-GROUP, "SIGKILL"],
      [-1, "SIGKILL"],
    ]);
    expect(table.filter((entry) => entry.state !== "Z").map((entry) => entry.pid)).toEqual([1]);
    expect(logged).toEqual([]);
  });

  it("as PID 1, still sweeps when the group went on SIGTERM", async () => {
    const table: ProcEntry[] = [{ pid: 900, pgid: 900, state: "S" }];
    const seams = fakeSeams(table, {
      isInit: true,
      onKill: (pid, signal, t) => {
        if (pid === -1) t.splice(0);
      },
    });
    await endGroup(child, 30, log, seams);
    expect(sent(seams.kills)).toEqual([
      [-GROUP, "SIGTERM"],
      [-1, "SIGKILL"],
    ]);
  });

  it("logs a fixed event when the sweep's processes do not go", async () => {
    const table: ProcEntry[] = [{ pid: 900, pgid: 900, state: "D" }];
    const seams = fakeSeams(table, { isInit: true });
    await endGroup({ ...child, pid: undefined }, 30, log, { ...seams, procs: () => [...table] });
    expect(sent(seams.kills)).toEqual([[-1, "SIGKILL"]]);
    expect(logged).toEqual(["substrate_bridge_sweep_still_running"]);
  }, 10_000);
});
