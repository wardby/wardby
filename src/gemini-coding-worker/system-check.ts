import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKER_AGENT_CLI_INCOMPATIBLE } from "../coding-worker/errors.js";
import {
  GEMINI_CLI_VERSION,
  GEMINI_SYSTEM_DIR,
  GEMINI_SYSTEM_POLICY_SHA256,
  GEMINI_SYSTEM_SETTINGS_SHA256,
} from "./cli.js";

/** Group- or other-writable. */
const WRITABLE_BY_OTHERS = 0o022;

async function ownedDirectory(path: string, uid: number, entries: readonly string[]): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.uid !== uid || (stats.mode & WRITABLE_BY_OTHERS) !== 0) {
    throw new Error(`system_dir_not_locked:${path}`);
  }
  const found = (await readdir(path)).sort();
  if (found.join("\n") !== [...entries].sort().join("\n")) throw new Error(`system_dir_entries:${path}`);
}

async function ownedFile(path: string, uid: number, sha256: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.uid !== uid || (stats.mode & WRITABLE_BY_OTHERS) !== 0) {
    throw new Error(`system_file_not_locked:${path}`);
  }
  if (
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex") !== sha256
  ) {
    throw new Error(`system_file_changed:${path}`);
  }
}

/**
 * The run starts only on the system settings the driver was tested with: /etc/gemini-cli holds
 * exactly settings.json and policies/wardby.toml, each root-owned, not writable by others, with the
 * hash built into the driver. The CLI itself skips a system file that is not root-owned, so a BYO
 * image (workerImageRef) that changed or dropped it would otherwise run unlocked. Fixed code only;
 * the cause names the check (debug trace).
 */
export async function verifyGeminiSystemSettings(options: { root?: string; expectedUid?: number } = {}): Promise<void> {
  const root = options.root ?? GEMINI_SYSTEM_DIR;
  const uid = options.expectedUid ?? 0;
  try {
    await ownedDirectory(root, uid, ["policies", "settings.json"]);
    await ownedFile(join(root, "settings.json"), uid, GEMINI_SYSTEM_SETTINGS_SHA256);
    await ownedDirectory(join(root, "policies"), uid, ["wardby.toml"]);
    await ownedFile(join(root, "policies", "wardby.toml"), uid, GEMINI_SYSTEM_POLICY_SHA256);
  } catch (error) {
    throw new Error(WORKER_AGENT_CLI_INCOMPATIBLE, { cause: error });
  }
}

/** `gemini --version` printed exactly the pinned version (it does so offline). */
export function checkGeminiCliVersion(stdout: string): void {
  if (stdout.trim() !== GEMINI_CLI_VERSION) throw new Error(WORKER_AGENT_CLI_INCOMPATIBLE);
}
