import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WORKER_BUDGET_EXHAUSTED_SUMMARY } from "../coding/continuation-wording.js";
import { deriveRegistryToken } from "../coding/registry/token.js";
import type { CodingTaskInput } from "../coding/protocol.js";
import { CODING_OUTPUT_JSON_SCHEMA, runCodingWorker, WORKER_SECURITY_INSTRUCTIONS } from "./driver.js";
import type { DependencyCacheModule, WorkerClientConfig, WorkerEvent, WorkerThread } from "./types.js";
import {
  BUDGET_MEASURE_TIMEOUT_MS,
  DEFAULT_TIMEOUTS,
  dependencyCacheBudget,
  dependencyCacheTimeLimit,
} from "./dependency-cache.mjs";
import { createDebugTracer } from "./debug-trace.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wardby-driver-"));
}

const input: CodingTaskInput = {
  schemaVersion: 1,
  runId: "run_123",
  repository: "openai/example",
  baseRef: "main",
  headRef: "wardby/run-run_123",
  task: "Fix the failing test.",
  model: "gpt-5.6-luna",
  budgetUsd: 1,
  deadlineAt: "2026-09-07T13:00:00.000Z",
};

async function* events(values: WorkerEvent[]) {
  yield* values;
}

function clientFor(values: WorkerEvent[], capture: { config?: WorkerClientConfig; thread?: unknown; prompt?: string }) {
  return (config: WorkerClientConfig) => {
    capture.config = config;
    return {
      startThread(options: unknown) {
        capture.thread = options;
        return {
          async runStreamed(prompt: string) {
            capture.prompt = prompt;
            return { events: events(values) };
          },
        } as WorkerThread;
      },
    };
  };
}

describe("runCodingWorker", () => {
  it("pins the model, workspace sandbox, proxy capability, and immutable developer policy", async () => {
    const capture: { config?: WorkerClientConfig; thread?: unknown; prompt?: string } = {};
    const progress = vi.fn();
    const workspace = await tempWorkspace();
    const output = JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      outcome: "changes_ready",
      summary: "Fixed the test.",
      tests: [{ command: "npm test", outcome: "passed" }],
    });
    const result = await runCodingWorker({
      input,
      workspace,
      proxyBaseUrl: "http://proxy:8080",
      capability: "rrp_worker_capability",
      signal: new AbortController().signal,
      createClient: clientFor(
        [
          { type: "turn.started" },
          { type: "item.started", item: { type: "command_execution", status: "in_progress" } },
          { type: "item.started", item: { type: input.task, status: "SECRET_PROVIDER_STATUS" } },
          { type: "item.completed", item: { type: "agent_message", status: "completed", text: output } },
          { type: "turn.completed" },
        ],
        capture,
      ),
      onProgress: progress,
    });

    expect(result.outcome).toBe("changes_ready");
    expect(capture.config).toMatchObject({
      proxyBaseUrl: "http://proxy:8080",
      capability: "rrp_worker_capability",
      developerInstructions: WORKER_SECURITY_INSTRUCTIONS,
      environment: expect.objectContaining({
        HOME: "/home/wardby",
        LANG: "C.UTF-8",
        PATH: "/opt/wardby/bin:/usr/local/bin:/usr/bin:/bin",
        TMPDIR: join(workspace, ".cache", "tmp"),
        npm_config_registry: "http://proxy:8080/registry/npm/",
      }),
    });
    expect((await stat(join(workspace, ".cache", "tmp"))).isDirectory()).toBe(true);
    expect((await stat(join(workspace, ".cache", "tmp"))).mode & 0o777).toBe(0o700);
    expect(capture.thread).toEqual({
      model: input.model,
      sandboxMode: "danger-full-access",
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
    });
    expect(capture.prompt).toContain(input.task);
    expect(WORKER_SECURITY_INSTRUCTIONS).toContain("AGENTS.md");
    expect(JSON.stringify(progress.mock.calls)).not.toContain(input.task);
    expect(JSON.stringify(progress.mock.calls)).not.toContain("npm test");
    expect(JSON.stringify(progress.mock.calls)).not.toContain("SECRET_PROVIDER_STATUS");
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ type: "activity", kind: "other" }));
  });

  it("points npm and pip at the proxy with the registry token, never the capability", async () => {
    const workspace = await tempWorkspace();
    const capability = "rrp_worker_capability";
    const proxyBaseUrl = "http://proxy:8080";
    const capture: { config?: WorkerClientConfig } = {};
    const output = JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      outcome: "no_changes",
      summary: "None.",
      tests: [],
    });
    await runCodingWorker({
      input,
      workspace,
      proxyBaseUrl,
      capability,
      signal: new AbortController().signal,
      createClient: clientFor([{ type: "item.completed", item: { type: "agent_message", text: output } }], capture),
    });

    const env = capture.config!.environment;
    expect(env.npm_config_registry).toBe(`${proxyBaseUrl}/registry/npm/`);
    expect(env.PIP_INDEX_URL).toContain(deriveRegistryToken(capability));
    expect(JSON.stringify(env)).not.toContain(capability);
    expect(await readFile(join(workspace, ".cache", "npm", "npmrc"), "utf8")).toContain("_authToken=rrg_");
  });

  it("hands the run's service variables to the agent's shells, never over its own", async () => {
    const workspace = await tempWorkspace();
    const capture: { config?: WorkerClientConfig } = {};
    const output = JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      outcome: "no_changes",
      summary: "None.",
      tests: [],
    });
    await runCodingWorker({
      input: {
        ...input,
        services: [
          {
            name: "postgres",
            version: "16",
            testEnv: { DATABASE_URL: "postgres://test:test@127.0.0.1:5432/test", PGHOST: "127.0.0.1", PATH: "/evil" },
          },
          {
            name: "mysql",
            version: "8",
            testEnv: { DATABASE_URL: "mysql://test:test@127.0.0.1:3306/test", MYSQL_HOST: "127.0.0.1" },
          },
        ],
      },
      workspace,
      proxyBaseUrl: "http://proxy:8080",
      capability: "rrp_worker_capability",
      signal: new AbortController().signal,
      createClient: clientFor([{ type: "item.completed", item: { type: "agent_message", text: output } }], capture),
    });

    const env = capture.config!.environment;
    // The first service listed wins a shared name; the worker's own PATH always wins.
    expect(env).toMatchObject({
      DATABASE_URL: "postgres://test:test@127.0.0.1:5432/test",
      PGHOST: "127.0.0.1",
      MYSQL_HOST: "127.0.0.1",
      PATH: "/opt/wardby/bin:/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/wardby",
    });
  });

  it("gives a run without services no service variables", async () => {
    const workspace = await tempWorkspace();
    const capture: { config?: WorkerClientConfig } = {};
    const output = JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      outcome: "no_changes",
      summary: "None.",
      tests: [],
    });
    await runCodingWorker({
      input,
      workspace,
      proxyBaseUrl: "http://proxy:8080",
      capability: "rrp_worker_capability",
      signal: new AbortController().signal,
      createClient: clientFor([{ type: "item.completed", item: { type: "agent_message", text: output } }], capture),
    });
    expect(capture.config!.environment).not.toHaveProperty("DATABASE_URL");
  });

  it("rewrites proxy tarball URLs in collected npm lockfiles back to the public registry", async () => {
    const workspace = await tempWorkspace();
    const proxied = `{\n  "resolved": "http://proxy:8080/registry/npm/-/tarball/%40react-aria%2Flive-announcer/3.5.1"\n}\n`;
    const output = JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      outcome: "changes_ready",
      summary: "Added a dependency.",
      tests: [],
    });
    await runCodingWorker({
      input,
      workspace,
      proxyBaseUrl: "http://proxy:8080",
      capability: "cap",
      signal: new AbortController().signal,
      createClient: () => ({
        startThread: () => ({
          async runStreamed() {
            // What `npm install` leaves behind in a subdirectory during the agent's turn.
            await mkdir(join(workspace, "web"));
            await writeFile(join(workspace, "web", "package-lock.json"), proxied);
            return { events: events([{ type: "item.completed", item: { type: "agent_message", text: output } }]) };
          },
        }),
      }),
    });

    expect(await readFile(join(workspace, "web", "package-lock.json"), "utf8")).toBe(
      `{\n  "resolved": "https://registry.npmjs.org/@react-aria/live-announcer/-/live-announcer-3.5.1.tgz"\n}\n`,
    );
  });

  it("rejects a structured result bound to another run", async () => {
    const output = JSON.stringify({
      schemaVersion: 1,
      runId: "run_other",
      outcome: "no_changes",
      summary: "None.",
      tests: [],
    });
    await expect(
      runCodingWorker({
        input,
        workspace: await tempWorkspace(),
        proxyBaseUrl: "http://proxy",
        capability: "cap",
        signal: new AbortController().signal,
        createClient: clientFor([{ type: "item.completed", item: { type: "agent_message", text: output } }], {}),
      }),
    ).rejects.toThrow("coding_output_run_mismatch");
  });

  it("returns a bounded budget result without reflecting provider errors", async () => {
    const result = await runCodingWorker({
      input,
      workspace: await tempWorkspace(),
      proxyBaseUrl: "http://proxy",
      capability: "cap",
      signal: new AbortController().signal,
      createClient: clientFor(
        [{ type: "turn.failed", error: { message: "wardby_budget_exhausted SECRET_PROVIDER_BODY" } }],
        {},
      ),
    });
    expect(result).toMatchObject({
      runId: input.runId,
      outcome: "budget_exhausted",
      summary: WORKER_BUDGET_EXHAUSTED_SUMMARY,
      tests: [],
    });
    expect(JSON.stringify(result)).not.toContain("SECRET_PROVIDER_BODY");
  });

  it("redacts the per-run proxy capability from structured results", async () => {
    const capability = `rrp_${"A".repeat(43)}`;
    const output = JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      outcome: "changes_ready",
      summary: `Completed with ${capability}`,
      tests: [{ command: `echo ${capability}`, outcome: "passed" }],
    });
    const result = await runCodingWorker({
      input,
      workspace: await tempWorkspace(),
      proxyBaseUrl: "http://proxy",
      capability,
      signal: new AbortController().signal,
      createClient: clientFor([{ type: "item.completed", item: { type: "agent_message", text: output } }], {}),
    });

    expect(JSON.stringify(result)).not.toContain(capability);
    expect(result.summary).toContain("[REDACTED]");
    expect(result.tests[0]?.command).toContain("[REDACTED]");
  });

  it("fails closed when Codex emits no valid terminal output", async () => {
    await expect(
      runCodingWorker({
        input,
        workspace: await tempWorkspace(),
        proxyBaseUrl: "http://proxy",
        capability: "cap",
        signal: new AbortController().signal,
        createClient: clientFor([{ type: "turn.failed", error: { message: "raw upstream failure" } }], {}),
      }),
    ).rejects.toThrow("coding_turn_failed");
  });

  it("reports a fixed code when the Codex event stream terminates unexpectedly", async () => {
    const createClient = () => ({
      startThread: () => ({
        runStreamed: async () => ({
          events: (async function* () {
            yield { type: "turn.started" } as WorkerEvent;
            throw new Error("provider detail must not escape");
          })(),
        }),
      }),
    });

    await expect(
      runCodingWorker({
        input,
        workspace: await tempWorkspace(),
        proxyBaseUrl: "http://proxy",
        capability: "cap",
        signal: new AbortController().signal,
        createClient,
      }),
    ).rejects.toThrow("coding_stream_failed");
  });

  describe("a Codex stream that throws", () => {
    const throwing = (message: string) => () => ({
      startThread: () => ({
        runStreamed: async () => ({
          events: (async function* () {
            yield { type: "turn.started" } as WorkerEvent;
            throw new Error(message);
          })(),
        }),
      }),
    });
    const run = async (message: string) =>
      runCodingWorker({
        input,
        workspace: await tempWorkspace(),
        proxyBaseUrl: "http://proxy",
        capability: "cap",
        signal: new AbortController().signal,
        createClient: throwing(message),
      });

    it("is classified into a fixed code, never carrying the message", async () => {
      const cases: Array<[string, string]> = [
        ["unexpected status 401 Unauthorized: secret-detail", "coding_stream_proxy_denied"],
        ["unexpected status 403 Forbidden", "coding_stream_proxy_denied"],
        ["exceeded retry limit, last status: 429 Too Many Requests", "coding_stream_rate_limited"],
        // A spend limit or an empty balance is a 429 too, but retrying never helps: named apart.
        [
          'unexpected status 429 Too Many Requests: {"error":{"code":"insufficient_quota"}}',
          "coding_stream_quota_exceeded",
        ],
        [
          'exceeded retry limit, last status: 429 Too Many Requests: {"code":"project_spend_limit_exceeded"}',
          "coding_stream_quota_exceeded",
        ],
        ["You exceeded your current quota, please check your plan and billing details", "coding_stream_quota_exceeded"],
        ["unexpected status 502 Bad Gateway: upstream_transport_error", "coding_stream_upstream_error"],
        ["stream disconnected: request timed out", "coding_stream_timeout"],
        [
          "error sending request for url (http://proxy/v1/responses): connection refused",
          "coding_stream_proxy_unreachable",
        ],
        ["connection reset by peer", "coding_stream_proxy_unreachable"],
        ["Codex Exec exited with code 1: something private", "coding_stream_agent_exited"],
        ["provider detail must not escape", "coding_stream_failed"],
      ];
      for (const [message, code] of cases) {
        const failure = run(message);
        await expect(failure).rejects.toThrow(code);
        await expect(failure).rejects.not.toThrow(/secret|private|provider detail/);
      }
    });

    it("reports budget exhaustion as an outcome, not a failure", async () => {
      await expect(run("unexpected status 429 Too Many Requests: wardby_budget_exhausted")).resolves.toMatchObject({
        outcome: "budget_exhausted",
      });
    });
  });

  it("reports a fixed code when structured output violates the worker schema", async () => {
    await expect(
      runCodingWorker({
        input,
        workspace: await tempWorkspace(),
        proxyBaseUrl: "http://proxy",
        capability: "cap",
        signal: new AbortController().signal,
        createClient: clientFor(
          [{ type: "item.completed", item: { type: "agent_message", text: '{"unexpected":"value"}' } }],
          {},
        ),
      }),
    ).rejects.toThrow("coding_output_invalid");
  });
});

describe("runCodingWorker dependency cache", () => {
  const MiB = 1024 * 1024;
  const agentOutput = JSON.stringify({
    schemaVersion: 1,
    runId: input.runId,
    outcome: "no_changes",
    summary: "None.",
    tests: [],
  });
  const cacheInput: CodingTaskInput = {
    ...input,
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    dependencyCache: true,
    diskMb: 2048,
  };

  type PrepareOptions = Parameters<DependencyCacheModule["prepareDependencies"]>[0];

  /** A module whose budget is the real one and whose prepare/seal are recorded. */
  function fakeModule(order: string[], prepare: (options: PrepareOptions) => Promise<unknown>) {
    const seen: {
      prepare?: PrepareOptions;
      budget?: Parameters<DependencyCacheModule["dependencyCacheBudget"]>[0];
      seals: number;
    } = { seals: 0 };
    const module: DependencyCacheModule = {
      BUDGET_MEASURE_TIMEOUT_MS,
      dependencyCacheTimeLimit,
      dependencyCacheBudget: async (options) => {
        order.push("budget");
        seen.budget = options;
        return dependencyCacheBudget(options);
      },
      prepareDependencies: async (options) => {
        order.push("prepare");
        seen.prepare = options;
        return (await prepare(options)) as never;
      },
      sealUploadWindow: async () => {
        order.push("seal");
        seen.seals += 1;
        return { status: 200, confirmed: true };
      },
    };
    return { module, seen };
  }

  async function run(
    runInput: CodingTaskInput,
    loadDependencyCache: () => Promise<DependencyCacheModule>,
    capture: { config?: WorkerClientConfig; thread?: unknown; prompt?: string } = {},
    order: string[] = [],
    extra: { proxyBaseUrl?: string; signal?: AbortSignal; workspace?: string } = {},
  ) {
    const workspace = extra.workspace ?? (await tempWorkspace());
    const createClient = clientFor(
      [{ type: "item.completed", item: { type: "agent_message", text: agentOutput } }],
      capture,
    );
    const output = await runCodingWorker({
      input: runInput,
      workspace,
      proxyBaseUrl: extra.proxyBaseUrl ?? "http://proxy:8080",
      capability: "rrp_worker_capability",
      signal: extra.signal ?? new AbortController().signal,
      createClient: (config) => {
        order.push("client");
        return createClient(config);
      },
      loadDependencyCache,
    });
    return { output, workspace };
  }

  it("never loads the module when the run's flag is off, and reports nothing", async () => {
    const load = vi.fn(async () => fakeModule([], async () => ({ projects: [] })).module);
    const capture: { prompt?: string } = {};
    const { output } = await run(input, load, capture);
    expect(load).not.toHaveBeenCalled();
    expect("dependencyCache" in output).toBe(false);
    expect(capture.prompt).not.toContain("pre-installed");
  });

  it("runs it before the agent starts, with exactly the agent's shell env and none of the driver's", async () => {
    process.env.WARDBY_RUN_CAPABILITY = "rrp_driver_secret_sentinel";
    try {
      const capture: { config?: WorkerClientConfig; prompt?: string } = {};
      const order: string[] = [];
      const { module, seen } = fakeModule(order, async (options) => {
        // The registry's npmrc is already written when the module runs.
        await stat(options.env.npm_config_userconfig as string);
        return {
          projects: [{ path: ".", result: "hit", key: "abc", sizeBytes: 10, restoreMs: 5, rebuild: "skipped" }],
        };
      });
      const { output, workspace } = await run(
        {
          ...cacheInput,
          services: [{ name: "postgres", version: "16", testEnv: { DATABASE_URL: "postgres://db" } }],
        },
        async () => module,
        capture,
        order,
      );
      expect(order).toEqual(["budget", "prepare", "client"]);
      const env = seen.prepare!.env;
      expect(seen.prepare?.workspace).toBe(workspace);
      expect(env).toEqual(capture.config?.environment);
      expect(env.HOME).toBe("/home/wardby");
      expect(env.DATABASE_URL).toBe("postgres://db");
      expect(JSON.stringify(env)).not.toContain("rrp_driver_secret_sentinel");
      expect(JSON.stringify(env)).not.toContain("rrp_worker_capability");
      expect(env.WARDBY_RUN_CAPABILITY).toBeUndefined();
      expect(output.dependencyCache).toEqual({
        projects: [{ path: ".", result: "hit", key: "abc", sizeBytes: 10, restoreMs: 5, rebuild: "skipped" }],
      });
      expect(capture.prompt).toContain(
        "Dependencies are pre-installed from the committed lockfile in: the repo root. Don't run `npm ci` there; add packages with a single install command.",
      );
    } finally {
      delete process.env.WARDBY_RUN_CAPABILITY;
    }
  });

  it("budgets the run's volume minus what the workspace already uses, and passes the run's cancellation", async () => {
    const workspace = await tempWorkspace();
    await writeFile(join(workspace, "big.bin"), Buffer.alloc(5 * MiB, 1));
    const { module, seen } = fakeModule([], async () => ({ projects: [] }));
    const controller = new AbortController();
    await run({ ...cacheInput, diskMb: 1024 }, async () => module, {}, [], { workspace, signal: controller.signal });
    expect(seen.prepare?.budgetBytes).toBeLessThanOrEqual(1024 * MiB - 5 * MiB - 64 * MiB);
    expect(seen.prepare?.budgetBytes).toBeGreaterThan(0);
    expect(seen.prepare?.signal).toBe(controller.signal);
  });

  it("a volume too small is a budget skip, never an attempt, and the window is sealed before the agent", async () => {
    const order: string[] = [];
    const { module } = fakeModule(order, async () => ({ projects: [] }));
    const { output } = await run({ ...cacheInput, diskMb: 64 }, async () => module, {}, order);
    expect(order).toEqual(["budget", "seal", "client"]);
    expect(output.dependencyCache).toEqual({ projects: [], reason: "budget_too_small" });
  });

  it("no volume size (budget_unknown) is a skip too", async () => {
    const order: string[] = [];
    const { module } = fakeModule(order, async () => ({ projects: [] }));
    const { output } = await run({ ...cacheInput, diskMb: undefined }, async () => module, {}, order);
    expect(order).toEqual(["budget", "seal", "client"]);
    expect(output.dependencyCache).toEqual({ projects: [], reason: "budget_unknown" });
  });

  it("gives the cache at most half the time left before the run's deadline, the budget walk included", async () => {
    const { module, seen } = fakeModule([], async () => ({ projects: [] }));
    const deadlineAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await run({ ...cacheInput, deadlineAt }, async () => module);
    const totalMs = seen.prepare?.timeouts?.totalMs ?? 0;
    expect(totalMs).toBeLessThanOrEqual(5 * 60_000);
    expect(totalMs).toBeGreaterThan(5 * 60_000 - 10_000);
    expect(seen.budget?.timeoutMs).toBe(BUDGET_MEASURE_TIMEOUT_MS);

    // A long run keeps the module's own bound.
    const long = fakeModule([], async () => ({ projects: [] }));
    await run(cacheInput, async () => long.module);
    expect(long.seen.prepare?.timeouts?.totalMs).toBeLessThanOrEqual(DEFAULT_TIMEOUTS.totalMs);
    expect(long.seen.prepare?.timeouts?.totalMs).toBeGreaterThan(DEFAULT_TIMEOUTS.totalMs - 10_000);

    // A very short run bounds the budget walk too.
    const short = fakeModule([], async () => ({ projects: [] }));
    await run({ ...cacheInput, deadlineAt: new Date(Date.now() + 20_000).toISOString() }, async () => short.module);
    expect(short.seen.budget?.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it("skips the cache, sealed, when the deadline has passed", async () => {
    const order: string[] = [];
    const { module } = fakeModule(order, async () => ({ projects: [] }));
    const { output } = await run({ ...cacheInput, deadlineAt: input.deadlineAt }, async () => module, {}, order);
    expect(order).toEqual(["seal", "client"]);
    expect(output.dependencyCache).toEqual({ projects: [], reason: "timeout" });
  });

  it("adds no task note when nothing was installed", async () => {
    const capture: { prompt?: string } = {};
    const { module } = fakeModule([], async () => ({
      projects: [{ path: ".", result: "skipped", reason: "no_lockfile" }],
    }));
    const { output } = await run(cacheInput, async () => module, capture);
    expect(output.dependencyCache).toEqual({ projects: [{ path: ".", result: "skipped", reason: "no_lockfile" }] });
    expect(capture.prompt).not.toContain("pre-installed");
  });

  it("never fails the run: a module that throws is a worker_error, sealed before the agent starts", async () => {
    const capture: { prompt?: string } = {};
    const order: string[] = [];
    const { module } = fakeModule(order, async () => {
      throw new Error("boom SECRET");
    });
    const { output } = await run(cacheInput, async () => module, capture, order);
    expect(order).toEqual(["budget", "prepare", "seal", "client"]);
    expect(output.outcome).toBe("no_changes");
    expect(output.dependencyCache).toEqual({ projects: [], reason: "worker_error" });
    expect(capture.prompt).toContain(input.task);
  });

  it("a module that won't load is a worker_error, and the driver seals with the registry token itself", async () => {
    const seals: { path?: string; authorization?: string }[] = [];
    const order: string[] = [];
    const server = createServer((request, response) => {
      seals.push({ path: `${request.method} ${request.url}`, authorization: request.headers.authorization });
      order.push("seal");
      response.writeHead(200, { "content-type": "application/json" }).end('{"sealed":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const { output } = await run(
        cacheInput,
        async () => {
          throw new Error("ERR_MODULE_NOT_FOUND");
        },
        {},
        order,
        { proxyBaseUrl: `http://127.0.0.1:${port}` },
      );
      expect(order).toEqual(["seal", "client"]);
      expect(seals).toEqual([
        {
          path: "POST /cache/npm/seal",
          authorization: `Bearer ${deriveRegistryToken("rrp_worker_capability")}`,
        },
      ]);
      expect(output.dependencyCache).toEqual({ projects: [], reason: "worker_error" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("bounds what the module returned", async () => {
    const { module } = fakeModule([], async () => ({
      projects: [{ path: ".", result: "refused", reason: "npm said: ERR! raw output" }],
    }));
    const { output } = await run(cacheInput, async () => module);
    expect(output.dependencyCache).toEqual({ projects: [], omitted: 1 });
  });
});

describe("runCodingWorker debug trace", () => {
  const capability = `rrp_${"C".repeat(43)}`;
  const throwingClient = (message: string) => () => ({
    startThread: () => ({
      runStreamed: async () => ({
        events: (async function* () {
          yield { type: "turn.started" } as WorkerEvent;
          yield { type: "error", message: "reconnecting 1/3" } as WorkerEvent;
          throw new Error(message, { cause: new Error("spawn detail") });
        })(),
      }),
    }),
  });
  const traced = () => {
    const lines: string[] = [];
    const trace = createDebugTracer({ runId: input.runId, secrets: [capability], write: (line) => lines.push(line) });
    const records = () =>
      lines.map((line) => (JSON.parse(line) as { debugTrace: { kind: string; data: unknown } }).debugTrace);
    return { trace, lines, records };
  };

  it("records every stream event and the full stream error when traced, with the same fixed code", async () => {
    const { trace, lines, records } = traced();
    const failure = runCodingWorker({
      input,
      workspace: await tempWorkspace(),
      proxyBaseUrl: "http://proxy",
      capability,
      signal: new AbortController().signal,
      createClient: throwingClient(`Codex Exec exited with code 1: thread panicked, key ${capability}`),
      trace,
    });
    await expect(failure).rejects.toThrow("coding_stream_agent_exited");
    const kinds = records().map((record) => record.kind);
    expect(kinds).toEqual(["event", "event", "error_event", "stream_error"]);
    expect(records()[2].data).toEqual({ message: "reconnecting 1/3" });
    const streamError = records()[3].data as { message: string; stack: string; cause: { message: string } };
    expect(streamError.message).toContain("thread panicked");
    expect(streamError.stack).toContain("thread panicked");
    expect(streamError.cause.message).toBe("spawn detail");
    expect(lines.join("")).not.toContain(capability);
  });

  it("records a turn.failed event's text when traced", async () => {
    const { trace, records } = traced();
    await expect(
      runCodingWorker({
        input,
        workspace: await tempWorkspace(),
        proxyBaseUrl: "http://proxy",
        capability,
        signal: new AbortController().signal,
        createClient: clientFor([{ type: "turn.failed", error: { message: "model refused: context too long" } }], {}),
        trace,
      }),
    ).rejects.toThrow("coding_turn_failed");
    expect(records().map((record) => record.kind)).toEqual(["event", "turn_failed"]);
    expect(records()[1].data).toEqual({ message: "model refused: context too long" });
  });

  it("writes nothing to stdout or stderr and fails identically when not traced", async () => {
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    try {
      const failure = runCodingWorker({
        input,
        workspace: await tempWorkspace(),
        proxyBaseUrl: "http://proxy",
        capability,
        signal: new AbortController().signal,
        createClient: throwingClient("Codex Exec exited with code 1: private"),
      });
      await expect(failure).rejects.toThrow(/^coding_stream_agent_exited$/);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

describe("CODING_OUTPUT_JSON_SCHEMA", () => {
  it("marks every property required with a nullable type for tag, per OpenAI's strict Structured Outputs rules", () => {
    // additionalProperties:false + strict mode requires every key in "properties" to appear in
    // "required" — optionality is expressed via a nullable type, never by omitting the key.
    // Getting this wrong (tag was once absent from "required") makes OpenAI reject every request
    // with an HTTP 400 before the model runs at all, regardless of whether a tag is even relevant.
    expect(CODING_OUTPUT_JSON_SCHEMA.required).toEqual(Object.keys(CODING_OUTPUT_JSON_SCHEMA.properties));
    expect(CODING_OUTPUT_JSON_SCHEMA.properties.tag).toMatchObject({ type: ["string", "null"] });
    expect(CODING_OUTPUT_JSON_SCHEMA.properties.tag.description).toContain("32 characters");
  });
});
