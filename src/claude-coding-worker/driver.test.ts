import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deriveRegistryToken } from "../coding/registry/token.js";
import type { CodingTaskInput } from "../coding/protocol.js";
import {
  CLAUDE_OUTPUT_JSON_SCHEMA,
  CLAUDE_WORKER_SECURITY_INSTRUCTIONS,
  runClaudeCodingWorker,
  type ClaudeQueryFactory,
  type ClaudeQueryOptions,
} from "./driver.js";

async function tempCacheRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wardby-claude-driver-"));
}

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
      cacheRoot: await tempCacheRoot(),
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

  it("points npm and pip at the proxy with the registry token, never the capability, and never in relayEnvironment", async () => {
    const cacheRoot = await tempCacheRoot();
    const capability = "rrp_worker_capability";
    const proxyBaseUrl = "http://wardby-proxy:8787";
    let captured: ClaudeQueryOptions | undefined;
    const createQuery: ClaudeQueryFactory = (options) => {
      captured = options;
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
    await runClaudeCodingWorker({
      input,
      proxyBaseUrl,
      capability,
      signal: new AbortController().signal,
      createQuery,
      cacheRoot,
    });

    const env = captured!.environment;
    expect(env.npm_config_registry).toBe(`${proxyBaseUrl}/registry/npm/`);
    expect(env.PIP_INDEX_URL).toContain(deriveRegistryToken(capability));
    // The registry-facing config (npm/pip settings and the written npmrc) must carry only the
    // derived rrg_ token, never the run capability -- even though ANTHROPIC_API_KEY (the model's
    // own auth to the proxy, unrelated to the package registry) legitimately holds the capability.
    expect(env.npm_config_registry).not.toContain(capability);
    expect(env.PIP_INDEX_URL).not.toContain(capability);
    expect(JSON.stringify(captured!.relayEnvironment)).not.toContain(deriveRegistryToken(capability));
    expect(JSON.stringify(captured!.relayEnvironment)).not.toContain("npm_config_registry");
    const npmrc = await readFile(join(cacheRoot, "npm", "npmrc"), "utf8");
    expect(npmrc).toContain("_authToken=rrg_");
    expect(npmrc).not.toContain(capability);
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
      cacheRoot: await tempCacheRoot(),
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
      cacheRoot: await tempCacheRoot(),
    });
    await expect(run).rejects.toThrow("coding_stream_failed");
  });

  it("fails closed for malformed, mismatched, or provider-error results", async () => {
    const cacheRoot = await tempCacheRoot();
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
        cacheRoot,
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
