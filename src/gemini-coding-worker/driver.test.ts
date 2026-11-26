import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingTaskInput } from "../coding/protocol.js";
import { safeWorkerErrorCode } from "../coding-worker/errors.js";
import { GEMINI_DEADLINE_MARGIN_MS, geminiBaseArgs, runGeminiCodingWorker, type GeminiRunOptions } from "./driver.js";
import type { GeminiCliRun, GeminiCliSpawner } from "./process.js";

const CAPABILITY = "rrp_FAKEcapability0123456789";
const input: CodingTaskInput = {
  schemaVersion: 1,
  runId: "run_rec",
  repository: "openai/example",
  baseRef: "main",
  headRef: "wardby/run-run_rec",
  task: "Add hello.txt",
  model: "google-ai-studio.gemini-4-neon",
  budgetUsd: 1,
  deadlineAt: "2099-01-01T00:00:00.000Z",
};
const fixture = (scenario: string) => {
  const dir = new URL("./fixtures/stream/", import.meta.url);
  const meta = JSON.parse(readFileSync(new URL(`${scenario}.json`, dir), "utf8")) as {
    exit: number;
    stderrTail: string;
  };
  return {
    lines: readFileSync(new URL(`${scenario}.jsonl`, dir), "utf8")
      .split("\n")
      .filter(Boolean),
    ...meta,
  };
};

const versionRun = (version = "0.70.0"): GeminiCliRun => ({
  lines: (async function* () {
    yield version;
  })(),
  done: Promise.resolve({ code: 0, signal: null, stderrTail: "", oversizedLines: 0 }),
});

/** Answers `--version`, then each run with the next scenario's recording; `before` runs as each run starts. */
type Recording = ReturnType<typeof fixture>;
function fakeCli(...scenarios: (string | Recording)[]) {
  const calls: { args: readonly string[]; env: Record<string, string> }[] = [];
  const hooks: { before?: (run: number) => Promise<void> | void; oversized?: number } = {};
  const spawnCli: GeminiCliSpawner = (args, options) => {
    calls.push({ args, env: options.env });
    if (args[0] === "--version") return versionRun();
    const index = calls.length - 1;
    const next = scenarios.shift() ?? "success-tools";
    const f = typeof next === "string" ? fixture(next) : next;
    return {
      lines: (async function* () {
        await hooks.before?.(index);
        yield* f.lines;
      })(),
      done: Promise.resolve({
        code: f.exit,
        signal: null,
        stderrTail: f.stderrTail,
        oversizedLines: hooks.oversized ?? 0,
      }),
    };
  };
  return { spawnCli, calls, hooks };
}

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function options(extra: Partial<GeminiRunOptions> = {}): Promise<GeminiRunOptions> {
  root = await mkdtemp(join(tmpdir(), "wardby-gemini-driver-"));
  const system = join(root, "etc");
  await mkdir(join(system, "policies"), { recursive: true });
  await copyFile(new URL("./system-settings.json", import.meta.url), join(system, "settings.json"));
  await copyFile(new URL("./policies/wardby.toml", import.meta.url), join(system, "policies", "wardby.toml"));
  for (const dir of [system, join(system, "policies")]) await chmod(dir, 0o755);
  await mkdir(join(root, "workspace"), { recursive: true });
  return {
    input,
    workspace: join(root, "workspace"),
    planRoot: join(root, "plan"),
    home: join(root, "home"),
    proxyBaseUrl: "http://wardby-proxy:8787",
    capability: CAPABILITY,
    signal: new AbortController().signal,
    runSettings: { subAgents: true, webTools: "off", commandTimeoutMs: 600_000 },
    systemCheck: { root: system, expectedUid: process.getuid!() },
    // Never the real sweep in a test: it would signal this machine's processes.
    sweepProcesses: async () => "swept" as const,
    operatorLog: () => {},
    ...extra,
  };
}

const settingsOf = async (o: GeminiRunOptions) =>
  JSON.parse(await readFile(join(o.home!, ".gemini", "settings.json"), "utf8")) as {
    model: { maxSessionTurns: number };
    tools: { exclude: string[] };
    modelConfigs: { customOverrides: { modelConfig: { generateContentConfig: { maxOutputTokens: number } } }[] };
  };

describe("runGeminiCodingWorker", () => {
  it("runs the pinned command line, writes the user settings, and returns the answer", async () => {
    const cli = fakeCli("success-tools");
    const onProgress = vi.fn();
    const o = await options({ spawnCli: cli.spawnCli, onProgress });
    const output = await runGeminiCodingWorker(o);
    expect(output).toMatchObject({ runId: "run_rec", outcome: "changes_ready" });
    const run = cli.calls[1];
    expect(run.args.slice(0, 5)).toEqual(geminiBaseArgs("gemini-4-neon"));
    expect(run.args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json"]));
    const prompt = run.args[run.args.indexOf("-p") + 1];
    expect(prompt.startsWith("You are running inside an isolated Wardby coding worker.")).toBe(true);
    expect(prompt).toContain("including GEMINI.md, AGENTS.md, CLAUDE.md");
    expect(prompt).toContain("The final JSON runId must be run_rec.");
    expect(run.env).toMatchObject({
      GEMINI_API_KEY: CAPABILITY,
      GOOGLE_GEMINI_BASE_URL: "http://wardby-proxy:8787",
      HOME: o.home,
    });
    const settings = await settingsOf(o);
    expect(settings.model.maxSessionTurns).toBe(200);
    expect(settings.modelConfigs.customOverrides[0].modelConfig.generateContentConfig.maxOutputTokens).toBe(32_000);
    expect(JSON.stringify(settings)).not.toContain(CAPABILITY);
    expect(onProgress).toHaveBeenLastCalledWith({
      schemaVersion: 1,
      runId: "run_rec",
      type: "completed",
      outcome: "changes_ready",
    });
  });

  it("checks the CLI version without the capability, with the run's guards", async () => {
    const cli = fakeCli("success-tools");
    await runGeminiCodingWorker(await options({ spawnCli: cli.spawnCli }));
    expect(cli.calls[0].args).toEqual(["--version"]);
    expect(JSON.stringify(cli.calls[0].env)).not.toContain(CAPABILITY);
    expect(cli.calls[0].env).toMatchObject({
      WARDBY_GEMINI_AUTH_TYPE: "gemini-api-key",
      GEMINI_CLI_NO_RELAUNCH: "true",
    });
  });

  it("uses the run's own limits", async () => {
    const o = await options({
      spawnCli: fakeCli("success-tools").spawnCli,
      input: { ...input, maxTurns: 9, maxOutputTokens: 4096 },
    });
    await runGeminiCodingWorker(o);
    const settings = await settingsOf(o);
    expect(settings.model.maxSessionTurns).toBe(9);
    expect(settings.modelConfigs.customOverrides[0].modelConfig.generateContentConfig.maxOutputTokens).toBe(4096);
  });

  it("repairs a prose answer once with --resume latest and JSON output", async () => {
    const cli = fakeCli("prose-final", "repair-json");
    const output = await runGeminiCodingWorker(await options({ spawnCli: cli.spawnCli }));
    expect(output.outcome).toBe("changes_ready");
    const repair = cli.calls[2].args;
    expect(repair).toEqual(expect.arrayContaining(["--resume", "latest", "--output-format", "json"]));
    expect(repair.slice(0, 5)).toEqual(geminiBaseArgs("gemini-4-neon"));
    expect(repair[repair.indexOf("-p") + 1]).toContain("with runId run_rec");
    expect(cli.calls[2].env).toEqual(cli.calls[1].env);
  });

  it("undoes what the agent wrote for the CLI before the repair turn, and keeps the session store", async () => {
    const cli = fakeCli("prose-final", "repair-json");
    const o = await options({ spawnCli: cli.spawnCli });
    const gemini = join(o.home!, ".gemini");
    const seen: Record<string, unknown> = {};
    cli.hooks.before = async (run) => {
      if (run === 1) {
        // The agent's shell, during the first turn.
        await mkdir(join(gemini, "policies"), { recursive: true });
        await writeFile(join(gemini, "policies", "allow-all.toml"), "[[rule]]\n");
        await writeFile(join(gemini, "settings.json"), JSON.stringify({ tools: { exclude: [] } }));
        await mkdir(join(gemini, "tmp", "workspace", "chats"), { recursive: true });
        await writeFile(join(gemini, "tmp", "workspace", "chats", "session.json"), "{}");
      } else {
        seen.policies = await lstat(join(gemini, "policies")).then(
          () => true,
          () => false,
        );
        seen.exclude = (await settingsOf(o)).tools.exclude;
        seen.session = await readFile(join(gemini, "tmp", "workspace", "chats", "session.json"), "utf8");
      }
    };
    await runGeminiCodingWorker(o);
    expect(seen).toEqual({ policies: false, exclude: ["google_web_search", "web_fetch"], session: "{}" });
  });

  it("verifies the system settings again before the repair turn", async () => {
    const cli = fakeCli("prose-final", "repair-json");
    const o = await options({ spawnCli: cli.spawnCli });
    cli.hooks.before = async (run) => {
      if (run === 1) await writeFile(join(o.systemCheck!.root!, "policies", "wardby.toml"), "# changed\n");
    };
    expect(safeWorkerErrorCode(await runGeminiCodingWorker(o).catch((e: unknown) => e))).toBe(
      "worker_agent_cli_incompatible",
    );
    expect(cli.calls).toHaveLength(2);
  });

  it("refuses a symlinked repository context file before the CLI starts, and again before the repair turn", async () => {
    const first = fakeCli("success-tools");
    const o = await options({ spawnCli: first.spawnCli });
    await symlink("/proc/self/environ", join(o.workspace, "GEMINI.md"));
    expect(safeWorkerErrorCode(await runGeminiCodingWorker(o).catch((e: unknown) => e))).toBe(
      "coding_context_file_refused",
    );
    // Only the version check ran: no agent turn.
    expect(first.calls.map((c) => c.args[0])).toEqual(["--version"]);
    await rm(root!, { recursive: true, force: true });

    const cli = fakeCli("prose-final", "repair-json");
    const again = await options({ spawnCli: cli.spawnCli });
    cli.hooks.before = async (run) => {
      if (run === 1) {
        await mkdir(join(again.workspace, "sub"), { recursive: true });
        await symlink("/proc/self/environ", join(again.workspace, "sub", "CLAUDE.md"));
      }
    };
    expect(safeWorkerErrorCode(await runGeminiCodingWorker(again).catch((e: unknown) => e))).toBe(
      "coding_context_file_refused",
    );
    expect(cli.calls).toHaveLength(2);
  });

  it("includes each extra repository for the CLI's file tools and refuses a linked context file in one", async () => {
    const repositories = [
      { name: "api", path: "/repos/api", access: "write" as const, repository: "your-org/api", commit: "a".repeat(40) },
      { name: "web", path: "/repos/web", access: "read" as const, repository: "your-org/web", commit: "b".repeat(40) },
    ];
    const cli = fakeCli("prose-final", "repair-json");
    const o = await options({ spawnCli: cli.spawnCli, input: { ...input, repositories } });
    const reposRoot = join(root!, "repos");
    o.reposRoot = reposRoot;
    for (const r of repositories) await mkdir(join(reposRoot, r.name), { recursive: true });
    const included: unknown[] = [];
    cli.hooks.before = async () => {
      included.push(
        (JSON.parse(await readFile(join(o.home!, ".gemini", "settings.json"), "utf8")) as { context?: unknown })
          .context,
      );
    };
    await runGeminiCodingWorker(o);
    // The repair turn gets the same directories.
    const context = { includeDirectories: [join(reposRoot, "api"), join(reposRoot, "web")] };
    expect(included).toEqual([context, context]);

    await symlink("/proc/self/environ", join(reposRoot, "web", "GEMINI.md"));
    const refused = fakeCli("success-tools");
    expect(
      safeWorkerErrorCode(await runGeminiCodingWorker({ ...o, spawnCli: refused.spawnCli }).catch((e: unknown) => e)),
    ).toBe("coding_context_file_refused");
    expect(refused.calls.map((c) => c.args[0])).toEqual(["--version"]);
  });

  it("stops leftover processes after every CLI run, before the next turn and before finishing", async () => {
    const order: string[] = [];
    const cli = fakeCli("prose-final", "repair-json");
    cli.hooks.before = (run) => {
      order.push(`run${run}`);
    };
    const onProgress = vi.fn((event: { type: string }) => {
      if (event.type === "completed") order.push("completed");
    });
    await runGeminiCodingWorker(
      await options({
        spawnCli: cli.spawnCli,
        onProgress,
        sweepProcesses: async () => (order.push("sweep"), "swept" as const),
      }),
    );
    // Before the first turn too (whatever the dependency cache's commands left).
    expect(order).toEqual(["sweep", "run1", "sweep", "sweep", "run2", "sweep", "completed"]);
  });

  it("says once when the process sweep is skipped (not in the worker image's own pid namespace)", async () => {
    const log = vi.fn();
    const sweeps: string[] = [];
    await runGeminiCodingWorker(
      await options({
        spawnCli: fakeCli("prose-final", "repair-json").spawnCli,
        operatorLog: log,
        sweepProcesses: async () => (sweeps.push("x"), "skipped" as const),
      }),
    );
    expect(sweeps.length).toBeGreaterThan(1);
    expect(log.mock.calls).toEqual([[{ warning: "gemini_process_sweep_skipped" }]]);
  });

  it("fails the run when leftover processes cannot all be stopped", async () => {
    const error = await runGeminiCodingWorker(
      await options({
        spawnCli: fakeCli("success-tools").spawnCli,
        sweepProcesses: (() => {
          let calls = 0;
          return async () => {
            calls += 1;
            // The sweep before the first turn succeeds; the one after it finds survivors.
            if (calls > 1) throw new Error("coding_stream_failed");
            return "swept" as const;
          };
        })(),
      }),
    ).catch((e: unknown) => e);
    expect(safeWorkerErrorCode(error)).toBe("coding_stream_failed");
  });

  it("turns sub-agents off and says so when a repository agent cannot be pinned", async () => {
    const log = vi.fn();
    const o = await options({ spawnCli: fakeCli("success-tools").spawnCli, operatorLog: log });
    await mkdir(join(o.workspace, ".gemini", "agents"), { recursive: true });
    await writeFile(join(o.workspace, ".gemini", "agents", "odd.md"), '---\n"name": odd\nmodel: other\n---\n');
    await runGeminiCodingWorker(o);
    expect((await settingsOf(o)).tools.exclude).toContain("invoke_agent");
    expect(log).toHaveBeenCalledWith({ warning: "gemini_sub_agents_disabled", reason: "repo_agents_unpinnable" });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("fails with the shared invalid-output code when the repair is still not an answer", async () => {
    const prose = {
      lines: [JSON.stringify({ session_id: "s", response: JSON.stringify({ schemaVersion: 1, runId: "run_rec" }) })],
      exit: 0,
      stderrTail: "",
    };
    const cli = fakeCli("prose-final", prose);
    const error = await runGeminiCodingWorker(await options({ spawnCli: cli.spawnCli })).catch((e: unknown) => e);
    expect(safeWorkerErrorCode(error)).toBe("coding_output_invalid");
    expect(cli.calls).toHaveLength(3);
  });

  it("fails closed when the repair exits 0 with no JSON document (no result to say it succeeded)", async () => {
    const cli = fakeCli("prose-final", "prose-final");
    const error = await runGeminiCodingWorker(await options({ spawnCli: cli.spawnCli })).catch((e: unknown) => e);
    // The prose stream read as --output-format json is no document at all.
    expect(safeWorkerErrorCode(error)).toBe("coding_stream_agent_exited");
    expect(cli.calls).toHaveLength(3);
  });

  it("ends a budget refusal as budget_exhausted, keeping the work", async () => {
    const output = await runGeminiCodingWorker(await options({ spawnCli: fakeCli("budget-limit0").spawnCli }));
    expect(output).toMatchObject({
      outcome: "budget_exhausted",
      summary: "The coding budget was exhausted before the task could complete.",
    });
  });

  it.each([
    ["turn-limit", "coding_turn_limit"],
    ["e401", "coding_stream_proxy_denied"],
    ["e500", "coding_stream_upstream_error"],
    ["bad-settings", "worker_agent_cli_incompatible"],
  ])("fails %s with %s", async (scenario, code) => {
    const error = await runGeminiCodingWorker(await options({ spawnCli: fakeCli(scenario).spawnCli })).catch(
      (e: unknown) => e,
    );
    expect(safeWorkerErrorCode(error)).toBe(code);
  });

  it("fails a run whose stream had a line too long to read, whatever else it said", async () => {
    const cli = fakeCli("success-tools");
    cli.hooks.oversized = 1;
    const error = await runGeminiCodingWorker(await options({ spawnCli: cli.spawnCli })).catch((e: unknown) => e);
    expect(safeWorkerErrorCode(error)).toBe("coding_stream_failed");
  });

  it("a cancelled run never succeeds, even when the CLI exits 0 after handling SIGTERM", async () => {
    const controller = new AbortController();
    const cli = fakeCli("success-tools");
    cli.hooks.before = () => controller.abort();
    const error = await runGeminiCodingWorker(
      await options({ spawnCli: cli.spawnCli, signal: controller.signal }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("worker_cancelled");
  });

  it("passes the runner a signal that ends the CLI before the run's deadline", async () => {
    let signal: AbortSignal | undefined;
    const spawnCli: GeminiCliSpawner = (args, run) => {
      if (args[0] === "--version") return versionRun();
      signal = run.signal;
      return {
        lines: (async function* () {
          await new Promise((resolve) => run.signal.addEventListener("abort", resolve, { once: true }));
          // Nothing printed: the CLI only ends when the signal stops it.
          yield* [];
        })(),
        done: Promise.resolve({ code: 0, signal: null, stderrTail: "", oversizedLines: 0 }),
      };
    };
    const deadlineAt = new Date(Date.now() + GEMINI_DEADLINE_MARGIN_MS + 300).toISOString();
    const error = await runGeminiCodingWorker(await options({ spawnCli, input: { ...input, deadlineAt } })).catch(
      (e: unknown) => e,
    );
    expect(signal?.aborted).toBe(true);
    expect(safeWorkerErrorCode(error)).toBe("coding_stream_timeout");
  });

  it("reports the deadline even when the sweep after the stopped CLI fails", async () => {
    const spawnCli: GeminiCliSpawner = (args, run) => {
      if (args[0] === "--version") return versionRun();
      return {
        lines: (async function* () {
          await new Promise((resolve) => run.signal.addEventListener("abort", resolve, { once: true }));
          yield* [];
        })(),
        done: Promise.resolve({ code: 143, signal: null, stderrTail: "", oversizedLines: 0 }),
      };
    };
    let sweeps = 0;
    const deadlineAt = new Date(Date.now() + GEMINI_DEADLINE_MARGIN_MS + 300).toISOString();
    const error = await runGeminiCodingWorker(
      await options({
        spawnCli,
        input: { ...input, deadlineAt },
        sweepProcesses: async () => {
          sweeps += 1;
          if (sweeps > 1) throw new Error("coding_stream_failed");
          return "swept" as const;
        },
      }),
    ).catch((e: unknown) => e);
    expect(sweeps).toBe(2);
    expect(safeWorkerErrorCode(error)).toBe("coding_stream_timeout");
  });

  it("refuses to start on a changed system file or another CLI version, before any model call", async () => {
    const o = await options();
    await chmod(join(o.systemCheck!.root!, "settings.json"), 0o666);
    const cli = fakeCli();
    expect(
      safeWorkerErrorCode(await runGeminiCodingWorker({ ...o, spawnCli: cli.spawnCli }).catch((e: unknown) => e)),
    ).toBe("worker_agent_cli_incompatible");
    expect(cli.calls).toHaveLength(0);
    const calls: string[][] = [];
    const other: GeminiCliSpawner = (args) => {
      calls.push([...args]);
      return versionRun("0.71.0");
    };
    const o2 = await options({ spawnCli: other });
    expect(safeWorkerErrorCode(await runGeminiCodingWorker(o2).catch((e: unknown) => e))).toBe(
      "worker_agent_cli_incompatible",
    );
    expect(calls).toEqual([["--version"]]);
  });

  it("Vertex: GOOGLE_API_KEY and the Google model id without the location", async () => {
    const cli = fakeCli("success-tools");
    await runGeminiCodingWorker(
      await options({ spawnCli: cli.spawnCli, input: { ...input, model: "us.gemini-4-neon" } }),
    );
    expect(cli.calls[1].args.slice(0, 2)).toEqual(["-m", "gemini-4-neon"]);
    expect(cli.calls[1].env).toMatchObject({
      GOOGLE_API_KEY: CAPABILITY,
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_LOCATION: "",
    });
  });

  it("refuses header mode with a real capability (Substrate holds only the placeholder)", async () => {
    const o = await options({ spawnCli: fakeCli().spawnCli, capabilityHeader: "x-api-key" });
    expect((await runGeminiCodingWorker(o).catch((e: Error) => e)) as Error).toHaveProperty(
      "message",
      "worker_capability_header_needs_placeholder",
    );
  });

  it("no capability or MCP token in the operator log, the progress events or the error", async () => {
    const mcpToken = "rmt_FAKEmcp0123456789abcdefABCDEF";
    const out: unknown[] = [];
    for (const scenario of ["success-tools", "e401", "budget-limit0"]) {
      const o = await options({
        spawnCli: fakeCli(scenario).spawnCli,
        mcpToken,
        onProgress: (event) => out.push(event),
        operatorLog: (event) => out.push(event),
      });
      out.push(await runGeminiCodingWorker(o).catch((e: Error) => ({ message: e.message })));
      const settings = await readFile(join(o.home!, ".gemini", "settings.json"), "utf8");
      expect(settings).not.toContain(mcpToken);
      await rm(root!, { recursive: true, force: true });
    }
    const text = JSON.stringify(out);
    expect(text).not.toContain(CAPABILITY);
    expect(text).not.toContain(mcpToken);
  });
});
