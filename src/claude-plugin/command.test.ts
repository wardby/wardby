import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudePluginCommand, claudePluginDoctorLines, PANE_TOOLS, type ClaudePluginDeps } from "./command.js";

/** A fake `claude`: answers by subcommand, records every call. */
function fakeDeps(
  opts: {
    hasClaude?: boolean;
    hasServer?: boolean;
    installFails?: boolean;
    /** Claude Code leaves the newly installed plugin turned off, as some versions do. */
    installsDisabled?: boolean;
    /** Plugin list output to return instead of the fake's own (for parsing tests). */
    listOutput?: string;
    confirm?: boolean;
    settings?: unknown;
  } = {},
) {
  const configDir = mkdtempSync(join(tmpdir(), "claude-config-"));
  const wardbyDir = mkdtempSync(join(tmpdir(), "wardby-home-"));
  if (opts.settings !== undefined) {
    writeFileSync(
      join(configDir, "settings.json"),
      typeof opts.settings === "string" ? opts.settings : JSON.stringify(opts.settings),
    );
  }
  const calls: string[][] = [];
  const lines: string[] = [];
  let pluginListed = false;
  let pluginEnabled = !opts.installsDisabled;
  const deps: ClaudePluginDeps = {
    run: (command, args) => {
      calls.push([command, ...args]);
      const ok = { status: 0, stdout: "", stderr: "" };
      if (opts.hasClaude === false) return { status: 127, stdout: "", stderr: "not found" };
      if (args[0] === "--version") return { ...ok, stdout: "2.1.311 (Claude Code)" };
      if (args[0] === "mcp" && args[1] === "get")
        return opts.hasServer ? ok : { status: 1, stdout: "", stderr: "No MCP server" };
      if (args[0] === "plugin" && args[1] === "install") {
        if (opts.installFails) return { status: 1, stdout: "", stderr: "Marketplace file not found at x" };
        pluginListed = true;
        return ok;
      }
      if (args[0] === "plugin" && args[1] === "enable") {
        pluginEnabled = true;
        return ok;
      }
      if (args[0] === "plugin" && args[1] === "list") {
        if (opts.listOutput !== undefined) return { ...ok, stdout: opts.listOutput };
        return {
          ...ok,
          stdout: pluginListed
            ? `  ❯ wardby-runs@wardby\n    Version: 0.9.0\n    Scope: user\n    Status: ${pluginEnabled ? "✔ enabled" : "✘ disabled"}\n`
            : "",
        };
      }
      if (args[0] === "plugin" && args[1] === "uninstall") {
        pluginListed = false;
        return ok;
      }
      return ok;
    },
    confirm: async () => opts.confirm ?? false,
    claudeConfigDir: configDir,
    wardbyDir,
    out: (line) => lines.push(line),
  };
  const settings = () => JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as Record<string, unknown>;
  return { deps, calls, lines, settings, configDir, wardbyDir };
}

describe("wardby claude-plugin install", () => {
  it("installs from wardby/wardby by default and keeps permission rules alone unless agreed", async () => {
    const { deps, calls, lines, configDir } = fakeDeps({ hasServer: true });
    expect(await claudePluginCommand(["install"], deps)).toBe(0);
    expect(calls).toContainEqual(["claude", "plugin", "install", "wardby-runs", "--marketplace", "wardby/wardby"]);
    expect(existsSync(join(configDir, "settings.json"))).toBe(false);
    expect(lines.join("\n")).toMatch(/Left permission rules alone/);
  });

  it("installs from an operator's own marketplace", async () => {
    const { deps, calls } = fakeDeps({ hasServer: true });
    await claudePluginCommand(["install", "--marketplace", "your-org/claude-plugins", "--no-allow-tools"], deps);
    expect(calls).toContainEqual([
      "claude",
      "plugin",
      "install",
      "wardby-runs",
      "--marketplace",
      "your-org/claude-plugins",
    ]);
  });

  it("adds the pane's read-only tools to the allow list, keeping every other setting and rule, and never stop_run", async () => {
    const { deps, settings } = fakeDeps({
      hasServer: true,
      settings: {
        theme: "dark",
        permissions: { allow: ["Bash(git *)", "mcp__wardby__get_run"], deny: ["Read(.env)"] },
      },
    });
    expect(await claudePluginCommand(["install", "--allow-tools"], deps)).toBe(0);
    const after = settings();
    expect(after.theme).toBe("dark");
    const permissions = after.permissions as { allow: string[]; deny: string[] };
    expect(permissions.deny).toEqual(["Read(.env)"]);
    expect(permissions.allow).toEqual([
      "Bash(git *)",
      "mcp__wardby__get_run",
      ...PANE_TOOLS.filter((t) => t !== "mcp__wardby__get_run"),
    ]);
    expect(permissions.allow).not.toContain("mcp__wardby__stop_run");
  });

  it("asks before adding rules, and adds none on no", async () => {
    const yes = fakeDeps({ hasServer: true, confirm: true });
    await claudePluginCommand(["install"], yes.deps);
    expect((yes.settings().permissions as { allow: string[] }).allow).toEqual([...PANE_TOOLS]);
    const no = fakeDeps({ hasServer: true, confirm: false, settings: { model: "opus" } });
    await claudePluginCommand(["install"], no.deps);
    expect(no.settings()).toEqual({ model: "opus" });
  });

  it("registers the MCP server from --server-url only when there is none, and only over https", async () => {
    const missing = fakeDeps({ hasServer: false });
    await claudePluginCommand(
      ["install", "--server-url", "https://wardby.example.com/mcp", "--no-allow-tools"],
      missing.deps,
    );
    expect(missing.calls).toContainEqual([
      "claude",
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      "wardby",
      "https://wardby.example.com/mcp",
    ]);
    const plain = fakeDeps({ hasServer: false });
    expect(await claudePluginCommand(["install", "--server-url", "http://wardby.example.com/mcp"], plain.deps)).toBe(1);
    expect(plain.calls.some((c) => c[2] === "add")).toBe(false);
    const present = fakeDeps({ hasServer: true });
    await claudePluginCommand(
      ["install", "--server-url", "https://other.example.com/mcp", "--no-allow-tools"],
      present.deps,
    );
    expect(present.calls.some((c) => c[1] === "mcp" && c[2] === "add")).toBe(false);
  });

  it("says how to add the MCP server when there is none and no --server-url", async () => {
    const { deps, lines } = fakeDeps({ hasServer: false });
    expect(await claudePluginCommand(["install", "--no-allow-tools"], deps)).toBe(0);
    expect(lines.join("\n")).toMatch(/no MCP server named wardby.*--server-url/);
  });

  it("fails clearly without claude, or when the plugin install fails", async () => {
    const none = fakeDeps({ hasClaude: false });
    expect(await claudePluginCommand(["install"], none.deps)).toBe(1);
    expect(none.lines.join("\n")).toMatch(/wasn't found on PATH/);
    const broken = fakeDeps({ hasServer: true, installFails: true });
    expect(await claudePluginCommand(["install", "--no-allow-tools"], broken.deps)).toBe(1);
    expect(broken.lines.join("\n")).toMatch(/Marketplace file not found/);
  });

  it("switches on the fullscreen view only with --fullscreen", async () => {
    const { deps, settings } = fakeDeps({ hasServer: true });
    await claudePluginCommand(["install", "--no-allow-tools", "--fullscreen"], deps);
    expect(settings().tui).toBe("fullscreen");
  });
});

describe("wardby claude-plugin install turns the plugin on", () => {
  it("enables a plugin that Claude Code installed turned off, by its exact id", async () => {
    const { deps, calls, lines } = fakeDeps({ hasServer: true, installsDisabled: true });
    expect(await claudePluginCommand(["install", "--no-allow-tools"], deps)).toBe(0);
    expect(calls).toContainEqual(["claude", "plugin", "enable", "wardby-runs@wardby"]);
    expect(lines.join("\n")).toMatch(/Turned on wardby-runs@wardby/);
  });

  it("leaves an already enabled plugin alone", async () => {
    const { deps, calls } = fakeDeps({ hasServer: true });
    await claudePluginCommand(["install", "--no-allow-tools"], deps);
    expect(calls.some((c) => c[2] === "enable")).toBe(false);
  });

  it("reads each plugin's own Status line, not a neighbour's", async () => {
    const { pluginEntries } = await import("./command.js");
    const listOutput = [
      "Installed plugins:",
      "  ❯ wardby-runs@wardby",
      "    Version: 0.9.0",
      "    Status: ✔ enabled",
      "  ❯ other-plugin@somewhere",
      "    Status: ✘ disabled",
      "  ❯ wardby-runs@wardby-runs-local",
      "    Status: ✘ disabled",
      "",
    ].join("\n");
    expect(pluginEntries(fakeDeps({ listOutput }).deps)).toEqual([
      { id: "wardby-runs@wardby", enabled: true },
      { id: "wardby-runs@wardby-runs-local", enabled: false },
    ]);
  });
});

describe("wardby claude-plugin uninstall and status", () => {
  it("removes the plugin and only the rules and view install added", async () => {
    const { deps, calls, settings } = fakeDeps({
      hasServer: true,
      settings: { permissions: { allow: ["Bash(git *)", "mcp__wardby__get_run"] } },
    });
    await claudePluginCommand(["install", "--allow-tools", "--fullscreen"], deps);
    expect(await claudePluginCommand(["uninstall"], deps)).toBe(0);
    expect(calls).toContainEqual(["claude", "plugin", "uninstall", "wardby-runs"]);
    // get_run was there before install, so it stays; the rest go, and so does the view install switched on.
    expect(settings()).toEqual({ permissions: { allow: ["Bash(git *)", "mcp__wardby__get_run"] } });
  });

  it("reports the plugin, the MCP server and the rules", async () => {
    const { deps, lines } = fakeDeps({ hasServer: true });
    expect(await claudePluginCommand(["status"], deps)).toBe(1);
    expect(lines.join("\n")).toMatch(/✗ wardby-runs plugin not installed/);
    lines.length = 0;
    await claudePluginCommand(["install", "--allow-tools"], deps);
    lines.length = 0;
    expect(await claudePluginCommand(["status"], deps)).toBe(0);
    expect(lines).toEqual([
      "✓ wardby-runs plugin installed",
      "✓ wardby MCP server configured",
      expect.stringMatching(/^✓ the pane's tools are allowed in /),
    ]);
  });
});

describe("wardby doctor's Claude Code pane lines", () => {
  it("warns when the plugin is installed but turned off", async () => {
    const listOutput = "  ❯ wardby-runs@wardby\n    Status: ✘ disabled\n";
    const lines = claudePluginDoctorLines(fakeDeps({ hasServer: true, listOutput }).deps);
    expect(lines[0]).toMatch(/^! wardby-runs@wardby is installed but turned off/);
    expect(lines[0]).toContain("claude plugin enable wardby-runs@wardby");
  });

  it("says nothing without Claude Code, and suggests the pane when it isn't installed", async () => {
    const { claudePluginDoctorLines } = await import("./command.js");
    expect(claudePluginDoctorLines(fakeDeps({ hasClaude: false }).deps)).toEqual([]);
    expect(claudePluginDoctorLines(fakeDeps({ hasServer: true }).deps)).toEqual([
      "○ Claude Code runs pane not installed (optional: npx @wardby/cli@latest claude-plugin install)",
    ]);
  });

  it("reports the plugin, the server and the rules, warning but never failing", async () => {
    const { claudePluginDoctorLines } = await import("./command.js");
    const ready = fakeDeps({ hasServer: true });
    await claudePluginCommand(["install", "--allow-tools"], ready.deps);
    expect(claudePluginDoctorLines(ready.deps)).toEqual([
      "✓ wardby-runs Claude Code plugin installed",
      "✓ wardby MCP server configured in Claude Code",
      "✓ the pane's tools are allowed for auto mode",
    ]);
    const bare = fakeDeps({ hasServer: false });
    await claudePluginCommand(["install", "--no-allow-tools"], bare.deps);
    const lines = claudePluginDoctorLines(bare.deps);
    expect(lines[0]).toBe("✓ wardby-runs Claude Code plugin installed");
    expect(lines[1]).toMatch(/^! Claude Code has no MCP server named wardby/);
    expect(lines[2]).toMatch(/^! not allowed for auto mode/);
    expect(lines.some((line) => line.startsWith("✗"))).toBe(false);
  });
});

describe("review fixes: broken settings, server names, quickstart's offer", () => {
  it("a settings file that isn't JSON stops install before anything is installed, with exit 1", async () => {
    const { deps, calls, lines, configDir } = fakeDeps({ hasServer: true, settings: "{ not json" });
    expect(await claudePluginCommand(["install", "--allow-tools"], deps)).toBe(1);
    expect(calls.some((c) => c[1] === "plugin" && c[2] === "install")).toBe(false);
    expect(lines.join("\n")).toMatch(/isn't valid JSON/);
    expect(readFileSync(join(configDir, "settings.json"), "utf8")).toBe("{ not json");
  });

  it("uninstall reports a broken settings file instead of throwing, and leaves it alone", async () => {
    const { deps, configDir, lines } = fakeDeps({ hasServer: true });
    await claudePluginCommand(["install", "--allow-tools"], deps);
    writeFileSync(join(configDir, "settings.json"), "{ broken");
    expect(await claudePluginCommand(["uninstall"], deps)).toBe(1);
    expect(lines.join("\n")).toMatch(/isn't valid JSON.*Remove mcp__wardby__list_runs/);
    expect(readFileSync(join(configDir, "settings.json"), "utf8")).toBe("{ broken");
  });

  it("uninstall leaves the settings file untouched when nothing install added is still there", async () => {
    const { deps, configDir } = fakeDeps({ hasServer: true, settings: { model: "opus" } });
    await claudePluginCommand(["install", "--no-allow-tools"], deps);
    const before = readFileSync(join(configDir, "settings.json"), "utf8");
    await claudePluginCommand(["uninstall"], deps);
    expect(readFileSync(join(configDir, "settings.json"), "utf8")).toBe(before);
  });

  it("--server-name names the server the pane uses, and its rules follow the name", async () => {
    const { deps, calls, settings } = fakeDeps({ hasServer: false });
    await claudePluginCommand(
      ["install", "--server-name", "wardby-prod", "--server-url", "https://wardby.example.com/mcp", "--allow-tools"],
      deps,
    );
    expect(calls).toContainEqual(["claude", "mcp", "get", "wardby-prod"]);
    expect(calls.find((c) => c[2] === "add")).toContain("wardby-prod");
    expect((settings().permissions as { allow: string[] }).allow).toEqual([
      "mcp__wardby-prod__list_runs",
      "mcp__wardby-prod__list_agents",
      "mcp__wardby-prod__get_run",
      "mcp__wardby-prod__get_run_transcript",
      "mcp__wardby-prod__get_run_steps",
    ]);
    const bad = fakeDeps({ hasServer: true });
    expect(await claudePluginCommand(["install", "--server-name", "x y"], bad.deps)).toBe(1);
  });

  it("an install from before run steps gains only the get_run_steps rule, and uninstall removes it", async () => {
    const earlier = [
      "mcp__wardby__list_runs",
      "mcp__wardby__list_agents",
      "mcp__wardby__get_run",
      "mcp__wardby__get_run_transcript",
    ];
    const { deps, lines, settings, wardbyDir, configDir } = fakeDeps({
      hasServer: true,
      settings: { permissions: { allow: ["Bash(git status)", ...earlier] } },
    });
    // The record an older install left, in the file the install writes.
    writeFileSync(
      join(wardbyDir, "claude-plugin.json"),
      JSON.stringify({ settingsPath: join(configDir, "settings.json"), rules: earlier, tui: false }),
    );
    // Status and doctor name the missing rule and say how to add it.
    await claudePluginCommand(["install", "--no-allow-tools"], deps);
    lines.length = 0;
    await claudePluginCommand(["status"], deps);
    const status = lines.join("\n");
    expect(status).toContain("mcp__wardby__get_run_steps");
    expect(status).not.toContain("mcp__wardby__list_runs,");
    expect(status).toMatch(/Re-run `wardby claude-plugin install --allow-tools`/);
    const doctor = claudePluginDoctorLines(deps).join("\n");
    expect(doctor).toContain("mcp__wardby__get_run_steps");
    expect(doctor).toMatch(/claude-plugin install --allow-tools/);

    await claudePluginCommand(["install", "--allow-tools"], deps);
    expect(lines).toContain("✓ Allowed mcp__wardby__get_run_steps.");
    expect((settings().permissions as { allow: string[] }).allow).toEqual([
      "Bash(git status)",
      ...earlier,
      "mcp__wardby__get_run_steps",
    ]);
    // A third run changes nothing.
    await claudePluginCommand(["install", "--allow-tools"], deps);
    expect(lines).toContain("✓ The pane's tools are already allowed.");
    expect((settings().permissions as { allow: string[] }).allow).toHaveLength(6);

    await claudePluginCommand(["uninstall"], deps);
    expect((settings().permissions as { allow: string[] }).allow).toEqual(["Bash(git status)"]);
  });

  it("uninstall leaves a get_run_steps rule the user added themselves", async () => {
    const { deps, settings, wardbyDir, configDir } = fakeDeps({
      hasServer: true,
      settings: { permissions: { allow: ["mcp__wardby__get_run_steps"] } },
    });
    writeFileSync(
      join(wardbyDir, "claude-plugin.json"),
      JSON.stringify({ settingsPath: join(configDir, "settings.json"), rules: [], tui: false }),
    );
    await claudePluginCommand(["install", "--allow-tools"], deps);
    await claudePluginCommand(["uninstall"], deps);
    expect((settings().permissions as { allow: string[] }).allow).toEqual(["mcp__wardby__get_run_steps"]);
  });

  it("quickstart offers the pane only once Claude Code is connected, and honours its flags", async () => {
    const { quickstartPaneStep } = await import("./command.js");
    const run = async (options: Partial<Parameters<typeof quickstartPaneStep>[0]>, answer = true, status = 0) => {
      const asked: string[] = [];
      const installs: unknown[] = [];
      const warnings: string[] = [];
      const result = await quickstartPaneStep(
        { client: "claude", mcpConfigured: true, nonInteractive: false, yes: false, ...options },
        {
          ask: async (question) => {
            asked.push(question);
            return answer;
          },
          install: async (opts) => {
            installs.push(opts);
            return status;
          },
          warn: (line) => warnings.push(line),
        },
      );
      return { result, asked, installs, warnings };
    };
    // Asked, and installed on yes from the default marketplace.
    const yes = await run({});
    expect(yes).toMatchObject({ result: "installed", asked: [expect.stringMatching(/runs pane/)] });
    expect(yes.installs).toEqual([{ marketplace: "wardby/wardby", fullscreen: false, yes: false }]);
    expect((await run({}, false)).result).toBe("skipped");
    // Only for Claude Code, and only once it was connected.
    for (const options of [{ client: "codex" }, { client: "none" }, { mcpConfigured: false }]) {
      const skipped = await run(options);
      expect(skipped).toMatchObject({ result: "skipped", asked: [], installs: [] });
    }
    expect((await run({ client: "both" })).result).toBe("installed");
    // The flags answer without asking; a non-interactive run never asks.
    expect(await run({ flag: true })).toMatchObject({ result: "installed", asked: [] });
    expect(await run({ flag: false })).toMatchObject({ result: "skipped", asked: [], installs: [] });
    expect(await run({ nonInteractive: true })).toMatchObject({ result: "skipped", asked: [] });
    expect(await run({ nonInteractive: true, flag: true, yes: true })).toMatchObject({ result: "installed" });
    // A failed install warns and carries on.
    const failed = await run({}, true, 1);
    expect(failed.result).toBe("failed");
    expect(failed.warnings[0]).toMatch(/claude-plugin install/);
  });
});
