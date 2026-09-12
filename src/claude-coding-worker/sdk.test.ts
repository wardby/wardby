import { describe, expect, it } from "vitest";
import type { ClaudeQueryOptions } from "./driver.js";
import { buildClaudeSdkOptions } from "./sdk.js";

function config(signal = new AbortController().signal): ClaudeQueryOptions {
  return {
    prompt: "Untrusted task text",
    model: "claude-sonnet-5",
    budgetUsd: 1,
    signal,
    environment: { ANTHROPIC_API_KEY: "private-run-capability" },
    relayEnvironment: { PATH: "/usr/bin:/bin" },
    outputSchema: {},
    developerInstructions: "Fixed security instructions",
  };
}

describe("Claude SDK configuration", () => {
  it("allows only the private socket relay and no Claude built-in tools", () => {
    const options = buildClaudeSdkOptions(config());
    expect(options).toMatchObject({
      cwd: "/opt/reevo/empty-workspace",
      maxTurns: 16,
      maxBudgetUsd: 1,
      tools: [],
      allowedTools: ["mcp__reevo_tools__run_command"],
      strictMcpConfig: true,
      settingSources: [],
      outputFormat: { type: "json_schema", schema: {} },
      permissionMode: "dontAsk",
      persistSession: false,
      env: { ANTHROPIC_API_KEY: "private-run-capability" },
    });
    expect(options.mcpServers).toEqual({
      reevo_tools: {
        command: "node",
        args: ["/opt/reevo/claude-coding-worker/tool-relay.js"],
        env: { PATH: "/usr/bin:/bin" },
        timeout: 120_000,
        alwaysLoad: true,
      },
    });
  });

  it("bridges host cancellation to the SDK abort controller", () => {
    const controller = new AbortController();
    const options = buildClaudeSdkOptions(config(controller.signal));
    const sdkController = options.abortController as AbortController;
    expect(sdkController.signal.aborted).toBe(false);
    controller.abort();
    expect(sdkController.signal.aborted).toBe(true);
  });
});
