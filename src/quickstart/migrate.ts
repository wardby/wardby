import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The installed npm package does not carry the Prisma CLI (a devDependency:
// its tree pulled advisories into every consumer install), so quickstart and
// doctor first look for a `prisma` executable on PATH and use it only if it
// reports exactly this version; anything else -- wrong version, not on PATH,
// a spawn error, a non-zero exit, or a timeout -- falls back to running the
// pinned version through npx, with a config file shipped in the package.
// Keep this equal to package.json's devDependencies.prisma (migrate.test.ts
// enforces it).
//
// Not supported on Windows: npx is `npx.cmd` there (and a local install would
// be `prisma.cmd`), which spawnSync can only run through a shell, and
// quickstart has no win32 handling anywhere else (Docker Compose paths,
// POSIX file modes) either.
export const PRISMA_CLI_VERSION = "7.10.0";

export const FETCH_NOTICE = `Fetching the Prisma CLI (prisma@${PRISMA_CLI_VERSION})…`;

export const REGISTRY_FAILURE_MESSAGE =
  `Could not download the Prisma CLI (prisma@${PRISMA_CLI_VERSION}) from the npm registry. ` +
  "quickstart and doctor fetch it on demand. Check your internet connection or npm registry settings " +
  "(.npmrc, proxy), then retry. You can also install it yourself " +
  `(\`npm i -g prisma@${PRISMA_CLI_VERSION}\`) and rerun quickstart -- doctor benefits too.`;

export const migrateConfigFile = fileURLToPath(new URL("../../prisma/migrate.config.mjs", import.meta.url));

export interface MigrateResult {
  status: number;
  stdout: string;
  stderr: string;
  // Set when npx could not be started or could not download the CLI: the
  // migration never ran, and Prisma's output (there is none) is not the story.
  registryFailure?: boolean;
}

export interface MigrateInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  // True when `command` is the locally installed `prisma` binary rather than
  // npx fetching one: nothing is downloaded, and a failure is Prisma's own.
  local: boolean;
}

// A short timeout so a wedged or misbehaving local binary can't stall
// quickstart/doctor -- any hang past this falls back to npx.
const LOCAL_PRISMA_PROBE_TIMEOUT_MS = 5000;

// `prisma --version` prints a fixed-label, padded-column report, e.g.:
//   prisma               : 7.10.0
//   @prisma/client       : 7.10.0
//   Operating System     : darwin
//   ...
// Several other lines carry their own version-shaped numbers (Node.js,
// TypeScript, the schema engine hash), so key off the "prisma" label
// specifically -- not the first x.y.z token anywhere in the output.
const LOCAL_VERSION_LINE = /^prisma\s*:\s*(\S+)$/m;

export function parseLocalPrismaVersion(stdout: string): string | undefined {
  return LOCAL_VERSION_LINE.exec(stdout)?.[1];
}

// Runs a local `prisma --version` under the given env's PATH and returns the
// version it reports, or undefined for anything that isn't a clean match:
// not on PATH, a spawn error, a non-zero exit, a timeout, or unparseable
// output. Never throws.
export function probeLocalPrismaVersion(env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync("prisma", ["--version"], {
    env,
    encoding: "utf8",
    stdio: "pipe",
    timeout: LOCAL_PRISMA_PROBE_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return undefined;
  return parseLocalPrismaVersion(result.stdout ?? "");
}

// DATABASE_URL travels in the child's environment only -- never argv, where
// any local user could read it from the process table. `probe` is injectable
// so tests never depend on the developer's real PATH.
export function prismaMigrateInvocation(
  subcommand: "deploy" | "status",
  env: NodeJS.ProcessEnv,
  probe: (env: NodeJS.ProcessEnv) => string | undefined = probeLocalPrismaVersion,
): MigrateInvocation {
  const childEnv = {
    ...env,
    PRISMA_HIDE_UPDATE_MESSAGE: "1",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
  };
  if (probe(childEnv) === PRISMA_CLI_VERSION) {
    return {
      command: "prisma",
      args: ["migrate", subcommand, "--config", migrateConfigFile],
      env: childEnv,
      local: true,
    };
  }
  return {
    command: "npx",
    args: ["--yes", `prisma@${PRISMA_CLI_VERSION}`, "migrate", subcommand, "--config", migrateConfigFile],
    env: childEnv,
    local: false,
  };
}

// npm's own error lines when it cannot fetch a package (npm 7+ prints
// "npm error", older "npm ERR!"): network failures and registry HTTP / version
// errors. A failed migration is printed by Prisma itself and never carries
// these -- in particular a database ECONNREFUSED is Prisma's P1001, not an
// "npm error code" line.
const REGISTRY_ERROR =
  /^npm (?:error|ERR!) (?:code|errno) (?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ETARGET|E[45]\d\d)\b|^npm (?:error|ERR!) network /m;

// `local` marks that `result`/`spawnError` came from the locally installed
// binary rather than npx: nothing was fetched, so neither an npm-shaped
// error line nor a spawn error is a registry failure there -- a spawn error
// still gets a clear message (below), just not that one.
export function classifyMigrateResult(result: MigrateResult, spawnError?: Error, local = false): MigrateResult {
  if (spawnError) {
    if (local) return { ...result, status: 1, stderr: spawnError.message };
    return { ...result, status: 1, stderr: spawnError.message, registryFailure: true };
  }
  if (!local && result.status !== 0 && REGISTRY_ERROR.test(result.stderr)) return { ...result, registryFailure: true };
  return result;
}

// The one-line reason for a failed run: the registry message, or Prisma's own
// first error line (URLs masked, though Prisma prints host and database only).
export function migrateFailureReason(result: MigrateResult): string {
  if (result.registryFailure) return REGISTRY_FAILURE_MESSAGE;
  const lines = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // A line that starts with "Error", or that carries a Prisma error code anywhere.
  const line =
    lines.find((candidate) => candidate.startsWith("Error") || /\bP\d{4}\b/.test(candidate)) ?? lines[0] ?? "no output";
  return line.replace(/postgres(ql)?:\/\/[^\s`'"]+/gi, "<database url>");
}

// Runs an already-resolved invocation (from `prismaMigrateInvocation`). Split
// out so callers can decide whether to print `FETCH_NOTICE` -- which only
// applies to the npx path -- before running it.
export function runPrismaMigrateInvocation(invocation: MigrateInvocation, cwd: string): MigrateResult {
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env: invocation.env,
    encoding: "utf8",
    stdio: "pipe",
  });
  return classifyMigrateResult(
    { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" },
    result.error,
    invocation.local,
  );
}

export function runPrismaMigrate(
  subcommand: "deploy" | "status",
  env: NodeJS.ProcessEnv,
  cwd: string,
  probe?: (env: NodeJS.ProcessEnv) => string | undefined,
): MigrateResult {
  return runPrismaMigrateInvocation(prismaMigrateInvocation(subcommand, env, probe), cwd);
}
