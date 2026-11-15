/**
 * A holder bridge's image self-check (custom images on the Substrate job launcher). Before it fetches
 * anything for the run, the tool bridge and the Codex bridge check that their image has what they
 * run: the runner they start, GNU tar, a writable /workspace and the /run/wardby directories they
 * write. The first missing one is reported to the proxy as one fixed item (IMAGE_ITEMS), never as
 * free text from the image: no path, error message or command output leaves this module.
 *
 * Only Node built-ins and sibling files are imported: the image carries dist/substrate-bridge/ alone.
 */
import { execFile } from "node:child_process";
import { access, constants, mkdir, stat } from "node:fs/promises";
import type { IMAGE_ITEMS } from "./constants.js";
import { BridgeError } from "./http.js";

export type ImageItem = (typeof IMAGE_ITEMS)[number];

export interface ImageCheck {
  /** The runner the bridge starts (tool: /opt/wardby/claude-tool-runner/main.mjs; Codex: CODEX_WORKER_ENTRY). */
  runnerEntry: string;
  /** The tar the bridge runs: its `--version` output must contain "GNU tar". */
  tar: string;
  /** /workspace: created when missing, then it must be writable. */
  workspace: string;
  /** The /run/wardby directories the bridge writes: each created when missing, then it must be writable. */
  runDirs: readonly string[];
}

const TAR_TIMEOUT_MS = 10_000;

/** The bridge's image lacks `item`; the readiness server is still open until close() (main never calls it: the bridge idles). */
export class ImageIncompleteError extends BridgeError {
  constructor(
    readonly item: ImageItem,
    readonly close: () => Promise<void>,
  ) {
    super("substrate_bridge_image_incomplete");
  }
}

const succeeds = (attempt: Promise<unknown>): Promise<boolean> =>
  attempt.then(
    () => true,
    () => false,
  );

/**
 * `tar --version` names GNU tar. Its output is only searched, never logged or returned. The answer is
 * "no" at the timeout even if a process the tar started keeps the output pipe open.
 */
function isGnuTar(tar: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const answer = (gnu: boolean): void => {
      clearTimeout(timer);
      resolve(gnu);
    };
    try {
      const child = execFile(tar, ["--version"], { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout) =>
        answer(!error && String(stdout).includes("GNU tar")),
      );
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        answer(false);
      }, timeoutMs);
    } catch {
      answer(false);
    }
  });
}

/** A regular file (not a directory) that can be read. */
const isReadableFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (info) => info.isFile() && succeeds(access(path, constants.R_OK)),
    () => false,
  );

/** Created when missing, then writable. */
const writableDir = (dir: string): Promise<boolean> =>
  succeeds(mkdir(dir, { recursive: true }).then(() => access(dir, constants.W_OK)));

/**
 * The first prerequisite the image lacks, in the order runner, tar, workspace, run_dir; undefined when
 * it has them all. Never throws. Reads nothing but file modes and `tar --version` (10 s timeout).
 */
export async function checkImage(
  check: ImageCheck,
  options?: { tarTimeoutMs?: number },
): Promise<ImageItem | undefined> {
  if (!(await isReadableFile(check.runnerEntry))) return "runner";
  if (!(await isGnuTar(check.tar, options?.tarTimeoutMs ?? TAR_TIMEOUT_MS))) return "tar";
  if (!(await writableDir(check.workspace))) return "workspace";
  for (const dir of check.runDirs) {
    if (!(await writableDir(dir))) return "run_dir";
  }
  return undefined;
}
