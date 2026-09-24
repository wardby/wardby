import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  composeProjectName,
  ensureWardbyIgnored,
  parseEnvFile,
  quickstartPaths,
  readQuickstartEnv,
  writeQuickstartEnv,
} from "./config.js";

describe("quickstart configuration", () => {
  it("creates stable, project-specific Compose names", () => {
    const first = composeProjectName("/tmp/Hello App");
    expect(first).toMatch(/^wardby-hello-app-[a-f0-9]{10}$/);
    expect(composeProjectName("/tmp/Hello App")).toBe(first);
    expect(composeProjectName("/other/Hello App")).not.toBe(first);
  });

  it("parses the quoted values emitted by the managed env writer", () => {
    expect(parseEnvFile('A="plain"\nTOKEN="a=b c"\nSINGLE=\'value\'\n# ignored\n')).toEqual({
      A: "plain",
      TOKEN: "a=b c",
      SINGLE: "value",
    });
  });

  it("writes private configuration that round-trips", () => {
    const root = mkdtempSync(join(tmpdir(), "wardby-config-"));
    const paths = quickstartPaths(root);
    writeQuickstartEnv(paths, { SECRET_APP_KEY: "a".repeat(64), TOKEN: "secret value" });

    expect(readQuickstartEnv(paths)).toEqual({ SECRET_APP_KEY: "a".repeat(64), TOKEN: "secret value" });
    expect(statSync(paths.wardbyDir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.envFile).mode & 0o777).toBe(0o600);
  });

  it("adds the local state ignore exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "wardby-ignore-"));
    ensureWardbyIgnored(root);
    ensureWardbyIgnored(root);
    const contents = readFileSync(join(root, ".gitignore"), "utf8");
    expect(contents.match(/^\.wardby\/$/gm)).toHaveLength(1);
  });
});
