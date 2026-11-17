import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NATIVE_PLACEHOLDER_CAPABILITY } from "./protocol.js";
import {
  EXIT_REPORT_ATTEMPTS,
  exitCodeOf,
  reportExit,
  SPAWN_FAILED_CODE,
  superviseOnce,
  type SupervisorOptions,
} from "./substrate-supervisor.js";

const GATEWAY_URL = "http://wardby-native-gateway.wardby.svc.cluster.local:8790/prefix/native-gateway/v1/call";
const EXIT_URL = "http://wardby-native-gateway.wardby.svc.cluster.local:8790/prefix/native-gateway/v1/exit";
const RUN_ACTOR = "wr-0123456789abcdef0123-native";
// Obviously fake: a value the supervisor's environment might hold. It must reach no output.
const FAKE_SECRET = "fake_supervisor_secret_0009";

/** A metadata dir whose `name` is `name` (or no file at all). */
function metadataDir(name?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "native-supervisor-"));
  if (name !== undefined) writeFileSync(join(dir, "name"), `${name}\n`);
  return dir;
}

/** A fake child process: `exit` ends it; `killed` records the signals passed on. */
class FakeChild extends EventEmitter {
  readonly killed: string[] = [];
  kill(signal: string): boolean {
    this.killed.push(signal);
    return true;
  }
}

function harness(over: Partial<SupervisorOptions> & { status?: number[] } = {}) {
  const child = new FakeChild();
  const spawnCalls: unknown[][] = [];
  const spawn = vi.fn((...args: unknown[]) => {
    spawnCalls.push(args);
    return child;
  }) as unknown as SupervisorOptions["spawn"];
  const statuses = [...(over.status ?? [200])];
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
    if (status === 0) throw new Error(`connect ECONNREFUSED ${FAKE_SECRET}`);
    return new Response(status === 204 ? null : JSON.stringify({ ok: status < 300, leak: FAKE_SECRET }), { status });
  }) as unknown as typeof globalThis.fetch;
  const sleeps: number[] = [];
  const lines: string[] = [];
  const signals = new EventEmitter();
  const options: SupervisorOptions = {
    env: { WARDBY_NATIVE_SUBSTRATE: "1", NATIVE_GATEWAY_URL: GATEWAY_URL, SOME_VALUE: FAKE_SECRET },
    entry: "/opt/wardby/native-worker/main.js",
    execPath: "/usr/local/bin/node",
    execArgv: [],
    metadataDir: metadataDir(RUN_ACTOR),
    spawn,
    fetch,
    sleep: async (ms) => void sleeps.push(ms),
    write: (line) => void lines.push(line),
    signals: signals as unknown as Pick<NodeJS.Process, "on">,
    ...over,
  };
  return { child, spawnCalls, requests, sleeps, lines, signals, options };
}

describe("exitCodeOf", () => {
  it("is the exit code, or 128 + the signal's number", () => {
    expect(exitCodeOf(0, null)).toBe(0);
    expect(exitCodeOf(1, null)).toBe(1);
    expect(exitCodeOf(null, "SIGKILL")).toBe(137);
    expect(exitCodeOf(null, "SIGTERM")).toBe(143);
    expect(exitCodeOf(null, null)).toBe(1);
  });
});

describe("superviseOnce", () => {
  it("starts the same entry as the supervised worker, with its env, sharing stdio", async () => {
    const h = harness();
    const done = superviseOnce(h.options);
    h.child.emit("exit", 0, null);
    await done;
    expect(h.spawnCalls).toEqual([
      [
        "/usr/local/bin/node",
        ["/opt/wardby/native-worker/main.js"],
        {
          env: { ...h.options.env, WARDBY_NATIVE_SUPERVISED: "1" },
          stdio: "inherit",
        },
      ],
    ]);
  });

  it("reports a run worker's exit code to the gateway's exit route with the placeholder bearer", async () => {
    const h = harness();
    const done = superviseOnce(h.options);
    h.child.emit("exit", 1, null);
    expect(await done).toEqual({ code: 1, report: "reported" });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].url).toBe(EXIT_URL);
    expect(h.requests[0].init?.method).toBe("POST");
    expect(JSON.parse(h.requests[0].init?.body as string)).toEqual({ code: 1 });
    expect(new Headers(h.requests[0].init?.headers).get("authorization")).toBe(
      `Bearer ${NATIVE_PLACEHOLDER_CAPABILITY}`,
    );
    expect(h.lines).toEqual(["native sandbox worker exited: code 1, exit reported\n"]);
  });

  it("reports a signal as 128 + its number", async () => {
    const h = harness();
    const done = superviseOnce(h.options);
    h.child.emit("exit", null, "SIGKILL");
    expect(await done).toEqual({ code: 137, report: "reported" });
    expect(JSON.parse(h.requests[0].init?.body as string)).toEqual({ code: 137 });
  });

  it("reports 127 when the worker cannot be started", async () => {
    const h = harness();
    const done = superviseOnce(h.options);
    h.child.emit("error", new Error("spawn ENOENT"));
    expect(await done).toEqual({ code: SPAWN_FAILED_CODE, report: "reported" });
  });

  it.each([
    ["the golden actor (no name yet)", undefined],
    ["the golden actor (a name that is not a run's)", "wardby-native-0123456789abcdef-golden"],
    ["a startup canary", "wr-0123456789abcdef0123-canary"],
  ])("makes no request at all for %s", async (_name, name) => {
    const h = harness({ metadataDir: metadataDir(name) });
    const done = superviseOnce(h.options);
    h.child.emit("exit", 1, null);
    expect(await done).toEqual({ code: 1, report: "skipped" });
    expect(h.requests).toEqual([]);
  });

  it("makes no request without an http gateway URL", async () => {
    const h = harness({ env: { WARDBY_NATIVE_SUBSTRATE: "1", NATIVE_GATEWAY_URL: "https://gateway.example/x" } });
    const done = superviseOnce(h.options);
    h.child.emit("exit", 1, null);
    expect((await done).report).toBe("skipped");
    expect(h.requests).toEqual([]);
  });

  it("passes SIGTERM and SIGINT on to the worker while it runs", async () => {
    const h = harness();
    const done = superviseOnce(h.options);
    h.signals.emit("SIGTERM");
    h.signals.emit("SIGINT");
    h.child.emit("exit", null, "SIGTERM");
    await done;
    h.signals.emit("SIGTERM");
    expect(h.child.killed).toEqual(["SIGTERM", "SIGINT"]);
  });

  it("never puts an environment value, the actor's name or an answer's text in its line or request", async () => {
    const h = harness({ status: [0, 503, 401] });
    const done = superviseOnce(h.options);
    h.child.emit("exit", 1, null);
    expect(await done).toEqual({ code: 1, report: "refused" });
    const out = JSON.stringify([h.lines, h.requests.map((r) => [r.url, r.init?.body, r.init?.headers])]);
    expect(out).not.toContain(FAKE_SECRET);
    expect(out).not.toContain(RUN_ACTOR);
    expect(h.lines).toEqual(["native sandbox worker exited: code 1, exit refused\n"]);
  });
});

describe("reportExit", () => {
  it("retries a network failure or a 5xx, then gives up", async () => {
    const h = harness({ status: [0, 503, 0, 500] });
    expect(await reportExit(EXIT_URL, 1, h.options)).toBe("unreported");
    expect(h.requests).toHaveLength(EXIT_REPORT_ATTEMPTS);
    expect(h.sleeps).toEqual([2_000, 2_000, 2_000]);
  });

  it("stops at once on a refusal (401, 400): the gateway said no", async () => {
    for (const status of [401, 400]) {
      const h = harness({ status: [status] });
      expect(await reportExit(EXIT_URL, 1, h.options)).toBe("refused");
      expect(h.requests).toHaveLength(1);
    }
  });

  it("succeeds on a later attempt", async () => {
    const h = harness({ status: [0, 200] });
    expect(await reportExit(EXIT_URL, 3, h.options)).toBe("reported");
    expect(h.requests).toHaveLength(2);
  });
});
