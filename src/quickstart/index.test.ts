import { describe, expect, it } from "vitest";
import { mcpAddArgs } from "./index.js";

describe("MCP registration arguments", () => {
  // `claude mcp add`'s `-e/--env <env...>` is variadic: anything between it and
  // the next option or `--` is read as another KEY=value, so the server name
  // must come before it ("Invalid environment variable format: wardby").
  it.each(["claude", "codex"] as const)("puts the server name before any env option for %s", (client) => {
    const args = mcpAddArgs(client, "/work/project", "@wardby/cli@1.2.3");
    expect(args.slice(0, 3)).toEqual(["mcp", "add", "wardby"]);
    const separator = args.indexOf("--");
    expect(args.slice(separator)).toEqual(["--", "npx", "--yes", "@wardby/cli@1.2.3", "mcp"]);
    expect(args.slice(3, separator)).toContain("WARDBY_PROJECT_DIR=/work/project");
  });

  it("keeps Claude Code's local scope", () => {
    const args = mcpAddArgs("claude", "/work/project", "@wardby/cli@1.2.3");
    expect(args.slice(0, args.indexOf("--"))).toEqual(
      expect.arrayContaining(["--scope", "local", "-e", "WARDBY_PROJECT_DIR=/work/project"]),
    );
  });
});

describe("doctor's Claude Code pane section", () => {
  it("never shows a failure mark for the optional pane", async () => {
    const { claudePaneDoctorLines } = await import("./index.js");
    const lines = claudePaneDoctorLines(() => ["✓ installed", "✗ wardby MCP server not configured", "○ optional"], {});
    expect(lines).toEqual(["✓ installed", "! wardby MCP server not configured", "○ optional"]);
    expect(lines.some((line) => line.startsWith("✗"))).toBe(false);
  });
});
