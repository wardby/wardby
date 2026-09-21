import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writable(path: string): Promise<boolean> {
  try {
    await writeFile(path, "isolation-probe", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(750, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function baseline(): Promise<void> {
  const marker = randomUUID();
  const [status, route, pidOne] = await Promise.all([
    readFile("/proc/self/status", "utf8"),
    readFile("/proc/net/route", "utf8"),
    readFile("/proc/1/cmdline", "utf8"),
  ]);
  const statusValue = (key: string) => status.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
  const hasDefaultRoute = route
    .split("\n")
    .slice(1)
    .some((line) => line.trim().split(/\s+/)[1] === "00000000");
  const rawSocket = spawnSync("/usr/bin/perl", [
    "-MSocket",
    "-e",
    "socket(S, PF_INET, SOCK_RAW, 1) or exit 42; exit 0",
  ]);
  const result = {
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    noNewPrivs: statusValue("NoNewPrivs"),
    seccomp: statusValue("Seccomp"),
    effectiveCapabilities: statusValue("CapEff"),
    hasDefaultRoute,
    pidOne: pidOne.replaceAll("\0", " ").trim(),
    dockerSocketExists: await exists("/var/run/docker.sock"),
    hostPathExists: await exists("/host/etc/passwd"),
    rawSocketCreated: rawSocket.status === 0,
    writes: {
      workspace: await writable(`/workspace/.isolation-probe-${marker}`),
      git: await writable(`/workspace/.git/.isolation-probe-${marker}`),
      input: await writable(`/run/wardby/input/.isolation-probe-${marker}`),
      output: await writable(`/run/wardby/output/.isolation-probe-${marker}`),
      root: await writable(`/etc/.isolation-probe-${marker}`),
    },
    connects: {
      proxy: await canConnect("wardby-proxy", 8787),
      localhost: await canConnect("127.0.0.1", 8787),
      metadata: await canConnect("169.254.169.254", 80),
      publicInternet: await canConnect("1.1.1.1", 80),
    },
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function exhaustPids(): Promise<void> {
  const children: ReturnType<typeof spawn>[] = [];
  let failure: string | undefined;
  for (let index = 0; index < 512 && !failure; index += 1) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
      stdio: "ignore",
    });
    const outcome = await new Promise<string>((resolve) => {
      child.once("spawn", () => resolve("spawned"));
      child.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
    });
    if (outcome === "spawned") children.push(child);
    else failure = outcome;
  }
  for (const child of children) child.kill("SIGKILL");
  process.stdout.write(`${JSON.stringify({ spawned: children.length, failure })}\n`);
}

async function fillDisk(): Promise<void> {
  const chunk = Buffer.alloc(1024 * 1024, 1);
  let writtenMb = 0;
  let failure: string | undefined;
  while (writtenMb < 1024) {
    try {
      await writeFile(`/workspace/fill-${writtenMb}`, chunk);
      writtenMb += 1;
    } catch (error) {
      failure = (error as NodeJS.ErrnoException).code;
      break;
    }
  }
  process.stdout.write(`${JSON.stringify({ writtenMb, failure })}\n`);
}

async function consumeMemory(): Promise<void> {
  const allocations: Buffer[] = [];
  while (true) {
    allocations.push(Buffer.alloc(16 * 1024 * 1024, 1));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function main(): Promise<void> {
  switch (process.argv[2]) {
    case "baseline":
      await baseline();
      return;
    case "pids":
      await exhaustPids();
      return;
    case "disk":
      await fillDisk();
      return;
    case "oom":
      await consumeMemory();
      return;
    case "hang":
      await new Promise(() => undefined);
      return;
    default:
      throw new Error("unknown_isolation_probe");
  }
}

main().catch(() => {
  process.exitCode = 1;
});
