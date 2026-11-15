import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { imageVariable } from "../config/providers.js";

export interface QuickstartImages {
  runtime: string;
  worker: string;
  /** Claude Code's worker and tool runner; absent when this source does not provide them. */
  claudeWorker?: string;
  claudeToolRunner?: string;
  /** Node + Python 3.12 workspace images (Codex worker, Claude Code tool runner); each optional on its own. */
  workerNodePython?: string;
  claudeToolRunnerNodePython?: string;
  /** The coding-worker driver image every worker is built on: the base for a bring-your-own worker image. */
  driver?: string;
  /** The native sandbox worker image (docs/native-sandbox.md); absent from releases before it existed. */
  nativeWorker?: string;
  /**
   * The Substrate bridge images (docs/substrate-backend.md): the Claude Code worker and tool runners
   * with the bridge as entrypoint, for JOB_LAUNCHER=substrate. Each optional (absent from releases
   * before they existed) and pinned when present.
   */
  substrateAgent?: string;
  substrateTool?: string;
  substrateToolNodePython?: string;
  source: "env" | "package" | "build";
}

const DIGEST_REF = /@sha256:[0-9a-f]{64}$/;

type PackageImages = Pick<
  QuickstartImages,
  | "runtime"
  | "worker"
  | "claudeWorker"
  | "claudeToolRunner"
  | "workerNodePython"
  | "claudeToolRunnerNodePython"
  | "driver"
  | "nativeWorker"
  | "substrateAgent"
  | "substrateTool"
  | "substrateToolNodePython"
>;

const OPTIONAL_PINNED = ["nativeWorker", "substrateAgent", "substrateTool", "substrateToolNodePython"] as const;

function readPackageImages(packageRoot: string): PackageImages | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, "dist", "quickstart-images.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { runtime, worker, claudeWorker, claudeToolRunner, workerNodePython, claudeToolRunnerNodePython, driver } =
      parsed as Record<string, unknown>;
    if (typeof runtime !== "string" || typeof worker !== "string") return undefined;
    // An image is never resolved by tag: a tag can be repointed after release.
    if (!DIGEST_REF.test(runtime) || !DIGEST_REF.test(worker)) return undefined;
    // The Claude Code images are optional, but both or neither, and pinned when present.
    const result: PackageImages = { runtime, worker };
    if (claudeWorker !== undefined || claudeToolRunner !== undefined) {
      if (typeof claudeWorker !== "string" || typeof claudeToolRunner !== "string") return undefined;
      if (!DIGEST_REF.test(claudeWorker) || !DIGEST_REF.test(claudeToolRunner)) return undefined;
      result.claudeWorker = claudeWorker;
      result.claudeToolRunner = claudeToolRunner;
    }
    // The Node + Python images are each optional on their own (an older release has neither).
    if (workerNodePython !== undefined) {
      if (typeof workerNodePython !== "string" || !DIGEST_REF.test(workerNodePython)) return undefined;
      result.workerNodePython = workerNodePython;
    }
    if (claudeToolRunnerNodePython !== undefined) {
      if (typeof claudeToolRunnerNodePython !== "string" || !DIGEST_REF.test(claudeToolRunnerNodePython)) {
        return undefined;
      }
      result.claudeToolRunnerNodePython = claudeToolRunnerNodePython;
    }
    // The driver is optional (an older release has none), and pinned when present.
    if (driver !== undefined) {
      if (typeof driver !== "string" || !DIGEST_REF.test(driver)) return undefined;
      result.driver = driver;
    }
    // Likewise the native sandbox worker and the Substrate bridge images, each on its own.
    for (const key of OPTIONAL_PINNED) {
      const value = (parsed as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || !DIGEST_REF.test(value)) return undefined;
      result[key] = value;
    }
    return result;
  } catch {
    return undefined;
  }
}

/** The digest-pinned image a worker Dockerfile's first FROM line names; undefined when it is not pinned. */
export function driverFromDockerfile(text: string): string | undefined {
  const image = /^FROM\s+(\S+)/im.exec(text)?.[1];
  return image && /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/.test(image) ? image : undefined;
}

function hasSource(packageRoot: string): boolean {
  return (
    existsSync(join(packageRoot, "deploy", "Dockerfile")) &&
    existsSync(join(packageRoot, "src", "coding-worker", "Dockerfile"))
  );
}

function sourceDriver(packageRoot: string): string | undefined {
  try {
    return driverFromDockerfile(readFileSync(join(packageRoot, "src", "coding-worker", "Dockerfile"), "utf8"));
  } catch {
    return undefined;
  }
}

/** `wardby doctor`'s line naming the base image for your own worker images; undefined when it is not known. */
export function baseImageLine(resolved: QuickstartImages | { unavailable: string }): string | undefined {
  if ("unavailable" in resolved || !resolved.driver) return undefined;
  return `Base image for your own worker images: ${resolved.driver}`;
}

/**
 * Where the coding step gets its runtime and worker images: explicit env
 * overrides, the digest-pinned refs written at release time, or a local build
 * from a source checkout.
 */
export function resolveQuickstartImages(opts: {
  env: NodeJS.ProcessEnv;
  packageRoot: string;
}): QuickstartImages | { unavailable: string } {
  const { env, packageRoot } = opts;
  // The Claude pair resolves on its own: both env vars together beat the package pair, and one
  // image is never taken from the environment and the other from the package.
  // Blank is unset, as the server reads it (imageVariable).
  const runtimeImage = imageVariable(env.WARDBY_RUNTIME_IMAGE);
  const workerImage = imageVariable(env.CODING_WORKER_IMAGE);
  const claudeWorker = imageVariable(env.CODING_CLAUDE_WORKER_IMAGE);
  const claudeToolRunner = imageVariable(env.CODING_CLAUDE_TOOL_RUNNER_IMAGE);
  const workerNodePython = imageVariable(env.CODING_WORKER_IMAGE_NODE_PYTHON_3_12);
  const claudeToolRunnerNodePython = imageVariable(env.CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12);
  // Each Node + Python image is independent: an env override beats the package or local build.
  const envNodePython = {
    ...(workerNodePython ? { workerNodePython } : {}),
    ...(claudeToolRunnerNodePython ? { claudeToolRunnerNodePython } : {}),
  };
  const envClaude = claudeWorker && claudeToolRunner ? { claudeWorker, claudeToolRunner } : {};
  if (runtimeImage && workerImage) {
    const driver =
      readPackageImages(packageRoot)?.driver ?? (hasSource(packageRoot) ? sourceDriver(packageRoot) : undefined);
    return {
      runtime: runtimeImage,
      worker: workerImage,
      ...envClaude,
      ...envNodePython,
      ...(driver ? { driver } : {}),
      source: "env",
    };
  }
  const pinned = readPackageImages(packageRoot);
  if (pinned) return { ...pinned, ...envClaude, ...envNodePython, source: "package" };
  if (hasSource(packageRoot)) {
    const driver = sourceDriver(packageRoot);
    return {
      runtime: "wardby-runtime:local",
      worker: "wardby-coding-worker:local",
      claudeWorker: "wardby-claude-coding-worker:local",
      claudeToolRunner: "wardby-claude-tool-runner:local",
      workerNodePython: "wardby-coding-worker-node-python:local",
      claudeToolRunnerNodePython: "wardby-claude-tool-runner-node-python:local",
      ...(driver ? { driver } : {}),
      source: "build",
    };
  }
  return {
    unavailable:
      "This version of @wardby/cli was published without coding images. Upgrade @wardby/cli, or run quickstart from a clone of the wardby repository.",
  };
}
