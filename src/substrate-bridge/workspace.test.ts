import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  endGroup,
  makeReadOnly,
  parseProcStat,
  parseSetupRepositories,
  readProcTable,
  type ProcEntry,
  type ProcessSeams,
} from "./workspace.js";

const exec = promisify(execFile);

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

describe("parseSetupRepositories", () => {
  it("reads an absent list as none, and a valid list field by field", () => {
    expect(parseSetupRepositories(undefined)).toEqual([]);
    expect(
      parseSetupRepositories([
        { name: "extra-alpha", access: "write", collectResultBundle: true },
        { name: "extra-beta", access: "read" },
      ]),
    ).toEqual([
      { name: "extra-alpha", access: "write", collectResultBundle: true },
      { name: "extra-beta", access: "read", collectResultBundle: false },
    ]);
  });

  it.each([
    ["a string", "x"],
    ["an object", {}],
    ["17 entries", Array.from({ length: 17 }, (_, i) => ({ name: `extra-${i}`, access: "read" }))],
    ["the reserved name", [{ name: "workspace", access: "write" }]],
    ["a path", [{ name: "../x", access: "read" }]],
    ["an upper-case name", [{ name: "Extra", access: "read" }]],
    [
      "a duplicate",
      [
        { name: "extra-alpha", access: "read" },
        { name: "extra-alpha", access: "write" },
      ],
    ],
    ["another key", [{ name: "extra-alpha", access: "read", hostPath: "/etc" }]],
    ["a non-boolean bundle flag", [{ name: "extra-alpha", access: "write", collectResultBundle: "yes" }]],
    ["a bundle flag on a read entry", [{ name: "extra-alpha", access: "read", collectResultBundle: true }]],
  ])("refuses %s", (_label, value) => {
    expect(parseSetupRepositories(value)).toBeUndefined();
  });
});

describe.skipIf(process.getuid?.() === 0)("makeReadOnly", () => {
  let dir: string;
  afterEach(async () => {
    // Writable again, so the folder can be removed.
    for (const path of [join(dir, "tree", "sub"), join(dir, "tree")]) await chmod(path, 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  const tree = async (): Promise<string> => {
    dir = await mkdtemp(join(tmpdir(), "read-only-"));
    const root = join(dir, "tree");
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "a.txt"), "a\n", { mode: 0o644 });
    await writeFile(join(root, "sub", "b.txt"), "b\n", { mode: 0o644 });
    await writeFile(join(dir, "outside.txt"), "outside\n", { mode: 0o644 });
    await chmod(join(dir, "outside.txt"), 0o644);
    await symlink(join(dir, "outside.txt"), join(root, "link"));
    return root;
  };

  it("makes directories 0555 and files 0444, leaving a symlink and its target alone", async () => {
    const root = await tree();
    const linkBefore = await lstat(join(root, "link"));
    await makeReadOnly(root, 10);
    const mode = async (path: string) => (await stat(path)).mode & 0o777;
    expect(await mode(root)).toBe(0o555);
    expect(await mode(join(root, "sub"))).toBe(0o555);
    expect(await mode(join(root, "a.txt"))).toBe(0o444);
    expect(await mode(join(root, "sub", "b.txt"))).toBe(0o444);
    expect(await mode(join(dir, "outside.txt"))).toBe(0o644);
    const linkAfter = await lstat(join(root, "link"));
    expect(linkAfter.mode).toBe(linkBefore.mode);
    await expect(writeFile(join(root, "new.txt"), "x")).rejects.toMatchObject({ code: "EACCES" });
  });

  it("keeps a script runnable (0555) and a plain file 0444, clearing setuid, setgid and sticky", async () => {
    const root = await tree();
    const script = join(root, "sub", "run.sh");
    await writeFile(script, "#!/bin/sh\necho ran\n", { mode: 0o755 });
    await chmod(script, 0o755);
    const owner = join(root, "owner-x.bin");
    await writeFile(owner, "x\n");
    await chmod(owner, 0o744);
    const special = join(root, "special.sh");
    await writeFile(special, "#!/bin/sh\n");
    await chmod(special, 0o6755);
    const plain = join(root, "plain.txt");
    await writeFile(plain, "p\n");
    await chmod(plain, 0o4644);
    await chmod(join(root, "sub"), 0o1755);
    await makeReadOnly(root, 20);
    const mode = async (path: string) => (await stat(path)).mode & 0o7777;
    expect(await mode(script)).toBe(0o555);
    expect(await mode(owner)).toBe(0o555);
    expect(await mode(special)).toBe(0o555);
    expect(await mode(plain)).toBe(0o444);
    expect(await mode(join(root, "a.txt"))).toBe(0o444);
    expect(await mode(join(root, "sub"))).toBe(0o555);
    expect((await exec(script, [])).stdout).toBe("ran\n");
  });

  it("refuses a tree past its bound, before changing anything", async () => {
    const root = await tree();
    await expect(makeReadOnly(root, 2)).rejects.toMatchObject({ code: "substrate_bridge_seed_failed" });
    expect((await stat(root)).mode & 0o777).not.toBe(0o555);
  });
});
