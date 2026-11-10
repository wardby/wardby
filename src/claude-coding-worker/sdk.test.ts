import { describe, expect, it } from "vitest";
import type { ClaudeQueryOptions } from "./driver.js";
import { buildClaudeSdkOptions, WARDBY_TOOLS_TIMEOUT_MS } from "./sdk.js";
import { MAX_CLAUDE_COMMAND_TIMEOUT_MS } from "../coding/command-timeouts.js";
import { KILL_GRACE_MS, MAX_COMMAND_TIMEOUT_MS } from "../claude-tool-runner/command.mjs";

function config(signal = new AbortController().signal): ClaudeQueryOptions {
  return {
    prompt: "Untrusted task text",
    model: "claude-sonnet-5",
    budgetUsd: 1,
    maxTurns: 200,
    signal,
    environment: { ANTHROPIC_API_KEY: "private-run-capability" },
    relayEnvironment: { PATH: "/usr/bin:/bin" },
    outputSchema: {},
    developerInstructions: "Fixed security instructions",
    contextDirectory: null,
    skills: false,
    persistSession: false,
  };
}

describe("Claude SDK configuration", () => {
  it("passes the run's turn limit through to the SDK", () => {
    expect(buildClaudeSdkOptions({ ...config(), maxTurns: 40 }).maxTurns).toBe(40);
  });

  it("keeps the SDK session only when the run asks for it", () => {
    expect(buildClaudeSdkOptions({ ...config(), persistSession: true }).persistSession).toBe(true);
    expect(buildClaudeSdkOptions({ ...config(), persistSession: false }).persistSession).toBe(false);
  });

  it("allows only the private socket relay and no Claude built-in tools", () => {
    const options = buildClaudeSdkOptions(config());
    expect(options).toMatchObject({
      cwd: "/opt/wardby/empty-workspace",
      maxTurns: 200,
      maxBudgetUsd: 1,
      tools: [],
      allowedTools: ["mcp__wardby_tools__run_command"],
      strictMcpConfig: true,
      settingSources: [],
      outputFormat: { type: "json_schema", schema: {} },
      permissionMode: "dontAsk",
      persistSession: false,
      env: { ANTHROPIC_API_KEY: "private-run-capability" },
    });
    expect(options.mcpServers).toEqual({
      wardby_tools: {
        command: "node",
        args: ["/opt/wardby/claude-coding-worker/tool-relay.js"],
        env: { PATH: "/usr/bin:/bin" },
        timeout: WARDBY_TOOLS_TIMEOUT_MS,
        alwaysLoad: true,
      },
    });
  });

  it("lets a wardby_tools call outlast the longest command the tool runner can be set to run", () => {
    // Claude Code's per-server timeout is a hard wall-clock limit (and its idle limit): at the old
    // 120 s it stopped every command at two minutes, whatever the tool runner allowed.
    const tools = (buildClaudeSdkOptions(config()).mcpServers as Record<string, { timeout: number }>).wardby_tools;
    expect(MAX_COMMAND_TIMEOUT_MS).toBe(MAX_CLAUDE_COMMAND_TIMEOUT_MS);
    expect(tools.timeout).toBeGreaterThan(MAX_CLAUDE_COMMAND_TIMEOUT_MS + KILL_GRACE_MS);
    expect(tools.timeout).toBeLessThanOrEqual(2_147_483_647);
  });

  it("never lets the agent call the worker's own dependency-cache tool, in any mode", () => {
    for (const options of [
      buildClaudeSdkOptions(config()),
      buildClaudeSdkOptions({ ...config(), contextDirectory: "/tmp/wardby-context", skills: true }),
    ]) {
      expect(options.disallowedTools).toEqual(["mcp__wardby_tools__wardby_prepare_dependencies"]);
      expect(options.allowedTools).not.toContain("mcp__wardby_tools__wardby_prepare_dependencies");
      expect(options.allowedTools).not.toContain("mcp__wardby_tools");
    }
  });

  it("keeps today's isolation when there is no native context", () => {
    expect(buildClaudeSdkOptions(config())).toMatchObject({
      cwd: "/opt/wardby/empty-workspace",
      tools: [],
      allowedTools: ["mcp__wardby_tools__run_command"],
      settingSources: [],
    });
  });

  it("loads project memory from the context directory, without the Skill tool when there are no skills", () => {
    expect(buildClaudeSdkOptions({ ...config(), contextDirectory: "/tmp/wardby-context" })).toMatchObject({
      cwd: "/tmp/wardby-context",
      tools: [],
      allowedTools: ["mcp__wardby_tools__run_command"],
      settingSources: ["project"],
      strictMcpConfig: true,
    });
  });

  it("restricts hooks to managed ones in native mode only", () => {
    expect(buildClaudeSdkOptions(config())).not.toHaveProperty("managedSettings");
    expect(buildClaudeSdkOptions({ ...config(), contextDirectory: "/tmp/wardby-context" }).managedSettings).toEqual({
      allowManagedHooksOnly: true,
    });
  });

  it("adds the Skill tool when the native context has skills", () => {
    expect(buildClaudeSdkOptions({ ...config(), contextDirectory: "/tmp/wardby-context", skills: true })).toMatchObject(
      {
        tools: ["Skill"],
        allowedTools: ["mcp__wardby_tools__run_command", "Skill"],
        settingSources: ["project"],
      },
    );
  });

  it("hands Claude Code's stderr to the SDK only when a trace asked for it", () => {
    expect(buildClaudeSdkOptions(config())).not.toHaveProperty("stderr");
    const stderr = () => undefined;
    expect(buildClaudeSdkOptions({ ...config(), stderr }).stderr).toBe(stderr);
  });

  describe("with MCP tools (the run's MCP token is set)", () => {
    const TOKEN = "rmt_fake_token_for_claude_sdk_options_test01";
    const mcp = { url: "http://wardby-proxy:8787/mcp", token: TOKEN };

    it("adds the wardby_mcp HTTP server and the server-level allow rule, keeping wardby_tools", () => {
      const without = buildClaudeSdkOptions(config());
      const options = buildClaudeSdkOptions({ ...config(), mcp });
      expect(options.mcpServers).toEqual({
        ...(without.mcpServers as Record<string, unknown>),
        wardby_mcp: {
          type: "http",
          url: "http://wardby-proxy:8787/mcp",
          headers: { Authorization: `Bearer ${TOKEN}` },
          alwaysLoad: true,
          timeout: 300_000,
        },
      });
      expect(options.allowedTools).toEqual(["mcp__wardby_tools__run_command", "mcp__wardby_mcp"]);
      expect(options.strictMcpConfig).toBe(true);
      expect(options.disallowedTools).toEqual(without.disallowedTools);
      const skills = buildClaudeSdkOptions({ ...config(), mcp, contextDirectory: "/tmp/wardby-context", skills: true });
      expect(skills.allowedTools).toEqual(["mcp__wardby_tools__run_command", "Skill", "mcp__wardby_mcp"]);
    });

    it("puts the token only in the wardby_mcp header, never in an environment", () => {
      const options = buildClaudeSdkOptions({ ...config(), mcp });
      const servers = options.mcpServers as { wardby_tools: { env: unknown } };
      expect(JSON.stringify(options.env)).not.toContain(TOKEN);
      expect(JSON.stringify(servers.wardby_tools)).not.toContain(TOKEN);
      expect(JSON.stringify({ ...options, mcpServers: { wardby_tools: servers.wardby_tools } })).not.toContain(TOKEN);
    });

    it("is unchanged without MCP tools", () => {
      const strip = (options: Record<string, unknown>) => {
        const { abortController: _ignored, ...rest } = options;
        return rest;
      };
      expect(strip(buildClaudeSdkOptions(config()))).not.toHaveProperty("mcpServers.wardby_mcp");
      expect(JSON.stringify(strip(buildClaudeSdkOptions(config())))).not.toContain("wardby_mcp");
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
