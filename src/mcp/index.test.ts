import { describe, expect, it, vi } from "vitest";
import { buildMcpProviders, warmUpExecutor } from "./index.js";

/**
 * `warmUpExecutor` is the single fire-and-forget call site `startMcp` uses to start an executor's
 * start-up warm-up (e.g. KubernetesJobLauncher's memoized cluster preflight) when a long-running
 * server process starts (`wardby mcp`, and `wardby serve` through it) — never from a one-shot CLI
 * command, which never calls it at all. These tests cover the call site's own contract in isolation,
 * without a database or cluster: the launcher-level preflight/memoization behavior is covered by
 * kubernetes.test.ts, and the Executor-level delegation by container.test.ts and routing.test.ts.
 */
describe("warmUpExecutor", () => {
  it("calls the executor's warmUp when it has one", () => {
    const warmUp = vi.fn(async () => {});
    warmUpExecutor({ warmUp });
    expect(warmUp).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an executor without warmUp (e.g. Docker, or native-only)", () => {
    expect(() => warmUpExecutor({})).not.toThrow();
  });

  it("never throws or rejects when warmUp itself rejects", async () => {
    const warmUp = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(() => warmUpExecutor({ warmUp })).not.toThrow();
    // Let the fire-and-forget rejection's .catch() run before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warmUp).toHaveBeenCalledTimes(1);
  });
});

describe("buildMcpProviders start-up check", () => {
  it("stops start-up on an invalid WARDBY_MCP_SERVERS, naming the variable", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
    vi.stubEnv("WARDBY_MCP_SERVERS", "everyone");
    try {
      expect(() => buildMcpProviders()).toThrow(/WARDBY_MCP_SERVERS must be off, admins or owners/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
