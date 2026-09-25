import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The installed npm package does not carry the Prisma CLI (a devDependency:
// its tree pulled advisories into every consumer install, SR-009), so
// quickstart and doctor run the exact CLI version the package was built with
// through npx, with a config file shipped in the package. Keep this equal to
// package.json's devDependencies.prisma (migrate.test.ts enforces it).
//
// Not supported on Windows: npx is `npx.cmd` there, which spawnSync can only
// run through a shell, and quickstart has no win32 handling anywhere else
// (Docker Compose paths, POSIX file modes) either.
export const PRISMA_CLI_VERSION = "7.10.0";

export const FETCH_NOTICE = `Fetching the Prisma CLI (prisma@${PRISMA_CLI_VERSION})…`;

export const REGISTRY_FAILURE_MESSAGE =
  `Could not download the Prisma CLI (prisma@${PRISMA_CLI_VERSION}) from the npm registry. ` +
  "quickstart and doctor fetch it on demand. Check your internet connection or npm registry settings " +
  "(.npmrc, proxy), then retry.";

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
}

// DATABASE_URL travels in the child's environment only -- never argv, where
// any local user could read it from the process table.
export function prismaMigrateInvocation(subcommand: "deploy" | "status", env: NodeJS.ProcessEnv): MigrateInvocation {
  return {
    command: "npx",
    args: ["--yes", `prisma@${PRISMA_CLI_VERSION}`, "migrate", subcommand, "--config", migrateConfigFile],
    env: {
      ...env,
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
    },
  };
}

// npm's own error lines when it cannot fetch a package (npm 7+ prints
// "npm error", older "npm ERR!"): network failures and registry HTTP / version
// errors. A failed migration is printed by Prisma itself and never carries
// these -- in particular a database ECONNREFUSED is Prisma's P1001, not an
// "npm error code" line.
const REGISTRY_ERROR =
  /^npm (?:error|ERR!) (?:code|errno) (?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ETARGET|E[45]\d\d)\b|^npm (?:error|ERR!) network /m;

export function classifyMigrateResult(result: MigrateResult, spawnError?: Error): MigrateResult {
  if (spawnError) {
    return { ...result, status: 1, stderr: spawnError.message, registryFailure: true };
  }
  if (result.status !== 0 && REGISTRY_ERROR.test(result.stderr)) return { ...result, registryFailure: true };
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
  const line = lines.find((candidate) => /^Error\b|P\d{4}/.test(candidate)) ?? lines[0] ?? "no output";
  return line.replace(/postgres(ql)?:\/\/[^\s`'"]+/gi, "<database url>");
}

export function runPrismaMigrate(subcommand: "deploy" | "status", env: NodeJS.ProcessEnv, cwd: string): MigrateResult {
  const { command, args, env: childEnv } = prismaMigrateInvocation(subcommand, env);
  const result = spawnSync(command, args, { cwd, env: childEnv, encoding: "utf8", stdio: "pipe" });
  return classifyMigrateResult(
    { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" },
    result.error,
  );
}
