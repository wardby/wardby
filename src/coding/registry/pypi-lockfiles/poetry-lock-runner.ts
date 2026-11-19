/**
 * Runs `poetry lock` in a project whose sources were swapped to the proxy, so
 * Poetry rewrites the lock's source URLs and `content-hash` itself. Never
 * fatal: the caller reverts the swap when this reports failure.
 */
import { spawn as nodeSpawn } from "node:child_process";

const OUTPUT_TAIL_BYTES = 4096;

export interface PoetrySpawnResult {
  /** Null when the process was killed or never started. */
  code: number | null;
  stderr: string;
  timedOut: boolean;
  notFound: boolean;
}

export type PoetrySpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
) => Promise<PoetrySpawnResult>;

export interface PoetryLockResult {
  ok: boolean;
  reason?: "poetry_not_installed" | "timeout" | "failed";
  /** The end of Poetry's stderr, for the warning. May name packages, never credentials. */
  stderrTail: string;
}

export const spawnPoetry: PoetrySpawn = (command, args, { cwd, env, timeoutMs }) =>
  new Promise((resolve) => {
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: PoetrySpawnResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = nodeSpawn(command, args, { cwd, env, stdio: ["ignore", "ignore", "pipe"], shell: false });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-OUTPUT_TAIL_BYTES);
    });
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish({ code: null, stderr: error.message, timedOut: false, notFound: error.code === "ENOENT" }),
    );
    child.on("close", (code) => finish({ code, stderr, timedOut, notFound: false }));
  });

/** `env` is the complete environment Poetry runs with: the agent's plus the proxy credentials. */
export async function runPoetryLock(input: {
  projectDir: string;
  env: Record<string, string>;
  timeoutMs: number;
  spawn?: PoetrySpawn;
}): Promise<PoetryLockResult> {
  const run = input.spawn ?? spawnPoetry;
  const result = await run("poetry", ["--no-plugins", "lock"], {
    cwd: input.projectDir,
    // The project directory is the working directory, but never on Python's import path:
    // a repository can contain a `poetry/` package or a `json.py`.
    env: { ...input.env, POETRY_NO_INTERACTION: "1", PYTHONSAFEPATH: "1", PYTHONNOUSERSITE: "1" },
    timeoutMs: input.timeoutMs,
  });
  const stderrTail = result.stderr.slice(-OUTPUT_TAIL_BYTES);
  if (result.notFound) return { ok: false, reason: "poetry_not_installed", stderrTail: "" };
  if (result.timedOut) return { ok: false, reason: "timeout", stderrTail };
  if (result.code !== 0) return { ok: false, reason: "failed", stderrTail };
  return { ok: true, stderrTail: "" };
}
