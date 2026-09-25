import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The installed npm package does not carry the Prisma CLI (a devDependency:
// its tree pulled advisories into every consumer install, SR-009), so
// quickstart and doctor run the exact CLI version the package was built with
// through npx, with a config file shipped in the package. Keep this equal to
// package.json's devDependencies.prisma (migrate.test.ts enforces it).
export const PRISMA_CLI_VERSION = "7.10.0";

export const migrateConfigFile = fileURLToPath(new URL("../../prisma/migrate.config.mjs", import.meta.url));

export interface MigrateResult {
  status: number;
  stdout: string;
  stderr: string;
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

export function runPrismaMigrate(subcommand: "deploy" | "status", env: NodeJS.ProcessEnv, cwd: string): MigrateResult {
  const { command, args, env: childEnv } = prismaMigrateInvocation(subcommand, env);
  const result = spawnSync(command, args, { cwd, env: childEnv, encoding: "utf8", stdio: "pipe" });
  if (result.error) return { status: 1, stdout: result.stdout ?? "", stderr: result.error.message };
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
