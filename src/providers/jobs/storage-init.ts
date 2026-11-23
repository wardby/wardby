import { resolve, sep } from "node:path";
import { isCodingRepositoryName, MAX_RUN_REPOSITORIES_IN_INPUT } from "../../coding/protocol.js";
import type { JobSpec } from "./types.js";

/** Where each extra repository of a run is mounted in the containers that see /workspace: /repos/<name>. */
export const REPOSITORY_MOUNT_ROOT = "/repos";

/**
 * Creates storage subdirectories owned by the run uid, before any container mounts them as a subpath
 * (otherwise Kubernetes's kubelet creates them root-owned, and Docker's fixed-folder keeper never has
 * them). Idempotent; no shell. Names are validated before this.
 */
export function storageInitScript(root: string, directories: readonly string[]): string {
  return [
    'const fs = require("node:fs");',
    `for (const name of ${JSON.stringify(directories).replaceAll(",", ", ")}) {`,
    `  const path = ${JSON.stringify(root)} + "/" + name;`,
    "  fs.mkdirSync(path, { recursive: true, mode: 0o700 });",
    "  fs.chmodSync(path, 0o700);",
    "}",
  ].join("\n");
}

/** Where every Wardby image that runs storage-init carries the toolchain command agent (#599). */
export const TOOLCHAIN_AGENT_SOURCE = "/opt/wardby/bin/wardby-cmd";
/** The storage folder holding the agent and the run's token; mounted read-only at /opt/wardby-cmd. */
export const TOOLCHAIN_AGENT_DIRECTORY = "cmd";

/**
 * Appended to storageInitScript (it reuses its `fs`) on a run with a toolchain: copies the command
 * agent into `<root>/cmd`, where the toolchain container (a team image) and the tool runner mount it,
 * and writes the run's token there. The token is 32 random bytes, readable by the run uid only, never
 * printed; a storage-init restart keeps it, since the toolchain read it when it started.
 */
export function toolchainAgentScript(root: string, source: string = TOOLCHAIN_AGENT_SOURCE): string {
  return [
    'const crypto = require("node:crypto");',
    `const dir = ${JSON.stringify(root)} + "/${TOOLCHAIN_AGENT_DIRECTORY}";`,
    "fs.mkdirSync(dir, { recursive: true, mode: 0o700 });",
    "fs.chmodSync(dir, 0o700);",
    'fs.rmSync(dir + "/wardby-cmd", { force: true });',
    `fs.copyFileSync(${JSON.stringify(source)}, dir + "/wardby-cmd");`,
    'fs.chmodSync(dir + "/wardby-cmd", 0o500);',
    'if (!fs.existsSync(dir + "/token")) {',
    '  fs.writeFileSync(dir + "/token", crypto.randomBytes(32).toString("hex"), { mode: 0o400, flag: "wx" });',
    "}",
  ].join("\n");
}

/**
 * The storage folder holding only the command agent's binary, for setup jobs (#589); mounted
 * read-only at /opt/wardby-cmd in their containers. Never the toolchain's token: a setup job shares
 * the run's loopback, and with the token it could command the toolchain, whose /workspace is writable.
 */
export const SETUP_AGENT_DIRECTORY = "cmd-bin";

/**
 * Appended to storageInitScript (it reuses its `fs`) on a run with setup jobs: copies the command
 * agent alone into `<root>/cmd-bin`. Writes no token.
 */
export function setupAgentScript(root: string, source: string = TOOLCHAIN_AGENT_SOURCE): string {
  return [
    `const binDir = ${JSON.stringify(root)} + "/${SETUP_AGENT_DIRECTORY}";`,
    "fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });",
    "fs.chmodSync(binDir, 0o700);",
    'fs.rmSync(binDir + "/wardby-cmd", { force: true });',
    `fs.copyFileSync(${JSON.stringify(source)}, binDir + "/wardby-cmd");`,
    'fs.chmodSync(binDir + "/wardby-cmd", 0o500);',
  ].join("\n");
}

/**
 * Where the Claude Code agent image (which runs storage-init) carries the docker CLI and its compose
 * plugin, off its PATH: `docker` and `cli-plugins/docker-compose` beneath it.
 */
export const TOOLCHAIN_DOCKER_SOURCE = "/opt/wardby/docker";
/** The folder inside `cmd` that holds them in a run: the toolchain's DOCKER_CONFIG, and on its PATH. */
export const TOOLCHAIN_DOCKER_DIRECTORY = "docker";

/**
 * Appended after toolchainAgentScript on a run with a toolchain and a `docker` service: copies the
 * docker CLI and compose plugin into `<root>/cmd/docker`, so the team's image needs no Docker CLI.
 * The plugin sits in `cli-plugins` there, where the CLI finds it with DOCKER_CONFIG pointing at that
 * folder. Binaries only; nothing secret. Idempotent, like the agent copy.
 */
export function toolchainDockerScript(root: string, source: string = TOOLCHAIN_DOCKER_SOURCE): string {
  return [
    `const dockerDir = ${JSON.stringify(root)} + "/${TOOLCHAIN_AGENT_DIRECTORY}/${TOOLCHAIN_DOCKER_DIRECTORY}";`,
    'fs.mkdirSync(dockerDir + "/cli-plugins", { recursive: true, mode: 0o700 });',
    'for (const file of ["docker", "cli-plugins/docker-compose"]) {',
    '  fs.rmSync(dockerDir + "/" + file, { force: true });',
    `  fs.copyFileSync(${JSON.stringify(source)} + "/" + file, dockerDir + "/" + file);`,
    '  fs.chmodSync(dockerDir + "/" + file, 0o500);',
    "}",
  ].join("\n");
}

/** The storage folder of each extra repository, in spec order: `repos/<name>`. */
export function repositoryStorageDirectories(spec: Pick<JobSpec, "repositories">): string[] {
  return (spec.repositories ?? []).map((r) => `repos/${r.name}`);
}

/**
 * Whether a spec's repository list is well formed: absent, or 1 to MAX_RUN_REPOSITORIES_IN_INPUT
 * entries, each a valid link name (isCodingRepositoryName) with "read" or "write" access and a
 * host path, no name twice. The host path itself is checked by the launcher, which knows the root.
 */
export function jobRepositoriesValid(spec: Pick<JobSpec, "repositories">): boolean {
  const repositories = spec.repositories;
  if (repositories === undefined) return true;
  if (!Array.isArray(repositories) || repositories.length === 0) return false;
  if (repositories.length > MAX_RUN_REPOSITORIES_IN_INPUT) return false;
  const names = new Set<string>();
  for (const entry of repositories) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Object.keys(entry).sort().join(",") !== "access,hostPath,name" ||
      typeof entry.name !== "string" ||
      !isCodingRepositoryName(entry.name) ||
      (entry.access !== "read" && entry.access !== "write") ||
      typeof entry.hostPath !== "string" ||
      entry.hostPath.length === 0 ||
      names.has(entry.name)
    ) {
      return false;
    }
    names.add(entry.name);
  }
  return true;
}

/**
 * Where the VCS prepared an extra repository's files for this run (git.ts expectedPaths), recomputed
 * by a launcher only to check a spec's hostPath against it, never to find the files. Undefined when
 * the name is not a link name or the path would leave the root.
 */
export function expectedRepositoryHostPath(workspaceRoot: string, runId: string, name: string): string | undefined {
  if (!isCodingRepositoryName(name)) return undefined;
  const root = resolve(workspaceRoot);
  const runRoot = resolve(root, runId);
  if (!runRoot.startsWith(`${root}${sep}`) || runRoot.slice(root.length + 1).includes(sep)) return undefined;
  return resolve(runRoot, "repos", name, "workspace");
}
