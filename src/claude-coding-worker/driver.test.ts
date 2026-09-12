import { describe, expect, it, vi } from "vitest";
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
  headRef: "reevo/run-run_claude_123",
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
      proxyBaseUrl: "http://reevo-proxy:8787/",
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
        ANTHROPIC_BASE_URL: "http://reevo-proxy:8787",
        ANTHROPIC_API_KEY: "rrp_worker_capability",
        DISABLE_UPDATES: "1",
      },
    });
    expect(config.relayEnvironment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(config.prompt).toContain(input.task);
    expect(JSON.stringify(progress.mock.calls)).not.toContain(input.task);
    expect(CLAUDE_WORKER_SECURITY_INSTRUCTIONS).toContain("reevo_tools MCP tool");
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
          throw new Error("provider secret");
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
});
