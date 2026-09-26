import type { PrismaClient } from "#prisma";
import type { NativeRunProviders } from "../../core/runner.js";
import { loadDbosConfig, type ProviderConfig } from "../../config/providers.js";
import { prisma as defaultDb } from "../../core/db.js";
import { InProcessExecutor } from "./in-process.js";
import { DbosExecutor } from "./dbos.js";
import type { Executor } from "./types.js";

/** Select the Executor adapter from EXECUTOR. Constructing never connects; call `launch?.()` for that. */
export function buildExecutor(
  config: Pick<ProviderConfig, "executor">,
  providers: NativeRunProviders,
  db: PrismaClient = defaultDb,
  env: NodeJS.ProcessEnv = process.env,
): Executor {
  switch (config.executor) {
    case "in-process":
      return new InProcessExecutor(providers, db);
    case "dbos":
      return new DbosExecutor(providers, loadDbosConfig(env), db);
    default:
      throw new Error(`EXECUTOR "${String(config.executor)}" has no adapter (use "in-process" or "dbos").`);
  }
}
