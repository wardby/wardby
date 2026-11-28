import { describe, expect, it } from "vitest";
import type { ClaudeQueryOptions } from "./driver.js";
import {
  buildClaudeSdkOptions,
  MAX_WORKFLOW_LAUNCHES,
  taskStopGuard,
  WARDBY_TOOLS_TIMEOUT_MS,
  workflowGuard,
} from "./sdk.js";
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

  it("resumes a session only when one is given (warm Substrate rounds)", () => {
    const id = "0b5f0d6c-4a43-4a1c-9b7e-2f6a1d2c3e4f";
    expect(buildClaudeSdkOptions({ ...config(), resumeSessionId: id }).resume).toBe(id);
    expect(buildClaudeSdkOptions(config())).not.toHaveProperty("resume");
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

  it("never lets the agent call the worker's own dependency-cache, git, plan and lockfile-restore tools, in any mode", () => {
    for (const options of [
      buildClaudeSdkOptions(config()),
      buildClaudeSdkOptions({ ...config(), contextDirectory: "/tmp/wardby-context", skills: true }),
    ]) {
      expect(options.disallowedTools).toEqual([
        "mcp__wardby_tools__wardby_prepare_dependencies",
        "mcp__wardby_tools__wardby_git_check",
        "mcp__wardby_tools__wardby_result_bundle",
        "mcp__wardby_tools__wardby_plan_place",
        "mcp__wardby_tools__wardby_plan_list",
        "mcp__wardby_tools__wardby_plan_read",
        "mcp__wardby_tools__wardby_restore_pypi_lockfiles",
      ]);
      expect(options.allowedTools).not.toContain("mcp__wardby_tools__wardby_prepare_dependencies");
      expect(options.allowedTools).not.toContain("mcp__wardby_tools__wardby_restore_pypi_lockfiles");
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

    it("header mode: the placeholder in x-wardby-mcp-token, no Authorization", () => {
      const options = buildClaudeSdkOptions({
        ...config(),
        mcp: {
          url: "http://wardby-proxy:8787/mcp",
          token: "rmt_placeholder_injected_by_gateway",
          header: "x-wardby-mcp-token",
        },
      });
      expect((options.mcpServers as Record<string, unknown>).wardby_mcp).toEqual({
        type: "http",
        url: "http://wardby-proxy:8787/mcp",
        headers: { "x-wardby-mcp-token": "rmt_placeholder_injected_by_gateway" },
        alwaysLoad: true,
        timeout: 300_000,
      });
      expect(options.allowedTools).toEqual(["mcp__wardby_tools__run_command", "mcp__wardby_mcp"]);
    });

    it("header mode refuses a real token", () => {
      const real = "rmt_" + "A".repeat(43);
      let error: unknown;
      try {
        buildClaudeSdkOptions({ ...config(), mcp: { url: mcp.url, token: real, header: "x-wardby-mcp-token" } });
      } catch (caught) {
        error = caught;
      }
      expect((error as Error).message).toBe("worker_mcp_header_needs_placeholder");
      expect(String(error)).not.toContain(real);
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

describe("workflow runs (#582)", () => {
  const workflow = { name: "fix-bug", args: { ticket: "X-1" } };

  it("adds the Workflow tool, allows it, and installs the guard only on a workflow run", () => {
    const options = buildClaudeSdkOptions({ ...config(), contextDirectory: "/tmp/wardby-context", workflow });
    expect(options.tools).toContain("Workflow");
    expect(options.allowedTools).toContain("Workflow");
    const hooks = options.hooks as { PreToolUse: { matcher: string; hooks: unknown[] }[] };
    expect(hooks.PreToolUse).toEqual([{ matcher: "Workflow", hooks: [expect.any(Function)] }]);

    const plain = buildClaudeSdkOptions({ ...config(), contextDirectory: "/tmp/wardby-context" });
    expect(plain.tools).not.toContain("Workflow");
    expect(plain.allowedTools).not.toContain("Workflow");
    expect(plain).not.toHaveProperty("hooks");
  });

  it("allows one call for the run's own name, and puts Wardby's args in it", async () => {
    const guard = workflowGuard(workflow);
    const first = await guard({ tool_input: { name: "fix-bug", args: { ticket: "OTHER" } } });
    expect(first.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { name: "fix-bug", args: { ticket: "X-1" } },
    });
    const second = await guard({ tool_input: { name: "fix-bug" } });
    expect(second.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("denies another name, an inline script, a scriptPath, remote and resume", async () => {
    for (const toolInput of [
      { name: "other" },
      { script: "export const meta = {}" },
      { scriptPath: "/tmp/x.js" },
      { name: "fix-bug", remote: true },
      { name: "fix-bug", resumeFromRunId: "wf_1" },
      {},
    ]) {
      const result = await workflowGuard(workflow)({ tool_input: toolInput });
      expect(result.hookSpecificOutput?.permissionDecision, JSON.stringify(toolInput)).toBe("deny");
    }
  });
});

describe("joinable workflow runs (#657)", () => {
  const state = { running: false, tasks: new Set(["w1"]) };
  const control = { running: () => state.running, ownsTask: (id: string) => state.tasks.has(id) };
  const workflow = { name: "fix-bug", args: { ticket: "X-1" }, control };

  it("adds TaskStop and its guard next to Workflow", () => {
    const options = buildClaudeSdkOptions({ ...config(), contextDirectory: "/tmp/wardby-context", workflow });
    expect(options.tools).toEqual(expect.arrayContaining(["Workflow", "TaskStop"]));
    expect(options.allowedTools).toEqual(expect.arrayContaining(["Workflow", "TaskStop"]));
    const hooks = options.hooks as { PreToolUse: { matcher: string }[] };
    expect(hooks.PreToolUse.map((h) => h.matcher)).toEqual(["Workflow", "TaskStop"]);
    const plain = buildClaudeSdkOptions({
      ...config(),
      contextDirectory: "/tmp/wardby-context",
      workflow: { name: "fix-bug", args: {} },
    });
    expect(plain.tools).not.toContain("TaskStop");
  });

  it("allows a restart only once no launch is running, with the run's args, up to the launch limit", async () => {
    const guard = workflowGuard(workflow);
    state.running = false;
    const first = await guard({ tool_input: { name: "fix-bug", args: { ticket: "OTHER" } } });
    expect(first.hookSpecificOutput?.updatedInput).toEqual({ name: "fix-bug", args: { ticket: "X-1" } });
    state.running = true;
    expect((await guard({ tool_input: { name: "fix-bug" } })).hookSpecificOutput?.permissionDecision).toBe("deny");
    state.running = false;
    for (let launch = 2; launch <= MAX_WORKFLOW_LAUNCHES; launch += 1) {
      const again = await guard({ tool_input: { name: "fix-bug", args: { ticket: "OTHER" } } });
      expect(again.hookSpecificOutput?.updatedInput).toEqual({ name: "fix-bug", args: { ticket: "X-1" } });
    }
    expect((await guard({ tool_input: { name: "fix-bug" } })).hookSpecificOutput?.permissionDecision).toBe("deny");
    for (const toolInput of [{ name: "other" }, { script: "x" }, { name: "fix-bug", resumeFromRunId: "wf_1" }]) {
      expect((await workflowGuard(workflow)({ tool_input: toolInput })).hookSpecificOutput?.permissionDecision).toBe(
        "deny",
      );
    }
  });

  it("lets TaskStop stop only a running launch of the run's own workflow", async () => {
    const guard = taskStopGuard(control);
    state.running = true;
    expect((await guard({ tool_input: { task_id: "w1" } })).hookSpecificOutput?.permissionDecision).toBe("allow");
    for (const toolInput of [{ task_id: "b9" }, { shell_id: "w1" }, { task_id: "w1", extra: 1 }, {}]) {
      expect((await guard({ tool_input: toolInput })).hookSpecificOutput?.permissionDecision).toBe("deny");
    }
    state.running = false;
    expect((await guard({ tool_input: { task_id: "w1" } })).hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});
