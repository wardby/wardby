// src/gemini-coding-worker/system-check.test.ts
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GEMINI_SYSTEM_POLICY_SHA256, GEMINI_SYSTEM_SETTINGS_SHA256 } from "./cli.js";
import { checkGeminiCliVersion, verifyGeminiSystemSettings } from "./system-check.js";

const SETTINGS = new URL("./system-settings.json", import.meta.url);
const POLICY = new URL("./policies/wardby.toml", import.meta.url);
const uid = process.getuid!();
let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function installed(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "wardby-gemini-system-"));
  const dir = join(root, "gemini-cli");
  await mkdir(join(dir, "policies"), { recursive: true, mode: 0o755 });
  await chmod(dir, 0o755);
  await chmod(join(dir, "policies"), 0o755);
  await copyFile(SETTINGS, join(dir, "settings.json"));
  await copyFile(POLICY, join(dir, "policies", "wardby.toml"));
  await chmod(join(dir, "settings.json"), 0o644);
  await chmod(join(dir, "policies", "wardby.toml"), 0o644);
  return dir;
}
const code = async (promise: Promise<unknown>) =>
  await promise.then(
    () => "ok",
    (e: Error) => e.message,
  );

describe("baked system settings", () => {
  it("hash to the constants the driver checks", async () => {
    const sha = async (url: URL) =>
      createHash("sha256")
        .update(await readFile(url))
        .digest("hex");
    expect(await sha(SETTINGS)).toBe(GEMINI_SYSTEM_SETTINGS_SHA256);
    expect(await sha(POLICY)).toBe(GEMINI_SYSTEM_POLICY_SHA256);
  });

  it("lock down what the spec lists", async () => {
    const settings = JSON.parse(await readFile(SETTINGS, "utf8"));
    expect(settings.advanced.ignoreLocalEnv).toBe(true);
    expect(settings.hooksConfig.enabled).toBe(false);
    expect(settings.mcp.allowed).toEqual(["wardby_mcp"]);
    expect(settings.context.fileName).toEqual(["GEMINI.md", "AGENTS.md", "CLAUDE.md"]);
    expect(settings.tools.exclude).toEqual(["enter_plan_mode", "list_background_processes", "read_background_output"]);
    expect(settings.security.auth.enforcedType).toBe("$WARDBY_GEMINI_AUTH_TYPE");
    // Never anything that trusts the repository's own settings.
    expect(JSON.stringify(settings)).not.toMatch(/folderTrust|TRUST_WORKSPACE/);
  });
});

describe("verifyGeminiSystemSettings", () => {
  it("accepts the files as the image installs them", async () => {
    expect(await code(verifyGeminiSystemSettings({ root: await installed(), expectedUid: uid }))).toBe("ok");
  });

  it.each([
    ["a changed settings file", async (dir: string) => writeFile(join(dir, "settings.json"), "{}\n")],
    ["a changed policy", async (dir: string) => writeFile(join(dir, "policies", "wardby.toml"), "")],
    ["a group-writable settings file", async (dir: string) => chmod(join(dir, "settings.json"), 0o664)],
    ["an other-writable directory", async (dir: string) => chmod(dir, 0o777)],
    ["an extra policy", async (dir: string) => writeFile(join(dir, "policies", "allow.toml"), "")],
    ["a system-defaults file", async (dir: string) => writeFile(join(dir, "system-defaults.json"), "{}")],
    [
      "a settings symlink",
      async (dir: string) => {
        await rm(join(dir, "settings.json"));
        await symlink(SETTINGS.pathname, join(dir, "settings.json"));
      },
    ],
    ["no policies folder", async (dir: string) => rm(join(dir, "policies"), { recursive: true })],
  ])("refuses %s", async (_name, tamper) => {
    const dir = await installed();
    await tamper(dir);
    expect(await code(verifyGeminiSystemSettings({ root: dir, expectedUid: uid }))).toBe(
      "worker_agent_cli_incompatible",
    );
  });

  it("refuses files another user owns (a BYO image that replaced them)", async () => {
    expect(await code(verifyGeminiSystemSettings({ root: await installed(), expectedUid: uid + 1 }))).toBe(
      "worker_agent_cli_incompatible",
    );
  });

  it("refuses a missing folder", async () => {
    expect(await code(verifyGeminiSystemSettings({ root: "/nonexistent/gemini-cli", expectedUid: uid }))).toBe(
      "worker_agent_cli_incompatible",
    );
  });
});

describe("checkGeminiCliVersion", () => {
  it("accepts only the pinned version", () => {
    expect(() => checkGeminiCliVersion("0.70.0\n")).not.toThrow();
    for (const other of ["0.71.0", "0.70.1", "", "gemini 0.70.0"]) {
      expect(() => checkGeminiCliVersion(other)).toThrow("worker_agent_cli_incompatible");
    }
  });
});
