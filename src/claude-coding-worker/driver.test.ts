import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS, type CodingTaskInput } from "../coding/protocol.js";
import { WORKER_BUDGET_EXHAUSTED_SUMMARY } from "../coding/continuation-wording.js";
import {
  CLAUDE_OUTPUT_JSON_SCHEMA,
  CLAUDE_WORKER_SECURITY_INSTRUCTIONS,
  runClaudeCodingWorker,
  type ClaudeQueryFactory,
  type ClaudeQueryOptions,
} from "./driver.js";

const input: CodingTaskInput = {
  schemaVersion: 1,
  runId: "run_claude_123",
  repository: "openai/example",
  baseRef: "main",
  headRef: "wardby/run-run_claude_123",
  task: "Fix the failing test.",
  model: "claude-sonnet-5",
  budgetUsd: 1,
  deadlineAt: "2026-09-07T13:00:00.000Z",
};

describe("runClaudeCodingWorker", () => {
  it("pins the proxy, disables built-ins, and permits only the socket relay", async () => {
    let captured: ClaudeQueryOptions | undefined;
    const createQuery: ClaudeQueryFactory = (options) => {
      captured = options;
      return (async function* () {
        yield { type: "system" };
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify({
            schemaVersion: 1,
            runId: input.runId,
            outcome: "changes_ready",
            summary: "Fixed it.",
            tests: [],
          }),
        };
      })();
    };
    const progress = vi.fn();
    const result = await runClaudeCodingWorker({
      input,
      proxyBaseUrl: "http://wardby-proxy:8787/",
      capability: "rrp_worker_capability",
      signal: new AbortController().signal,
      createQuery,
      onProgress: progress,
    });

    expect(result.outcome).toBe("changes_ready");
    expect(captured).toBeDefined();
    const config = captured!;
    expect(config).toMatchObject({
      model: input.model,
      budgetUsd: input.budgetUsd,
      outputSchema: CLAUDE_OUTPUT_JSON_SCHEMA,
      developerInstructions: CLAUDE_WORKER_SECURITY_INSTRUCTIONS,
      environment: {
        ANTHROPIC_BASE_URL: "http://wardby-proxy:8787",
        ANTHROPIC_API_KEY: "rrp_worker_capability",
        DISABLE_UPDATES: "1",
      },
    });
    expect(config.relayEnvironment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(config.prompt).toContain(input.task);
    expect(JSON.stringify(progress.mock.calls)).not.toContain(input.task);
    expect(CLAUDE_WORKER_SECURITY_INSTRUCTIONS).toContain("wardby_tools MCP tool");
  });

  it("keeps the session and reports its id only on a session-resume run", async () => {
    const persist: boolean[] = [];
    const createQuery: ClaudeQueryFactory = (options) => {
      persist.push(options.persistSession);
      return (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "s-1",
          mcp_servers: [{ name: "wardby_tools", status: "connected" }],
        };
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify({
            schemaVersion: 1,
            runId: input.runId,
            outcome: "no_changes",
            summary: "None.",
            tests: [],
          }),
        };
      })();
    };
    const base = { proxyBaseUrl: "http://proxy", capability: "cap", signal: new AbortController().signal, createQuery };
    const onSessionId = vi.fn();
    await runClaudeCodingWorker({ ...base, input: { ...input, sessionResume: true }, onSessionId });
    expect(onSessionId).toHaveBeenCalledTimes(1);
    expect(onSessionId).toHaveBeenCalledWith("s-1");
    await runClaudeCodingWorker({ ...base, input });
    expect(persist).toEqual([true, false]);
  });

  it("uses the run's turn limit, or the worker default when the agent sets none", async () => {
    const seen: number[] = [];
    const createQuery: ClaudeQueryFactory = (options) => {
      seen.push(options.maxTurns);
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify({
            schemaVersion: 1,
            runId: input.runId,
            outcome: "no_changes",
            summary: "None.",
            tests: [],
          }),
        };
      })();
    };
    const base = { proxyBaseUrl: "http://proxy", capability: "cap", signal: new AbortController().signal, createQuery };
    await runClaudeCodingWorker({ ...base, input });
    await runClaudeCodingWorker({ ...base, input: { ...input, maxTurns: 40 } });
    expect(seen).toEqual([200, 40]);
  });

  it("caps each reply at 32000 output tokens by default, or the run's maxOutputTokens", async () => {
    const seen: (string | undefined)[] = [];
    const createQuery: ClaudeQueryFactory = (options) => {
      seen.push(options.environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS);
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify({
            schemaVersion: 1,
            runId: input.runId,
            outcome: "no_changes",
            summary: "None.",
            tests: [],
          }),
        };
      })();
    };
    const base = { proxyBaseUrl: "http://proxy", capability: "cap", signal: new AbortController().signal, createQuery };
    await runClaudeCodingWorker({ ...base, input });
    await runClaudeCodingWorker({ ...base, input: { ...input, maxOutputTokens: 64_000 } });
    expect(DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS).toBe(32_000);
    expect(seen).toEqual(["32000", "64000"]);
  });

  it("reports running out of turns as coding_turn_limit, whether the SDK returns or throws it", async () => {
    const run = (stream: () => AsyncGenerator<{ type: string; subtype?: string }>) =>
      runClaudeCodingWorker({
        input,
        proxyBaseUrl: "http://proxy",
        capability: "cap",
        signal: new AbortController().signal,
        createQuery: stream,
      });
    await expect(
      run(async function* () {
        yield { type: "result", subtype: "error_max_turns" };
      }),
    ).rejects.toThrow("coding_turn_limit");
    await expect(
      run(async function* () {
        yield { type: "system" };
        throw new Error("Claude Code returned an error result: Reached maximum number of turns (16)");
      }),
    ).rejects.toThrow("coding_turn_limit");
  });

  it("maps only the SDK budget terminal result to a safe budget outcome", async () => {
    const result = await runClaudeCodingWorker({
      input,
      proxyBaseUrl: "http://proxy",
      capability: "cap",
      signal: new AbortController().signal,
      createQuery: () =>
        (async function* () {
          yield { type: "result", subtype: "error_max_budget_usd" };
        })(),
    });
    expect(result).toMatchObject({
      runId: input.runId,
      outcome: "budget_exhausted",
      summary: WORKER_BUDGET_EXHAUSTED_SUMMARY,
      tests: [],
    });
  });

  it("keeps a successful result whose text mentions the budget refusal code", async () => {
    const result = await runClaudeCodingWorker({
      input,
      proxyBaseUrl: "http://proxy",
      capability: "cap",
      signal: new AbortController().signal,
      createQuery: () =>
        (async function* () {
          yield {
            type: "result",
            subtype: "success",
            result: JSON.stringify({
              schemaVersion: 1,
              runId: input.runId,
              outcome: "changes_ready",
              summary: "Handled the proxy's wardby_budget_exhausted refusal in the client.",
              tests: [],
            }),
          };
        })(),
    });
    expect(result).toMatchObject({
      outcome: "changes_ready",
      summary: "Handled the proxy's wardby_budget_exhausted refusal in the client.",
    });
  });

  it("ends cleanly when the proxy refuses a request for budget", async () => {
    const run = (createQuery: () => AsyncIterable<unknown>) =>
      runClaudeCodingWorker({
        input,
        proxyBaseUrl: "http://proxy",
        capability: "cap",
        signal: new AbortController().signal,
        createQuery: createQuery as ClaudeQueryFactory,
      });
    const refusal = 'API Error: 429 {"error":{"code":"wardby_budget_exhausted"}}';
    const results = [
      { type: "result", subtype: "error_during_execution", result: refusal },
      { type: "result", subtype: "error_during_execution", errors: [refusal] },
      { type: "result", subtype: "success", is_error: true, result: refusal },
    ];
    for (const message of results) {
      const out = await run(() =>
        (async function* () {
          yield message;
        })(),
      );
      expect(out).toMatchObject({ runId: input.runId, outcome: "budget_exhausted", tests: [] });
    }
    const thrown = await run(() =>
      (async function* () {
        yield { type: "system" };
        throw new Error(refusal);
      })(),
    );
    expect(thrown).toMatchObject({ outcome: "budget_exhausted" });
    await expect(
      run(() =>
        (async function* () {
          yield { type: "result", subtype: "error_during_execution", result: "API Error: 429 rate limited" };
        })(),
      ),
    ).rejects.toThrow("coding_turn_failed");
    await expect(
      run(() =>
        (async function* () {
          yield { type: "system" };
          throw new Error("API Error: 500");
        })(),
      ),
    ).rejects.toThrow("coding_stream_upstream_error");
    // The same codes as Codex for what the stream threw, and the generic code for anything else.
    for (const [text, code] of [
      ["Claude Code process exited with code 1", "coding_stream_agent_exited"],
      ["connect ECONNREFUSED 10.0.0.1:443", "coding_stream_proxy_unreachable"],
      ["provider secret", "coding_stream_failed"],
    ]) {
      await expect(
        run(() =>
          (async function* () {
            yield { type: "system" };
            throw new Error(text);
          })(),
        ),
      ).rejects.toThrow(new RegExp(`^${code}$`));
    }
  });

  it("names the API failure the SDK reported when the turn fails", async () => {
    const run = (messages: unknown[]) =>
      runClaudeCodingWorker({
        input,
        proxyBaseUrl: "http://proxy",
        capability: "cap",
        signal: new AbortController().signal,
        createQuery: (() =>
          (async function* () {
            for (const message of messages) yield message;
          })()) as unknown as ClaudeQueryFactory,
      });
    const failed = { type: "result", subtype: "error_during_execution", result: "provider detail" };
    const assistant = (error: string) => ({ type: "assistant", message: { content: [] }, error });
    const retry = (error: string, errorStatus: number | null, noResponse = false) => ({
      type: "system",
      subtype: "api_retry",
      error,
      error_status: errorStatus,
      ...(noResponse ? { no_response: { waited_ms: 1, retry_wait_ms: 1 } } : {}),
    });
    const cases: [unknown[], string][] = [
      [[assistant("rate_limit"), failed], "coding_stream_rate_limited"],
      [[assistant("overloaded"), failed], "coding_stream_upstream_error"],
      [[assistant("server_error"), failed], "coding_stream_upstream_error"],
      [[assistant("authentication_failed"), failed], "coding_stream_proxy_denied"],
      [[retry("unknown", null, true), assistant("unknown"), failed], "coding_stream_timeout"],
      [[retry("unknown", null), assistant("unknown"), failed], "coding_stream_proxy_unreachable"],
      [[retry("unknown", 503), failed], "coding_stream_upstream_error"],
      [[retry("unknown", 429), failed], "coding_stream_rate_limited"],
      // The last report wins: a retry that later became a rate limit is reported as the rate limit.
      [[retry("unknown", null), assistant("rate_limit"), failed], "coding_stream_rate_limited"],
      // A retried request that then succeeded says nothing about a later failure.
      [[retry("rate_limit", 429), { type: "assistant", message: { content: [] } }, failed], "coding_turn_failed"],
      [[retry("unknown", null), assistant("max_output_tokens"), failed], "coding_turn_failed"],
      // No code fits these: the turn still fails as before.
      [[assistant("invalid_request"), failed], "coding_turn_failed"],
      [[assistant("billing_error"), failed], "coding_stream_quota_exceeded"],
      [[failed], "coding_turn_failed"],
    ];
    for (const [messages, code] of cases) {
      await expect(run(messages)).rejects.toThrow(new RegExp(`^${code}$`));
    }
    // A run that succeeds after a retried API error is not a failure.
    const done = JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      outcome: "no_changes",
      summary: "s",
      tests: [],
    });
    await expect(
      run([retry("rate_limit", 429), { type: "result", subtype: "success", result: done }]),
    ).resolves.toMatchObject({ outcome: "no_changes" });
    // The proxy's budget refusal still ends the run out of budget, whatever the SDK called it.
    const refusal = 'API Error: 429 {"error":{"code":"wardby_budget_exhausted"}}';
    await expect(
      run([assistant("rate_limit"), { type: "result", subtype: "error_during_execution", result: refusal }]),
    ).resolves.toMatchObject({ outcome: "budget_exhausted" });
  });

  it("fails closed when cancellation interrupts the provider stream", async () => {
    const controller = new AbortController();
    const run = runClaudeCodingWorker({
      input,
      proxyBaseUrl: "http://proxy",
      capability: "cap",
      signal: controller.signal,
      createQuery: () =>
        (async function* () {
          controller.abort();
          yield Promise.reject(new Error("provider secret"));
        })(),
    });
    await expect(run).rejects.toThrow("coding_stream_failed");
  });

  it("fails closed for malformed, mismatched, or provider-error results", async () => {
    const run = (result: unknown) =>
      runClaudeCodingWorker({
        input,
        proxyBaseUrl: "http://proxy",
        capability: "cap",
        signal: new AbortController().signal,
        createQuery: () =>
          (async function* () {
            yield result as { type: string };
          })(),
      });
    await expect(run({ type: "result", subtype: "error_during_execution", result: "provider secret" })).rejects.toThrow(
      "coding_turn_failed",
    );
    await expect(run({ type: "result", subtype: "success", result: "{}" })).rejects.toThrow("coding_output_invalid");
    await expect(
      run({
        type: "result",
        subtype: "success",
        result: JSON.stringify({
          schemaVersion: 1,
          runId: "other",
          outcome: "no_changes",
          summary: "None.",
          tests: [],
        }),
      }),
    ).rejects.toThrow("coding_output_run_mismatch");
  });

  it("fails the run by name when its command tool never connected, instead of finishing without it", async () => {
    const done = JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      outcome: "no_changes",
      summary: "ok",
      tests: [],
    });
    const run = (servers: Array<{ name: string; status: string }>) =>
      runClaudeCodingWorker({
        input,
        proxyBaseUrl: "http://wardby-proxy:8787",
        capability: "rrp_worker_capability",
        signal: new AbortController().signal,
        createQuery: () =>
          (async function* () {
            yield { type: "system", subtype: "init", mcp_servers: servers };
            yield { type: "result", subtype: "success", result: done };
          })(),
      });
    for (const servers of [
      [{ name: "wardby_tools", status: "failed" }],
      [{ name: "wardby_tools", status: "disabled" }],
      [],
    ]) {
      await expect(run(servers)).rejects.toThrow("worker_tool_runner_unreachable");
    }
    await expect(run([{ name: "wardby_tools", status: "connected" }])).resolves.toMatchObject({
      outcome: "no_changes",
    });
    await expect(run([{ name: "wardby_tools", status: "pending" }])).resolves.toMatchObject({ outcome: "no_changes" });
  });

  it("lets Claude Code retry a failed model request; every retry is metered by the proxy", async () => {
    let captured: ClaudeQueryOptions | undefined;
    await runClaudeCodingWorker({
      input,
      proxyBaseUrl: "http://wardby-proxy:8787",
      capability: `rrp_${"c".repeat(32)}`,
      signal: new AbortController().signal,
      createQuery: (options) => {
        captured = options;
        return (async function* () {
          yield {
            type: "result",
            subtype: "success",
            result: JSON.stringify({
              schemaVersion: 1,
              runId: input.runId,
              outcome: "no_changes",
              summary: "ok",
              tests: [],
            }),
          };
        })();
      },
    });
    expect(captured?.environment.CLAUDE_CODE_MAX_RETRIES).toBe("3");
    expect(CLAUDE_WORKER_SECURITY_INSTRUCTIONS).toContain(
      "npm installs in that tool, and pip installs inside a Python virtual environment where the tool has Python, already go through Wardby's package registry; don't configure registries or proxies.",
    );
  });

  describe("repository context", () => {
    const parents: string[] = [];
    afterEach(async () => Promise.all(parents.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

    async function contextRoot(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "wardby-driver-ctx-"));
      parents.push(dir);
      return join(dir, "ctx");
    }

    /** Runs the worker against a fake query that records the options it was given. */
    async function capture(runInput: CodingTaskInput, root: string): Promise<ClaudeQueryOptions> {
      let captured: ClaudeQueryOptions | undefined;
      await runClaudeCodingWorker({
        input: runInput,
        proxyBaseUrl: "http://proxy",
        capability: "cap",
        signal: new AbortController().signal,
        contextRoot: root,
        createQuery: (options) => {
          captured = options;
          return (async function* () {
            yield {
              type: "result",
              subtype: "success",
              result: JSON.stringify({
                schemaVersion: 1,
                runId: runInput.runId,
                outcome: "no_changes",
                summary: "ok",
                tests: [],
              }),
            };
          })();
        },
      });
      return captured!;
    }

    const instructions = { path: "CLAUDE.md", content: "Use pnpm." };

    it("stays in bare mode with only the security instructions when there is no context", async () => {
      const config = await capture(input, await contextRoot());
      expect(config.contextDirectory).toBeNull();
      expect(config.skills).toBe(false);
      expect(config.environment.CLAUDE_CODE_SIMPLE).toBe("1");
      expect(config.developerInstructions).toBe(CLAUDE_WORKER_SECURITY_INSTRUCTIONS);
      expect(config.environment.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS).toBe("1");
    });

    it("injects the context into the system prompt in bare mode and writes nothing", async () => {
      const root = await contextRoot();
      const config = await capture({ ...input, claudeContext: { files: [instructions] } }, root);
      expect(config.contextDirectory).toBeNull();
      expect(config.environment.CLAUDE_CODE_SIMPLE).toBe("1");
      expect(config.developerInstructions.startsWith(CLAUDE_WORKER_SECURITY_INSTRUCTIONS)).toBe(true);
      expect(config.developerInstructions).toContain("Use pnpm.");
      await expect(access(root)).rejects.toThrow();
    });

    it("writes the context to disk and drops bare mode in native mode", async () => {
      const root = await contextRoot();
      const config = await capture(
        {
          ...input,
          claudeBareMode: false,
          claudeContext: { files: [instructions, { path: ".claude/skills/a/SKILL.md", content: "s" }] },
        },
        root,
      );
      expect(config.contextDirectory).toBe(root);
      expect(config.skills).toBe(true);
      expect(config.environment).not.toHaveProperty("CLAUDE_CODE_SIMPLE");
      expect(config.environment.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS).toBe("1");
      expect(config.developerInstructions).toBe(CLAUDE_WORKER_SECURITY_INSTRUCTIONS);
    });

    it("falls back to bare mode with the context injected when it cannot be written", async () => {
      const root = await contextRoot();
      await mkdir(root);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const config = await capture(
          { ...input, claudeBareMode: false, claudeContext: { files: [instructions] } },
          root,
        );
        expect(config.contextDirectory).toBeNull();
        expect(config.skills).toBe(false);
        expect(config.environment.CLAUDE_CODE_SIMPLE).toBe("1");
        expect(config.developerInstructions.startsWith(CLAUDE_WORKER_SECURITY_INSTRUCTIONS)).toBe(true);
        expect(config.developerInstructions).toContain("Use pnpm.");
        const written = stderr.mock.calls.map((call) => String(call[0])).join("");
        expect(written).toContain('"warning":"claude_context_unavailable"');
        expect(written).not.toContain("Use pnpm.");
      } finally {
        stderr.mockRestore();
      }
    });

    it("removes a partly written context directory before falling back", async () => {
      const root = await contextRoot();
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        // A file and a directory at the same path: the second write fails after the first succeeded.
        const config = await capture(
          {
            ...input,
            claudeBareMode: false,
            claudeContext: {
              files: [
                { path: "docs/a.md", content: "A" },
                { path: "docs/a.md/b.md", content: "B" },
              ],
            },
          },
          root,
        );
        expect(config.contextDirectory).toBeNull();
        await expect(readdir(root)).rejects.toThrow();
      } finally {
        stderr.mockRestore();
      }
    });

    it("drops bare mode in native mode even without context", async () => {
      const config = await capture({ ...input, claudeBareMode: false }, await contextRoot());
      expect(config.contextDirectory).toBeNull();
      expect(config.environment).not.toHaveProperty("CLAUDE_CODE_SIMPLE");
    });
  });
});

describe("runClaudeCodingWorker dependency cache", () => {
  const success = JSON.stringify({
    schemaVersion: 1,
    runId: input.runId,
    outcome: "no_changes",
    summary: "Nothing to do.",
    tests: [],
  });

  async function run(
    runInput: CodingTaskInput,
    prepareDependencies: () => Promise<unknown>,
    order: string[] = [],
    final: { type: string; subtype?: string; result?: string } = {
      type: "result",
      subtype: "success",
      result: success,
    },
  ) {
    let prompt: string | undefined;
    const output = await runClaudeCodingWorker({
      input: runInput,
      proxyBaseUrl: "http://proxy",
      capability: "cap",
      signal: new AbortController().signal,
      createQuery: (options) => {
        order.push("query");
        prompt = options.prompt;
        return (async function* () {
          yield final;
        })();
      },
      prepareDependencies: async () => {
        order.push("prepare");
        return prepareDependencies();
      },
    });
    return { output, prompt };
  }

  it("asks the tool runner once, before the agent's query exists, and reports and notes the result", async () => {
    const order: string[] = [];
    const { output, prompt } = await run(
      { ...input, dependencyCache: true },
      async () => ({
        projects: [
          { path: ".", result: "nearest", key: "abc", installMs: 3, rebuild: "ok" },
          { path: "web", result: "refused", reason: "unsafe_archive" },
        ],
      }),
      order,
    );
    expect(order).toEqual(["prepare", "query"]);
    expect(output.dependencyCache).toEqual({
      projects: [
        { path: ".", result: "nearest", key: "abc", installMs: 3, rebuild: "ok" },
        { path: "web", result: "refused", reason: "unsafe_archive" },
      ],
    });
    expect(prompt).toContain(
      "Dependencies are pre-installed from the committed lockfile in: the repo root. Don't run `npm ci` there; add packages with a single install command.",
    );
  });

  it("never asks when the run's flag is off", async () => {
    const order: string[] = [];
    const { output, prompt } = await run(input, async () => ({ projects: [] }), order);
    expect(order).toEqual(["query"]);
    expect("dependencyCache" in output).toBe(false);
    expect(prompt).not.toContain("pre-installed");
  });

  it("adds no note when nothing was installed", async () => {
    const { prompt } = await run({ ...input, dependencyCache: true }, async () => ({
      projects: [{ path: ".", result: "skipped", reason: "no_lockfile" }],
    }));
    expect(prompt).not.toContain("pre-installed");
  });

  it("never fails the run: a failed call is a stable code and the agent still runs", async () => {
    for (const [error, reason] of [
      [new Error("dependency_cache_tool_unavailable"), "tool_unavailable"],
      [new Error("dependency_cache_tool_failed"), "worker_error"],
      [new Error("SECRET raw text"), "worker_error"],
    ] as const) {
      const order: string[] = [];
      const { output, prompt } = await run(
        { ...input, dependencyCache: true },
        async () => {
          throw error;
        },
        order,
      );
      expect(order).toEqual(["prepare", "query"]);
      expect(output.dependencyCache).toEqual({ projects: [], reason });
      expect(prompt).not.toContain("pre-installed");
    }
  });

  it("keeps the report on a budget-exhausted run", async () => {
    const { output } = await run(
      { ...input, dependencyCache: true },
      async () => ({ projects: [{ path: ".", result: "hit" }] }),
      [],
      { type: "result", subtype: "error_max_budget_usd" },
    );
    expect(output).toMatchObject({ outcome: "budget_exhausted", dependencyCache: { projects: [{ result: "hit" }] } });
  });
});
