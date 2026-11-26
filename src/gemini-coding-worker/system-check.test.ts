import { createHash } from "node:crypto";
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GEMINI_ALWAYS_EXCLUDED_TOOLS,
  GEMINI_CONTEXT_FILE_NAMES,
  GEMINI_SYSTEM_POLICY_SHA256,
  GEMINI_SYSTEM_SETTINGS_SHA256,
} from "./cli.js";
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
    expect(settings.context.fileName).toEqual([...GEMINI_CONTEXT_FILE_NAMES]);
    expect(settings.tools.exclude).toEqual([...GEMINI_ALWAYS_EXCLUDED_TOOLS]);
    expect(settings.telemetry).toEqual({ enabled: false, logPrompts: false });
    expect(settings.security.enableConseca).toBe(false);
    expect(settings.security.auth.enforcedType).toBe("$WARDBY_GEMINI_AUTH_TYPE");
    // No credential is ever written into the system file.
    expect(JSON.stringify(settings)).not.toMatch(/apiKey|API_KEY|token|password/i);
    // Never anything that trusts the repository's own settings.
    expect(JSON.stringify(settings)).not.toMatch(/folderTrust|TRUST_WORKSPACE/);
  });
});

describe("baked admin policy", () => {
  it("denies exactly the always-excluded tools", async () => {
    const policy = await readFile(POLICY, "utf8");
    const denied = [...policy.matchAll(/^toolName = "([^"]+)"$/gm)].map((match) => match[1]);
    expect(denied).toEqual([...GEMINI_ALWAYS_EXCLUDED_TOOLS]);
    expect(policy.match(/^decision = "deny"$/gm)).toHaveLength(GEMINI_ALWAYS_EXCLUDED_TOOLS.length);
    expect(policy).not.toMatch(/decision = "(allow|ask_user)"/);
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
    ["a group-writable policy file", async (dir: string) => chmod(join(dir, "policies", "wardby.toml"), 0o664)],
    ["an other-writable policies folder", async (dir: string) => chmod(join(dir, "policies"), 0o757)],
    [
      "a symlinked policies folder",
      async (dir: string) => {
        const elsewhere = join(dir, "..", "elsewhere");
        await mkdir(elsewhere, { mode: 0o755 });
        await copyFile(POLICY, join(elsewhere, "wardby.toml"));
        await chmod(join(elsewhere, "wardby.toml"), 0o644);
        await rm(join(dir, "policies"), { recursive: true });
        await symlink(elsewhere, join(dir, "policies"));
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

  // chown to another user needs root; the image's own test run (as root) covers it.
  it.skipIf(uid !== 0)("refuses a single file another user owns", async () => {
    const dir = await installed();
    await chown(join(dir, "policies", "wardby.toml"), 1, 1);
    expect(await code(verifyGeminiSystemSettings({ root: dir, expectedUid: uid }))).toBe(
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
