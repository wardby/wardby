import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_CODING_SERVICES } from "../../../coding/services/builtins.js";
import {
  ResolvedCodingServiceSchema,
  resolvedFromDefinition,
  type ResolvedCodingService,
} from "../../../coding/services/catalog.js";
import {
  MAX_SERVICE_SCRIPT_BYTES,
  MAX_SERVICE_SCRIPTS_BYTES,
  SERVICE_SCRIPT_DIR,
  SERVICE_STATE_LINE,
  serviceStartScript,
  servicesInOrder,
  servicesWaitMs,
  shellQuote,
  substrateServiceProblems,
} from "./service-script.js";

const PINNED_POSTGRES =
  [
    "#!/bin/sh",
    "# wardby service start script (generated; never logged).",
    "dir='/run/wardby-svc'",
    'st() { printf \'%s\\n\' "$1" > "$dir/state.tmp" && mv -f "$dir/state.tmp" "$dir/state"; }',
    "idle() { while :; do sleep 3600; done; }",
    "st 'state=starting'",
    "export PGDATA='/var/lib/postgresql/data/pgdata'",
    "export POSTGRES_DB='test'",
    "export POSTGRES_PASSWORD='test'",
    "export POSTGRES_USER='test'",
    "'docker-entrypoint.sh' 'postgres' &",
    "pid=$!",
    'if command -v timeout >/dev/null 2>&1; then t="timeout 2"; else t=""; fi',
    "n=0",
    "while :; do",
    "  if ! kill -0 \"$pid\" 2>/dev/null; then st 'state=exited'; idle; fi",
    "  if $t 'pg_isready' '-h' '127.0.0.1' '-p' '5432' '-U' 'test' '-d' 'test' >/dev/null 2>&1; then st 'state=ready'; break; fi",
    "  n=$((n + 1))",
    "  if [ \"$n\" -ge 30 ]; then st 'state=failed reason=probe_failed'; idle; fi",
    '  st "state=probing attempts=$n"',
    "  sleep 2",
    "done",
    'wait "$pid"',
    "st 'state=exited'",
    "idle",
  ].join("\n") + "\n";

const PINNED_REDIS =
  [
    "#!/bin/sh",
    "# wardby service start script (generated; never logged).",
    "dir='/run/wardby-svc'",
    'st() { printf \'%s\\n\' "$1" > "$dir/state.tmp" && mv -f "$dir/state.tmp" "$dir/state"; }',
    "idle() { while :; do sleep 3600; done; }",
    "st 'state=starting'",
    "'docker-entrypoint.sh' 'redis-server' &",
    "pid=$!",
    'if command -v timeout >/dev/null 2>&1; then t="timeout 2"; else t=""; fi',
    "n=0",
    "while :; do",
    "  if ! kill -0 \"$pid\" 2>/dev/null; then st 'state=exited'; idle; fi",
    "  if $t 'redis-cli' '-h' '127.0.0.1' '-p' '6379' 'ping' >/dev/null 2>&1; then st 'state=ready'; break; fi",
    "  n=$((n + 1))",
    "  if [ \"$n\" -ge 30 ]; then st 'state=failed reason=probe_failed'; idle; fi",
    '  st "state=probing attempts=$n"',
    "  sleep 1",
    "done",
    'wait "$pid"',
    "st 'state=exited'",
    "idle",
  ].join("\n") + "\n";

const PINNED_MYSQL =
  [
    "#!/bin/sh",
    "# wardby service start script (generated; never logged).",
    "dir='/run/wardby-svc'",
    'st() { printf \'%s\\n\' "$1" > "$dir/state.tmp" && mv -f "$dir/state.tmp" "$dir/state"; }',
    "idle() { while :; do sleep 3600; done; }",
    "st 'state=starting'",
    "export MYSQL_DATABASE='test'",
    "export MYSQL_PASSWORD='test'",
    "export MYSQL_ROOT_PASSWORD='test'",
    "export MYSQL_USER='test'",
    "'docker-entrypoint.sh' 'mysqld' &",
    "pid=$!",
    'if command -v timeout >/dev/null 2>&1; then t="timeout 3"; else t=""; fi',
    "n=0",
    "while :; do",
    "  if ! kill -0 \"$pid\" 2>/dev/null; then st 'state=exited'; idle; fi",
    "  if $t 'mysqladmin' 'ping' '-h' '127.0.0.1' '-P' '3306' '-utest' '-ptest' '--silent' >/dev/null 2>&1; then st 'state=ready'; break; fi",
    "  n=$((n + 1))",
    "  if [ \"$n\" -ge 45 ]; then st 'state=failed reason=probe_failed'; idle; fi",
    '  st "state=probing attempts=$n"',
    "  sleep 2",
    "done",
    'wait "$pid"',
    "st 'state=exited'",
    "idle",
  ].join("\n") + "\n";

function builtin(name: string, version: string): ResolvedCodingService {
  const definition = BUILTIN_CODING_SERVICES.find((s) => s.name === name && s.version === version);
  if (!definition) throw new Error(`no built-in ${name} ${version}`);
  return resolvedFromDefinition(definition);
}

const FAKE_SERVICE: ResolvedCodingService = {
  name: "fakedb",
  version: "1",
  image: `registry.example/fakedb@sha256:${"b".repeat(64)}`,
  port: 5999,
  serviceEnv: { FAKEDB_PASSWORD: "FAKE_SERVICE_ENV_VALUE_0001", FAKEDB_QUOTE: "it's $HOME `x`" },
  testEnv: {},
  readiness: { command: ["true"], periodSeconds: 1, timeoutSeconds: 1, failureThreshold: 3 },
  startCommand: ["true"],
  resources: { cpuMillicores: 100, memoryMib: 64, diskMib: 64 },
  dataPath: "/var/lib/fakedb",
  writablePaths: [],
};

describe("shellQuote", () => {
  it("quotes plain values and embedded single quotes", () => {
    expect(shellQuote("abc")).toBe("'abc'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("keeps $, backticks, spaces, semicolons and newlines inside one word", () => {
    expect(shellQuote("$HOME")).toBe("'$HOME'");
    expect(shellQuote("`x`")).toBe("'`x`'");
    expect(shellQuote("a b; rm -rf /")).toBe("'a b; rm -rf /'");
    expect(shellQuote("a\nb")).toBe("'a\nb'");
  });
});

describe("serviceStartScript in a real shell", () => {
  const children: ChildProcess[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "svc-script-"));
    dirs.push(dir);
    return dir;
  };
  const run = (script: string, env?: NodeJS.ProcessEnv): ChildProcess => {
    const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore", ...(env ? { env } : {}) });
    children.push(child);
    return child;
  };
  const readState = (dir: string): string | undefined => {
    try {
      return readFileSync(join(dir, "state"), "utf8").trim();
    } catch {
      return undefined;
    }
  };
  const waitFor = async (check: () => boolean, ms: number): Promise<void> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const alive = (child: ChildProcess): boolean => {
    try {
      process.kill(child.pid as number, 0);
      return child.exitCode === null;
    } catch {
      return false;
    }
  };

  it.skipIf(!existsSync("/bin/sh"))(
    "runs the script in a real shell: quoting survives, env is exported, the probe gates ready",
    async () => {
      const dir = tempDir();
      const out = join(dir, "env.out");
      const service: ResolvedCodingService = {
        ...FAKE_SERVICE,
        startCommand: ["/bin/sh", "-c", 'printf "%s|%s" "$FAKEDB_PASSWORD" "$FAKEDB_QUOTE" > "$0"; exec sleep 30', out],
        readiness: { ...FAKE_SERVICE.readiness, command: ["/bin/sh", "-c", 'test -f "$0"', out] },
      };
      run(serviceStartScript(service, { stateDir: dir }));
      await waitFor(() => readState(dir) === "state=ready", 5000);
      expect(readState(dir)).toBe("state=ready");
      expect(readFileSync(out, "utf8")).toBe("FAKE_SERVICE_ENV_VALUE_0001|it's $HOME `x`");
    },
  );

  it("does not let a value with ; or a newline run as a command", async () => {
    const dir = tempDir();
    const marker = join(dir, "pwned");
    const out = join(dir, "env.out");
    const value = `x'; touch ${marker}; echo '\n$(touch ${marker})`;
    const service: ResolvedCodingService = {
      ...FAKE_SERVICE,
      serviceEnv: { FAKEDB_PASSWORD: value },
      startCommand: ["/bin/sh", "-c", 'printf "%s" "$FAKEDB_PASSWORD" > "$0"; exec sleep 30', out],
      readiness: { ...FAKE_SERVICE.readiness, command: ["/bin/sh", "-c", 'test -f "$0"', out] },
    };
    run(serviceStartScript(service, { stateDir: dir }));
    await waitFor(() => readState(dir) === "state=ready", 5000);
    expect(readFileSync(out, "utf8")).toBe(value);
    expect(existsSync(marker)).toBe(false);
  });

  it("fails after the threshold and never exits", async () => {
    const dir = tempDir();
    const service: ResolvedCodingService = {
      ...FAKE_SERVICE,
      startCommand: ["sleep", "30"],
      readiness: { command: ["false"], periodSeconds: 1, timeoutSeconds: 1, failureThreshold: 2 },
    };
    const child = run(serviceStartScript(service, { stateDir: dir }));
    const seen = new Set<string>();
    await waitFor(() => {
      const state = readState(dir);
      if (state) seen.add(state);
      return state === "state=failed reason=probe_failed";
    }, 8000);
    expect(readState(dir)).toBe("state=failed reason=probe_failed");
    expect(seen.has("state=probing attempts=1")).toBe(true);
    for (const line of seen) expect(SERVICE_STATE_LINE.test(line)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(alive(child)).toBe(true);
  }, 15_000);

  it("reports a start command that exits", async () => {
    const dir = tempDir();
    const service: ResolvedCodingService = {
      ...FAKE_SERVICE,
      startCommand: ["true"],
      readiness: { command: ["false"], periodSeconds: 1, timeoutSeconds: 1, failureThreshold: 5 },
    };
    const child = run(serviceStartScript(service, { stateDir: dir }));
    await waitFor(() => readState(dir) === "state=exited", 5000);
    expect(readState(dir)).toBe("state=exited");
    expect(alive(child)).toBe(true);
  });

  it("works without timeout", async () => {
    const dir = tempDir();
    const bin = tempDir();
    for (const tool of ["sh", "printf", "mv", "sleep", "kill", "true"]) {
      const found = ["/bin", "/usr/bin"].map((d) => join(d, tool)).find((p) => existsSync(p));
      if (found) symlinkSync(found, join(bin, tool));
    }
    mkdirSync(dir, { recursive: true });
    const service: ResolvedCodingService = {
      ...FAKE_SERVICE,
      startCommand: ["sleep", "30"],
      readiness: { command: ["true"], periodSeconds: 1, timeoutSeconds: 1, failureThreshold: 3 },
    };
    run(serviceStartScript(service, { stateDir: dir }), { PATH: bin });
    await waitFor(() => readState(dir) === "state=ready", 5000);
    expect(readState(dir)).toBe("state=ready");
  });
});

describe("serviceStartScript text", () => {
  it("pins the built-in scripts", () => {
    expect(serviceStartScript(builtin("postgres", "16"))).toBe(PINNED_POSTGRES);
    expect(serviceStartScript(builtin("redis", "7"))).toBe(PINNED_REDIS);
    expect(serviceStartScript(builtin("mysql", "8"))).toBe(PINNED_MYSQL);
    expect(PINNED_MYSQL).toContain(" '-ptest' ");
  });

  it("never carries a newline or control character from a value", () => {
    expect(ResolvedCodingServiceSchema.safeParse({ ...FAKE_SERVICE, serviceEnv: { A: "x\ny" } }).success).toBe(false);
    for (const script of [PINNED_POSTGRES, PINNED_REDIS, PINNED_MYSQL, serviceStartScript(FAKE_SERVICE)]) {
      for (const line of script.split("\n")) expect(line).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it("quotes every value, and logs nothing", () => {
    const logs: unknown[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => {
      const original = console[level];
      console[level] = (...args: unknown[]) => void logs.push(args);
      return () => {
        console[level] = original;
      };
    });
    let script: string;
    try {
      script = serviceStartScript(FAKE_SERVICE);
    } finally {
      for (const restore of spies) restore();
    }
    expect(logs).toEqual([]);
    expect(script).toContain("export FAKEDB_PASSWORD='FAKE_SERVICE_ENV_VALUE_0001'");
    expect(script).toContain("export FAKEDB_QUOTE='it'\\''s $HOME `x`'");
  });

  it("throws for an entry without a start command", () => {
    const { startCommand: _omit, ...without } = FAKE_SERVICE;
    expect(() => serviceStartScript(without)).toThrow("substrate_service_start_command_missing");
  });

  it("honours the state directory option", () => {
    expect(serviceStartScript(FAKE_SERVICE, { stateDir: "/tmp/it's" })).toContain("dir='/tmp/it'\\''s'");
  });
});

describe("substrateServiceProblems", () => {
  const { startCommand: _omit, ...WITHOUT_START } = FAKE_SERVICE;

  it("accepts the built-ins", () => {
    expect(substrateServiceProblems([builtin("postgres", "16"), builtin("redis", "7"), builtin("mysql", "8")])).toEqual(
      [],
    );
  });

  it("flags a missing start command", () => {
    expect(substrateServiceProblems([WITHOUT_START])).toEqual([{ name: "fakedb", reason: "start_command_missing" }]);
  });

  it.each([["/run/wardby-svc"], ["/run/wardby-svc/data"], ["/run"]])("reserves data path %s", (dataPath) => {
    expect(substrateServiceProblems([{ ...FAKE_SERVICE, dataPath }])).toEqual([
      { name: "fakedb", reason: "data_path_reserved" },
    ]);
  });

  it.each([["/run/wardby-other"], ["/run/wardby"], ["/var/run/wardby-svc"]])("allows data path %s", (dataPath) => {
    expect(substrateServiceProblems([{ ...FAKE_SERVICE, dataPath }])).toEqual([]);
  });

  it("reports a missing start command before a reserved path", () => {
    expect(substrateServiceProblems([{ ...WITHOUT_START, dataPath: SERVICE_SCRIPT_DIR }])).toEqual([
      { name: "fakedb", reason: "start_command_missing" },
    ]);
  });

  it("flags one script past its bound", () => {
    const serviceEnv = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`V${i}`, "v".repeat(1024)]));
    const big = { ...FAKE_SERVICE, serviceEnv };
    expect(Buffer.byteLength(serviceStartScript(big))).toBeGreaterThan(MAX_SERVICE_SCRIPT_BYTES);
    expect(substrateServiceProblems([big])).toEqual([{ name: "fakedb", reason: "setup_too_large" }]);
  });

  it("measures a script as it sits in the setup JSON, where quotes and backslashes take two bytes", () => {
    // Raw, the script fits its bound; JSON-escaped (codexWorkerSetup), it would not.
    const heavy = `"\\`.repeat(300);
    const serviceEnv = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`V${i}`, heavy]));
    const service = { ...FAKE_SERVICE, serviceEnv };
    const script = serviceStartScript(service);
    expect(Buffer.byteLength(script)).toBeLessThan(MAX_SERVICE_SCRIPT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(script))).toBeGreaterThan(MAX_SERVICE_SCRIPT_BYTES);
    expect(substrateServiceProblems([service])).toEqual([{ name: "fakedb", reason: "setup_too_large" }]);
  });

  it("measures the run's total as JSON too", () => {
    const fill = (name: string): ResolvedCodingService => ({
      ...FAKE_SERVICE,
      name,
      serviceEnv: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`V${i}`, `"\\`.repeat(300)])),
    });
    const raw = Buffer.byteLength(serviceStartScript(fill("a")));
    const json = Buffer.byteLength(JSON.stringify(serviceStartScript(fill("a"))));
    expect(raw * 5).toBeLessThan(MAX_SERVICE_SCRIPTS_BYTES);
    expect(json).toBeLessThan(MAX_SERVICE_SCRIPT_BYTES);
    expect(json * 5).toBeGreaterThan(MAX_SERVICE_SCRIPTS_BYTES);
    const names = ["svc-a", "svc-b", "svc-c", "svc-d", "svc-e"];
    expect(json * 4).toBeLessThan(MAX_SERVICE_SCRIPTS_BYTES);
    expect(substrateServiceProblems(names.map(fill))).toEqual([{ name: "svc-e", reason: "setup_too_large" }]);
  });

  it("flags the service that takes the total past its bound, in name order", () => {
    const fill = (name: string): ResolvedCodingService => ({
      ...FAKE_SERVICE,
      name,
      serviceEnv: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`V${i}`, "v".repeat(1000)])),
    });
    const size = Buffer.byteLength(serviceStartScript(fill("a")));
    expect(size).toBeLessThan(MAX_SERVICE_SCRIPT_BYTES);
    expect(size).toBeGreaterThan(13 * 1024);
    const names = ["svc-e", "svc-b", "svc-d", "svc-a", "svc-c"];
    expect(substrateServiceProblems(names.map(fill))).toEqual([{ name: "svc-e", reason: "setup_too_large" }]);
  });
});

describe("servicesWaitMs", () => {
  it("adds the marker bound to the probing time, capped", () => {
    expect(servicesWaitMs([builtin("postgres", "16")], 300_000)).toBe(150_000);
    expect(servicesWaitMs([builtin("postgres", "16"), builtin("mysql", "8")], 300_000)).toBe(300_000);
    expect(servicesWaitMs([], 300_000)).toBe(30_000);
  });
});

describe("servicesInOrder", () => {
  it("sorts by name without changing the input", () => {
    const input = [builtin("redis", "7"), builtin("mysql", "8"), builtin("postgres", "16")];
    expect(servicesInOrder(input).map((s) => s.name)).toEqual(["mysql", "postgres", "redis"]);
    expect(input.map((s) => s.name)).toEqual(["redis", "mysql", "postgres"]);
  });
});
