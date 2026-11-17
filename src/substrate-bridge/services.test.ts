import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseServicesReport } from "../providers/jobs/substrate/names.js";
import { MAX_SERVICE_SCRIPT_BYTES, SERVICE_START_MARKER_MS } from "./constants.js";
import { DEFAULT_POLICY } from "./http.js";
import {
  parseServicesWaitMs,
  parseSetupServices,
  parseStateLine,
  ServicesUnreadyError,
  startServices,
  type SetupService,
} from "./services.js";

const FAST = { ...DEFAULT_POLICY, baseMs: 5, maxMs: 20, retryAfterCapMs: 20 };
const TOKEN = "wr-0123456789abcdef0123";
/** What a real start script carries: serviceEnv values, readiness and start arguments. */
const SCRIPT = [
  "#!/bin/sh",
  "export FAKEDB_PASSWORD='FAKE_SERVICE_ENV_VALUE_0001'",
  "'fakedb' '--fake-start-arg-0001' &",
  "'fakedb-ready' 'FAKE_READINESS_ARG_0001'",
].join("\n");
const LOG_KEYS = ["event", "runToken", "service", "state", "attempts", "reason", "count", "ms"];

describe("parseSetupServices", () => {
  it("takes an absent list as none and a valid one as it is", () => {
    expect(parseSetupServices(undefined)).toEqual([]);
    expect(parseSetupServices([{ name: "postgres", script: "S" }])).toEqual([{ name: "postgres", script: "S" }]);
  });

  it.each([
    ["six entries", Array.from({ length: 6 }, (_, i) => ({ name: `svc-${i}`, script: "S" }))],
    ["an upper-case name", [{ name: "Postgres", script: "S" }]],
    [
      "a duplicate",
      [
        { name: "postgres", script: "S" },
        { name: "postgres", script: "T" },
      ],
    ],
    ["another key", [{ name: "postgres", script: "S", env: {} }]],
    ["a non-string script", [{ name: "postgres", script: 5 }]],
    ["an oversized script", [{ name: "postgres", script: "x".repeat(MAX_SERVICE_SCRIPT_BYTES + 1) }]],
    ["not a list", "nope"],
    ["a non-object entry", ["postgres"]],
  ])("refuses %s", (_label, value) => {
    expect(parseSetupServices(value)).toBeUndefined();
  });
});

describe("parseServicesWaitMs", () => {
  it("takes an integer from 1 ms to an hour", () => {
    expect(parseServicesWaitMs(1)).toBe(1);
    expect(parseServicesWaitMs(150_000)).toBe(150_000);
    expect(parseServicesWaitMs(3_600_000)).toBe(3_600_000);
  });

  it.each([[0], [-1], [1.5], [3_600_001], ["150000"], [undefined], [Number.NaN]])("refuses %s", (value) => {
    expect(parseServicesWaitMs(value)).toBeUndefined();
  });
});

describe("parseStateLine", () => {
  it("maps each token form", () => {
    expect(parseStateLine("state=starting\n")).toEqual({ state: "pending" });
    expect(parseStateLine("state=probing attempts=3\n")).toEqual({ state: "probing", attempts: 3 });
    expect(parseStateLine("state=ready\n")).toEqual({ state: "ready" });
    expect(parseStateLine("state=failed reason=probe_failed\n")).toEqual({ state: "failed", reason: "probe_failed" });
    expect(parseStateLine("state=exited\n")).toEqual({ state: "failed", reason: "exited" });
    expect(parseStateLine("state=ready")).toEqual({ state: "ready" });
  });

  it.each([
    ["state=ready extra"],
    ["state=probing attempts=x"],
    ["state=probing"],
    ["state=failed"],
    ["state=failed reason=FAKE_SERVICE_ENV_VALUE_0001"],
    ["state=ready attempts=1"],
    ["state=ready\n\n"],
    [""],
  ])("refuses %j", (text) => {
    expect(parseStateLine(text)).toBeUndefined();
  });
});

describe("startServices", () => {
  let dir: string;
  let root: string;
  let server: Server;
  let base: string;
  let bodies: unknown[];
  let logs: string[];
  let clock: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridge-services-"));
    root = join(dir, "services");
    bodies = [];
    logs = [];
    clock = 0;
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.method === "POST" && request.url === `/substrate/runs/${TOKEN}/services`) {
          bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          response.writeHead(200).end("{}");
        } else response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/substrate/runs/${TOKEN}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const services = (names: string[]): SetupService[] => names.map((name) => ({ name, script: SCRIPT }));
  const volumes = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i++) await mkdir(join(root, String(i)), { recursive: true });
  };
  const start = (list: SetupService[], extra: { waitMs?: number; signal?: AbortSignal } = {}) =>
    startServices({
      base,
      token: TOKEN,
      headers: {},
      root,
      services: list,
      waitMs: extra.waitMs ?? 60_000,
      pollMs: 10,
      policy: FAST,
      log: (event, fields = {}) => void logs.push(JSON.stringify({ event, ...fields })),
      signal: extra.signal ?? new AbortController().signal,
      now: () => clock,
    });
  const setState = (i: number, line: string) => writeFile(join(root, String(i), "state"), `${line}\n`);
  /** Waits until the posted reports include one matching `check`. */
  const posted = async (check: (body: string) => boolean): Promise<void> => {
    const until = Date.now() + 5000;
    while (!bodies.some((body) => check(JSON.stringify(body)))) {
      if (Date.now() > until) throw new Error("not posted");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const allFiles = async (folder: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) out.push(await readFile(join(entry.parentPath, entry.name), "utf8"));
    }
    return out;
  };

  it("writes each start.sh, reports every change, and removes the scripts once all are ready", async () => {
    await volumes(2);
    const list = services(["fakedb", "fakekv"]);
    const result = start(list);
    await posted(
      (body) => body === '{"services":[{"name":"fakedb","state":"pending"},{"name":"fakekv","state":"pending"}]}',
    );
    expect(await readFile(join(root, "0", "start.sh"), "utf8")).toBe(SCRIPT);
    expect(existsSync(join(root, "1", "start.sh"))).toBe(true);
    expect(existsSync(join(root, "0", "start.sh.tmp"))).toBe(false);
    for (const line of ["state=starting", "state=probing attempts=1", "state=ready"]) {
      await setState(0, line);
      await setState(1, line);
      await posted((body) =>
        body.includes(`"fakekv","state":"${line === "state=starting" ? "pending" : line.slice(6, 13).trim()}`),
      );
    }
    await expect(result).resolves.toEqual({ ok: true });
    expect(bodies[0]).toEqual({
      services: [
        { name: "fakedb", state: "pending" },
        { name: "fakekv", state: "pending" },
      ],
    });
    expect(bodies.at(-1)).toEqual({
      services: [
        { name: "fakedb", state: "ready" },
        { name: "fakekv", state: "ready" },
      ],
    });
    expect(bodies).toContainEqual({
      services: [
        { name: "fakedb", state: "probing", attempts: 1 },
        { name: "fakekv", state: "probing", attempts: 1 },
      ],
    });
    for (const body of bodies) expect(parseServicesReport(body, ["fakedb", "fakekv"])).toBeDefined();
    expect(existsSync(join(root, "0", "start.sh"))).toBe(false);
    expect(existsSync(join(root, "1", "start.sh"))).toBe(false);
    for (const text of await allFiles(root)) expect(text).not.toContain("FAKE_SERVICE_ENV_VALUE_0001");
    expect(logs.map((line) => JSON.parse(line).event)).toContain("substrate_bridge_services_ready");
  });

  describe("fails", () => {
    const last = (): { name: string; state: string; reason?: string }[] =>
      (bodies.at(-1) as { services: { name: string; state: string; reason?: string }[] }).services;

    it("on a probe failure", async () => {
      await volumes(1);
      const result = start(services(["fakedb"]));
      await setState(0, "state=failed reason=probe_failed");
      await expect(result).resolves.toEqual({ ok: false, service: "fakedb", reason: "probe_failed" });
      expect(last()).toEqual([{ name: "fakedb", state: "failed", reason: "probe_failed" }]);
      expect(existsSync(join(root, "0", "start.sh"))).toBe(true);
    });

    it("on an exit", async () => {
      await volumes(1);
      const result = start(services(["fakedb"]));
      await setState(0, "state=exited");
      await expect(result).resolves.toEqual({ ok: false, service: "fakedb", reason: "exited" });
      expect(last()).toEqual([{ name: "fakedb", state: "failed", reason: "exited" }]);
      expect(existsSync(join(root, "0", "start.sh"))).toBe(true);
    });

    it("on a missing start marker", async () => {
      await volumes(2);
      const result = start(services(["fakedb", "fakekv"]));
      await setState(0, "state=starting");
      await posted((body) => body.includes('"fakedb","state":"pending"'));
      clock = SERVICE_START_MARKER_MS - 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(bodies.some((body) => JSON.stringify(body).includes("failed"))).toBe(false);
      clock = SERVICE_START_MARKER_MS;
      await expect(result).resolves.toEqual({ ok: false, service: "fakekv", reason: "start_failed" });
      expect(last()).toEqual([
        { name: "fakedb", state: "pending" },
        { name: "fakekv", state: "failed", reason: "start_failed" },
      ]);
      expect(existsSync(join(root, "1", "start.sh"))).toBe(true);
    });

    it("on a volume it cannot write", async () => {
      // No volume directory: the script cannot be written.
      await expect(start(services(["fakedb"]))).resolves.toEqual({
        ok: false,
        service: "fakedb",
        reason: "start_failed",
      });
      expect(last()).toEqual([{ name: "fakedb", state: "failed", reason: "start_failed" }]);
    });

    it("at the deadline, for the first service not ready", async () => {
      await volumes(3);
      const result = start(services(["fakea", "fakeb", "fakec"]), { waitMs: 40_000 });
      await setState(0, "state=ready");
      await setState(1, "state=probing attempts=2");
      await setState(2, "state=probing attempts=4");
      await posted((body) => body.includes('"fakec","state":"probing","attempts":4'));
      clock = 40_000;
      await expect(result).resolves.toEqual({ ok: false, service: "fakeb", reason: "timed_out" });
      expect(last()).toEqual([
        { name: "fakea", state: "ready" },
        { name: "fakeb", state: "failed", reason: "timed_out" },
        { name: "fakec", state: "probing", attempts: 4 },
      ]);
      for (const i of [0, 1, 2]) expect(existsSync(join(root, String(i), "start.sh"))).toBe(true);
    });
  });

  it("retries the final failure report until it is delivered", async () => {
    // The first post carrying a failure is refused (a non-retriable status): the report must still arrive.
    let refused = 0;
    server.removeAllListeners("request");
    server.on("request", (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.includes('"failed"') && refused === 0) {
          refused++;
          response.writeHead(400).end();
          return;
        }
        bodies.push(JSON.parse(text));
        response.writeHead(200).end("{}");
      });
    });
    await volumes(1);
    const result = start(services(["fakedb"]));
    await setState(0, "state=failed reason=probe_failed");
    await expect(result).resolves.toEqual({ ok: false, service: "fakedb", reason: "probe_failed" });
    expect(refused).toBe(1);
    expect(bodies.at(-1)).toEqual({ services: [{ name: "fakedb", state: "failed", reason: "probe_failed" }] });
  });

  it("stops when its signal aborts", async () => {
    await volumes(1);
    const controller = new AbortController();
    const result = start(services(["fakedb"]), { signal: controller.signal });
    await posted(() => true);
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "substrate_bridge_stopped" });
  });

  it("logs fixed fields only", async () => {
    await volumes(2);
    const ok = start(services(["fakedb", "fakekv"]));
    await setState(0, "state=probing attempts=1");
    await setState(1, "state=ready");
    await posted((body) => body.includes('"fakedb","state":"probing"'));
    await setState(0, "state=ready");
    await expect(ok).resolves.toEqual({ ok: true });
    await rm(root, { recursive: true });
    await volumes(1);
    const failed = start(services(["fakedb"]));
    await setState(0, "state=exited");
    await expect(failed).resolves.toMatchObject({ ok: false });
    const withService = logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((f) => "service" in f);
    expect(withService.length).toBeGreaterThan(0);
    for (const fields of withService) for (const key of Object.keys(fields)) expect(LOG_KEYS).toContain(key);
    const text = logs.join("\n");
    for (const value of ["FAKE_SERVICE_ENV_VALUE_0001", "FAKE_READINESS_ARG_0001", "--fake-start-arg-0001"])
      expect(text).not.toContain(value);
    expect(logs.map((line) => JSON.parse(line).event)).toEqual(
      expect.arrayContaining([
        "substrate_bridge_services_written",
        "substrate_bridge_service_state",
        "substrate_bridge_services_ready",
      ]),
    );
  });

  it("names its error with a fixed code", () => {
    const error = new ServicesUnreadyError("fakedb", "probe_failed", async () => undefined);
    expect(error.code).toBe("substrate_bridge_service_unready");
    expect(error.service).toBe("fakedb");
    expect(error.reason).toBe("probe_failed");
  });
});
