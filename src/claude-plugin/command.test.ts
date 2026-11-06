import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudePluginCommand, PANE_TOOLS, type ClaudePluginDeps } from "./command.js";

/** A fake `claude`: answers by subcommand, records every call. */
function fakeDeps(
  opts: {
    hasClaude?: boolean;
    hasServer?: boolean;
    installFails?: boolean;
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
      if (args[0] === "plugin" && args[1] === "list")
        return { ...ok, stdout: pluginListed ? "  ❯ wardby-runs@wardby\n" : "" };
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

  it("refuses to touch a settings file that isn't valid JSON", async () => {
    const { deps, configDir } = fakeDeps({ hasServer: true, settings: "{ not json" });
    await expect(claudePluginCommand(["install", "--allow-tools"], deps)).rejects.toThrow(/isn't valid JSON/);
    expect(readFileSync(join(configDir, "settings.json"), "utf8")).toBe("{ not json");
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
