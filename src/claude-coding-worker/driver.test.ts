import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingTaskInput } from "../coding/protocol.js";
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
    expect(result).toMatchObject({ runId: input.runId, outcome: "budget_exhausted", tests: [] });
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
